import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUN_EVENT,
  OUTCOME,
  SEVERITY,
  RUN_EVENT_FORMAT,
  createNdjsonFileSink,
  createNdjsonStdoutSink,
  type RunEvent,
  type Severity,
} from '../src/events/index.js';

// ---------------------------------------------------------------------------
// The NDJSON sinks, rewritten around `pino.destination()`.
//
// The contract these pin is "nothing observable changed except the writer":
// the same bytes, the same filtering, the same best-effort failure handling,
// plus the two things the writer bought — a `sync` flag, and `flush`/`close`
// hooks that make the buffered mode safe to exit after.
//
// `assertSameBytesAsLegacy` below is the load-bearing one: it runs the
// **previous implementation**, verbatim, over the same events and compares the
// files byte for byte, rather than comparing against a hand-written expectation
// of what the previous implementation used to produce.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-ndjson-sink-test');

let caseDir: string;
let caseCounter = 0;
let errorList: string[];

beforeEach(() => {
  caseCounter += 1;
  caseDir = path.join(rootDir, `case-${caseCounter}`);
  fsSync.mkdirSync(caseDir, { recursive: true });
  errorList = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorList.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fsSync.rmSync(rootDir, { recursive: true, force: true });
});

/** A path inside this test case's own directory. */
function casePath(...segments: string[]): string {
  return path.join(caseDir, ...segments);
}

/** The file's bytes, or `undefined` when it does not exist. */
function readBytes(filePath: string): Buffer | undefined {
  try {
    return fsSync.readFileSync(filePath);
  } catch {
    return undefined;
  }
}

/** The file's lines, `\n`-terminated ones only, or `[]` when it does not exist. */
function readLines(filePath: string): string[] {
  const text = readBytes(filePath)?.toString('utf-8') ?? '';
  return text.length === 0 ? [] : text.split('\n').slice(0, -1);
}

// ---------------------------------------------------------------------------
// One representative event of every kind (`event-types.ts`'s `RunEvent` union)
// ---------------------------------------------------------------------------

const RUN_ID = 'run-1770000000000-abcde';

const STEP = {
  index: 2,
  iteration: 1,
  label: 'fetch the thing',
  plugin: '@rawbox/rawbox-plugin-default',
  operation: 'time/sleep',
  registry_hash: 'sha256-deadbeef',
} as const;

const ENVELOPE = {
  ts: '2026-08-15T10:11:12.345Z',
  run_id: RUN_ID,
  workspace: 'my-workspace',
  workflow: 'example',
} as const;

/**
 * Every kind the union declares, plus the variants whose *filtering* differs
 * within a kind: an ok and an error `step.end`, an ok / error / interrupted
 * `run.end`, and a `log` at each of the four levels — the last of which is
 * what separates the outcome predicate from a severity threshold.
 */
const EVENT_LIST: readonly RunEvent[] = [
  { ...ENVELOPE, event: RUN_EVENT.RUN_START, format: RUN_EVENT_FORMAT },
  {
    ...ENVELOPE,
    event: RUN_EVENT.SEED_OVERRIDE_APPLIED,
    overrides: [{ key: 'sleep_ms', source: '--seed' }],
  },
  {
    ...ENVELOPE,
    event: RUN_EVENT.STORAGE_SEED,
    seed_count: 3,
    key_count: 2,
    keys: ['sleep_ms', 'history_queue'],
    duration_ms: 4,
  },
  { ...ENVELOPE, event: RUN_EVENT.STEP_START, step: STEP, input: { sleep_ms: 10 } },
  { ...ENVELOPE, event: RUN_EVENT.RUN_HEARTBEAT, step: STEP, in_flight_ms: 10_000 },
  {
    ...ENVELOPE,
    event: RUN_EVENT.STEP_PROGRESS,
    message: 'halfway',
    data: { processed: 4200, total: 10_000 },
    step: STEP,
  },
  { ...ENVELOPE, event: RUN_EVENT.LOG, level: 'debug', message: 'a debug line', step: STEP },
  { ...ENVELOPE, event: RUN_EVENT.LOG, level: 'info', message: 'an info line', step: STEP },
  {
    ...ENVELOPE,
    event: RUN_EVENT.LOG,
    level: 'warn',
    message: 'a warn line',
    step: STEP,
    severity: SEVERITY.WARN,
  },
  {
    ...ENVELOPE,
    event: RUN_EVENT.LOG,
    level: 'error',
    message: 'an error line a handler chose',
    step: STEP,
    severity: SEVERITY.ERROR,
  },
  {
    ...ENVELOPE,
    event: RUN_EVENT.STEP_END,
    step: STEP,
    outcome: OUTCOME.OK,
    duration_ms: 11,
    output: { slept_ms: 10 },
  },
  {
    ...ENVELOPE,
    event: RUN_EVENT.STEP_END,
    step: STEP,
    outcome: OUTCOME.ERROR,
    duration_ms: 12,
    timed_out: true,
    timeout_ms: 12,
    error: { message: 'the step timed out' },
    severity: SEVERITY.ERROR,
  },
  {
    ...ENVELOPE,
    event: RUN_EVENT.BOOTSTRAP_ERROR,
    stage: 'resolve',
    message: 'could not resolve the workflow',
    severity: SEVERITY.ERROR,
  },
  {
    ...ENVELOPE,
    event: RUN_EVENT.RUN_END,
    outcome: OUTCOME.OK,
    duration_ms: 30,
    steps_total: 2,
    steps_failed: 0,
  },
];

