/**
 * The OpenTelemetry bridge — the third sink of the run-event stream
 * (README, "OpenTelemetry").
 *
 * This module is **API-only**: it imports `@opentelemetry/api` and
 * `@opentelemetry/api-logs`, never an SDK. Both packages are no-ops until some
 * *other* code registers a provider, so a user who has never heard of OTel pays
 * for two tiny dependency trees and a handful of calls into no-op objects. The
 * SDK wiring — exporters, resources, `OTEL_EXPORTER_OTLP_*` — lives in
 * `@rawbox/cli` and is imported only when `--otel` (or the standard endpoint
 * env vars) activates it (README, "Turning it on").
 *
 * ## The mapping
 *
 * It is mechanical, because the event envelope was designed against the span
 * model in the first place (`event-types.ts`, "Kinds"):
 *
 * | Event | OTel |
 * | --- | --- |
 * | `run.start` | Root span `rawbox.workflow.run` opens, at the event's `ts` |
 * | `run.end` | Root span closes; status from `outcome` (`interrupted` leaves it UNSET — neither OK nor ERROR would be honest); `rawbox.run.count` counter |
 * | `step.start` | Child span opens, named by the step's label |
 * | `step.end` | That child closes; status from `outcome`; `rawbox.step.duration` histogram; a timed-out step adds `rawbox.step.timed_out` and is grouped under its own `error.type` |
 * | `storage.seed` | Span event on the root span |
 * | `bootstrap.error` | Exception event on the root span — or a log record, when the failure predates `run.start` |
 * | `log` | Log record, correlated to the span of the step in flight |
 * | `run.heartbeat` | Span event `run.heartbeat` on the in-flight step's span |
 * | `step.progress` | Span event `step.progress` on the in-flight step's span |
 * | `log.rotate` | Span event `log.rotate` on the root span |
 *
 * Every kind the runner produces is bridged; a kind this module does not know
 * is ignored rather than guessed at, so adding an event kind can never break an
 * exporter.
 *
 * ## `severity`
 *
 * Every log record this bridge emits derives its `severityNumber` from the
 * event's own alarm classification rather than a hardcoded literal: `log`
 * from `level` (the finer-grained source `severity` itself is projected
 * from), `bootstrap.error` from its `severity` field, which is always
 * `"error"`. Span *status* is unaffected — it was already driven by `outcome`
 * before `severity` existed, and stays that way: a `step.end`/`run.end` whose
 * `outcome` is `"error"` never produces an *additional* log record just
 * because it also carries `severity: "error"`, it only sets the span's status
 * as it always has.
 *
 * ## Timestamps
 *
 * Spans are opened and closed with **explicit** start/end times taken from the
 * event's `ts`, never with "now". A run's NDJSON file and its trace are then
 * two renderings of one set of instants: a step whose file line says it took
 * 502 ms shows 502 ms in Jaeger, regardless of how long the exporter, the sink
 * fan-out, or a slow terminal renderer sat between the two.
 *
 * ## Identity and pairing
 *
 * A child span is keyed by `(step.index, step.iteration)` — the same triple
 * (with `run_id`) that identifies a `step.start`/`step.end` pair. Loop
 * iterations therefore become *sibling* spans sharing a label and separated by
 * `rawbox.step.iteration`, which is what lets a backend group them
 * (README, "The `rawbox.*` attribute namespace").
 *
 * ## Not here (yet)
 *
 * Context propagation *into* plugin handlers is deliberately not built yet
 * (README, "Not built (yet)"): an HTTP-calling plugin does not yet join the trace. See the
 * design note on {@link OtelSinkState.stepContextByKey} for exactly where
 * that door is.
 */

import {
  SpanStatusCode,
  ValueType,
  context as otelContext,
  metrics as otelMetrics,
  trace as otelTrace,
  type Attributes,
  type Context,
  type Histogram,
  type Counter,
  type Meter,
  type Span,
  type TimeInput,
  type Tracer,
} from '@opentelemetry/api';
import { SeverityNumber, logs as otelLogs, type Logger } from '@opentelemetry/api-logs';

import {
  OUTCOME,
  RUN_EVENT,
  type BootstrapErrorEvent,
  type LogEvent,
  type LogLevel,
  type LogRotateEvent,
  type RunEndEvent,
  type RunEvent,
  type RunEventStep,
  type RunHeartbeatEvent,
  type RunStartEvent,
  type SeedOverrideAppliedEvent,
  type Severity,
  type StepEndEvent,
  type StepProgressEvent,
  type StepStartEvent,
  type StorageSeedEvent,
} from './event-types.js';
import type { RunEventSink } from './sink.js';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * The instrumentation scope every span, log record and metric this bridge
 * produces is attributed to. Backends group by it, so it is the package name
 * rather than anything friendlier.
 */
