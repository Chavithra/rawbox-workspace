/**
 * The **one producer** of the run-event stream.
 *
 * Everything in `event-types.ts` is created here and nowhere else, so the
 * envelope is stamped once and every sink — NDJSON file, terminal renderer, OTel
 * bridge — sees byte-identical events.
 *
 * ## Why transition deltas rather than XState's inspection API
 *
 * Both were on the table. The producer derives
 * events from **snapshot deltas** on `actor.subscribe`, for four reasons:
 *
 * 1. **The context already is the execution model.** `execution.todoStep` means
 *    "what is about to run" and `execution.doneStep` means "what just ran" —
 *    the two facts `step.start`/`step.end` need. The state value supplies the
 *    third (which phase the machine is in). The delta is a two-field comparison
 *    against the previous snapshot.
 * 2. **Inspection would not remove that read.** An `@xstate.actor` /
 *    `@xstate.snapshot` inspection event reports an *actor's* lifecycle; the
 *    invoked promise actor carries no step index, no label and no plugin, so
 *    resolving "which step is this?" still means reaching into the parent
 *    machine's context. Inspection would add an API surface without removing
 *    the one it was supposed to replace.
 * 3. **It would couple to internal names.** Telling `runActor` apart from
 *    `syncDbActor` in an inspection stream means matching on `src` strings that
 *    are private to `machine-instance.ts`. The state value (`running.running`)
 *    is no more public, but there is exactly one place to match it and it is
 *    already the machine's documented shape.
 * 4. **Volume.** Inspection reports every event and micro-transition, including
 *    the internal ones, all of which would have to be filtered back out.
 *
 * The cost, stated plainly: `duration_ms` is measured around the machine's
 * `running.running` phase, so it includes one transition's overhead
 * (microtask-scale) on top of the handler's own time. That is the right number
 * anyway — an operator asking "how long did this step take?" is asking about
 * wall-clock time in the step, not about the handler function in isolation.
 */

import {
  setRunEventChannel,
  type HostRunEvent,
  type RunEventChannel,
} from '@rawbox/plugin/core';

import type { MachineContext } from '../machine/machine-types.js';
import type { ResolvedWorkflow, Workflow } from '../workflow/workflow-types.js';
import {
  OUTCOME,
  RUN_EVENT,
  RUN_EVENT_FORMAT,
  SEVERITY,
  type BootstrapStage,
  type LogEvent,
  type LogLevel,
  type LogRotateEvent,
  type Outcome,
  type RunEndEvent,
  type RunEventError,
  type RunEventStep,
  type RunHeartbeatEvent,
  type RunOutcome,
  type SeedOverrideAppliedEntry,
  type Severity,
  type StepEndEvent,
  type StepProgressEvent,
  type StepStartEvent,
} from './event-types.js';
import type { SegmentRotationInfo } from './ndjson-file-sink.js';
import { RunEventEmitter, type RunEventSink } from './sink.js';

/**
 * Default `run.heartbeat` cadence, milliseconds, when
 * {@link RunEventProducerInput.heartbeatMs} is omitted.
 *
 * `@rawbox/cli`'s `--heartbeat` flag and `runWorkflowInstance`'s own option
 * both fall back to this rather than duplicating the number.
 */
export const DEFAULT_HEARTBEAT_MS = 10_000;

// ---------------------------------------------------------------------------
// Machine-shape helpers
//
// The only place in the package that reads the machine's state *value*. Kept
// private rather than exported so the coupling has exactly one site.
// ---------------------------------------------------------------------------

/** The `running.*` substate in which `runActor` executes a step's handler. */
const PHASE_RUNNING_STEP = 'running';

/**
 * The `running.*` substate of a snapshot, or `undefined` once the machine has
 * left `running` (its value is then the plain string `'stopping'`).
 */
function readPhase(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const running = (value as Record<string, unknown>)[PHASE_RUNNING_STEP];
  return typeof running === 'string' ? running : undefined;
}

