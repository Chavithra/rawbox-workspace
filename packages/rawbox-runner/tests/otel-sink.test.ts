import { describe, it, expect } from 'vitest';
import { SpanStatusCode, type HrTime } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs';

import {
  OTEL_ATTRIBUTE,
  RUN_SPAN_NAME,
  createOtelSink,
} from '../src/events/otel-sink.js';
import { RUN_EVENT_FORMAT, type RunEvent } from '../src/events/event-types.js';

// ---------------------------------------------------------------------------
// The OTel bridge (README, "OpenTelemetry").
//
// Driven by synthetic event sequences rather than by a real run: the sink's
// whole contract is "`RunEvent` in, spans/log records/metrics out", and the
// events a real run produces are already covered by `events.test.ts`. Feeding
// them by hand is what lets these assertions pin the *exact* `ts` values that
// must reappear as span timestamps.
//
// The tracer and logger are passed in explicitly, wired to in-memory exporters,
// so nothing here touches the `@opentelemetry/api` globals — two test files
// registering a global SDK would fight over one process-wide slot.
// ---------------------------------------------------------------------------

const RUN_ID = 'run-otel-test';
const WORKSPACE = 'otel-workspace';
const WORKFLOW = 'otel-workflow';

/** The envelope every synthetic event below shares. */
function envelope(ts: string): { ts: string; run_id: string; workspace: string; workflow: string } {
  return { ts, run_id: RUN_ID, workspace: WORKSPACE, workflow: WORKFLOW };
}

/** One step descriptor, at a given index/iteration. */
function step(index: number, iteration: number, label: string) {
  return {
    index,
    iteration,
    label,
    plugin: '@rawbox/rawbox-plugin-default',
    operation: 'time/sleep',
    registry_hash: 'hash-abc123',
  };
}

/** A tracer + logger pair backed by in-memory exporters, plus the sink using them. */
function makeHarness() {
  const spanExporter = new InMemorySpanExporter();
  // `sdk-trace-base`'s `SimpleSpanProcessor` is the compatibility shim over
  // `sdk-trace`'s: it takes the exporter *positionally*, unlike its log-record
  // counterpart just below, which takes an options object.
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });

  const sink = createOtelSink({
    tracer: tracerProvider.getTracer('test'),
    logger: loggerProvider.getLogger('test'),
  });

  return {
    sink,
    /** Every finished span, in completion order. */
    spans: (): ReadableSpan[] => spanExporter.getFinishedSpans(),
    /** Every emitted log record, in emission order. */
    logRecords: (): ReadableLogRecord[] => logExporter.getFinishedLogRecords(),
    emit: (...eventList: RunEvent[]): void => {
      for (const event of eventList) {
        sink.emit(event);
      }
    },
  };
}

/** An OTel `HrTime` as epoch milliseconds, for comparison with a parsed `ts`. */
function hrTimeToMs(time: HrTime): number {
  return time[0] * 1_000 + time[1] / 1_000_000;
}