export const OTEL_INSTRUMENTATION_SCOPE = '@rawbox/runner';

/**
 * The scope's version.
 *
 * A literal rather than a read of `package.json`: this module must stay
 * importable from `dist/` without shipping a JSON import or a resolver hop, and
 * the value only ever changes when the package's own version does.
 */
export const OTEL_INSTRUMENTATION_VERSION = '0.0.1';

/** The root span's name — one per run (README, "The mapping"). */
export const RUN_SPAN_NAME = 'rawbox.workflow.run';

/**
 * The `rawbox.*` attribute namespace (README, "The `rawbox.*` attribute namespace").
 *
 * There is no OTel semantic convention for workflow engines, so a small,
 * documented, *closed* namespace is the correct move — the same one Temporal's
 * and Airflow's integrations make. Exported so the CLI's docs, a dashboard, or
 * a consumer's query can name these without re-typing the strings.
 *
 * Conventional attributes are used where they exist: `error.type` on a failing
 * span, and the `exception.*` set that `Span.recordException` writes.
 */
export const OTEL_ATTRIBUTE = {
  /** The run's correlation id — the same `run_id` on every NDJSON line. */
  RUN_ID: 'rawbox.run.id',
  /** Workspace name. */
  WORKSPACE_NAME: 'rawbox.workspace.name',
  /** Workflow name. */
  WORKFLOW_NAME: 'rawbox.workflow.name',
  /** `ok` / `error` / `interrupted`, on the root span and the run counter. */
  RUN_OUTCOME: 'rawbox.run.outcome',
  /** Step executions the run performed. */
  RUN_STEPS_TOTAL: 'rawbox.run.steps.total',
  /** How many of those failed. */
  RUN_STEPS_FAILED: 'rawbox.run.steps.failed',
  /** The authored `label:`, falling back to `step-<index>`. */
  STEP_LABEL: 'rawbox.step.label',
  /** Position in the workflow's `steps:` list. */
  STEP_INDEX: 'rawbox.step.index',
  /** Which execution of that index this span is, from `0`. */
  STEP_ITERATION: 'rawbox.step.iteration',
  /** `ok` / `error`, on the child span and the duration histogram. */
  STEP_OUTCOME: 'rawbox.step.outcome',
  /**
   * `true` on a step whose bound expired — a **bounded step** the runner
   * stopped waiting for. An attribute rather than an outcome value for the
   * reason `event-types.ts` gives: the span's status and `rawbox.step.outcome`
   * stay `error`, so every existing failure query still finds it, and this
   * refines rather than replaces them. Absent on every other step.
   */
  STEP_TIMED_OUT: 'rawbox.step.timed_out',
  /** The authored `plugin:` — an npm package name. */
  PLUGIN_NAME: 'rawbox.plugin.name',
  /** The authored `operation:` — e.g. `time/sleep`. */
  OPERATION_PATH: 'rawbox.operation.path',
  /** The resolved contract-registry hash the step was bound to. */
  REGISTRY_HASH: 'rawbox.registry.hash',
  /** Which preflight stage a `bootstrap.error` failed in. */
  BOOTSTRAP_STAGE: 'rawbox.bootstrap.stage',
  /** `putSync` calls the seeding transaction performed. */
  SEED_COUNT: 'rawbox.seed.count',
  /** Distinct storage keys it wrote. */
  SEED_KEY_COUNT: 'rawbox.seed.key_count',
  /** Those keys, in document order. */
  SEED_KEYS: 'rawbox.seed.keys',
  /** Keys a `seedOverrides:`/`--seed` layer replaced, index-aligned with `SEED_OVERRIDE_SOURCES`. */
  SEED_OVERRIDE_KEYS: 'rawbox.seed_override.keys',
  /** Each key's source layer, index-aligned with `SEED_OVERRIDE_KEYS`. No values — see `event-types.ts`. */
  SEED_OVERRIDE_SOURCES: 'rawbox.seed_override.sources',
  /** The event's own `duration_ms`, mirrored so a span event carries it too. */
  DURATION_MS: 'rawbox.duration_ms',
  /** A failed step's error record, JSON-encoded — the shape is the plugin's to declare. */
  ERROR_RECORD: 'rawbox.error.record',
  /** The workflow-authored `log` level, on its log record. */
  LOG_LEVEL: 'rawbox.log.level',
  /** The segment `log.rotate` says was just sealed. */
  LOG_ROTATE_SEALED_SEGMENT: 'rawbox.log_rotate.sealed_segment',
  /** The segment `log.rotate` says is now live — the one it is the first line of. */
  LOG_ROTATE_LIVE_SEGMENT: 'rawbox.log_rotate.live_segment',
  /** The segment `log.rotate` says was unlinked to honour `maxFiles`, when one was. */
  LOG_ROTATE_DELETED_SEGMENT: 'rawbox.log_rotate.deleted_segment',
  /** `rotate.maxBytes` in force for the segment sequence `log.rotate` describes. */
  LOG_ROTATE_MAX_BYTES: 'rawbox.log_rotate.max_bytes',
  /** `rotate.maxFiles` in force for the segment sequence `log.rotate` describes. */
  LOG_ROTATE_MAX_FILES: 'rawbox.log_rotate.max_files',
} as const;

