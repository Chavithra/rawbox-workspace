/**
 * # The run-event stream — the log-format contract
 *
 * Every observable thing a run does is one **typed event**. This module is the
 * normative definition of those events: it is simultaneously
 *
 * 1. the **NDJSON log format** (`@rawbox/runner` writes one `JSON.stringify`d
 *    event per line — see `ndjson-file-sink.ts`),
 * 2. the **terminal renderer's input**, and
 * 3. the **OTel mapping's source**, designed against the span model
 *    (README, "The mapping") so the file logs and any exported telemetry can never
 *    diverge.
 *
 * One producer, N sinks. Nothing downstream re-derives run state from XState
 * snapshots.
 *
 * ## The envelope
 *
 * Every event carries the same first five fields, **in this order**, so a line
 * is recognisable before it is parsed:
 *
 * ```jsonc
 * {"ts":"2026-08-09T10:11:12.345Z","run_id":"run-…","workspace":"my-workspace","workflow":"example","event":"run.start","format":1}
 * ```
 *
 * | Field | Meaning |
 * | --- | --- |
 * | `ts` | ISO-8601 UTC instant the event was produced (`Date.toISOString()`). |
 * | `run_id` | Correlates every event of one run. **This is the trace key**: the OTel bridge maps it to one trace. |
 * | `workspace` | Workspace name → `rawbox.workspace.name`. |
 * | `workflow` | Workflow name → `rawbox.workflow.name`. |
 * | `event` | The kind discriminator; see {@link RUN_EVENT}. |
 *
 * `workspace` and `workflow` are optional **in the schema only**, and only
 * because a run can fail before it knows them: the workspace document is loaded
 * first, and a `bootstrap.error` raised while loading it or the workflow
 * document has no names to report yet. From `run.start` onward they are always
 * present. `run.start` requires them at the schema level.
 *
 * Field names are `snake_case` throughout, matching the examples in
 * OBSERVABILITY.md, "Envelope" and OTel attribute style. The nesting is deliberate: `step` is an object rather than
 * `step_index`/`step_label`/… so a consumer forwards one value.
 *
 * ## Kinds
 *
 * | `event` | When | OTel shape |
 * | --- | --- | --- |
 * | `run.start` | Once, as soon as the run's identity is known. Carries `format: 1`. | Root span `rawbox.workflow.run` opens |
 * | `run.end` | Once, last event of the run. | Root span closes; status from `outcome` |
 * | `step.start` | The machine is about to execute a step's handler. | Child span opens |
 * | `step.end` | The step produced a result — success or failure. | Child span closes |
 * | `storage.seed` | Once, after seeding commits, when the document seeds anything. | Span event on the root span |
 * | `seed.override.applied` | Once, right after `run.start`, when a workspace or `--seed` layer replaced a seed. | Span event on the root span |
 * | `bootstrap.error` | A preflight stage failed; the run never reaches the machine. | Exception on the root span |
 * | `log` | The built-in `observability/log` operation emitted a line. | Log record correlated to the active step's span |
 * | `run.heartbeat` | On a configurable interval, while a step is in flight. | Span event on that step's span |
 * | `step.progress` | Opt-in: an operation reports progress mid-step, via the same channel as `log`. | Span event on that step's span |
 * | `log.rotate` | Once per roll of the run's **main** NDJSON log, always the first line of the segment it names `live_segment`. | Span event on the root span |
 *
 * ## `log.rotate`
 *
 * Rotation destroys history — the oldest segment is unlinked once
 * `rotate.maxFiles` is exceeded — and this kind is what keeps that fact in the
 * stream instead of leaving a reader unable to tell "nothing was logged before
 * this" from "the log was trimmed". It carries `sealed_segment` (the segment
 * just closed), `live_segment` (the segment this very event is the first line
 * of), `deleted_segment` (present only when a segment was actually unlinked to
 * honour `maxFiles` — the load-bearing field), and the `max_bytes`/`max_files`
 * bounds in force, so a reader never has to go back to the workspace document
 * to know the policy that produced the gap.
 *
 * Emitted only for the **main** log's own rotation, never for the filtered
 * error log's independent one (`ndjson-file-sink.ts`'s `createNdjsonFileSink`
 * wires the hook to that writer alone) — the error log is a *view* of the main
 * log, and CLI readers (`log-segments.ts`/`log-merge.ts`) enumerate the main
 * log's segments, not the error log's.
 *
 * Guaranteed to be the first line of `live_segment`, in every sink, not only
 * the file: the writer's `open()` fires it synchronously, re-entering the
 * producer and this event's own sink, before the line that necessitated (or
 * was queued behind) the rotation is written — see `ndjson-file-sink.ts`'s
 * module doc, "Rotation", for why that re-entrancy terminates in one extra
 * frame rather than recursing.
 *
 * ## `severity`
 *
 * An optional envelope field, added only to the kinds that warrant paging
 * someone: `bootstrap.error` always carries `severity: "error"`; an
 * error-outcome `step.end`/`run.end` carries `severity: "error"`; a `log`
 * event inherits its level (`error` → `"error"`, `warn` → `"warn"`,
 * `info`/`debug` → absent); `log.rotate` carries `severity: "warn"` exactly
 * when it also carries `deleted_segment` — a routine roll that discarded
 * nothing is not an alarm, but one that destroyed history is more than
 * routine chatter. `run.heartbeat` and `step.progress` never carry one —
 * neither is ever an alarm. `--output quiet` and the OTel bridge key off this
 * field rather than re-deriving "is this bad" per kind
 * (OBSERVABILITY.md, "`severity`").
 *

 * ## Span pairing and loop iterations
 *
 * A `step.start`/`step.end` pair is identified by
 * **`(run_id, step.index, step.iteration)`** — that triple is the child span's
 * identity, and no other pair in the run shares it. `iteration` counts
 * executions of *that step index* within the run, from `0`, so the repeated
 * sibling spans a `loop-gate` produces are distinguishable even though they
 * share a label (README, "The mapping"). `index` rather than `label` is the identity
 * because a label is optional in the workflow format.
 *
 * ## `format: 1`
 *
 * `run.start` carries `format: 1`, mirroring the workflow document's own
 * `formatVersion` discipline: it is the first line of every run's log, so a
 * reader knows what it is holding before parsing anything else. Additive changes
 * (a new optional field, a new kind) keep `1`; a change that would make an
 * existing reader wrong takes `2`.
 *
 * **Decided (OBSERVABILITY.md, "Versioning"):** `run.heartbeat`, `step.progress`
 * and `severity` are exactly that kind of additive change — a new kind and a
 * new optional envelope field, nothing more — so they ship under `format: 1`,
 * not `2`. `step.end`'s `timed_out`/`timeout_ms` (a **bounded step** whose bound
 * expired) join that list on the same reasoning: two new optional fields on one
 * existing kind, whose `outcome` stays `"error"` so every reader that already
 * counts, colours or exports failures keeps seeing this one. `run.end`'s
 * `timed_out`/`timeout_ms` are the same two fields on a second existing kind,
 * added when the **preflight bound** (`RunWorkflowOptions.preflightTimeoutMs`)
 * gave the runner a second thing it can stop waiting for, and they follow the
 * identical rule — optional, emitted as a pair, `outcome` unchanged. The `run.end`
 * outcome **value** `interrupted` ships under
 * `format: 1` by the same discipline: no existing value changed meaning, and a
 * reader treating an unknown outcome as "not ok, not error" degrades
 * gracefully rather than misreading anything. `log.rotate` is the same kind of
 * change `run.heartbeat`/`step.progress` were: a new kind and a new optional
 * `severity` value on it, nothing an existing reader was already parsing
 * changes meaning. The corollary is a requirement on every reader, not just this
 * package's own: **readers MUST ignore unknown event kinds and unknown
 * envelope fields.** `ndjson-file-sink.ts` writes whatever `JSON.stringify`
 * produces regardless of kind; `@rawbox/cli`'s log-merge, log-summary and
 * terminal-sink read event-shaped JSON generically (`event`, `ts`, and a
 * handful of named fields) rather than validating against a closed schema, so
 * a stream from a newer runner never breaks an older reader, and a stream
 * from an older runner (no `severity`, no `run.heartbeat`) renders in a newer
 * reader exactly as it always has. `format` only ever bumps for a change that
 * would make an existing reader's *interpretation* of a field wrong — nothing
 * in this revision does that.
 *
 * ## What is deliberately *not* here
 *
 * - **No state-machine vocabulary.** `running.syncingDb` is an implementation
 *   detail of the XState layer; an event stream that leaked it would pin the
 *   log format to the machine's internal shape.
 * - **No terminal formatting.** Colour, alignment and truncation belong to the
 *   renderer that consumes these, not to the record.
 * - **No metrics.** Durations are on the events; histograms are the OTel sink's
 *   job (README, "The `rawbox.*` attribute namespace").
 */