/**
 * A stream ending in an error `run.end`, for the tests about the terminal
 * event. Kept separate from {@link EVENT_LIST} so that list can end on the
 * ordinary success path.
 */
const FAILED_RUN_END: RunEvent = {
  ...ENVELOPE,
  event: RUN_EVENT.RUN_END,
  outcome: OUTCOME.ERROR,
  duration_ms: 31,
  steps_total: 2,
  steps_failed: 1,
  error: { message: 'the run failed', stack: 'Error: the run failed\n    at <anonymous>' },
  severity: SEVERITY.ERROR,
};

const INTERRUPTED_RUN_END: RunEvent = {
  ...ENVELOPE,
  event: RUN_EVENT.RUN_END,
  outcome: OUTCOME.INTERRUPTED,
  duration_ms: 32,
  steps_total: 1,
  steps_failed: 0,
};

// ---------------------------------------------------------------------------
// The previous implementation, verbatim — the byte-for-byte reference
// ---------------------------------------------------------------------------

/**
 * `createNdjsonFileSink` exactly as it was before the pino rewrite:
 * `appendFileSync` per line, `isFailureEvent` for the error log, one
 * `JSON.stringify` per event.
 *
 * Copied rather than imported on purpose. It is the *old* behaviour, which no
 * longer exists in `src/`, and the whole value of the comparison below is that
 * the two implementations share no code.
 */
function createLegacyNdjsonFileSink(
  logFilePath: string,
  errorLogFilePath: string,
): { emit(event: RunEvent): void } {
  const ensure = (filePath: string): boolean => {
    try {
      fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
      return true;
    } catch {
      return false;
    }
  };
  let logUsable = ensure(logFilePath);
  let errorLogUsable = ensure(errorLogFilePath);

  const append = (filePath: string, line: string): boolean => {
    try {
      fsSync.appendFileSync(filePath, line);
      return true;
    } catch {
      return false;
    }
  };

  const isFailure = (event: RunEvent): boolean =>
    event.event === RUN_EVENT.BOOTSTRAP_ERROR ||
    ('outcome' in event && event.outcome === OUTCOME.ERROR);

  return {
    emit(event: RunEvent): void {
      if (!logUsable && !errorLogUsable) {
        return;
      }
      let line: string;
      try {
        line = `${JSON.stringify(event)}\n`;
      } catch {
        return;
      }
      if (logUsable) {
        logUsable = append(logFilePath, line);
      }
      if (errorLogUsable && isFailure(event)) {
        errorLogUsable = append(errorLogFilePath, line);
      }
    },
  };
}

// ---------------------------------------------------------------------------