/** OTel's own conventional attribute for "what kind of error was this". */
const ATTRIBUTE_ERROR_TYPE = 'error.type';

/** `error.type` values, one per site a failure can be recorded from. */
const ERROR_TYPE = {
  RUN: 'rawbox.run.error',
  STEP: 'rawbox.step.error',
  BOOTSTRAP: 'rawbox.bootstrap.error',
  /**
   * A bounded step's bound expired. Distinct from {@link ERROR_TYPE.STEP}
   * because `error.type` is the conventional field a backend groups failures
   * by, and "the run was stopped waiting" is a different class of incident from
   * "the step reported a failure" — the first points at a dependency, the
   * second at the workflow.
   */
  TIMEOUT: 'rawbox.step.timeout',
} as const;

/** The two instruments the bridge exports — deliberately no others (README, "The `rawbox.*` attribute namespace"). */
export const OTEL_METRIC = {
  /** Histogram of step-execution wall-clock durations, in milliseconds. */
  STEP_DURATION: 'rawbox.step.duration',
  /** Counter of finished runs. */
  RUN_COUNT: 'rawbox.run.count',
} as const;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * What {@link createOtelSink} accepts. Every field is optional: the default is
 * "take it from the `@opentelemetry/api` globals", which is exactly the
 * arrangement that makes the whole bridge free when no SDK is registered.
 */
export interface OtelSinkOptions {
  /**
   * Where spans go. Defaults to `trace.getTracer(OTEL_INSTRUMENTATION_SCOPE)`.
   *
   * The API's global tracer is a *proxy*: fetching it before an SDK is
   * registered is safe, because it re-delegates the moment one appears.
   */
  tracer?: Tracer;
  /**
   * Where log records go. Defaults to `logs.getLogger(OTEL_INSTRUMENTATION_SCOPE)`,
   * which is likewise a proxy and likewise late-binding.
   */
  logger?: Logger;
  /**
   * Where metrics go. Unlike the other two, the metrics API has **no** proxy
   * provider — `metrics.getMeter()` resolves against whatever provider is
   * registered *at that instant*. So this is resolved lazily, on the first
   * measurement rather than at construction, which is after the CLI has
   * started its SDK. Passing one explicitly skips the question entirely.
   */
  meter?: Meter;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** A step's span name and `rawbox.step.label`: the authored label, or `step-<index>`. */
function stepLabel(step: RunEventStep): string {
  return step.label ?? `step-${step.index}`;
}

/** The map key that pairs a `step.start` with its `step.end` (and any `log` between them). */
function stepKey(step: RunEventStep): string {
  return `${step.index}:${step.iteration}`;
}

/**
 * An event's `ts` as an OTel {@link TimeInput}.
 *
 * `Date` rather than a number so the API does its own hrtime conversion; an
 * unparseable `ts` (which the schema makes impossible, but a hand-fed sink does
 * not) falls back to "now" rather than producing an `Invalid Date` span that no
 * backend can place.
 */
function eventTime(isoTimestamp: string): TimeInput {
  const parsed = Date.parse(isoTimestamp);
  return Number.isNaN(parsed) ? new Date() : new Date(parsed);
}

/** Every attribute a step's span, and its duration measurement, are tagged with. */
function stepAttributes(step: RunEventStep): Attributes {
  return {
    [OTEL_ATTRIBUTE.STEP_LABEL]: stepLabel(step),
    [OTEL_ATTRIBUTE.STEP_INDEX]: step.index,
    [OTEL_ATTRIBUTE.STEP_ITERATION]: step.iteration,
    [OTEL_ATTRIBUTE.PLUGIN_NAME]: step.plugin,
    [OTEL_ATTRIBUTE.OPERATION_PATH]: step.operation,
    [OTEL_ATTRIBUTE.REGISTRY_HASH]: step.registry_hash,
  };
}

/**
 * The human-readable message inside a failure, whatever shape it arrived in.
 *
 * A `step.end`'s `error` is a `Record<string, unknown>` the *plugin's*
 * `errorSchema` describes, so `message` is a convention rather than a
 * guarantee; `run.end`/`bootstrap.error` carry the runner's own
 * `{ message, stack? }`. Both are probed, and an unrecognisable record is
 * JSON-encoded rather than stringified to `[object Object]`.
 */
function errorMessageOf(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error !== null && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
    const encoded = encodeRecord(error);
    if (encoded !== undefined) {
      return encoded;
    }
  }
  return String(error);
}