import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';

import { StrictObject } from '@rawbox/store';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The value of `format:` on `run.start` for this revision of the stream.
 *
 * A number, not a string, unlike the workflow document's `formatVersion: "1.0"`:
 * this format has no minor component to express, and the spec's own envelope
 * example (OBSERVABILITY.md, "Envelope") writes `"format":1`.
 */
export const RUN_EVENT_FORMAT = 1;

/** Every event kind the runner produces. */
export const RUN_EVENT = {
  RUN_START: 'run.start',
  RUN_END: 'run.end',
  STEP_START: 'step.start',
  STEP_END: 'step.end',
  STORAGE_SEED: 'storage.seed',
  /** A workspace or `--seed` layer replaced a seed's value before it was written. */
  SEED_OVERRIDE_APPLIED: 'seed.override.applied',
  BOOTSTRAP_ERROR: 'bootstrap.error',
  LOG: 'log',
  /** Emitted on an interval while a step is in flight (OBSERVABILITY.md, "`run.heartbeat`"). */
  RUN_HEARTBEAT: 'run.heartbeat',
  /** Opt-in: an operation reports progress mid-step, via the same channel as `log`. */
  STEP_PROGRESS: 'step.progress',
  /**
   * The run's main NDJSON log crossed a segment boundary. Always the first
   * line of the segment it names `live_segment` (OBSERVABILITY.md, "Event
   * kinds"; this module's own doc, "`log.rotate`").
   */
  LOG_ROTATE: 'log.rotate',
} as const;