/** The span whose name matches, asserted to be exactly one. */
function spanNamed(spanList: ReadableSpan[], name: string): ReadableSpan {
  const matches = spanList.filter((span) => span.name === name);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

// ---------------------------------------------------------------------------

describe('OTel sink — span tree shape', () => {
  it('opens one root span and one child span per step execution, correctly parented', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.100Z'),
        event: 'step.start',
        step: step(0, 0, 'first-step'),
      },
      {
        ...envelope('2026-08-09T10:00:00.600Z'),
        event: 'step.end',
        step: step(0, 0, 'first-step'),
        outcome: 'ok',
        duration_ms: 500,
      },
      {
        ...envelope('2026-08-09T10:00:00.700Z'),
        event: 'step.start',
        step: step(1, 0, 'second-step'),
      },
      {
        ...envelope('2026-08-09T10:00:00.900Z'),
        event: 'step.end',
        step: step(1, 0, 'second-step'),
        outcome: 'ok',
        duration_ms: 200,
      },
      {
        ...envelope('2026-08-09T10:00:01.000Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 1000,
        steps_total: 2,
        steps_failed: 0,
      },
    );

    const spanList = harness.spans();
    expect(spanList).toHaveLength(3);

    const root = spanNamed(spanList, RUN_SPAN_NAME);
    const first = spanNamed(spanList, 'first-step');
    const second = spanNamed(spanList, 'second-step');

    // One trace per run, both steps parented on the root.
    expect(first.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(second.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(first.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(second.parentSpanContext?.spanId).toBe(root.spanContext().spanId);

    // The children close before the root does — the root is exported last.
    expect(spanList[spanList.length - 1]!.name).toBe(RUN_SPAN_NAME);
  });

  it('pairs across loop iterations: repeated sibling spans under one label', () => {
    const harness = makeHarness();

    harness.emit({
      ...envelope('2026-08-09T10:00:00.000Z'),
      event: 'run.start',
      format: RUN_EVENT_FORMAT,
    });

    // Two executions of step index 0, interleaved with a step index 1 between
    // them — the shape a `loop-gate` produces. The middle event must not be
    // able to steal iteration 1's span, which is the whole point of keying on
    // `(index, iteration)` rather than on index or label alone.
    harness.emit(
      { ...envelope('2026-08-09T10:00:00.100Z'), event: 'step.start', step: step(0, 0, 'looped') },
      {
        ...envelope('2026-08-09T10:00:00.200Z'),
        event: 'step.end',
        step: step(0, 0, 'looped'),
        outcome: 'ok',
        duration_ms: 100,
      },
      { ...envelope('2026-08-09T10:00:00.300Z'), event: 'step.start', step: step(1, 0, 'gate') },
      {
        ...envelope('2026-08-09T10:00:00.310Z'),
        event: 'step.end',
        step: step(1, 0, 'gate'),
        outcome: 'ok',
        duration_ms: 10,
      },
      { ...envelope('2026-08-09T10:00:00.400Z'), event: 'step.start', step: step(0, 1, 'looped') },
      {
        ...envelope('2026-08-09T10:00:00.520Z'),
        event: 'step.end',
        step: step(0, 1, 'looped'),
        outcome: 'ok',
        duration_ms: 120,
      },
      {
        ...envelope('2026-08-09T10:00:01.000Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 1000,
        steps_total: 3,
        steps_failed: 0,
      },
    );

    const loopedSpans = harness
      .spans()
      .filter((span) => span.name === 'looped')
      .sort(
        (left, right) =>
          Number(left.attributes[OTEL_ATTRIBUTE.STEP_ITERATION]) -
          Number(right.attributes[OTEL_ATTRIBUTE.STEP_ITERATION]),
      );

    expect(loopedSpans).toHaveLength(2);
    expect(loopedSpans.map((span) => span.attributes[OTEL_ATTRIBUTE.STEP_ITERATION])).toEqual([
      0, 1,
    ]);
    // Siblings, not nested: both parented on the root, distinct span ids.
    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    for (const span of loopedSpans) {
      expect(span.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    }
    expect(loopedSpans[0]!.spanContext().spanId).not.toBe(loopedSpans[1]!.spanContext().spanId);

    // Each iteration kept its own duration rather than sharing one span.
    expect(loopedSpans[0]!.attributes[OTEL_ATTRIBUTE.DURATION_MS]).toBe(100);
    expect(loopedSpans[1]!.attributes[OTEL_ATTRIBUTE.DURATION_MS]).toBe(120);
  });

  it('falls back to `step-<index>` for a span name when the step has no label', () => {
    const harness = makeHarness();
    const unlabelled = { ...step(4, 0, 'x') } as Partial<ReturnType<typeof step>>;
    delete unlabelled.label;

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.100Z'),
        event: 'step.start',
        step: unlabelled as ReturnType<typeof step>,
      },
      {
        ...envelope('2026-08-09T10:00:00.200Z'),
        event: 'step.end',
        step: unlabelled as ReturnType<typeof step>,
        outcome: 'ok',
        duration_ms: 100,
      },
    );

    expect(spanNamed(harness.spans(), 'step-4').attributes[OTEL_ATTRIBUTE.STEP_LABEL]).toBe(
      'step-4',
    );
  });
});

describe('OTel sink — attributes', () => {
  it('puts the run identity on the root span and the step identity on each child', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.100Z'),
        event: 'step.start',
        step: step(0, 0, 'attributed'),
        input: { ms: 500 },
      },
      {
        ...envelope('2026-08-09T10:00:00.600Z'),
        event: 'step.end',
        step: step(0, 0, 'attributed'),
        outcome: 'ok',
        duration_ms: 500,
        output: { timestamp: 1 },
      },
      {
        ...envelope('2026-08-09T10:00:01.000Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 1000,
        steps_total: 1,
        steps_failed: 0,
      },
    );

    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    expect(root.attributes[OTEL_ATTRIBUTE.RUN_ID]).toBe(RUN_ID);
    expect(root.attributes[OTEL_ATTRIBUTE.WORKSPACE_NAME]).toBe(WORKSPACE);
    expect(root.attributes[OTEL_ATTRIBUTE.WORKFLOW_NAME]).toBe(WORKFLOW);
    expect(root.attributes[OTEL_ATTRIBUTE.RUN_OUTCOME]).toBe('ok');
    expect(root.attributes[OTEL_ATTRIBUTE.RUN_STEPS_TOTAL]).toBe(1);
    expect(root.attributes[OTEL_ATTRIBUTE.RUN_STEPS_FAILED]).toBe(0);
    expect(root.status.code).toBe(SpanStatusCode.OK);

    const child = spanNamed(harness.spans(), 'attributed');
    expect(child.attributes).toMatchObject({
      [OTEL_ATTRIBUTE.STEP_LABEL]: 'attributed',
      [OTEL_ATTRIBUTE.STEP_INDEX]: 0,
      [OTEL_ATTRIBUTE.STEP_ITERATION]: 0,
      [OTEL_ATTRIBUTE.PLUGIN_NAME]: '@rawbox/rawbox-plugin-default',
      [OTEL_ATTRIBUTE.OPERATION_PATH]: 'time/sleep',
      [OTEL_ATTRIBUTE.REGISTRY_HASH]: 'hash-abc123',
      [OTEL_ATTRIBUTE.STEP_OUTCOME]: 'ok',
    });
  });

  it('records storage.seed as a span event on the root span, not as a span of its own', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.050Z'),
        event: 'storage.seed',
        seed_count: 3,
        key_count: 2,
        keys: ['sleep_ms', 'halt_reason'],
        duration_ms: 4,
      },
      {
        ...envelope('2026-08-09T10:00:01.000Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 1000,
        steps_total: 0,
        steps_failed: 0,
      },
    );

    expect(harness.spans()).toHaveLength(1);
    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    const seedEvent = root.events.find((event) => event.name === 'storage.seed');

    expect(seedEvent).toBeDefined();
    expect(seedEvent!.attributes).toMatchObject({
      [OTEL_ATTRIBUTE.SEED_COUNT]: 3,
      [OTEL_ATTRIBUTE.SEED_KEY_COUNT]: 2,
      [OTEL_ATTRIBUTE.SEED_KEYS]: ['sleep_ms', 'halt_reason'],
    });
    expect(hrTimeToMs(seedEvent!.time)).toBe(Date.parse('2026-08-09T10:00:00.050Z'));
  });

  it('records log.rotate as a span event on the root span, carrying the deleted segment when there is one', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.500Z'),
        event: 'log.rotate',
        sealed_segment: 3,
        live_segment: 4,
        deleted_segment: 0,
        max_bytes: 2000,
        max_files: 4,
        severity: 'warn',
      },
      {
        ...envelope('2026-08-09T10:00:01.000Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 1000,
        steps_total: 0,
        steps_failed: 0,
      },
    );

    expect(harness.spans()).toHaveLength(1);
    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    const rotateEvent = root.events.find((event) => event.name === 'log.rotate');

    expect(rotateEvent).toBeDefined();
    expect(rotateEvent!.attributes).toMatchObject({
      [OTEL_ATTRIBUTE.LOG_ROTATE_SEALED_SEGMENT]: 3,
      [OTEL_ATTRIBUTE.LOG_ROTATE_LIVE_SEGMENT]: 4,
      [OTEL_ATTRIBUTE.LOG_ROTATE_DELETED_SEGMENT]: 0,
      [OTEL_ATTRIBUTE.LOG_ROTATE_MAX_BYTES]: 2000,
      [OTEL_ATTRIBUTE.LOG_ROTATE_MAX_FILES]: 4,
    });
    expect(hrTimeToMs(rotateEvent!.time)).toBe(Date.parse('2026-08-09T10:00:00.500Z'));
  });

  it('omits the deleted-segment attribute on a roll that retired nothing', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.500Z'),
        event: 'log.rotate',
        sealed_segment: 0,
        live_segment: 1,
        max_bytes: 2000,
        max_files: 100,
      },
      {
        ...envelope('2026-08-09T10:00:01.000Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 1000,
        steps_total: 0,
        steps_failed: 0,
      },
    );

    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    const rotateEvent = root.events.find((event) => event.name === 'log.rotate');
    expect(rotateEvent).toBeDefined();
    expect(rotateEvent!.attributes).not.toHaveProperty(OTEL_ATTRIBUTE.LOG_ROTATE_DELETED_SEGMENT);
  });
});

