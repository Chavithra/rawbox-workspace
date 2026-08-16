import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RunEventProducer, type RunSnapshotView } from '../src/events/producer.js';
import { MemoryRunEventSink } from '../src/events/sink.js';
import type { RunHeartbeatEvent, StepEndEvent } from '../src/events/event-types.js';

// ---------------------------------------------------------------------------
// `run.heartbeat` (OBSERVABILITY.md, "`run.heartbeat`").
//
// Driven directly against `RunEventProducer.observe()` with hand-built
// snapshots, the same technique `machine-instance.test.ts` uses for the
// machine's own reducer — this is a unit test of the timer's lifecycle, not
// of the XState machine, so a real workflow run (already covered by
// `events.test.ts`) would only add real-clock flakiness for no extra
// coverage.
// ---------------------------------------------------------------------------

/** A snapshot where the machine has just entered `running.running` for `index`. */
function runningSnapshot(index: number): RunSnapshotView {
  return {
    value: { running: 'running' },
    context: {
      execution: { todoStep: { index }, doneStep: null },
    },
  } as unknown as RunSnapshotView;
}

/** A snapshot where the machine has just left `running.running`, reporting `doneStep`. */
function doneSnapshot(index: number): RunSnapshotView {
  return {
    value: 'stopping',
    context: {
      execution: { todoStep: null, doneStep: { index, outputRecord: {} } },
    },
  } as unknown as RunSnapshotView;
}

/**
 * A snapshot where the machine has just left `running.running` with **no**
 * `doneStep` — the step itself failed rather than the handler declaring a
 * logical failure, so `context.error` is the only record of what happened.
 * `timeoutMs` is present exactly when that failure was a bounded step's bound
 * expiring (`StepTimeoutError`, carried across by `resultErrorAssigner`).
 */