describe('createNdjsonFileSink — byte-for-byte identical to the appendFileSync writer', () => {
  it.each([
    ['synchronous (the default)', false],
    ['buffered (--log-async)', true],
  ])('produces the same two files as the previous implementation, %s', async (_name, isAsync) => {
    const eventList = [...EVENT_LIST, FAILED_RUN_END, INTERRUPTED_RUN_END];

    const legacyLog = casePath('legacy', 'run.ndjson');
    const legacyErrorLog = casePath('legacy', 'run.error.ndjson');
    const legacy = createLegacyNdjsonFileSink(legacyLog, legacyErrorLog);
    for (const event of eventList) {
      legacy.emit(event);
    }

    const log = casePath('pino', 'run.ndjson');
    const errorLog = casePath('pino', 'run.error.ndjson');
    const sink = createNdjsonFileSink(log, errorLog, { async: isAsync });
    for (const event of eventList) {
      sink.emit(event);
    }
    await sink.flush?.();
    await sink.close?.();

    // `.equals` rather than a string compare: the claim is about bytes, and a
    // difference in encoding or line terminator has to fail here.
    expect(readBytes(log)?.equals(readBytes(legacyLog)!)).toBe(true);
    expect(readBytes(errorLog)?.equals(readBytes(legacyErrorLog)!)).toBe(true);
    // Not vacuously true: every kind is present, one line each.
    expect(readLines(log)).toHaveLength(eventList.length);
    expect(errorList).toEqual([]);
  });

  it('writes one JSON.stringify line per event, envelope order unchanged', async () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'));
    for (const event of EVENT_LIST) {
      sink.emit(event);
    }
    await sink.close?.();

    const lines = readLines(log);
    expect(lines).toEqual(EVENT_LIST.map((event) => JSON.stringify(event)));
    // The envelope is recognisable before the line is parsed — `ts` first,
    // then `run_id` (OBSERVABILITY.md, "Envelope"). A key-sorting encoder
    // (`safe-stable-stringify`, which pino's *logger* would have brought)
    // would break exactly this.
    expect(lines[0]).toMatch(/^\{"ts":"2026-08-15T10:11:12\.345Z","run_id":"run-/);
  });
});

describe('createNdjsonFileSink — the error log is the outcome-filtered view', () => {
  it('receives exactly the failure events and no others, over every event kind', async () => {
    const eventList = [...EVENT_LIST, FAILED_RUN_END, INTERRUPTED_RUN_END];
    const log = casePath('run.ndjson');
    const errorLog = casePath('run.error.ndjson');
    const sink = createNdjsonFileSink(log, errorLog);
    for (const event of eventList) {
      sink.emit(event);
    }
    await sink.close?.();

    const expected = eventList.filter(
      (event) =>
        event.event === RUN_EVENT.BOOTSTRAP_ERROR ||
        ('outcome' in event && event.outcome === OUTCOME.ERROR),
    );
    expect(readLines(errorLog)).toEqual(expected.map((event) => JSON.stringify(event)));
    // Concretely: the failed step.end, the bootstrap.error, the failed
    // run.end — and neither the interrupted run.end (an operator stop is
    // intent, not an alarm) nor anything ok.
    expect(readLines(errorLog)).toHaveLength(3);
  });

  it('filters on `outcome`, NOT on a severity threshold — the two disagree on `log`', async () => {
    // OBSERVABILITY.md, "`severity`" says severity "classifies an event for
    // alerting; it is not the log level a handler chose", and `LogEvent`
    // projects `level: "error"` onto `severity: "error"`. So a threshold of
    // `>= error` is NOT equivalent to the outcome predicate: it would pull a
    // workflow-authored log line into a file documented as the run's failure
    // record. This test exists so nobody "simplifies" the predicate into the
    // threshold on the strength of §1.3 alone.
    const severityOf = (event: RunEvent): Severity | undefined =>
      (event as { severity?: Severity }).severity;

    const eventList = [...EVENT_LIST, FAILED_RUN_END, INTERRUPTED_RUN_END];
    const byThreshold = eventList.filter((event) => severityOf(event) === SEVERITY.ERROR);
    const byOutcome = eventList.filter(
      (event) =>
        event.event === RUN_EVENT.BOOTSTRAP_ERROR ||
        ('outcome' in event && event.outcome === OUTCOME.ERROR),
    );

    // They disagree, and they disagree on exactly one kind.
    expect(byThreshold).not.toEqual(byOutcome);
    const onlyInThreshold = byThreshold.filter((event) => !byOutcome.includes(event));
    expect(onlyInThreshold.map((event) => event.event)).toEqual([RUN_EVENT.LOG]);

    // And the file follows the outcome predicate.
    const errorLog = casePath('run.error.ndjson');
    const sink = createNdjsonFileSink(casePath('run.ndjson'), errorLog);
    for (const event of eventList) {
      sink.emit(event);
    }
    await sink.close?.();
    expect(readLines(errorLog)).toEqual(byOutcome.map((event) => JSON.stringify(event)));
    expect(readLines(errorLog).join('\n')).not.toContain('an error line a handler chose');
  });
});

describe('createNdjsonFileSink — best effort, never fails the run', () => {
  it('disables one file when its writes fail, keeps the other, and never throws', async () => {
    // A directory where the log file should be: `openSync` fails with EISDIR
    // at the first line, which is the "a write failed" path.
    const log = casePath('run.ndjson');
    fsSync.mkdirSync(log, { recursive: true });
    const errorLog = casePath('run.error.ndjson');

    const sink = createNdjsonFileSink(log, errorLog);
    expect(() => {
      for (const event of [...EVENT_LIST, FAILED_RUN_END]) {
        sink.emit(event);
      }
    }).not.toThrow();
    await expect(sink.flush?.()).resolves.toBeUndefined();
    await expect(sink.close?.()).resolves.toBeUndefined();

    expect(errorList).toHaveLength(1);
    expect(errorList[0]).toContain(`failed to write "${log}", further writes disabled`);
    // The other file is untouched by its neighbour's failure.
    expect(readLines(errorLog)).toHaveLength(3);
  });

  it('reports once, not once per line, when a file is disabled', async () => {
    const log = casePath('run.ndjson');
    fsSync.mkdirSync(log, { recursive: true });
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'));
    for (const event of EVENT_LIST) {
      sink.emit(event);
    }
    await sink.close?.();
    expect(errorList).toHaveLength(1);
  });

  it('disables logging at construction when the log directory cannot be created', async () => {
    // A *file* where the log's parent directory should be: `mkdirSync`
    // fails with ENOTDIR/EEXIST before a single event is emitted.
    const blocker = casePath('logs');
    fsSync.writeFileSync(blocker, 'not a directory\n');
    const log = path.join(blocker, 'run.ndjson');
    const errorLog = path.join(blocker, 'run.error.ndjson');

    let sink!: ReturnType<typeof createNdjsonFileSink>;
    expect(() => {
      sink = createNdjsonFileSink(log, errorLog);
    }).not.toThrow();
    expect(errorList).toHaveLength(2);
    expect(errorList[0]).toContain(`cannot create the log directory for "${log}"`);
    expect(errorList[1]).toContain(`cannot create the log directory for "${errorLog}"`);

    // Both files disabled: emitting is a no-op, and nothing throws — losing a
    // log line must never change a run's outcome.
    expect(() => {
      for (const event of [...EVENT_LIST, FAILED_RUN_END]) {
        sink.emit(event);
      }
    }).not.toThrow();
    await expect(sink.close?.()).resolves.toBeUndefined();
    // Still exactly the two construction diagnostics — a disabled file is
    // silent from then on.
    expect(errorList).toHaveLength(2);
    expect(fsSync.readFileSync(blocker, 'utf-8')).toBe('not a directory\n');
  });

  it('drops an unencodable event and keeps writing the rest', async () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'));
    sink.emit(EVENT_LIST[0]!);
    sink.emit({
      ...ENVELOPE,
      event: RUN_EVENT.STEP_END,
      step: STEP,
      outcome: OUTCOME.OK,
      duration_ms: 1,
      output: circular,
    });
    sink.emit({
      ...ENVELOPE,
      event: RUN_EVENT.STEP_END,
      step: STEP,
      outcome: OUTCOME.OK,
      duration_ms: 2,
      // `JSON.stringify` throws on a BigInt rather than encoding it.
      output: { count: BigInt(7) as unknown as number },
    });
    sink.emit(EVENT_LIST[EVENT_LIST.length - 1]!);
    await sink.close?.();

    // Two lines, not four, and neither is a partial line: a half-written line
    // would break every reader of the file, not just that one.
    const lines = readLines(log);
    expect(lines).toEqual([
      JSON.stringify(EVENT_LIST[0]),
      JSON.stringify(EVENT_LIST[EVENT_LIST.length - 1]),
    ]);
    expect(errorList).toHaveLength(2);
    expect(errorList[0]).toContain('dropped an unencodable "step.end" event');
    expect(errorList[1]).toContain('dropped an unencodable "step.end" event');
  });

  it('leaves no error log behind for a run that never fails', async () => {
    // The descriptor is opened on the first line a file receives, so a clean
    // run's on-disk footprint is what it was in the appendFileSync era: one
    // file, not one file plus an empty one.
    const errorLog = casePath('run.error.ndjson');
    const sink = createNdjsonFileSink(casePath('run.ndjson'), errorLog);
    const cleanRun = EVENT_LIST.filter(
      (event) =>
        event.event !== RUN_EVENT.BOOTSTRAP_ERROR &&
        !('outcome' in event && event.outcome === OUTCOME.ERROR),
    );
    for (const event of cleanRun) {
      sink.emit(event);
    }
    await sink.close?.();
    expect(fsSync.existsSync(errorLog)).toBe(false);
  });
});