/** The `event` discriminator of a {@link RunEvent}. */
export type RunEventKind = (typeof RUN_EVENT)[keyof typeof RUN_EVENT];

/**
 * The preflight stages a `bootstrap.error` can name.
 *
 * A closed set rather than free text, because the terminal renderer's advice
 * ("run `workspace setup`", "re-lock") is keyed by it, and because it is the one
 * field distinguishing "your document is wrong" from "your install is wrong".
 */
export const BOOTSTRAP_STAGE = {
  /** Loading/validating the workspace document. */
  WORKSPACE: 'workspace',
  /** Loading/validating the workflow document (authoring model). */
  WORKFLOW: 'workflow',
  /** Reading or validating `rawbox.lock`. */
  LOCK: 'lock',
  /** Resolving the authoring document into the runtime model. */
  RESOLVE: 'resolve',
  /** Type-checking seeds against the consuming steps' input schemas. */
  SEED_VALIDATION: 'seed-validation',
  /**
   * A `seedOverrides:` layer (the workspace's, or the CLI's `--seed`) failed
   * validation — a foreign key, a key the workflow does not seed, or a value
   * the declared strategy cannot store (`workspace/seed-overrides.ts`).
   *
   * Its own stage rather than folded into {@link BOOTSTRAP_STAGE.WORKSPACE}:
   * before `--seed` existed, an override could only come from the workspace
   * document, so tagging the failure `workspace` was accurate. Now a
   * `--seed`-only failure — no workspace `seedOverrides:` block involved at
   * all — tagged `workspace` would send an operator looking at the wrong
   * document. Distinct from {@link BOOTSTRAP_STAGE.SEED} for the same reason
   * that stage is distinct from `resolve`: the document(s) are fine, a
   * *replacement* asked for is not.
   */
  SEED_OVERRIDE: 'seed-override',
  /**
   * Constructing the box store the run will write through.
   *
   * Distinct from {@link BOOTSTRAP_STAGE.SEED} because it fails *before* a
   * store exists, not while using one: the document declares a storage strategy
   * this build has no implementation wired for (`workflow/store-support.ts`).
   * It is its own stage rather than folded into `resolve` because the document
   * resolved perfectly well — what is missing is in this binary, not in the
   * file, and that is exactly the distinction this field exists to carry
   * ("your document is wrong" versus "your install is wrong").
   */
  STORE: 'store',
  /** Writing the seeds into the box store. */
  SEED: 'seed',
} as const;

/** The `stage` of a `bootstrap.error`. */
export type BootstrapStage = (typeof BOOTSTRAP_STAGE)[keyof typeof BOOTSTRAP_STAGE];

/**
 * The `outcome` values of a `run.end` or a `step.end`.
 *
 * `interrupted` is a **run-level outcome only** (OBSERVABILITY.md, "Event kinds"):
 * it records a graceful shutdown on an operator signal (SIGTERM/SIGINT) — the
 * run was told to stop and stopped cleanly. A step never ends `interrupted`;
 * a step in flight when the run is interrupted is abandoned without a
 * `step.end` (its `step.start` followed directly by the interrupted `run.end`
 * is the honest record: the step never reported a result). An interrupted
 * `run.end` MUST NOT carry `severity` — an operator stop is intent, not an
 * alarm — which is also what keeps it out of the filtered error log
 * (`ndjson-file-sink.ts` filters on `outcome: "error"`, unchanged).
 */