/** A failure's `stack`, when it came from a thrown `Error` and kept one. */
function errorStackOf(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object') {
    const stack = (error as { stack?: unknown }).stack;
    if (typeof stack === 'string') {
      return stack;
    }
  }
  return undefined;
}

/**
 * JSON for an attribute value, or `undefined` when the value cannot be encoded.
 *
 * A plugin's error record is arbitrary data, so encoding it can throw (a
 * circular structure, a `BigInt`) — the same hazard `ndjson-file-sink.ts`
 * guards, with the same answer: drop the one attribute rather than let a log
 * destination fail a run.
 */
function encodeRecord(value: unknown): string | undefined {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === 'string' ? encoded : undefined;
  } catch {
    return undefined;
  }
}

/** The `log` event's level as an OTel severity. */
function severityOf(level: LogLevel): SeverityNumber {
  switch (level) {
    case 'debug':
      return SeverityNumber.DEBUG;
    case 'warn':
      return SeverityNumber.WARN;
    case 'error':
      return SeverityNumber.ERROR;
    case 'info':
    default:
      return SeverityNumber.INFO;
  }
}

/**
 * The envelope's `severity` field as an OTel severity — the coarser, two-
 * value counterpart to {@link severityOf}, used by the one log-record site
 * (`bootstrap.error`) whose event carries `severity` but no `level`.
 */
function severityNumberOf(severity: Severity): SeverityNumber {
  return severity === 'error' ? SeverityNumber.ERROR : SeverityNumber.WARN;
}

/**
 * Marks a span failed: conventional status, conventional `exception` event,
 * conventional `error.type`, plus the raw record under
 * {@link OTEL_ATTRIBUTE.ERROR_RECORD} so nothing the plugin declared is lost on
 * the way to the backend.
 *
 * `recordException` is given the event's own timestamp, like every other
 * instant this module writes.
 */