describe('createNdjsonFileSink — sync by default, buffered on request', () => {
  it('writes every line before returning when nothing configures it', () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'));
    sink.emit(EVENT_LIST[0]!);
    // No flush, no close, no await: the line is already on disk. This is the
    // property `logs.async: false` exists to guarantee — a run killed here
    // still has the events that explain why.
    expect(readLines(log)).toEqual([JSON.stringify(EVENT_LIST[0])]);
  });

  it('treats an explicit `async: false` the same as the default', () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), { async: false });
    sink.emit(EVENT_LIST[0]!);
    expect(readLines(log)).toEqual([JSON.stringify(EVENT_LIST[0])]);
  });

  it('buffers with `async: true`, and `close()` is what lands it', async () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), { async: true });
    // Everything but the terminal event, which is flushed on its own terms.
    for (const event of EVENT_LIST.slice(0, -1)) {
      sink.emit(event);
    }
    expect(readLines(log)).toEqual([]);

    await sink.flush?.();
    await sink.close?.();
    expect(readLines(log)).toEqual(EVENT_LIST.slice(0, -1).map((event) => JSON.stringify(event)));
  });

  it('makes `run.end` durable the instant it is emitted, in buffered mode too', () => {
    // `run.end` is the one event whose absence changes how a run is read: a
    // stream that ends without one means "the process died", not "the run
    // failed". So it does not wait for a flush, in either mode — one flush
    // per run, not per event.
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), { async: true });
    for (const event of EVENT_LIST) {
      sink.emit(event);
    }
    // No flush and no close: the whole stream, `run.end` included, is on disk
    // because writing `run.end` flushed it.
    expect(readLines(log)).toEqual(EVENT_LIST.map((event) => JSON.stringify(event)));
  });

  it('flushes the error log on `run.end` too', () => {
    const errorLog = casePath('run.error.ndjson');
    const sink = createNdjsonFileSink(casePath('run.ndjson'), errorLog, { async: true });
    sink.emit(EVENT_LIST[0]!);
    sink.emit(FAILED_RUN_END);
    expect(readLines(errorLog)).toEqual([JSON.stringify(FAILED_RUN_END)]);
  });
});