export const OUTCOME = {
  OK: 'ok',
  ERROR: 'error',
  /** `run.end` only — never a `step.end` outcome. */
  INTERRUPTED: 'interrupted',
} as const;

/** A `step.end`'s `outcome`: a step either produced a result or failed. */
export const Outcome = Type.Union([
  Type.Literal(OUTCOME.OK),
  Type.Literal(OUTCOME.ERROR),
]);
export type Outcome = Static<typeof Outcome>;

/** A `run.end`'s `outcome`: the step values plus `interrupted` (see {@link OUTCOME}). */
export const RunOutcome = Type.Union([
  Type.Literal(OUTCOME.OK),
  Type.Literal(OUTCOME.ERROR),
  Type.Literal(OUTCOME.INTERRUPTED),
]);
export type RunOutcome = Static<typeof RunOutcome>;

/** Levels the built-in `observability/log` operation accepts. */
export const LogLevel = Type.Union([
  Type.Literal('debug'),
  Type.Literal('info'),
  Type.Literal('warn'),
  Type.Literal('error'),
]);
export type LogLevel = Static<typeof LogLevel>;

/**
 * The alarm classification (OBSERVABILITY.md, "`severity`"): an optional
 * envelope field, present only on the kinds documented in `event-types.ts`'s
 * module doc ("`severity`") and only when the specific event warrants it.
 * `--output quiet` and the OTel bridge's log-record severity are both driven
 * by this one field instead of each re-deriving "is this bad" from `outcome`/
 * `level` per kind.
 */
export const SEVERITY = {
  WARN: 'warn',
  ERROR: 'error',
} as const;

export const Severity = Type.Union([
  Type.Literal(SEVERITY.WARN),
  Type.Literal(SEVERITY.ERROR),
]);
export type Severity = Static<typeof Severity>;

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/**
 * The step a `step.*` (or step-scoped `log`) event is about.
 *
 * Everything an OTel child span needs is here and nowhere else: the span's name
 * (`label`, falling back to `operation`), its identity within the trace
 * (`index` + `iteration`) and its attributes (`rawbox.step.index`,
 * `rawbox.step.label`, `rawbox.plugin.name`, `rawbox.operation.path`,
 * `rawbox.registry.hash`).
 *
 * `plugin` and `operation` come from the **authoring** document, which is the
 * only place they exist — the resolved model replaces them with the
 * `(contractRegistryHash, definitionPath)` pair, and a hash is not what a human
 * or a dashboard wants to read. `registry_hash` carries the resolved half, so
 * one event pins both what was written and what actually ran.
 */
export const RunEventStep = StrictObject({
  /** Position in the workflow's `steps:` list. Stable identity; always present. */
  index: Type.Number(),
  /**
   * Which execution of this step index this is, from `0`. A step a `loop-gate`
   * jumps back to reports `0`, `1`, `2`, … on successive passes.
   */
  iteration: Type.Number(),
  /** The authored `label:`. Optional in the format, so optional here. */
  label: Type.Optional(Type.String()),
  /** The authored `plugin:` — an npm package name. */
  plugin: Type.String(),
  /** The authored `operation:` — e.g. `time/sleep`. */
  operation: Type.String(),
  /** The resolved contract-registry hash the step was bound to. */
  registry_hash: Type.String(),
});
export type RunEventStep = Static<typeof RunEventStep>;

/**
 * A failure as it appears on `run.end` and `bootstrap.error`.
 *
 * `stack` is optional and present only when the failure came from a thrown
 * `Error`; a `Result`-carried failure often has no stack, and inventing one
 * would be worse than omitting it.
 */
export const RunEventError = StrictObject({
  message: Type.String(),
  stack: Type.Optional(Type.String()),
});
export type RunEventError = Static<typeof RunEventError>;

/**
 * The envelope, shared by every kind.
 *
 * Spread into each event's own `StrictObject` rather than intersected, so the
 * key *order* of the produced JSON is the documented one and each event stays a
 * single closed object schema.
 */
const envelopeProperties = {
  /** ISO-8601 UTC instant. */
  ts: Type.String(),
  /** Correlates every event of one run; the OTel trace key. */
  run_id: Type.String(),
  /** Workspace name. Absent only on a `bootstrap.error` raised before it is known. */
  workspace: Type.Optional(Type.String()),
  /** Workflow name. Absent only on a `bootstrap.error` raised before it is known. */
  workflow: Type.Optional(Type.String()),
} as const;

// ---------------------------------------------------------------------------
// The kinds
// ---------------------------------------------------------------------------

/**
 * `run.start` — the first event of every run that gets as far as knowing what it
 * is running, and the line that declares the format of the file it opens.
 *
 * The root span `rawbox.workflow.run` opens here.
 */