describe('OTel sink — explicit timestamps', () => {
  it('uses each event\'s own `ts` as the span start/end, not the wall clock', () => {
    const harness = makeHarness();

    const runStartTs = '2026-08-09T10:00:00.000Z';
    const stepStartTs = '2026-08-09T10:00:00.100Z';
    const stepEndTs = '2026-08-09T10:00:00.602Z';
    const runEndTs = '2026-08-09T10:00:00.812Z';

    harness.emit(
      { ...envelope(runStartTs), event: 'run.start', format: RUN_EVENT_FORMAT },
      { ...envelope(stepStartTs), event: 'step.start', step: step(0, 0, 'timed') },
      {
        ...envelope(stepEndTs),
        event: 'step.end',
        step: step(0, 0, 'timed'),
        outcome: 'ok',
        duration_ms: 502,
      },
      {
        ...envelope(runEndTs),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 812,
        steps_total: 1,
        steps_failed: 0,
      },
    );

    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    const child = spanNamed(harness.spans(), 'timed');

    expect(hrTimeToMs(root.startTime)).toBe(Date.parse(runStartTs));
    expect(hrTimeToMs(root.endTime)).toBe(Date.parse(runEndTs));
    expect(hrTimeToMs(child.startTime)).toBe(Date.parse(stepStartTs));
    expect(hrTimeToMs(child.endTime)).toBe(Date.parse(stepEndTs));

    // The whole reason the timestamps are explicit: the span's own duration and
    // the NDJSON line's `duration_ms` are the same number.
    expect(hrTimeToMs(child.endTime) - hrTimeToMs(child.startTime)).toBe(502);
    expect(hrTimeToMs(root.endTime) - hrTimeToMs(root.startTime)).toBe(812);
  });
});