function recordFailure(
  span: Span,
  error: unknown,
  errorType: string,
  time: TimeInput,
): void {
  const message = errorMessageOf(error);
  const stack = errorStackOf(error);

  span.setStatus({ code: SpanStatusCode.ERROR, message });
  span.setAttribute(ATTRIBUTE_ERROR_TYPE, errorType);
  span.recordException(
    {
      name: errorType,
      message,
      ...(stack !== undefined ? { stack } : {}),
    },
    time,
  );

  if (error !== undefined && error !== null && typeof error === 'object') {
    const encoded = encodeRecord(error);
    if (encoded !== undefined) {
      span.setAttribute(OTEL_ATTRIBUTE.ERROR_RECORD, encoded);
    }
  }
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/**
 * The mutable per-run state the sink threads between events.
 *
 * Kept as a named type purely so the propagation design note below has
 * somewhere to live that a reader will actually pass through.
 */
interface OtelSinkState {
  /** The root span, from `run.start` until `run.end`. */
  rootSpan: Span | undefined;
  /** A {@link Context} carrying {@link rootSpan}, the parent of every child span. */
  rootContext: Context | undefined;
  /** Open child spans, keyed by {@link stepKey}. */
  stepSpanByKey: Map<string, Span>;
  /**
   * A {@link Context} per open child span, so a `log` event emitted mid-step
   * can be correlated to that step's span rather than to the run.
   *
   * **Design note — context propagation into plugin handlers.** This map is the
   * hook deliberately designed but not yet walked through (README, "Not built (yet)"). A
   * future extension makes the handler signature carry the active span
   * context so an HTTP-calling plugin joins the trace; it would read the entry
   * for the step in flight (or, more likely, the *producer* would run the
   * handler inside `context.with(...)` and this sink would keep translating
   * events as it does now). Nothing here needs to change for that to happen —
   * which is the point of noting it rather than building it.
   */
  stepContextByKey: Map<string, Context>;
  /** Run identity, captured on `run.start` and reused by the metrics. */
  workflowName: string | undefined;
}

/**
 * Builds the OTel bridge sink.
 *
 * Registered like any other sink, via `runWorkflowInstance`'s
 * `options.sinkList`. With no SDK registered every call below lands on a no-op
 * span, a no-op logger and a no-op instrument: no allocation that matters, no
 * I/O, no exporter, and — importantly — no throw. That is what makes it safe
 * for an embedder to register unconditionally.
 *
 * @param options - See {@link OtelSinkOptions}. Omit it entirely to use the
 *   `@opentelemetry/api` globals.
 */
export function createOtelSink(options: OtelSinkOptions = {}): RunEventSink {
  const tracer =
    options.tracer ??
    otelTrace.getTracer(OTEL_INSTRUMENTATION_SCOPE, OTEL_INSTRUMENTATION_VERSION);
  const logger =
    options.logger ??
    otelLogs.getLogger(OTEL_INSTRUMENTATION_SCOPE, OTEL_INSTRUMENTATION_VERSION);

  const state: OtelSinkState = {
    rootSpan: undefined,
    rootContext: undefined,
    stepSpanByKey: new Map(),
    stepContextByKey: new Map(),
    workflowName: undefined,
  };

  // Lazily resolved — see {@link OtelSinkOptions.meter}.
  let meter: Meter | undefined = options.meter;
  let stepDuration: Histogram | undefined;
  let runCount: Counter | undefined;

  function getMeter(): Meter {
    meter ??= otelMetrics.getMeter(
      OTEL_INSTRUMENTATION_SCOPE,
      OTEL_INSTRUMENTATION_VERSION,
    );
    return meter;
  }

  function getStepDuration(): Histogram {
    stepDuration ??= getMeter().createHistogram(OTEL_METRIC.STEP_DURATION, {
      description: 'Wall-clock duration of one step execution.',
      unit: 'ms',
      valueType: ValueType.DOUBLE,
    });
    return stepDuration;
  }

  function getRunCount(): Counter {
    runCount ??= getMeter().createCounter(OTEL_METRIC.RUN_COUNT, {
      description: 'Workflow runs that reached a run.end event.',
      unit: '{run}',
      valueType: ValueType.INT,
    });
    return runCount;
  }

  /** The parent context for a child span: the root's, or the ambient one pre-`run.start`. */
  function parentContext(): Context {
    return state.rootContext ?? otelContext.active();
  }

  // -- run.start -------------------------------------------------------------
  function onRunStart(event: RunStartEvent): void {
    state.workflowName = event.workflow;
    // `context.active()` rather than `ROOT_CONTEXT`: an embedder that already
    // has a span open — a scheduler running workflows inside its own trace —
    // gets the run nested under it for free, and a plain CLI run (no context
    // manager, no active span) starts a fresh trace either way.
    const span = tracer.startSpan(
      RUN_SPAN_NAME,
      {
        startTime: eventTime(event.ts),
        attributes: {
          [OTEL_ATTRIBUTE.RUN_ID]: event.run_id,
          [OTEL_ATTRIBUTE.WORKSPACE_NAME]: event.workspace,
          [OTEL_ATTRIBUTE.WORKFLOW_NAME]: event.workflow,
        },
      },
      otelContext.active(),
    );
    state.rootSpan = span;
    state.rootContext = otelTrace.setSpan(otelContext.active(), span);
  }

  // -- run.end ---------------------------------------------------------------
  function onRunEnd(event: RunEndEvent): void {
    const time = eventTime(event.ts);
    const workflowName = event.workflow ?? state.workflowName;

    getRunCount().add(1, {
      ...(workflowName !== undefined
        ? { [OTEL_ATTRIBUTE.WORKFLOW_NAME]: workflowName }
        : {}),
      [OTEL_ATTRIBUTE.RUN_OUTCOME]: event.outcome,
    });

    const span = state.rootSpan;
    if (span === undefined) {
      return;
    }

    span.setAttribute(OTEL_ATTRIBUTE.RUN_OUTCOME, event.outcome);
    span.setAttribute(OTEL_ATTRIBUTE.RUN_STEPS_TOTAL, event.steps_total);
    span.setAttribute(OTEL_ATTRIBUTE.RUN_STEPS_FAILED, event.steps_failed);
    span.setAttribute(OTEL_ATTRIBUTE.DURATION_MS, event.duration_ms);

    if (event.outcome === OUTCOME.ERROR) {
      recordFailure(span, event.error ?? { message: 'run failed' }, ERROR_TYPE.RUN, time);
    } else if (event.outcome === OUTCOME.OK) {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    // `interrupted` deliberately leaves the root span's status UNSET: the run
    // neither succeeded nor failed — an operator stopped it. The outcome
    // attribute above carries the fact; a status of OK or ERROR would lie.

    // Any step span still open at this point belongs to a step the machine
    // abandoned (a throw between `step.start` and `step.end` — or, on an
    // interrupted run, the in-flight step the graceful stop abandoned, which
    // gets no `step.end` of its own). Closing them first keeps the trace
    // well-formed — an unended child is simply never exported, which reads in
    // a backend as "the step vanished". On an interrupted run the abandoned
    // step is not an error, so its span too closes with status UNSET.
    endDanglingStepSpans(
      time,
      'the run ended before this step reported a result',
      event.outcome !== OUTCOME.INTERRUPTED,
    );

    span.end(time);
    state.rootSpan = undefined;
    state.rootContext = undefined;
  }

  // -- step.start ------------------------------------------------------------
  function onStepStart(event: StepStartEvent): void {
    const key = stepKey(event.step);
    const span = tracer.startSpan(
      stepLabel(event.step),
      { startTime: eventTime(event.ts), attributes: stepAttributes(event.step) },
      parentContext(),
    );
    state.stepSpanByKey.set(key, span);
    state.stepContextByKey.set(key, otelTrace.setSpan(parentContext(), span));
  }

  // -- step.end --------------------------------------------------------------
  function onStepEnd(event: StepEndEvent): void {
    const time = eventTime(event.ts);
    const workflowName = event.workflow ?? state.workflowName;

    getStepDuration().record(event.duration_ms, {
      ...(workflowName !== undefined
        ? { [OTEL_ATTRIBUTE.WORKFLOW_NAME]: workflowName }
        : {}),
      [OTEL_ATTRIBUTE.STEP_LABEL]: stepLabel(event.step),
      [OTEL_ATTRIBUTE.STEP_OUTCOME]: event.outcome,
    });

    const key = stepKey(event.step);
    const span = state.stepSpanByKey.get(key);
    state.stepSpanByKey.delete(key);
    state.stepContextByKey.delete(key);
    if (span === undefined) {
      // A `step.end` with no matching `step.start` means the stream was fed to
      // this sink partially (a test, a replay of a truncated log). The metric
      // above is still correct, so there is nothing to repair.
      return;
    }

    span.setAttribute(OTEL_ATTRIBUTE.STEP_OUTCOME, event.outcome);
    span.setAttribute(OTEL_ATTRIBUTE.DURATION_MS, event.duration_ms);
    if (event.timed_out) {
      span.setAttribute(OTEL_ATTRIBUTE.STEP_TIMED_OUT, true);
    }

    if (event.outcome === OUTCOME.ERROR) {
      recordFailure(
        span,
        event.error ?? { message: 'step failed' },
        // A timeout keeps the ERROR status and the `exception` event that
        // `recordFailure` writes; only the `error.type` it is grouped under
        // changes.
        event.timed_out ? ERROR_TYPE.TIMEOUT : ERROR_TYPE.STEP,
        time,
      );
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }

    span.end(time);
  }

  // -- storage.seed ----------------------------------------------------------
  function onStorageSeed(event: StorageSeedEvent): void {
    // A span event on the root span, exactly as event-types.ts promises: one
    // summary of "the store was primed", never one event per written key.
    state.rootSpan?.addEvent(
      RUN_EVENT.STORAGE_SEED,
      {
        [OTEL_ATTRIBUTE.SEED_COUNT]: event.seed_count,
        [OTEL_ATTRIBUTE.SEED_KEY_COUNT]: event.key_count,
        [OTEL_ATTRIBUTE.SEED_KEYS]: [...event.keys],
        [OTEL_ATTRIBUTE.DURATION_MS]: event.duration_ms,
      },
      eventTime(event.ts),
    );
  }

  // -- seed.override.applied --------------------------------------------------
  function onSeedOverrideApplied(event: SeedOverrideAppliedEvent): void {
    // `storage.seed`'s neighbour, deliberately: a span event on the root span,
    // one summary per run. Parallel-array attributes rather than an array of
    // `{key, source}` objects because OTel span-event attributes are flat
    // key→primitive(-array); `key_count`-style companions are skipped since
    // `event.overrides.length` already answers "how many" for anyone reading
    // the arrays.
    state.rootSpan?.addEvent(
      RUN_EVENT.SEED_OVERRIDE_APPLIED,
      {
        [OTEL_ATTRIBUTE.SEED_OVERRIDE_KEYS]: event.overrides.map((o) => o.key),
        [OTEL_ATTRIBUTE.SEED_OVERRIDE_SOURCES]: event.overrides.map((o) => o.source),
      },
      eventTime(event.ts),
    );
  }

  // -- log.rotate --------------------------------------------------------------
  function onLogRotate(event: LogRotateEvent): void {
    // A span event on the root span, `storage.seed`'s neighbour: one summary
    // per roll, not a special record of its own. Silently dropped when there
    // is no root span — a hand-fed stream, or a `log.rotate` that arrived
    // before `run.start` in a replay — never fabricated.
    state.rootSpan?.addEvent(
      RUN_EVENT.LOG_ROTATE,
      {
        [OTEL_ATTRIBUTE.LOG_ROTATE_SEALED_SEGMENT]: event.sealed_segment,
        [OTEL_ATTRIBUTE.LOG_ROTATE_LIVE_SEGMENT]: event.live_segment,
        ...(event.deleted_segment !== undefined
          ? { [OTEL_ATTRIBUTE.LOG_ROTATE_DELETED_SEGMENT]: event.deleted_segment }
          : {}),
        [OTEL_ATTRIBUTE.LOG_ROTATE_MAX_BYTES]: event.max_bytes,
        [OTEL_ATTRIBUTE.LOG_ROTATE_MAX_FILES]: event.max_files,
      },
      eventTime(event.ts),
    );
  }

  // -- bootstrap.error -------------------------------------------------------
  function onBootstrapError(event: BootstrapErrorEvent): void {
    const time = eventTime(event.ts);
    const span = state.rootSpan;

    if (span !== undefined) {
      span.setAttribute(OTEL_ATTRIBUTE.BOOTSTRAP_STAGE, event.stage);
      recordFailure(span, { message: event.message }, ERROR_TYPE.BOOTSTRAP, time);
      return;
    }

    // The two earliest stages (`workspace`, `workflow`) fail before the run
    // knows its own identity, so there is no root span — and never will be, for
    // this run. A log record is the only place the diagnostic can go without
    // inventing a trace for a run that never started.
    logger.emit({
      timestamp: time,
      severityNumber: severityNumberOf(event.severity),
      severityText: event.severity.toUpperCase(),
      body: event.message,
      attributes: {
        [OTEL_ATTRIBUTE.RUN_ID]: event.run_id,
        [OTEL_ATTRIBUTE.BOOTSTRAP_STAGE]: event.stage,
        [ATTRIBUTE_ERROR_TYPE]: ERROR_TYPE.BOOTSTRAP,
        ...envelopeAttributes(event),
      },
    });
  }

  // -- log -------------------------------------------------------------------
  function onLog(event: LogEvent): void {
    const stepAttributeSet =
      event.step !== undefined ? stepAttributes(event.step) : undefined;
    // The step in flight, if any: its span context is what correlates this
    // record to the step rather than merely to the run. Falling back to the
    // root context still gives the record a `trace_id`, which is the property
    // the mapping actually promises: log records correlated by
    // trace_id/span_id (README, "The mapping").
    const logContext =
      (event.step !== undefined
        ? state.stepContextByKey.get(stepKey(event.step))
        : undefined) ?? state.rootContext;

    const encodedData = event.data !== undefined ? encodeRecord(event.data) : undefined;

    logger.emit({
      timestamp: eventTime(event.ts),
      severityNumber: severityOf(event.level),
      severityText: event.level.toUpperCase(),
      body: event.message,
      attributes: {
        [OTEL_ATTRIBUTE.RUN_ID]: event.run_id,
        [OTEL_ATTRIBUTE.LOG_LEVEL]: event.level,
        ...envelopeAttributes(event),
        ...(stepAttributeSet ?? {}),
        ...(encodedData !== undefined ? { 'rawbox.log.data': encodedData } : {}),
      },
      ...(logContext !== undefined ? { context: logContext } : {}),
    });
  }

  // -- run.heartbeat -----------------------------------------------------------
  function onRunHeartbeat(event: RunHeartbeatEvent): void {
    // A span event on the step's own span, exactly like `storage.seed` is a
    // span event on the root: evidence of life, not a record of its own.
    // Silently dropped when no matching span is open (a hand-fed stream, or a
    // heartbeat that outlived its span in some replay) — never fabricated.
    state.stepSpanByKey.get(stepKey(event.step))?.addEvent(
      RUN_EVENT.RUN_HEARTBEAT,
      { [OTEL_ATTRIBUTE.DURATION_MS]: event.in_flight_ms, ...stepAttributes(event.step) },
      eventTime(event.ts),
    );
  }

  // -- step.progress -------------------------------------------------------
  function onStepProgress(event: StepProgressEvent): void {
    const span =
      (event.step !== undefined ? state.stepSpanByKey.get(stepKey(event.step)) : undefined) ??
      state.rootSpan;
    const encodedData = event.data !== undefined ? encodeRecord(event.data) : undefined;

    span?.addEvent(
      RUN_EVENT.STEP_PROGRESS,
      {
        ...(event.message !== undefined ? { message: event.message } : {}),
        ...(encodedData !== undefined ? { data: encodedData } : {}),
      },
      eventTime(event.ts),
    );
  }

  /** The `workspace`/`workflow` names off any event, when it has them. */
  function envelopeAttributes(event: RunEvent): Attributes {
    return {
      ...(event.workspace !== undefined
        ? { [OTEL_ATTRIBUTE.WORKSPACE_NAME]: event.workspace }
        : {}),
      ...(event.workflow !== undefined
        ? { [OTEL_ATTRIBUTE.WORKFLOW_NAME]: event.workflow }
        : {}),
    };
  }

  /**
   * Ends every still-open child span, marking why it had to be closed from
   * outside. `markError: false` (the interrupted-run path) ends the spans with
   * their status left UNSET instead: a step abandoned by a graceful operator
   * stop did not fail, it was never allowed to finish.
   */
  function endDanglingStepSpans(time: TimeInput, reason: string, markError = true): void {
    for (const span of state.stepSpanByKey.values()) {
      if (markError) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
        span.setAttribute(ATTRIBUTE_ERROR_TYPE, ERROR_TYPE.STEP);
      }
      span.end(time);
    }
    state.stepSpanByKey.clear();
    state.stepContextByKey.clear();
  }

  return {
    emit(event: RunEvent): void {
      switch (event.event) {
        case RUN_EVENT.RUN_START:
          onRunStart(event);
          return;
        case RUN_EVENT.RUN_END:
          onRunEnd(event);
          return;
        case RUN_EVENT.STEP_START:
          onStepStart(event);
          return;
        case RUN_EVENT.STEP_END:
          onStepEnd(event);
          return;
        case RUN_EVENT.STORAGE_SEED:
          onStorageSeed(event);
          return;
        case RUN_EVENT.SEED_OVERRIDE_APPLIED:
          onSeedOverrideApplied(event);
          return;
        case RUN_EVENT.BOOTSTRAP_ERROR:
          onBootstrapError(event);
          return;
        case RUN_EVENT.LOG:
          onLog(event);
          return;
        case RUN_EVENT.RUN_HEARTBEAT:
          onRunHeartbeat(event);
          return;
        case RUN_EVENT.STEP_PROGRESS:
          onStepProgress(event);
          return;
        case RUN_EVENT.LOG_ROTATE:
          onLogRotate(event);
          return;
        default:
          // An event kind this bridge does not know. Ignored on purpose: adding
          // a kind to the stream must never break an exporter.
          return;
      }
    },

    /**
     * Closes anything the stream left open.
     *
     * A process killed mid-run, or an embedder that stops feeding events,
     * leaves spans open; an unended span is never exported, so a run that
     * crashed would show up as *nothing at all* rather than as a truncated
     * trace. Ending them here — with an `ERROR` status saying why — is the
     * difference between the two.
     *
     * Flushing the *exporters* is deliberately not this sink's job: it holds no
     * SDK. Whoever started the SDK shuts it down (in the CLI, `sdk.shutdown()`
     * after the run), which is also the only place that can await a real
     * network flush.
     */
    async close(): Promise<void> {
      const now = new Date();
      endDanglingStepSpans(now, 'the run-event stream ended before this step reported');
      if (state.rootSpan !== undefined) {
        state.rootSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'the run-event stream ended before run.end',
        });
        state.rootSpan.setAttribute(ATTRIBUTE_ERROR_TYPE, ERROR_TYPE.RUN);
        state.rootSpan.end(now);
        state.rootSpan = undefined;
        state.rootContext = undefined;
      }
    },
  };
}