export const RunStartEvent = StrictObject({
  ...envelopeProperties,
  // Re-declared as required: past this point identity is always known, and a
  // consumer keying its display off `run.start` alone must never see a gap.
  workspace: Type.String(),
  workflow: Type.String(),
  event: Type.Literal(RUN_EVENT.RUN_START),
  format: Type.Literal(RUN_EVENT_FORMAT),
});
export type RunStartEvent = Static<typeof RunStartEvent>;

/**
 * `run.end` — the last event of every run, emitted on the success and the
 * failure path alike, so "the file ends without one" means "the process died",
 * not "the run failed".
 *
 * `steps_total` counts **step executions**, not distinct steps: a looping
 * workflow reports the work it did. `steps_failed` counts executions that ended
 * `outcome: "error"`.
 *
 * `outcome: "interrupted"` is the graceful-shutdown record (see {@link OUTCOME}):
 * an operator signal stopped the run, it concluded cleanly, and this event —
 * with `duration_ms` and the step counts as usual, but never `severity` and
 * never `error` — is still the stream's final line. A SIGKILLed run, by
 * contrast, writes nothing; the run registry's crash detection is what reports
 * that case (OBSERVABILITY.md, "Lifecycle and crash detection").
 *
 * `timed_out`/`timeout_ms` say that the run ended because **a runner bound
 * expired**, and carry which bound. They follow `step.end`'s pair exactly:
 * emitted together or not at all, `timed_out` is `true` or absent, and
 * `outcome` stays `"error"` so nothing that already counts failures loses one.
 * Two bounds can put them here, and the stream itself says which:
 *
 * - a **bounded step** — there is a `step.end` carrying the same pair, and this
 *   event repeats it so a reader holding only the run's conclusion still knows
 *   the run was stopped rather than broken;
 * - the **preflight bound** (`RunWorkflowOptions.preflightTimeoutMs`) — a step
 *   definition's module never finished importing, so there is no `step.start`
 *   and no `step.end` at all. This event is then the *only* record of the
 *   timeout, which is precisely why the pair had to exist on `run.end`: without
 *   it, "your plugin hung at import" and "your plugin failed to import" are the
 *   same error-outcome `run.end` with different prose, and they have different
 *   remedies.
 */
export const RunEndEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.RUN_END),
  outcome: RunOutcome,
  /** Wall-clock milliseconds from `run.start` to here. */
  duration_ms: Type.Number(),
  /** Step executions that produced a `step.end`. */
  steps_total: Type.Number(),
  /** How many of those ended `outcome: "error"`. */
  steps_failed: Type.Number(),
  /**
   * Present, and only ever `true`, when a runner bound is what ended this run.
   * Always accompanied by {@link timeout_ms}, and always with
   * `outcome: "error"`.
   */
  timed_out: Type.Optional(Type.Literal(true)),
  /**
   * The bound that expired, in milliseconds — the step's effective `timeoutMs`
   * or the effective preflight bound, never the elapsed time (`duration_ms` is
   * that, and covers the whole run rather than the wait that expired).
   */
  timeout_ms: Type.Optional(Type.Number()),
  /** Present exactly when `outcome` is `"error"`. */
  error: Type.Optional(RunEventError),
  /** `"error"` exactly when `outcome` is `"error"`; absent on success. */
  severity: Type.Optional(Type.Literal(SEVERITY.ERROR)),
});
export type RunEndEvent = Static<typeof RunEndEvent>;

/**
 * `step.start` — the handler is about to run. Opens the step's child span; the
 * `duration_ms` on the matching `step.end` is measured from this event's
 * production.
 *
 * `input` is the record the machine read out of storage for this execution —
 * the same values the handler receives. See {@link StepEndEvent} for why the two
 * records are on the events at all.
 */
export const StepStartEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.STEP_START),
  step: RunEventStep,
  /** The input record read out of storage for this execution. See {@link StepEndEvent}. */
  input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type StepStartEvent = Static<typeof StepStartEvent>;