describe('OTel sink — failures', () => {
  it('sets ERROR status and records the error record on a failing step, without failing the run span', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      { ...envelope('2026-08-09T10:00:00.100Z'), event: 'step.start', step: step(0, 0, 'boom') },
      {
        ...envelope('2026-08-09T10:00:00.103Z'),
        event: 'step.end',
        step: step(0, 0, 'boom'),
        outcome: 'error',
        duration_ms: 3,
        error: { message: 'the handler refused', code: 'E_REFUSED' },
      },
      {
        ...envelope('2026-08-09T10:00:00.200Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 200,
        steps_total: 1,
        steps_failed: 1,
      },
    );

    const child = spanNamed(harness.spans(), 'boom');
    expect(child.status.code).toBe(SpanStatusCode.ERROR);
    expect(child.status.message).toBe('the handler refused');
    expect(child.attributes['error.type']).toBe('rawbox.step.error');
    // The plugin's own error record survives intact.
    expect(JSON.parse(String(child.attributes[OTEL_ATTRIBUTE.ERROR_RECORD]))).toEqual({
      message: 'the handler refused',
      code: 'E_REFUSED',
    });

    const exception = child.events.find((event) => event.name === 'exception');
    expect(exception).toBeDefined();
    expect(exception!.attributes?.['exception.message']).toBe('the handler refused');
    expect(hrTimeToMs(exception!.time)).toBe(Date.parse('2026-08-09T10:00:00.103Z'));

    // A step outcome is not a run outcome: this run reported `ok`.
    expect(spanNamed(harness.spans(), RUN_SPAN_NAME).status.code).toBe(SpanStatusCode.OK);
  });

  it('marks a timed-out step with its own error.type, keeping the ERROR status a failure query already finds', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      { ...envelope('2026-08-09T10:00:00.100Z'), event: 'step.start', step: step(0, 0, 'slow') },
      {
        ...envelope('2026-08-09T10:00:30.100Z'),
        event: 'step.end',
        step: step(0, 0, 'slow'),
        outcome: 'error',
        duration_ms: 30_000,
        timed_out: true,
        timeout_ms: 30_000,
        error: { message: 'Step 0 "slow" timed out after 30000 ms (the handler did not return).' },
        severity: 'error',
      },
    );

    const child = spanNamed(harness.spans(), 'slow');
    // The outcome attribute and the span status are unchanged — a timeout is a
    // failure first and a timeout second, so nothing that already queries for
    // failing steps has to learn a new value to keep finding this one.
    expect(child.status.code).toBe(SpanStatusCode.ERROR);
    expect(child.attributes[OTEL_ATTRIBUTE.STEP_OUTCOME]).toBe('error');
    expect(child.attributes[OTEL_ATTRIBUTE.STEP_TIMED_OUT]).toBe(true);
    // Only the grouping key differs: "the run was stopped waiting" is a
    // different class of incident from "the step reported a failure".
    expect(child.attributes['error.type']).toBe('rawbox.step.timeout');
  });

  it('leaves a non-timeout failure grouped under the ordinary step error.type', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      { ...envelope('2026-08-09T10:00:00.100Z'), event: 'step.start', step: step(0, 0, 'boom') },
      {
        ...envelope('2026-08-09T10:00:00.103Z'),
        event: 'step.end',
        step: step(0, 0, 'boom'),
        outcome: 'error',
        duration_ms: 3,
        error: { message: 'the handler refused' },
      },
    );

    const child = spanNamed(harness.spans(), 'boom');
    expect(child.attributes['error.type']).toBe('rawbox.step.error');
    expect(child.attributes[OTEL_ATTRIBUTE.STEP_TIMED_OUT]).toBeUndefined();
  });

  it('sets ERROR status on the root span when the run itself ends in error', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.500Z'),
        event: 'run.end',
        outcome: 'error',
        duration_ms: 500,
        steps_total: 1,
        steps_failed: 1,
        error: { message: 'step "boom" failed' },
      },
    );

    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.status.message).toBe('step "boom" failed');
    expect(root.attributes['error.type']).toBe('rawbox.run.error');
    expect(root.attributes[OTEL_ATTRIBUTE.RUN_OUTCOME]).toBe('error');
  });

  it('records a post-run.start bootstrap.error on the root span', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.010Z'),
        event: 'bootstrap.error',
        stage: 'resolve',
        message: 'plugin "@acme/x" is not installed',
        severity: 'error',
      },
      {
        ...envelope('2026-08-09T10:00:00.020Z'),
        event: 'run.end',
        outcome: 'error',
        duration_ms: 20,
        steps_total: 0,
        steps_failed: 0,
        error: { message: 'plugin "@acme/x" is not installed' },
        severity: 'error',
      },
    );

    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    expect(root.attributes[OTEL_ATTRIBUTE.BOOTSTRAP_STAGE]).toBe('resolve');
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(harness.logRecords()).toHaveLength(0);
  });

  it('routes a pre-run.start bootstrap.error to a log record, since no root span exists', () => {
    const harness = makeHarness();

    harness.emit({
      ts: '2026-08-09T10:00:00.000Z',
      run_id: RUN_ID,
      event: 'bootstrap.error',
      stage: 'workspace',
      message: 'workspace.yaml not found',
      severity: 'error',
    });

    expect(harness.spans()).toHaveLength(0);

    const records = harness.logRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toBe('workspace.yaml not found');
    expect(records[0]!.severityNumber).toBe(SeverityNumber.ERROR);
    expect(records[0]!.attributes[OTEL_ATTRIBUTE.BOOTSTRAP_STAGE]).toBe('workspace');
    expect(records[0]!.attributes[OTEL_ATTRIBUTE.RUN_ID]).toBe(RUN_ID);
  });
});