// ---------------------------------------------------------------------------
// `logs.steps` — the step-detail policy for the main log
//
// The measured problem: `step.start`/`step.end` were 91% of a real workspace's
// log bytes, because they carry `input`/`output` and those grow with the state
// a looping workflow accumulates. The policy trims exactly those two kinds,
// on exactly the main route.
//
// What these pin is as much what the policy must NOT do as what it does: the
// error log keeps full fidelity under all three values, `full` is
// byte-for-byte the pre-option writer, and the events a reader needs to make
// sense of a file at all — `run.start`, `run.end`, `log.rotate` — survive
// `off`.
// ---------------------------------------------------------------------------

/**
 * The rotation marker, emitted straight into the sink rather than by filling a
 * segment: what is under test here is the *filter*, and the marker's real
 * production (it must be the first line of the new segment) is pinned by
 * `tests/ndjson-rotation.test.ts`.
 */
const LOG_ROTATE_EVENT: RunEvent = {
  ...ENVELOPE,
  event: RUN_EVENT.LOG_ROTATE,
  sealed_segment: 0,
  live_segment: 1,
  max_bytes: 4096,
  max_files: 8,
};

/**
 * A failed `step.end` that produced output before it failed — the event the
 * error log must keep whole under every value of the policy. {@link
 * EVENT_LIST}'s failing `step.end` is a timeout and carries no `output`, which
 * would make "the error log still has the payload" vacuously true.
 */
const FAILED_STEP_END: RunEvent = {
  ...ENVELOPE,
  event: RUN_EVENT.STEP_END,
  step: STEP,
  outcome: OUTCOME.ERROR,
  duration_ms: 13,
  output: { partial: 'what the handler managed before it failed' },
  error: { message: 'the step failed after producing output' },
  severity: SEVERITY.ERROR,
};