/**
 * `step.end` — the handler produced a result. Closes the child span opened by
 * the `step.start` sharing this event's `(run_id, step.index, step.iteration)`.
 *
 * `error` is the step's **error record**: the shape the contract's `errorSchema`
 * describes when a handler failed logically, or `{ message, stack? }` when the
 * step itself threw. It is a record rather than a fixed object precisely because
 * its shape is the plugin's to declare.
 *
 * `output` carries the handler's output record, as `step.start`'s `input`
 * carries what it read. The pair is what makes the NDJSON file a *debugging*
 * artifact rather than a timing report — the state dumps this format replaces
 * carried both, and "which value did this step actually see?" is the first
 * question anyone asks of a run that misbehaved. Both are optional, so a
 * control-flow step's `{ label }`, a step with no bindings, and a failed step's
 * absence of output are all representable. Consumers that only want shape (the
 * terminal renderer at default verbosity, the OTel span) ignore them; values are
 * bounded by their keys' `valueSizeMax`, so they cannot grow without the author
 * having declared room for them.
 *
 * `timed_out`/`timeout_ms` record the one failure the *runner* caused rather
 * than observed: a **bounded step** whose `timeoutMs` expired while the handler
 * was still running. `outcome` stays `"error"` — a timeout is a run-terminating
 * failure and belongs in every failure path a reader already has — and the two
 * fields sit beside it as the refinement, never as a replacement for it. They
 * are emitted together or not at all, and `timed_out` is `true` or absent:
 * `false` is unrepresentable on purpose, exactly as it is for `severity` and
 * `output`, so "not a timeout" has one spelling instead of two.
 */
export const StepEndEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.STEP_END),
  step: RunEventStep,
  outcome: Outcome,
  /** Wall-clock milliseconds since the matching `step.start`. */
  duration_ms: Type.Number(),
  /**
   * Present, and only ever `true`, when this step's bound expired. Always
   * accompanied by {@link timeout_ms}, and always with `outcome: "error"`.
   */
  timed_out: Type.Optional(Type.Literal(true)),
  /**
   * The bound that expired, in milliseconds — the step's effective `timeoutMs`,
   * not the elapsed time (`duration_ms` is that, and is `>= timeout_ms` because
   * the runner arms the bound before the definition load rather than at the
   * handler call).
   */
  timeout_ms: Type.Optional(Type.Number()),
  /** The handler's output record, when it produced one. */
  output: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** Present exactly when `outcome` is `"error"`. */
  error: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  /** `"error"` exactly when `outcome` is `"error"`; absent on success. */
  severity: Type.Optional(Type.Literal(SEVERITY.ERROR)),
});
export type StepEndEvent = Static<typeof StepEndEvent>;

/**
 * `storage.seed` — **one** event summarising the whole seeding pass, not one per
 * seed.
 *
 * Three reasons it is a summary:
 *
 * 1. **Seeding is one transaction.** Every seed commits or none does, so
 *    per-seed events would advertise a granularity the operation does not have —
 *    there is no state in which seed 3 succeeded and seed 4 did not.
 * 2. **A seed is not one document entry.** The resolver expands an `lmdb-fifo`
 *    seed into one `Seed` per list element, so a 1000-element queue seed would
 *    emit 1000 events describing a single authored line.
 * 3. **It maps to one span event.** In OTel this is an event on the root span
 *    ("the store was primed"), which is what a trace reader wants; a thousand
 *    span events is noise.
 *
 * `key_count` is distinct keys, `seed_count` is writes performed — they differ
 * exactly by FIFO expansion, which makes the expansion visible without listing
 * it.
 */
export const StorageSeedEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.STORAGE_SEED),
  /** `putSync` calls performed — one per resolved `Seed`. */
  seed_count: Type.Number(),
  /** Distinct storage keys written. */
  key_count: Type.Number(),
  /** Those keys, in document order. Keys are ≤ 79 bytes, so the list stays small. */
  keys: Type.Array(Type.String()),
  /** Wall-clock milliseconds the seeding transaction took. */
  duration_ms: Type.Number(),
});
export type StorageSeedEvent = Static<typeof StorageSeedEvent>;

/**
 * One key `seed.override.applied` reports: the key, and the source that
 * supplied the value written for it — a workspace's `seedOverrides:` block
 * (its document path) or the CLI's `--seed` flag.
 *
 * No `value` field. See `workspace/seed-overrides.ts`'s
 * `summarizeAppliedSeedOverrides` for why the value is deliberately left out
 * of what this event — and therefore the NDJSON log on disk — carries.
 */
export const SeedOverrideAppliedEntry = StrictObject({
  key: Type.String(),
  source: Type.String(),
});
export type SeedOverrideAppliedEntry = Static<typeof SeedOverrideAppliedEntry>;