describe('OTel sink — log events', () => {
  it('emits a log record correlated to the span of the step in flight', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      { ...envelope('2026-08-09T10:00:00.100Z'), event: 'step.start', step: step(2, 1, 'noisy') },
      {
        ...envelope('2026-08-09T10:00:00.150Z'),
        event: 'log',
        level: 'warn',
        message: 'threshold exceeded',
        data: { value: 42 },
        step: step(2, 1, 'noisy'),
      },
      {
        ...envelope('2026-08-09T10:00:00.200Z'),
        event: 'step.end',
        step: step(2, 1, 'noisy'),
        outcome: 'ok',
        duration_ms: 100,
      },
      {
        ...envelope('2026-08-09T10:00:00.300Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 300,
        steps_total: 1,
        steps_failed: 0,
      },
    );

    const records = harness.logRecords();
    expect(records).toHaveLength(1);

    const record = records[0]!;
    expect(record.body).toBe('threshold exceeded');
    expect(record.severityNumber).toBe(SeverityNumber.WARN);
    expect(record.severityText).toBe('WARN');
    expect(hrTimeToMs(record.hrTime)).toBe(Date.parse('2026-08-09T10:00:00.150Z'));
    expect(record.attributes[OTEL_ATTRIBUTE.STEP_LABEL]).toBe('noisy');
    expect(record.attributes[OTEL_ATTRIBUTE.STEP_ITERATION]).toBe(1);
    expect(record.attributes['rawbox.log.data']).toBe('{"value":42}');

    // The correlation the mapping promises (README, "The mapping"): same trace as the
    // run, same span as the step that was executing.
    const child = spanNamed(harness.spans(), 'noisy');
    expect(record.spanContext?.traceId).toBe(child.spanContext().traceId);
    expect(record.spanContext?.spanId).toBe(child.spanContext().spanId);
  });

  it('correlates a step-less log record to the run span instead', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.050Z'),
        event: 'log',
        level: 'info',
        message: 'ambient line',
      },
      {
        ...envelope('2026-08-09T10:00:00.100Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 100,
        steps_total: 0,
        steps_failed: 0,
      },
    );

    const record = harness.logRecords()[0]!;
    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    expect(record.spanContext?.traceId).toBe(root.spanContext().traceId);
    expect(record.spanContext?.spanId).toBe(root.spanContext().spanId);
    expect(record.severityNumber).toBe(SeverityNumber.INFO);
  });
});