/** The slice of an XState snapshot the producer reads. */
export interface RunSnapshotView {
  value: unknown;
  context: MachineContext;
}

// ---------------------------------------------------------------------------
// Step descriptors
// ---------------------------------------------------------------------------

/**
 * A step's identity, minus the `iteration` the producer counts.
 *
 * Assembled from **both** models: `plugin`/`operation` exist only in the
 * authoring document, `registry_hash` only in the resolved one.
 */
export type RunEventStepDescriptor = Omit<RunEventStep, 'iteration'>;

/**
 * Zips the authoring and resolved step lists into one descriptor per step.
 *
 * The two lists are index-aligned by construction: `resolveWorkflow` pushes one
 * `ResolvedStep` per authored step and returns `err` — never a short list — if
 * any step fails to resolve. Each pair is still read defensively rather than
 * asserted, because a mismatch should degrade the log, not crash the run.
 *
 * @param authored - The schema-valid authoring document.
 * @param resolved - The runtime model `resolveWorkflow` produced from it.
 */
export function buildStepDescriptorList(
  authored: Workflow,
  resolved: ResolvedWorkflow,
): RunEventStepDescriptor[] {
  return resolved.stepList.map((resolvedStep, index) => {
    const authoredStep = authored.steps[index];
    const label = resolvedStep.label ?? authoredStep?.label;
    return {
      index,
      ...(label === undefined ? {} : { label }),
      plugin: authoredStep?.plugin ?? '',
      operation: authoredStep?.operation ?? '',
      registry_hash: resolvedStep.definitionLocation.contractRegistryHash,
    };
  });
}

// ---------------------------------------------------------------------------
// The producer
// ---------------------------------------------------------------------------

/** What a step in flight is paired against when it ends. */
interface InFlightStep {
  step: RunEventStep;
  startedAtMs: number;
}

/** Constructor input for {@link RunEventProducer}. */
export interface RunEventProducerInput {
  /** Correlates every event of this run; the same id the machine carries. */
  runId: string;
  /** Where the events go. Order is preserved on fan-out. */
  sinkList: readonly RunEventSink[];
  /**
   * Milliseconds between `run.heartbeat` events while a step is in flight.
   * Defaults to {@link DEFAULT_HEARTBEAT_MS}. `0` disables heartbeats
   * entirely — no timer is ever started (OBSERVABILITY.md, "`run.heartbeat`").
   */
  heartbeatMs?: number;
}

/**
 * Turns a run's lifecycle into the typed event stream.
 *
 * Lifecycle, in the order `runWorkflowInstance` calls it:
 *
 * ```text
 * new RunEventProducer(…)              // usable immediately, for pre-identity failures
 *   .bootstrapError(stage, message)    // any preflight stage
 *   .start(workspaceName, workflowName) // names known -> run.start (format: 1)
 *   .seedOverrideApplied(applicationList) // -> seed.override.applied, when non-empty
 *   .setStepDescriptorList(…)          // once the document is resolved
 *   .storageSeed(seedList, durationMs) // -> storage.seed
 *   .installLogChannel()               // workflow-authored log/step.progress lines join the stream
 *   .observe(snapshot)                 // per machine transition -> step.start / step.end
 *                                       //   (also starts/stops the run.heartbeat timer per step)
 *   .logRotate(info)                   // -> log.rotate, whenever the main NDJSON log rolls
 *                                       //   (called by the sink itself, not by run-workflow.ts)
 *   .end(outcome, error?)              // -> run.end
 *   .close()                           // uninstalls the channel, stops the timer, closes sinks
 * ```
 */
export class RunEventProducer {
  /**
   * The run's correlation id, on every event as `run_id`.
   *
   * Public because the machine must be given the *same* id: a snapshot logged
   * by an embedder and an event read out of the NDJSON have to name one run.
   */
  readonly runId: string;

  private readonly emitter: RunEventEmitter;

  private workspaceName: string | undefined;
  private workflowName: string | undefined;