/**
 * `seed.override.applied` — every seed a workspace `seedOverrides:` block or
 * the CLI's `--seed` flag replaced before this run's seeding pass wrote it,
 * one event per run.
 *
 * `storage.seed`'s neighbour and shaped like it on purpose — a `keys` list,
 * one summary per run rather than one event per key — but reporting a
 * different fact: `storage.seed` says *that* these keys were written and how
 * many writes it took; this event says *which* of them did not carry the
 * workflow's own authored value, and *whose* value they carried instead. The
 * two are emitted at different points for the same reason they say different
 * things: `storage.seed` fires *after* the seeding transaction commits, once
 * the writes are real; this one fires as soon as the run's identity is known,
 * because reporting an override is not conditional on the store existing yet
 * — see `run-workflow.ts`'s call site.
 *
 * Emitted only when `overrides` would be non-empty: a run replacing nothing
 * emits nothing, so a log with no overrides reads exactly as it did before
 * this event existed. This is the load-bearing half of the whole feature's
 * reviewability story (see `--seed`'s own `--help` text and
 * `workspace/seed-overrides.ts`'s module doc): the CLI layer has no file, no
 * diff and no `rawbox.lock` entry, so this event — and the identical report
 * `workflow verify` prints before a run ever starts — is the only place an
 * override made from the command line is visible at all.
 */
export const SeedOverrideAppliedEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.SEED_OVERRIDE_APPLIED),
  overrides: Type.Array(SeedOverrideAppliedEntry),
});
export type SeedOverrideAppliedEvent = Static<typeof SeedOverrideAppliedEvent>;

/**
 * `bootstrap.error` — a preflight stage failed and the machine never started.
 *
 * Replaces the ad-hoc `[Bootstrap Error] …` string the runner used to append to
 * the error log, which was a third format nothing could parse. `stage` says
 * which preflight stage failed; `message` is the same multi-line diagnostic the
 * function returns to its caller, unabridged.
 *
 * This is the one kind whose `workspace`/`workflow` may be missing: the two
 * earliest stages are what discover them.
 *
 * Always carries `severity: "error"` — a preflight failure is unconditionally
 * an alarm, unlike `step.end`/`run.end`/`log`, whose severity depends on how
 * they turned out.
 */
export const BootstrapErrorEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.BOOTSTRAP_ERROR),
  stage: Type.Union([
    Type.Literal(BOOTSTRAP_STAGE.WORKSPACE),
    Type.Literal(BOOTSTRAP_STAGE.WORKFLOW),
    Type.Literal(BOOTSTRAP_STAGE.LOCK),
    Type.Literal(BOOTSTRAP_STAGE.RESOLVE),
    Type.Literal(BOOTSTRAP_STAGE.SEED_VALIDATION),
    Type.Literal(BOOTSTRAP_STAGE.SEED_OVERRIDE),
    Type.Literal(BOOTSTRAP_STAGE.STORE),
    Type.Literal(BOOTSTRAP_STAGE.SEED),
  ]),
  message: Type.String(),
  severity: Type.Literal(SEVERITY.ERROR),
});
export type BootstrapErrorEvent = Static<typeof BootstrapErrorEvent>;

/**
 * `log` — a line a *workflow author* asked for, via the built-in
 * `observability/log` operation.
 *
 * It shares the envelope with everything else so workflow-authored logs land in
 * the same stream, the same file and the same exporter as runner-authored
 * events, and the OTel bridge turns it into a log record correlated to the
 * active step's span — no special case for the plugin that emitted it, only for
 * this event kind, which the runner owns (README, "Where workflow-authored `log` lines come from").
 *
 * `step` is the step that was executing when the line was produced. It is
 * optional because the channel is ambient: a definition could emit outside a
 * step, and a record with no step is better than a wrong one.
 *
 * `severity` inherits from `level`: `error` → `"error"`, `warn` → `"warn"`,
 * `info`/`debug` → absent. It is redundant with `level` by construction —
 * `level` is the source of truth, `severity` is the projection of it that a
 * generic consumer (`--output quiet`, the OTel bridge) can key on without
 * knowing this kind's own vocabulary.
 */
export const LogEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.LOG),
  level: LogLevel,
  message: Type.String(),
  /** The operation's optional `data` payload, verbatim. */
  data: Type.Optional(Type.Unknown()),
  /** The step in flight when the line was emitted. */
  step: Type.Optional(RunEventStep),
  /** Projected from `level`; see the kind's own doc. */
  severity: Type.Optional(Severity),
});
export type LogEvent = Static<typeof LogEvent>;

/**
 * `run.heartbeat` — emitted on a configurable interval while a step is in
 * flight, so a workflow blocked in a long step (a websocket feed waiting for a
 * tick) is distinguishable from a hung process
 * (OBSERVABILITY.md, "`run.heartbeat`").
 *
 * `step` is the same shape `step.start` carries for the step currently
 * running — a consumer that only reads `step.start`/`step.end` already knows
 * how to render it. `in_flight_ms` is wall-clock time since that step's
 * `step.start`, measured the same way `step.end`'s own `duration_ms` is.
 *
 * The producer starts this timer when a step begins and stops it the instant
 * that step ends, so a heartbeat can **never** fire between steps or after
 * `run.end` — there is no state in which one would be misleading. It carries
 * no `severity`: a heartbeat is evidence of life, never an alarm.
 */
