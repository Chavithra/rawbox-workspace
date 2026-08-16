/**
 * The typed **run-event stream**: one producer, N sinks.
 *
 * - `event-types.ts` is the normative format contract — the NDJSON schema, the
 *   terminal renderer's input, and the source of the OTel span/log-record
 *   mapping. Read its module doc first; it is where the envelope, the kinds and
 *   the span-pairing rule are specified.
 * - `sink.ts` is where events go: the {@link RunEventSink} interface, the
 *   fan-out {@link RunEventEmitter}, and an in-memory sink for tests and
 *   embedders.
 * - `ndjson-file-sink.ts` is the file writer (a compatibility shim for the log
 *   paths `runWorkflowInstance` still takes; the format itself is final).
 * - `otel-sink.ts` is the OpenTelemetry bridge: the same events as spans, log
 *   records and two metrics, using `@opentelemetry/api` only — a no-op until
 *   something (the CLI's `--otel`) registers an SDK.
 * - `producer.ts` is where events come from: it derives them from the XState
 *   machine's snapshot deltas and routes plugin-emitted `log` events into the
 *   same stream.
 */

export {
  BOOTSTRAP_STAGE,
  OUTCOME,
  RUN_EVENT,
  RUN_EVENT_FORMAT,
  SEVERITY,
  RunEvent,
  RunEventError,
  RunEventStep,
  RunEventValidator,
  BootstrapErrorEvent,
  LogEvent,
  LogLevel,
  LogRotateEvent,
  Outcome,
  RunEndEvent,
  RunHeartbeatEvent,
  RunOutcome,
  RunStartEvent,
  Severity,
  StepEndEvent,
  StepProgressEvent,
  StepStartEvent,
  StorageSeedEvent,
  SeedOverrideAppliedEntry,
  SeedOverrideAppliedEvent,
  type BootstrapStage,
  type RunEventKind,
} from './event-types.js';

export {
  MemoryRunEventSink,
  RunEventEmitter,
  type RunEventSink,
} from './sink.js';

export {
  STEP_DETAIL,
  STEP_DETAIL_LIST,
  createNdjsonFileSink,
  createNdjsonStdoutSink,
  type NdjsonSinkOptions,
  type SegmentRotationInfo,
  type StepDetail,
} from './ndjson-file-sink.js';

export {
  OTEL_ATTRIBUTE,
  OTEL_INSTRUMENTATION_SCOPE,
  OTEL_INSTRUMENTATION_VERSION,
  OTEL_METRIC,
  RUN_SPAN_NAME,
  createOtelSink,
  type OtelSinkOptions,
} from './otel-sink.js';

export {
  DEFAULT_HEARTBEAT_MS,
  RunEventProducer,
  buildStepDescriptorList,
  type RunEventProducerInput,
  type RunEventStepDescriptor,
  type RunSnapshotView,
} from './producer.js';