  private stepDescriptorList: readonly RunEventStepDescriptor[] = [];
  /** Step index → executions started so far; the source of `step.iteration`. */
  private readonly iterationByStepIndex = new Map<number, number>();

  private phase: string | undefined;
  private inFlight: InFlightStep | null = null;

  private readonly heartbeatMs: number;
  /**
   * The `run.heartbeat` timer for the step currently in flight, or
   * `undefined` between steps and outside a run. Started in {@link beginStep},
   * stopped in {@link emitStepEnd} — the two are the *only* places this field
   * is touched, which is what makes "never fires between steps" true by
   * construction rather than by a guard checked on every tick.
   */
  private heartbeatTimer: NodeJS.Timeout | undefined;

  private runStartedAtMs = 0;
  private runStartEmitted = false;
  private runEndEmitted = false;
  private stepsEnded = 0;
  private stepsFailed = 0;

  /**
   * Set by {@link markInterrupted} the instant an operator abort is acted on.
   * From then on, a step the machine abandons (leaving `running` without a
   * fresh `doneStep`) is *not* fabricated into an error `step.end` — the run
   * is being stopped on purpose, and the truthful record is a `step.start`
   * with no `step.end`, followed by the interrupted `run.end`.
   */
  private interrupted = false;

  private channelInstalled = false;
  private previousChannel: RunEventChannel | undefined;

  constructor({ runId, sinkList, heartbeatMs }: RunEventProducerInput) {
    this.runId = runId;
    this.emitter = new RunEventEmitter(sinkList);
    this.heartbeatMs = heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  }

  // -- Run boundaries ------------------------------------------------------

  /**
   * Records the run's identity and emits `run.start` — the first line of the
   * run's log and the line that declares its format.
   *
   * Identity and emission are one call because they are one fact: a run "starts"
   * exactly when it knows what it is running. That is also why a failure in the
   * two preflight stages that *establish* identity produces a `bootstrap.error`
   * and no `run.start` — there would be nothing truthful to put in the envelope.
   * Every event emitted after this one carries the two names.
   */
  start(workspaceName: string, workflowName: string): void {
    this.workspaceName = workspaceName;
    this.workflowName = workflowName;

    if (this.runStartEmitted) {
      return;
    }
    this.runStartedAtMs = Date.now();
    this.runStartEmitted = true;

    this.emitter.emit({
      ts: new Date().toISOString(),
      run_id: this.runId,
      workspace: workspaceName,
      workflow: workflowName,
      event: RUN_EVENT.RUN_START,
      format: RUN_EVENT_FORMAT,
    });
  }

  /**
   * Emits `seed.override.applied` — every seed a workspace `seedOverrides:`
   * block or the CLI's `--seed` flag replaced, once per run.
   *
   * Called right after {@link start}, deliberately: this is the point the
   * run's identity — the two names every event past this one carries — first
   * exists, and an override's applicability was already settled before that,
   * at the merge `applySeedOverrides` performed while establishing the
   * document this run is actually going to execute
   * (`run-workflow.ts`'s steps 2b/3). There is nothing to wait for.
   *
   * No-op when `applicationList` is empty: a run replacing nothing emits
   * nothing, so a run with no overrides produces a stream byte-identical to
   * one from before this event existed. This is the same "only when non-empty"
   * discipline {@link storageSeed} follows for the reason `event-types.ts`
   * gives — a document seeding nothing gets no `storage.seed` line either.
   *
   * @param applicationList - Every key an override replaced and the source
   *   that supplied it, from
   *   `workspace/seed-overrides.ts`'s `summarizeAppliedSeedOverrides`. Holds
   *   no value — see that function's doc for why the report is deliberately
   *   shape-only.
   */
  seedOverrideApplied(applicationList: readonly SeedOverrideAppliedEntry[]): void {
    if (applicationList.length === 0) {
      return;
    }

    this.emitter.emit({
      ...this.envelope(RUN_EVENT.SEED_OVERRIDE_APPLIED),
      overrides: applicationList.map(({ key, source }) => ({ key, source })),
    });
  }