export const RunHeartbeatEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.RUN_HEARTBEAT),
  step: RunEventStep,
  /** Wall-clock milliseconds since this step's `step.start`. */
  in_flight_ms: Type.Number(),
});
export type RunHeartbeatEvent = Static<typeof RunHeartbeatEvent>;

/**
 * `step.progress` — opt-in: an operation reports what it is doing partway
 * through a long step, via the same ambient run-event channel `log` uses
 * (`@rawbox/plugin`'s `emitRunEvent`, OBSERVABILITY.md, "Event kinds").
 *
 * Validated and stamped identically to `log` (see `producer.ts`): the runner
 * recognises the event kind, not the plugin that sent it, stamps the envelope
 * and the step correlation itself, and drops a malformed payload rather than
 * writing it. `message` is optional — unlike `log`, a progress line may carry
 * only `data` (e.g. `{ processed: 4200, total: 10000 }`) with nothing to say
 * in words. Carries no `severity`: progress is informational by definition.
 */
export const StepProgressEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.STEP_PROGRESS),
  message: Type.Optional(Type.String()),
  /** The operation's optional `data` payload, verbatim. */
  data: Type.Optional(Type.Unknown()),
  /** The step in flight when progress was reported. */
  step: Type.Optional(RunEventStep),
});
export type StepProgressEvent = Static<typeof StepProgressEvent>;

/**
 * `log.rotate` — the run's **main** NDJSON log crossed a segment boundary.
 * See this module's own doc, "`log.rotate`", for the full account; the
 * summary of each field:
 *
 * - `sealed_segment` / `live_segment` — the segment just closed and the
 *   segment this event is the first line of. Reconstructing "what happened"
 *   needs both: a reader holding only `live_segment` cannot tell a first-ever
 *   roll from the fifth.
 * - `deleted_segment` — present exactly when a segment was actually unlinked
 *   to honour `rotate.maxFiles`. Absent when the roll kept every prior
 *   segment (or when the one unlink attempt failed — `ndjson-file-sink.ts`
 *   reports that on `console.error` and leaves this field off rather than
 *   claiming a removal that did not happen). This is the field the kind
 *   exists for: it turns a silent gap at the low end of a run's segments into
 *   a recorded one.
 * - `max_bytes` / `max_files` — the `rotate` bounds in force for this segment
 *   sequence, so a reader never has to cross-reference the workspace document
 *   to know the policy that produced the roll.
 *
 * Never emitted for the filtered error log's own, independent rotation — see
 * this module's doc.
 */
export const LogRotateEvent = StrictObject({
  ...envelopeProperties,
  event: Type.Literal(RUN_EVENT.LOG_ROTATE),
  /** The segment that was just sealed — complete, immutable, never appended to again. */
  sealed_segment: Type.Number(),
  /** The segment now live. This event is that segment's first line, by construction. */
  live_segment: Type.Number(),
  /**
   * The segment unlinked to honour `rotate.maxFiles`, when the unlink
   * succeeded. Absent on a roll that retired nothing, and absent (rather than
   * fabricated) when retirement was attempted but failed.
   */
  deleted_segment: Type.Optional(Type.Number()),
  /** `rotate.maxBytes` in force for this segment sequence. */
  max_bytes: Type.Number(),
  /** `rotate.maxFiles` in force for this segment sequence. */
  max_files: Type.Number(),
  /** `"warn"` exactly when `deleted_segment` is present; absent otherwise. */
  severity: Type.Optional(Type.Literal(SEVERITY.WARN)),
});
export type LogRotateEvent = Static<typeof LogRotateEvent>;

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

/** One line of the NDJSON log; one item of the event stream. */
export const RunEvent = Type.Union([
  RunStartEvent,
  RunEndEvent,
  StepStartEvent,
  StepEndEvent,
  StorageSeedEvent,
  SeedOverrideAppliedEvent,
  BootstrapErrorEvent,
  LogEvent,
  RunHeartbeatEvent,
  StepProgressEvent,
  LogRotateEvent,
]);
export type RunEvent = Static<typeof RunEvent>;

/**
 * Compiled validator for the whole union.
 *
 * Exported because the format is a contract with consumers outside this package
 * — a renderer, an exporter, a test — and they should be able to check a line
 * they read rather than trusting the writer.
 */
export const RunEventValidator = Compile(RunEvent);