/** The success-path step events of {@link EVENT_LIST}, as the policy sees them. */
const STEP_START_EVENT = EVENT_LIST.find((event) => event.event === RUN_EVENT.STEP_START)!;
const OK_STEP_END_EVENT = EVENT_LIST.find(
  (event) => event.event === RUN_EVENT.STEP_END && event.outcome === OUTCOME.OK,
)!;

describe('createNdjsonFileSink — `logs.steps`, the step-detail policy', () => {
  it('defaults to `full`, and `full` is byte-for-byte the pre-option writer', async () => {
    // Against the *previous implementation*, verbatim, exactly as the
    // byte-identity suite at the top of this file does — the claim being that
    // adding the option cost the default path nothing, not merely that the
    // option's own two spellings agree with each other.
    const eventList = [...EVENT_LIST, FAILED_STEP_END, LOG_ROTATE_EVENT, FAILED_RUN_END];

    const legacyLog = casePath('legacy', 'run.ndjson');
    const legacyErrorLog = casePath('legacy', 'run.error.ndjson');
    const legacy = createLegacyNdjsonFileSink(legacyLog, legacyErrorLog);
    for (const event of eventList) {
      legacy.emit(event);
    }

    for (const [name, options] of [
      ['unset', undefined],
      ['explicit full', { steps: 'full' as const }],
    ] as const) {
      const log = casePath(name, 'run.ndjson');
      const errorLog = casePath(name, 'run.error.ndjson');
      const sink = createNdjsonFileSink(log, errorLog, options);
      for (const event of eventList) {
        sink.emit(event);
      }
      await sink.close?.();

      expect(readBytes(log)?.equals(readBytes(legacyLog)!)).toBe(true);
      expect(readBytes(errorLog)?.equals(readBytes(legacyErrorLog)!)).toBe(true);
    }
    expect(errorList).toEqual([]);
  });

  it('`summary` drops `input`/`output` and keeps every other field, in order', async () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), { steps: 'summary' });
    for (const event of EVENT_LIST) {
      sink.emit(event);
    }
    await sink.close?.();
    const lineList = readLines(log);

    // Same number of lines — `summary` thins events, never the stream.
    expect(lineList).toHaveLength(EVENT_LIST.length);

    // Written out in full rather than derived by re-running the
    // implementation's own omission: the expectation is the exact bytes,
    // envelope order included (`ts` first, then `run_id`), so a rebuilt object
    // literal that happened to reorder the fields would fail here.
    const stepStartLine = lineList[EVENT_LIST.indexOf(STEP_START_EVENT)];
    expect(stepStartLine).toBe(
      JSON.stringify({ ...ENVELOPE, event: RUN_EVENT.STEP_START, step: STEP }),
    );
    const stepEndLine = lineList[EVENT_LIST.indexOf(OK_STEP_END_EVENT)];
    expect(stepEndLine).toBe(
      JSON.stringify({
        ...ENVELOPE,
        event: RUN_EVENT.STEP_END,
        step: STEP,
        outcome: OUTCOME.OK,
        duration_ms: 11,
      }),
    );

    // Concretely: the payload is gone, and the diagnosis is not.
    expect(stepEndLine).not.toContain('slept_ms');
    expect(stepStartLine).not.toContain('sleep_ms');
    for (const line of [stepStartLine, stepEndLine]) {
      expect(line).toMatch(/^\{"ts":"2026-08-15T10:11:12\.345Z","run_id":"run-/);
      expect(line).toContain('"step":{"index":2');
    }
    // A failed step.end keeps `outcome`, `duration_ms`, `timed_out`,
    // `timeout_ms`, `error` and `severity` — everything but the payload.
    const failedStepLine = lineList.find(
      (line) => line.includes('"step.end"') && line.includes('"error"'),
    );
    expect(failedStepLine).toBe(
      JSON.stringify(
        EVENT_LIST.find(
          (event) => event.event === RUN_EVENT.STEP_END && event.outcome === OUTCOME.ERROR,
        ),
      ),
    );

    // Every other kind is untouched, byte for byte.
    for (const [index, event] of EVENT_LIST.entries()) {
      if (event === STEP_START_EVENT || event === OK_STEP_END_EVENT) {
        continue;
      }
      expect(lineList[index]).toBe(JSON.stringify(event));
    }
  });

  it('`off` writes no `step.start`/`step.end` at all, and nothing else changes', async () => {
    const eventList = [...EVENT_LIST, LOG_ROTATE_EVENT];
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), { steps: 'off' });
    for (const event of eventList) {
      sink.emit(event);
    }
    await sink.close?.();

    const kept = eventList.filter(
      (event) =>
        event.event !== RUN_EVENT.STEP_START && event.event !== RUN_EVENT.STEP_END,
    );
    // Not vacuous: three step events were emitted and none survived.
    expect(eventList.length - kept.length).toBe(3);
    expect(readLines(log)).toEqual(kept.map((event) => JSON.stringify(event)));
  });

  it('never filters the events a reader depends on, even under `off`', async () => {
    // `log.rotate` is the load-bearing one: it must be the first line of every
    // new segment, in every sink (OBSERVABILITY.md, "Event kinds"), and a
    // reader that finds a segment without one treats the file as damaged. The
    // rest are the events that say a run happened and how it ended —
    // `logs.steps` bounds step payloads, it is not a way to thin the stream.
    const mustSurvive: readonly RunEvent[] = [
      LOG_ROTATE_EVENT,
      ...EVENT_LIST.filter(
        (event) =>
          event.event !== RUN_EVENT.STEP_START && event.event !== RUN_EVENT.STEP_END,
      ),
    ];
    // The list above genuinely covers every non-step kind of the union.
    expect(new Set(mustSurvive.map((event) => event.event))).toEqual(
      new Set([
        RUN_EVENT.RUN_START,
        RUN_EVENT.RUN_END,
        RUN_EVENT.LOG,
        RUN_EVENT.LOG_ROTATE,
        RUN_EVENT.STORAGE_SEED,
        RUN_EVENT.SEED_OVERRIDE_APPLIED,
        RUN_EVENT.BOOTSTRAP_ERROR,
        RUN_EVENT.RUN_HEARTBEAT,
        RUN_EVENT.STEP_PROGRESS,
      ]),
    );

    for (const steps of ['full', 'summary', 'off'] as const) {
      const log = casePath(steps, 'run.ndjson');
      const sink = createNdjsonFileSink(log, casePath(steps, 'run.error.ndjson'), { steps });
      for (const event of mustSurvive) {
        sink.emit(event);
      }
      await sink.close?.();
      // Byte for byte, under every value: none of these kinds is transformed
      // either.
      expect(readLines(log)).toEqual(mustSurvive.map((event) => JSON.stringify(event)));
    }
  });

  it.each(['full', 'summary', 'off'] as const)(
    'leaves the error log at full fidelity under `%s`',
    async (steps) => {
      // The invariant the whole policy is bounded by: losing successful step
      // records is the trade an operator makes, losing the failing step's
      // `input`/`output` is not. `isFailureEvent`'s route carries no transform
      // under any value.
      const eventList = [...EVENT_LIST, FAILED_STEP_END, FAILED_RUN_END];
      const errorLog = casePath('run.error.ndjson');
      const sink = createNdjsonFileSink(casePath('run.ndjson'), errorLog, { steps });
      for (const event of eventList) {
        sink.emit(event);
      }
      await sink.close?.();

      const expected = eventList.filter(
        (event) =>
          event.event === RUN_EVENT.BOOTSTRAP_ERROR ||
          ('outcome' in event && event.outcome === OUTCOME.ERROR),
      );
      expect(readLines(errorLog)).toEqual(expected.map((event) => JSON.stringify(event)));
      // Concretely: the failed step's output is still there under `off`.
      expect(readLines(errorLog).join('\n')).toContain(
        'what the handler managed before it failed',
      );
    },
  );

  it('encodes once for routes that share a shape, and once more for one that does not', () => {
    // The fan-out memoises the encoded line per distinct transform, so the two
    // files of a `full` sink cost one `JSON.stringify` between them — the
    // property that keeps the default free. A getter counts the reads rather
    // than a spy on `JSON.stringify`, which the writer underneath may also
    // call.
    const failedStepEndWithCountedOutput = (): { event: RunEvent; readCount: () => number } => {
      let readCount = 0;
      const event = {
        ...ENVELOPE,
        event: RUN_EVENT.STEP_END,
        step: STEP,
        outcome: OUTCOME.ERROR,
        duration_ms: 13,
        get output() {
          readCount += 1;
          return { partial: 'x' };
        },
        error: { message: 'boom' },
        severity: SEVERITY.ERROR,
      } as unknown as RunEvent;
      return { event, readCount: () => readCount };
    };

    // `full`: main and error routes want the same bytes — one encode.
    const shared = failedStepEndWithCountedOutput();
    const sharedSink = createNdjsonFileSink(
      casePath('full', 'run.ndjson'),
      casePath('full', 'run.error.ndjson'),
    );
    sharedSink.emit(shared.event);
    expect(shared.readCount()).toBe(1);
    expect(readLines(casePath('full', 'run.ndjson'))).toHaveLength(1);
    expect(readLines(casePath('full', 'run.error.ndjson'))).toHaveLength(1);

    // `summary`: the two routes now want different bytes, so this event costs
    // two — one read to strip the payload for the main log, one to encode it
    // whole for the error log. That is the price of the error log's fidelity,
    // and it is paid on failures only.
    const split = failedStepEndWithCountedOutput();
    const splitSink = createNdjsonFileSink(
      casePath('summary', 'run.ndjson'),
      casePath('summary', 'run.error.ndjson'),
      { steps: 'summary' },
    );
    splitSink.emit(split.event);
    expect(split.readCount()).toBe(2);
  });
});