// ---------------------------------------------------------------------------
// `severity` (OBSERVABILITY.md, "`severity`"): the bridge maps the
// envelope's own field to log-record severity, and — the other half of the
// same sentence — never lets it grow a *second* log record out of a
// `step.end`/`run.end` failure, whose span status was already the complete
// story before `severity` existed.
// ---------------------------------------------------------------------------

describe('OTel sink — severity mapping', () => {
  it("drives a pre-run.start bootstrap.error's log-record severity off the event's own `severity` field", () => {
    const harness = makeHarness();

    harness.emit({
      ts: '2026-08-09T10:00:00.000Z',
      run_id: RUN_ID,
      event: 'bootstrap.error',
      stage: 'workspace',
      message: 'workspace.yaml not found',
      severity: 'error',
    });

    const record = harness.logRecords()[0]!;
    expect(record.severityNumber).toBe(SeverityNumber.ERROR);
    expect(record.severityText).toBe('ERROR');
  });

  it("does not emit an extra log record for a severity-bearing step.end/run.end — span status is the whole story, as before", () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      { ...envelope('2026-08-09T10:00:00.100Z'), event: 'step.start', step: step(0, 0, 'boom') },
      {
        ...envelope('2026-08-09T10:00:00.103Z'),
        event: 'step.end',
        step: step(0, 0, 'boom'),
        outcome: 'error',
        duration_ms: 3,
        error: { message: 'the handler refused' },
        severity: 'error',
      },
      {
        ...envelope('2026-08-09T10:00:00.200Z'),
        event: 'run.end',
        outcome: 'error',
        duration_ms: 200,
        steps_total: 1,
        steps_failed: 1,
        error: { message: 'the handler refused' },
        severity: 'error',
      },
    );

    // Both spans still report the failure via status, exactly as before
    // `severity` existed —
    expect(spanNamed(harness.spans(), 'boom').status.code).toBe(SpanStatusCode.ERROR);
    expect(spanNamed(harness.spans(), RUN_SPAN_NAME).status.code).toBe(SpanStatusCode.ERROR);
    // — and neither produced a log record: `severity` classifies for `quiet`/
    // alarms, it does not invent a second telemetry signal for events that
    // already have one (span status).
    expect(harness.logRecords()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// `run.heartbeat` / `step.progress` (OBSERVABILITY.md, "`run.heartbeat`" and "Event kinds"): both
// ride the existing fan-out, so the bridge gets them "for free" as a span
// event on the step in flight — never a new span, never a log record.
// ---------------------------------------------------------------------------

describe('OTel sink — run.heartbeat / step.progress', () => {
  it('records a run.heartbeat as a span event on the in-flight step, not a span of its own', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      { ...envelope('2026-08-09T10:00:00.100Z'), event: 'step.start', step: step(0, 0, 'long') },
      {
        ...envelope('2026-08-09T10:00:05.100Z'),
        event: 'run.heartbeat',
        step: step(0, 0, 'long'),
        in_flight_ms: 5000,
      },
      {
        ...envelope('2026-08-09T10:00:10.100Z'),
        event: 'step.end',
        step: step(0, 0, 'long'),
        outcome: 'ok',
        duration_ms: 10000,
      },
      {
        ...envelope('2026-08-09T10:00:10.200Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 10200,
        steps_total: 1,
        steps_failed: 0,
      },
    );

    // Still exactly the root + one child — a heartbeat never opens a span.
    expect(harness.spans()).toHaveLength(2);
    const child = spanNamed(harness.spans(), 'long');
    const heartbeatEvent = child.events.find((event) => event.name === 'run.heartbeat');
    expect(heartbeatEvent).toBeDefined();
    expect(heartbeatEvent!.attributes?.[OTEL_ATTRIBUTE.DURATION_MS]).toBe(5000);
    expect(hrTimeToMs(heartbeatEvent!.time)).toBe(Date.parse('2026-08-09T10:00:05.100Z'));
    // Never an alarm: no log record either.
    expect(harness.logRecords()).toHaveLength(0);
  });

  it('records step.progress as a span event on the in-flight step, carrying message and data', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      { ...envelope('2026-08-09T10:00:00.100Z'), event: 'step.start', step: step(0, 0, 'long') },
      {
        ...envelope('2026-08-09T10:00:02.000Z'),
        event: 'step.progress',
        message: 'halfway there',
        data: { processed: 5, total: 10 },
        step: step(0, 0, 'long'),
      },
      {
        ...envelope('2026-08-09T10:00:04.000Z'),
        event: 'step.end',
        step: step(0, 0, 'long'),
        outcome: 'ok',
        duration_ms: 4000,
      },
      {
        ...envelope('2026-08-09T10:00:04.100Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 4100,
        steps_total: 1,
        steps_failed: 0,
      },
    );

    const child = spanNamed(harness.spans(), 'long');
    const progressEvent = child.events.find((event) => event.name === 'step.progress');
    expect(progressEvent).toBeDefined();
    expect(progressEvent!.attributes?.['message']).toBe('halfway there');
    expect(JSON.parse(String(progressEvent!.attributes?.['data']))).toEqual({
      processed: 5,
      total: 10,
    });
  });

  it('falls back to the root span for a step-less step.progress', () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      {
        ...envelope('2026-08-09T10:00:00.050Z'),
        event: 'step.progress',
        message: 'ambient progress',
      },
      {
        ...envelope('2026-08-09T10:00:00.100Z'),
        event: 'run.end',
        outcome: 'ok',
        duration_ms: 100,
        steps_total: 0,
        steps_failed: 0,
      },
    );

    const root = spanNamed(harness.spans(), RUN_SPAN_NAME);
    const progressEvent = root.events.find((event) => event.name === 'step.progress');
    expect(progressEvent).toBeDefined();
    expect(progressEvent!.attributes?.['message']).toBe('ambient progress');
  });

  it('silently drops a heartbeat/progress with no matching span rather than fabricating one', () => {
    const harness = makeHarness();

    expect(() => {
      // No `step.start` at all: neither has anywhere to attach.
      harness.sink.emit({
        ...envelope('2026-08-09T10:00:00.000Z'),
        event: 'run.heartbeat',
        step: step(9, 0, 'ghost'),
        in_flight_ms: 100,
      });
    }).not.toThrow();
    expect(harness.spans()).toHaveLength(0);
  });
});