function failedSnapshot(message: string, timeoutMs?: number): RunSnapshotView {
  return {
    value: 'stopping',
    context: {
      execution: { todoStep: null, doneStep: null },
      error: { message, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
    },
  } as unknown as RunSnapshotView;
}

function heartbeats(sink: MemoryRunEventSink): RunHeartbeatEvent[] {
  return sink.ofKind('run.heartbeat');
}

function stepEnds(sink: MemoryRunEventSink): StepEndEvent[] {
  return sink.ofKind('step.end');
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('run.heartbeat — cadence and silence', () => {
  it('emits on the configured interval while a step is in flight, and never between steps', () => {
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-hb-1', sinkList: [sink], heartbeatMs: 1000 });
    producer.start('ws', 'wf');

    producer.observe(runningSnapshot(0));
    expect(heartbeats(sink)).toHaveLength(0);

    vi.advanceTimersByTime(1000);
    expect(heartbeats(sink)).toHaveLength(1);
    expect(heartbeats(sink)[0]).toMatchObject({
      event: 'run.heartbeat',
      step: { index: 0, iteration: 0 },
      in_flight_ms: 1000,
    });

    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(heartbeats(sink)).toHaveLength(3);
    expect(heartbeats(sink).map((e) => e.in_flight_ms)).toEqual([1000, 2000, 3000]);

    // The step ends: silence between steps is not "the interval happens to
    // not have elapsed yet" — no timer exists at all once a step is done.
    producer.observe(doneSnapshot(0));
    vi.advanceTimersByTime(5000);
    expect(heartbeats(sink)).toHaveLength(3);

    producer.end('ok');
  });

  it('starts a fresh cadence for the next step rather than continuing the last one', () => {
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-hb-2', sinkList: [sink], heartbeatMs: 500 });
    producer.start('ws', 'wf');

    producer.observe(runningSnapshot(0));
    vi.advanceTimersByTime(500);
    producer.observe(doneSnapshot(0));

    producer.observe(runningSnapshot(1));
    // Nothing left over from step 0's timer: the first tick of step 1's own
    // timer is still a full interval away, not immediate.
    expect(heartbeats(sink)).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(heartbeats(sink)).toHaveLength(2);
    expect(heartbeats(sink)[1]!.step.index).toBe(1);

    producer.observe(doneSnapshot(1));
    producer.end('ok');
  });

  it('stops the timer at run end, even with a step still in flight', () => {
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-hb-3', sinkList: [sink], heartbeatMs: 200 });
    producer.start('ws', 'wf');

    producer.observe(runningSnapshot(0));
    vi.advanceTimersByTime(200);
    expect(heartbeats(sink)).toHaveLength(1);

    // The run ends abruptly (a throw between step.start and step.end) —
    // `end()` closes the dangling step itself, which must stop the timer.
    producer.end('error', { message: 'boom' });

    vi.advanceTimersByTime(5000);
    expect(heartbeats(sink)).toHaveLength(1);
  });

  it('0 disables heartbeats entirely — no timer is ever started', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-hb-4', sinkList: [sink], heartbeatMs: 0 });
    producer.start('ws', 'wf');

    producer.observe(runningSnapshot(0));
    vi.advanceTimersByTime(60_000);
    expect(heartbeats(sink)).toHaveLength(0);
    expect(setIntervalSpy).not.toHaveBeenCalled();

    producer.observe(doneSnapshot(0));
    producer.end('ok');
  });

  it('defaults to ~10s when heartbeatMs is omitted', () => {
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-hb-5', sinkList: [sink] });
    producer.start('ws', 'wf');

    producer.observe(runningSnapshot(0));
    vi.advanceTimersByTime(9_999);
    expect(heartbeats(sink)).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(heartbeats(sink)).toHaveLength(1);

    producer.observe(doneSnapshot(0));
    producer.end('ok');
  });
});

// ---------------------------------------------------------------------------
// `step.end` for a bounded step whose bound expired.
//
// The producer half of the feature, driven the same way the heartbeat is: the
// machine already put `timeoutMs` on `context.error` by the time the producer
// sees anything, so the unit under test here is purely "does the fallback
// branch of `finishStep` carry that number onto the event, and does the step
// still stop cleanly". The end-to-end path is `tests/timeout.test.ts`.
// ---------------------------------------------------------------------------

describe('step.end — a bounded step that timed out', () => {
  it('carries timed_out and timeout_ms, and leaves no heartbeat behind it', () => {
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-to-1', sinkList: [sink], heartbeatMs: 300 });
    producer.start('ws', 'wf');

    producer.observe(runningSnapshot(0));
    vi.advanceTimersByTime(900);
    expect(heartbeats(sink)).toHaveLength(3);

    producer.observe(
      failedSnapshot('Step 0 "slow" timed out after 1000 ms (the handler did not return).', 1000),
    );

    const stepEnd = stepEnds(sink)[0]!;
    expect(stepEnd).toMatchObject({
      outcome: 'error',
      timed_out: true,
      timeout_ms: 1000,
      severity: 'error',
      error: { message: expect.stringContaining('timed out') },
    });
    // The runner's own diagnostic, not a contract-shaped record: it carries
    // `message` (and a `stack` when there was one) and nothing else. The bound
    // rides on the event's own fields precisely so the record stays the
    // plugin's namespace.
    expect(Object.keys(stepEnd.error!)).toEqual(['message']);

    // Every heartbeat fired strictly inside the bound, and the timer is gone:
    // `emitStepEnd` stops it before emitting, so a step that ended by timing
    // out cannot go on reporting itself alive.
    for (const heartbeat of heartbeats(sink)) {
      expect(heartbeat.in_flight_ms).toBeLessThan(1000);
    }
    vi.advanceTimersByTime(60_000);
    expect(heartbeats(sink)).toHaveLength(3);

    producer.end('error', { message: 'timed out' });
  });

  it('adds neither field when the step failed for any other reason', () => {
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-to-2', sinkList: [sink], heartbeatMs: 0 });
    producer.start('ws', 'wf');

    producer.observe(runningSnapshot(0));
    producer.observe(failedSnapshot('the handler threw'));

    const stepEnd = stepEnds(sink)[0]!;
    expect(stepEnd.outcome).toBe('error');
    expect(stepEnd).not.toHaveProperty('timed_out');
    expect(stepEnd).not.toHaveProperty('timeout_ms');

    producer.end('error', { message: 'the handler threw' });
  });
});

describe('run.heartbeat — unref', () => {
  it('unrefs its timer, so a heartbeat can never keep the process alive', () => {
    const unrefSpy = vi.fn();
    const nativeSetInterval = global.setInterval;
    vi.spyOn(global, 'setInterval').mockImplementation(((handler: TimerHandler, ms?: number) => {
      const timer = nativeSetInterval(handler as () => void, ms);
      // `Timeout#unref` normally returns the timer itself; preserve that so
      // the producer's `.unref()` call site keeps working under the spy.
      (timer as unknown as { unref: () => unknown }).unref = unrefSpy.mockImplementation(() => timer);
      return timer;
    }) as typeof setInterval);

    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-hb-6', sinkList: [sink], heartbeatMs: 1000 });
    producer.start('ws', 'wf');
    producer.observe(runningSnapshot(0));

    expect(unrefSpy).toHaveBeenCalledTimes(1);

    producer.observe(doneSnapshot(0));
    producer.end('ok');
  });
});

type TimerHandler = (...args: unknown[]) => void;