describe('createNdjsonStdoutSink — the same stream on a descriptor', () => {
  it('writes byte-for-byte the main log file to the descriptor it is given', async () => {
    const log = casePath('run.ndjson');
    const mirror = casePath('stdout.ndjson');
    const fd = fsSync.openSync(mirror, 'a');
    try {
      const fileSink = createNdjsonFileSink(log, casePath('run.error.ndjson'));
      const streamSink = createNdjsonStdoutSink({}, fd);
      for (const event of [...EVENT_LIST, FAILED_RUN_END]) {
        fileSink.emit(event);
        streamSink.emit(event);
      }
      await fileSink.close?.();
      await streamSink.close?.();

      expect(readBytes(mirror)?.equals(readBytes(log)!)).toBe(true);
    } finally {
      // Still open: the sink never closes a descriptor it did not open, which
      // is what keeps fd 1 usable for whatever the process prints next.
      expect(() => fsSync.fstatSync(fd)).not.toThrow();
      fsSync.closeSync(fd);
    }
  });

  it('gets every event — a descriptor stream is not the filtered error view', async () => {
    const mirror = casePath('stdout.ndjson');
    const fd = fsSync.openSync(mirror, 'a');
    try {
      const sink = createNdjsonStdoutSink({}, fd);
      for (const event of EVENT_LIST) {
        sink.emit(event);
      }
      await sink.close?.();
      expect(readLines(mirror)).toHaveLength(EVENT_LIST.length);
    } finally {
      fsSync.closeSync(fd);
    }
  });

  it.each(['full', 'summary', 'off'] as const)(
    'honours `logs.steps: %s`, staying byte-for-byte the main log file',
    async (steps) => {
      // This sink's entire contract is "the main log's lines, on a
      // descriptor". A `logs.steps` value the file honoured and the descriptor
      // ignored would make that false the first time anyone set it — and would
      // hand a systemd/Docker log stack the very payloads the operator turned
      // off to keep off their disk.
      const log = casePath('run.ndjson');
      const mirror = casePath('stdout.ndjson');
      const fd = fsSync.openSync(mirror, 'a');
      try {
        const fileSink = createNdjsonFileSink(log, casePath('run.error.ndjson'), { steps });
        const streamSink = createNdjsonStdoutSink({ steps }, fd);
        for (const event of [...EVENT_LIST, LOG_ROTATE_EVENT, FAILED_STEP_END]) {
          fileSink.emit(event);
          streamSink.emit(event);
        }
        await fileSink.close?.();
        await streamSink.close?.();

        expect(readBytes(mirror)?.equals(readBytes(log)!)).toBe(true);
        // Not vacuous: `off` really did drop lines from both.
        expect(readLines(mirror).some((line) => line.includes('"step.start"'))).toBe(
          steps !== 'off',
        );
      } finally {
        fsSync.closeSync(fd);
      }
    },
  );

  it('is synchronous by default here as well', () => {
    const mirror = casePath('stdout.ndjson');
    const fd = fsSync.openSync(mirror, 'a');
    try {
      const sink = createNdjsonStdoutSink({}, fd);
      sink.emit(EVENT_LIST[0]!);
      expect(readLines(mirror)).toEqual([JSON.stringify(EVENT_LIST[0])]);
    } finally {
      fsSync.closeSync(fd);
    }
  });
});