describe('OTel sink — robustness', () => {
  it('throws nothing when no SDK is registered — every call lands on a no-op', async () => {
    // No tracer/logger/meter passed: the sink resolves them from the
    // `@opentelemetry/api` globals, which no test registers anything into.
    const sink = createOtelSink();

    expect(() => {
      sink.emit({
        ...envelope('2026-08-09T10:00:00.000Z'),
        event: 'run.start',
        format: RUN_EVENT_FORMAT,
      });
      sink.emit({
        ...envelope('2026-08-09T10:00:00.100Z'),
        event: 'step.start',
        step: step(0, 0, 'noop'),
      });
      sink.emit({
        ...envelope('2026-08-09T10:00:00.150Z'),
        event: 'log',
        level: 'error',
        message: 'still nothing to see',
        step: step(0, 0, 'noop'),
        severity: 'error',
      });
      sink.emit({
        ...envelope('2026-08-09T10:00:00.160Z'),
        event: 'run.heartbeat',
        step: step(0, 0, 'noop'),
        in_flight_ms: 60,
      });
      sink.emit({
        ...envelope('2026-08-09T10:00:00.170Z'),
        event: 'step.progress',
        message: 'still nothing to see, take two',
        step: step(0, 0, 'noop'),
      });
      sink.emit({
        ...envelope('2026-08-09T10:00:00.200Z'),
        event: 'step.end',
        step: step(0, 0, 'noop'),
        outcome: 'error',
        duration_ms: 100,
        error: { message: 'nope' },
        severity: 'error',
      });
      sink.emit({
        ...envelope('2026-08-09T10:00:00.220Z'),
        event: 'log.rotate',
        sealed_segment: 0,
        live_segment: 1,
        deleted_segment: 0,
        max_bytes: 2000,
        max_files: 4,
        severity: 'warn',
      });
      sink.emit({
        ...envelope('2026-08-09T10:00:00.250Z'),
        event: 'storage.seed',
        seed_count: 1,
        key_count: 1,
        keys: ['k'],
        duration_ms: 1,
      });
      sink.emit({
        ...envelope('2026-08-09T10:00:00.300Z'),
        event: 'bootstrap.error',
        stage: 'lock',
        message: 'lock is stale',
        severity: 'error',
      });
      sink.emit({
        ...envelope('2026-08-09T10:00:00.400Z'),
        event: 'run.end',
        outcome: 'error',
        duration_ms: 400,
        steps_total: 1,
        steps_failed: 1,
        error: { message: 'nope' },
        severity: 'error',
      });
    }).not.toThrow();

    await expect(sink.close!()).resolves.toBeUndefined();
  });

  it('ignores an unknown event kind rather than guessing at it', () => {
    const harness = makeHarness();

    harness.emit({ ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT });
    expect(() =>
      // Deliberately off-contract: a kind a future runner might add.
      harness.sink.emit({
        ...envelope('2026-08-09T10:00:00.100Z'),
        event: 'future.kind',
      } as unknown as RunEvent),
    ).not.toThrow();
    expect(harness.spans()).toHaveLength(0);
  });

  it('closes dangling spans on close(), so a truncated run still exports a trace', async () => {
    const harness = makeHarness();

    harness.emit(
      { ...envelope('2026-08-09T10:00:00.000Z'), event: 'run.start', format: RUN_EVENT_FORMAT },
      { ...envelope('2026-08-09T10:00:00.100Z'), event: 'step.start', step: step(0, 0, 'killed') },
    );

    // Nothing has been exported yet: both spans are still open.
    expect(harness.spans()).toHaveLength(0);

    await harness.sink.close!();

    const spanList = harness.spans();
    expect(spanList).toHaveLength(2);
    expect(spanNamed(spanList, 'killed').status.code).toBe(SpanStatusCode.ERROR);
    expect(spanNamed(spanList, RUN_SPAN_NAME).status.code).toBe(SpanStatusCode.ERROR);
  });
});