  /**
   * Marks the run as being gracefully interrupted (an operator signal).
   *
   * Called by the runner **before** it stops the machine, so the stop's own
   * transition — which leaves `running` with no fresh `doneStep` — abandons
   * any in-flight step instead of fabricating an error `step.end` for it. An
   * operator stop is intent, not a failure, and must not write alarm events
   * (OBSERVABILITY.md, "`severity`"). The abandoned step's open OTel span is
   * closed by the bridge when the interrupted `run.end` arrives
   * (`otel-sink.ts`).
   */
  markInterrupted(): void {
    this.interrupted = true;
  }

  /**
   * Emits `run.end`, closing any step still in flight first.
   *
   * A step is still in flight here only when the machine died without producing
   * a `doneStep` — an actor rejection, or a throw out of the promise the runner
   * awaits. Closing it with the run's own error is what keeps every `step.start`
   * paired, which the OTel bridge relies on to avoid leaking spans. The one
   * exception is an **interrupted** run: its abandoned step gets no `step.end`
   * at all (see {@link markInterrupted}), and the OTel bridge closes the open
   * span itself on the interrupted `run.end`.
   *
   * No-op when `run.start` was never emitted: a run that failed before it knew
   * its own identity terminates the stream with its `bootstrap.error`.
   *
   * @param timeoutMs - The bound that expired, when a **runner bound** is what
   *   ended this run — a bounded step's or the preflight one. Present means
   *   both `timed_out` and `timeout_ms` go on the event, together or not at
   *   all, exactly as on `step.end` (see {@link RunEndEvent}). It is passed
   *   separately rather than folded into `error` because `RunEventError` is a
   *   closed schema of `{ message, stack? }`.
   */
  end(outcome: RunOutcome, error?: RunEventError, timeoutMs?: number): void {
    if (!this.runStartEmitted || this.runEndEmitted) {
      return;
    }

    if (this.inFlight) {
      if (outcome === OUTCOME.INTERRUPTED) {
        this.abandonInFlightStep();
      } else {
        this.emitStepEnd(
          OUTCOME.ERROR,
          error
            ? { message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
            : { message: 'The step did not report a result.' },
          undefined,
        );
      }
    }

    this.runEndEmitted = true;
    // Defensive: the block above already closes any in-flight step via
    // `emitStepEnd`, which stops the timer itself — this is a backstop for a
    // path that reaches `run.end` without ever having had one in flight.
    this.stopHeartbeat();

    const event: RunEndEvent = {
      ...this.envelope(RUN_EVENT.RUN_END),
      outcome,
      duration_ms: Date.now() - this.runStartedAtMs,
      steps_total: this.stepsEnded,
      steps_failed: this.stepsFailed,
      // Gated on the error outcome as well as on the bound, so an interrupted
      // run can never claim a timeout: an operator stop that happened to race
      // an armed bound is still an operator stop.
      ...(outcome === OUTCOME.ERROR && timeoutMs !== undefined
        ? { timed_out: true as const, timeout_ms: timeoutMs }
        : {}),
      ...(outcome === OUTCOME.ERROR && error ? { error } : {}),
      ...(outcome === OUTCOME.ERROR ? { severity: SEVERITY.ERROR } : {}),
    };
    this.emitter.emit(event);
  }

  // -- Preflight -----------------------------------------------------------

  /**
   * Emits `bootstrap.error` — the typed replacement for the `[Bootstrap Error]`
   * strings the runner used to append to the error log.
   *
   * @param stage - Which preflight stage failed; see `BOOTSTRAP_STAGE`.
   * @param message - The full diagnostic, unabridged. These are multi-line and
   *   deliberately long: they are the same text the caller receives.
   */
  bootstrapError(stage: BootstrapStage, message: string): void {
    this.emitter.emit({
      ...this.envelope(RUN_EVENT.BOOTSTRAP_ERROR),
      stage,
      message,
      severity: SEVERITY.ERROR,
    });
  }

  /** The step table, once the document has been resolved. */
  setStepDescriptorList(stepDescriptorList: readonly RunEventStepDescriptor[]): void {
    this.stepDescriptorList = stepDescriptorList;
  }

  /**
   * Emits the single `storage.seed` summary for the seeding transaction.
   *
   * @param seedList - The resolved seeds actually written, in write order. Note
   *   that several share a key when a FIFO seed was expanded, which is exactly
   *   the difference `seed_count` and `key_count` report.
   * @param durationMs - Wall-clock time the transaction took.
   */
  storageSeed(seedList: readonly { key: string }[], durationMs: number): void {
    const keyList: string[] = [];
    for (const seed of seedList) {
      if (!keyList.includes(seed.key)) {
        keyList.push(seed.key);
      }
    }

    this.emitter.emit({
      ...this.envelope(RUN_EVENT.STORAGE_SEED),
      seed_count: seedList.length,
      key_count: keyList.length,
      keys: keyList,
      duration_ms: durationMs,
    });
  }

  // -- Log rotation ----------------------------------------------------------

  /**
   * Emits `log.rotate` — the run's main NDJSON log crossed a segment
   * boundary.
   *
   * Called synchronously from `ndjson-file-sink.ts`'s `onSegmentRotate` hook,
   * itself fired from inside that writer's own `open()`, the instant the new
   * segment's descriptor exists and before a single real line has been
   * written to it. That timing is what makes this event the new segment's
   * **first line**: `this.emitter.emit(event)` below fans out to every sink
   * — including the very NDJSON writer that is calling this method — and
   * that reentrant write lands before the line which necessitated (or was
   * queued behind) the roll gets its turn. See `ndjson-file-sink.ts`'s
   * module doc, "The `log.rotate` marker", for the full mechanism and why
   * the reentrancy terminates rather than recursing.
   *
   * Routed through the producer, like every other event, rather than written
   * directly into the file by the sink alone: the marker must reach the
   * terminal renderer and the OTel bridge too, or the file's content
   * diverges from "the event stream" — the property `event-types.ts`'s
   * module doc opens with.
   */
  logRotate(info: SegmentRotationInfo): void {
    const event: LogRotateEvent = {
      ...this.envelope(RUN_EVENT.LOG_ROTATE),
      sealed_segment: info.sealedSegment,
      live_segment: info.liveSegment,
      ...(info.deletedSegment === undefined ? {} : { deleted_segment: info.deletedSegment }),
      max_bytes: info.maxBytes,
      max_files: info.maxFiles,
      // A routine roll that discarded nothing is not an alarm; one that
      // destroyed history is more than routine chatter (OBSERVABILITY.md,
      // "`severity`").
      ...(info.deletedSegment === undefined ? {} : { severity: SEVERITY.WARN }),
    };
    this.emitter.emit(event);
  }

  // -- The machine ---------------------------------------------------------

  /**
   * Derives `step.start`/`step.end` from one machine snapshot.
   *
   * The delta is the `running.*` phase: entering `running.running` means the
   * step's handler is about to be invoked, leaving it means it produced
   * something. Which of the two happened is read off `execution.doneStep`:
   *
   * - `doneStep` for the step that was in flight, with an `errorRecord` → the
   *   handler failed logically (`outcome: "error"`, the record attached);
   * - `doneStep` without one → success, with `outputRecord` as `output`;
   * - no matching `doneStep` → the actor itself failed, and `context.error`
   *   carries why.
   */
  observe(snapshot: RunSnapshotView): void {
    const previousPhase = this.phase;
    const phase = readPhase(snapshot.value);
    this.phase = phase;

    if (previousPhase === PHASE_RUNNING_STEP && phase !== PHASE_RUNNING_STEP) {
      this.finishStep(snapshot);
    }

    if (phase === PHASE_RUNNING_STEP && previousPhase !== PHASE_RUNNING_STEP) {
      this.beginStep(snapshot);
    }
  }

  /** Emits `step.start` for the step the machine just entered `running` with. */
  private beginStep(snapshot: RunSnapshotView): void {
    const todoStep = snapshot.context.execution.todoStep;
    if (!todoStep) {
      return;
    }

    const index = todoStep.index;
    const iteration = this.iterationByStepIndex.get(index) ?? 0;
    this.iterationByStepIndex.set(index, iteration + 1);

    const descriptor = this.stepDescriptorList[index];
    const step: RunEventStep = descriptor
      ? { ...descriptor, iteration }
      : {
          // Defensive: the table is built from the very workflow the machine is
          // running, so an index outside it cannot happen. Reporting the step
          // with empty identity beats dropping the pair and leaving a span open.
          index,
          iteration,
          plugin: '',
          operation: '',
          registry_hash: '',
        };

    this.inFlight = { step, startedAtMs: Date.now() };
    this.startHeartbeat();

    const event: StepStartEvent = {
      ...this.envelope(RUN_EVENT.STEP_START),
      step,
      ...(todoStep.inputRecord === undefined ? {} : { input: todoStep.inputRecord }),
    };
    this.emitter.emit(event);
  }

  /** Emits `step.end` for the step the machine just left `running` with. */
  private finishStep(snapshot: RunSnapshotView): void {
    if (!this.inFlight) {
      return;
    }

    // A graceful interrupt stops the machine out from under the in-flight
    // step: the transition out of `running` carries no fresh `doneStep` (a
    // stale one from a previous execution may still sit in the context), so
    // nothing here can honestly say how the step ended — it didn't. Abandon
    // it: no `step.end`, no step counted; the interrupted `run.end` that
    // follows is the record (see {@link markInterrupted}).
    if (this.interrupted) {
      this.abandonInFlightStep();
      return;
    }

    const doneStep = snapshot.context.execution.doneStep;

    if (doneStep && doneStep.index === this.inFlight.step.index) {
      if (doneStep.errorRecord) {
        this.emitStepEnd(OUTCOME.ERROR, doneStep.errorRecord, undefined);
      } else {
        this.emitStepEnd(OUTCOME.OK, undefined, doneStep.outputRecord);
      }
      return;
    }

    // No `doneStep` for the step in flight: the step itself failed rather than
    // the handler declaring a logical failure, so the machine's own error is
    // the record. A **bounded step** whose bound expired arrives here too, and
    // only here — `run-actor.ts` reports a timeout as `err(StepTimeoutError)`
    // precisely so it takes this path and terminates the run, instead of the
    // `doneStep.errorRecord` path that writes `errors:` bindings and continues.
    // The bound it carries becomes `timed_out`/`timeout_ms` on the event; the
    // `error` record itself keeps carrying `{ message, stack? }` and nothing
    // more, because its shape is the plugin's to declare.
    const machineError = snapshot.context.error;
    this.emitStepEnd(
      OUTCOME.ERROR,
      machineError
        ? {
            message: machineError.message,
            ...(machineError.stack ? { stack: machineError.stack } : {}),
          }
        : { message: 'The step ended without reporting a result.' },
      undefined,
      machineError?.timeoutMs,
    );
  }

  /**
   * Drops the in-flight step without a `step.end` — the interrupted-run path
   * only. Clears the pairing state and stops the heartbeat exactly as
   * {@link emitStepEnd} would, but emits nothing and counts nothing: the step
   * never reported a result, and the run was stopped on purpose.
   */
  private abandonInFlightStep(): void {
    this.inFlight = null;
    this.stopHeartbeat();
  }

  /**
   * The one place a `step.end` is built, so its accounting cannot drift.
   *
   * @param timeoutMs - The bound that expired, when this `step.end` reports a
   *   **bounded step** timing out; `undefined` for every other failure and
   *   every success. Present means both `timed_out` and `timeout_ms` go on the
   *   event — they are emitted together or not at all, and `timed_out: false`
   *   is deliberately unrepresentable (see {@link StepEndEvent}).
   */
  private emitStepEnd(
    outcome: Outcome,
    errorRecord: Record<string, unknown> | undefined,
    outputRecord: Record<string, unknown> | undefined,
    timeoutMs?: number,
  ): void {
    const inFlight = this.inFlight;
    if (!inFlight) {
      return;
    }
    this.inFlight = null;
    // The step is no longer in flight the instant this runs — stopping the
    // timer here, and only here (besides {@link beginStep}'s pairing start),
    // is what makes a heartbeat between steps unreachable rather than merely
    // unlikely.
    this.stopHeartbeat();

    this.stepsEnded += 1;
    if (outcome === OUTCOME.ERROR) {
      this.stepsFailed += 1;
    }

    const event: StepEndEvent = {
      ...this.envelope(RUN_EVENT.STEP_END),
      step: inFlight.step,
      outcome,
      duration_ms: Date.now() - inFlight.startedAtMs,
      ...(timeoutMs === undefined
        ? {}
        : { timed_out: true as const, timeout_ms: timeoutMs }),
      ...(outputRecord === undefined ? {} : { output: outputRecord }),
      ...(errorRecord === undefined ? {} : { error: errorRecord }),
      ...(outcome === OUTCOME.ERROR ? { severity: SEVERITY.ERROR } : {}),
    };
    this.emitter.emit(event);
  }

  // -- Heartbeat ------------------------------------------------------------

  /**
   * Starts the `run.heartbeat` timer for the step that just began. No-op when
   * heartbeats are disabled (`heartbeatMs <= 0`).
   *
   * `.unref()` is the whole reason this timer can never keep the process
   * alive: without it, a run whose last step never emits again (a hang the
   * heartbeat exists to make *visible*) would itself hang the CLI process
   * that is supposed to be reporting that fact.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatMs <= 0) {
      return;
    }
    const timer = setInterval(() => this.emitHeartbeat(), this.heartbeatMs);
    timer.unref();
    this.heartbeatTimer = timer;
  }

  /** Clears the heartbeat timer, if one is running. Idempotent. */
  private stopHeartbeat(): void {
    if (this.heartbeatTimer === undefined) {
      return;
    }
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /** One `run.heartbeat` tick for the step currently in flight. */
  private emitHeartbeat(): void {
    const inFlight = this.inFlight;
    if (!inFlight) {
      // Defensive: `stopHeartbeat` is called synchronously the instant a step
      // ends, so a tick should never observe no step in flight. Stopping the
      // timer here as well means a stray tick cannot repeat.
      this.stopHeartbeat();
      return;
    }

    const event: RunHeartbeatEvent = {
      ...this.envelope(RUN_EVENT.RUN_HEARTBEAT),
      step: inFlight.step,
      in_flight_ms: Date.now() - inFlight.startedAtMs,
    };
    this.emitter.emit(event);
  }

  // -- The plugin channel --------------------------------------------------

  /**
   * Installs the ambient host channel, so a definition that emits a `log` or
   * `step.progress` event lands in this stream instead of on `console` (or
   * nowhere, for `step.progress`, which has no standalone fallback).
   *
   * The runner recognises **the event kinds it owns**, never the plugin that
   * sent them: any definition of any package may emit `{ event: "log", … }`
   * or `{ event: "step.progress", … }` and be routed, and any other event kind
   * is dropped. That is what keeps `observability/log` — and a `step.progress`
   * emitter — from being special-cased anywhere in the runner
   * (OBSERVABILITY.md, "Event kinds").
   */
  installLogChannel(): void {
    if (this.channelInstalled) {
      return;
    }
    this.previousChannel = setRunEventChannel({
      emit: (hostEvent: HostRunEvent) => this.acceptHostEvent(hostEvent),
    });
    this.channelInstalled = true;
  }

  /** Restores whatever channel was installed before {@link installLogChannel}. */
  uninstallLogChannel(): void {
    if (!this.channelInstalled) {
      return;
    }
    setRunEventChannel(this.previousChannel);
    this.channelInstalled = false;
    this.previousChannel = undefined;
  }

  /**
   * Dispatches one event handed over by a definition handler to the kind-
   * specific validator, or drops it when the kind is not one this runner
   * owns.
   */
  private acceptHostEvent(hostEvent: HostRunEvent): void {
    if (hostEvent.event === RUN_EVENT.LOG) {
      this.acceptLogEvent(hostEvent);
      return;
    }
    if (hostEvent.event === RUN_EVENT.STEP_PROGRESS) {
      this.acceptStepProgressEvent(hostEvent);
      return;
    }
  }

  /**
   * Validates and stamps a `log` event.
   *
   * Handler-supplied data is untrusted input like any other: `level` must be
   * one of the four, and `message` must be a string. Anything else is dropped
   * rather than written, because a malformed line in an NDJSON file breaks
   * every reader of that file, not just the line.
   */
  private acceptLogEvent(hostEvent: HostRunEvent): void {
    const level = hostEvent['level'];
    const message = hostEvent['message'];
    if (!isLogLevel(level) || typeof message !== 'string') {
      return;
    }

    const severity = severityOfLevel(level);
    const event: LogEvent = {
      ...this.envelope(RUN_EVENT.LOG),
      level,
      message,
      ...('data' in hostEvent ? { data: hostEvent['data'] } : {}),
      ...(this.inFlight ? { step: this.inFlight.step } : {}),
      ...(severity === undefined ? {} : { severity }),
    };
    this.emitter.emit(event);
  }

  /**
   * Validates and stamps a `step.progress` event, sanitized like {@link
   * acceptLogEvent}: `message`, when present at all, must be a string —
   * unlike `log`, a progress line may carry only `data` and say nothing in
   * words, so an absent `message` is fine and a non-string one is dropped.
   */
  private acceptStepProgressEvent(hostEvent: HostRunEvent): void {
    const message = hostEvent['message'];
    if (message !== undefined && typeof message !== 'string') {
      return;
    }

    const event: StepProgressEvent = {
      ...this.envelope(RUN_EVENT.STEP_PROGRESS),
      ...(typeof message === 'string' ? { message } : {}),
      ...('data' in hostEvent ? { data: hostEvent['data'] } : {}),
      ...(this.inFlight ? { step: this.inFlight.step } : {}),
    };
    this.emitter.emit(event);
  }

  // -- Teardown ------------------------------------------------------------

  /**
   * Uninstalls the channel, stops any running heartbeat, then flushes and
   * closes every sink.
   *
   * Always awaited in a `finally`, so a throw anywhere in the run still leaves
   * the log files complete, the timer cleared, and any exporter shut down.
   */
  async close(): Promise<void> {
    this.uninstallLogChannel();
    this.stopHeartbeat();
    await this.emitter.close();
  }

  // -- Envelope ------------------------------------------------------------

  /**
   * The shared fields, in the documented key order — which is also the order
   * they appear in the NDJSON, since object spread preserves insertion order.
   *
   * `workspace`/`workflow` are spread conditionally rather than set to
   * `undefined`, so a pre-identity `bootstrap.error` omits the keys instead of
   * serialising them as `null`.
   */
  private envelope<Kind extends string>(
    event: Kind,
  ): { ts: string; run_id: string; workspace?: string; workflow?: string; event: Kind } {
    return {
      ts: new Date().toISOString(),
      run_id: this.runId,
      ...(this.workspaceName === undefined ? {} : { workspace: this.workspaceName }),
      ...(this.workflowName === undefined ? {} : { workflow: this.workflowName }),
      event,
    };
  }
}

/** Narrows an unknown `level` to the four the format admits. */
function isLogLevel(value: unknown): value is LogLevel {
  return (
    value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
  );
}

/** A `log` event's `severity`, projected from its `level` — see {@link LogEvent}'s own doc. */
function severityOfLevel(level: LogLevel): Severity | undefined {
  if (level === 'error') {
    return SEVERITY.ERROR;
  }
  if (level === 'warn') {
    return SEVERITY.WARN;
  }
  return undefined;
}
