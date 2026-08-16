import { describe, it, expect } from 'vitest';
import type { RunEvent, RunEventStep } from '@rawbox/runner';

import {
  createTerminalSink,
  resolveDefaultOutputMode,
} from '../src/render/terminal-sink.js';

// ---------------------------------------------------------------------------
// A captured writer, plus an ANSI-stripping accessor — same technique
// `run.test.ts` uses for `@clack/prompts` output, applied here to the raw
// lines the sink writes directly to its `write` callback.
// ---------------------------------------------------------------------------

function makeCapture(): { write: (text: string) => void; lines: () => string[]; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (text: string) => chunks.push(text),
    // eslint-disable-next-line no-control-regex
    lines: () => chunks.join('').replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => l.length > 0),
    // eslint-disable-next-line no-control-regex
    text: () => chunks.join('').replace(/\x1b\[[0-9;]*m/g, ''),
  };
}

const RUN_ID = 'run-test-0001';
const WORKSPACE = 'ws-example';
const WORKFLOW = 'wf-example';

function step(overrides: Partial<RunEventStep> = {}): RunEventStep {
  return {
    index: 0,
    iteration: 0,
    label: 'sleep-step',
    plugin: '@rawbox/rawbox-plugin-default',
    operation: 'time/sleep',
    registry_hash: 'deadbeef',
    ...overrides,
  };
}

function runStart(): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'run.start',
    format: 1,
  };
}

function stepStart(s: RunEventStep, input?: Record<string, unknown>): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'step.start',
    step: s,
    ...(input === undefined ? {} : { input }),
  };
}

function stepEndOk(s: RunEventStep, durationMs: number, output?: Record<string, unknown>): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'step.end',
    step: s,
    outcome: 'ok',
    duration_ms: durationMs,
    ...(output === undefined ? {} : { output }),
  };
}

// Deliberately carries no `severity` field — this is the "old NDJSON stream"
// shape the backward-tolerance tests below exercise, alongside the ordinary
// pretty/quiet tests that use it.
function stepEndError(s: RunEventStep, durationMs: number, message: string): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'step.end',
    step: s,
    outcome: 'error',
    duration_ms: durationMs,
    error: { message },
  };
}

/** The current-format counterpart of {@link stepEndError}: carries `severity` explicitly. */
function stepEndErrorWithSeverity(s: RunEventStep, durationMs: number, message: string): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'step.end',
    step: s,
    outcome: 'error',
    duration_ms: durationMs,
    error: { message },
    severity: 'error',
  };
}

function logEvent(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  s?: RunEventStep,
): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'log',
    level,
    message,
    ...(s === undefined ? {} : { step: s }),
  };
}

function runEnd(outcome: 'ok' | 'error', stepsTotal: number, stepsFailed: number, durationMs: number): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'run.end',
    outcome,
    duration_ms: durationMs,
    steps_total: stepsTotal,
    steps_failed: stepsFailed,
  };
}

function bootstrapError(stage: 'workspace' | 'workflow' | 'lock' | 'resolve' | 'seed-validation' | 'seed-override' | 'store' | 'seed', message: string): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    event: 'bootstrap.error',
    stage,
    message,
    severity: 'error',
  };
}

function runHeartbeat(s: RunEventStep, inFlightMs: number): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'run.heartbeat',
    step: s,
    in_flight_ms: inFlightMs,
  };
}

function stepProgress(
  s?: RunEventStep,
  message?: string,
  data?: unknown,
): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'step.progress',
    ...(message === undefined ? {} : { message }),
    ...(data === undefined ? {} : { data }),
    ...(s === undefined ? {} : { step: s }),
  };
}

function logRotate(
  sealedSegment: number,
  liveSegment: number,
  deletedSegment: number | undefined,
  maxFiles = 8,
): RunEvent {
  return {
    ts: new Date().toISOString(),
    run_id: RUN_ID,
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    event: 'log.rotate',
    sealed_segment: sealedSegment,
    live_segment: liveSegment,
    max_bytes: 134_217_728,
    max_files: maxFiles,
    ...(deletedSegment === undefined
      ? {}
      : { deleted_segment: deletedSegment, severity: 'warn' as const }),
  };
}

const LOG_FILE = '/tmp/example/run-test-0001.ndjson';
const ERROR_LOG_FILE = '/tmp/example/run-test-0001.error.ndjson';

describe('createTerminalSink — pretty', () => {
  it('renders a header, one line per successful step, and a recap with the log path', () => {
    const stepA = step({ index: 0, label: 'sleep-step', operation: 'time/sleep' });
    const stepB = step({ index: 1, label: 'done', operation: 'control-flow/halt' });
    const capture = makeCapture();
    const sink = createTerminalSink({
      mode: 'pretty',
      logFilePath: LOG_FILE,
      errorLogFilePath: ERROR_LOG_FILE,
      write: capture.write,
    });

    sink.emit(runStart());
    sink.emit(stepStart(stepA));
    sink.emit(stepEndOk(stepA, 502));
    sink.emit(stepStart(stepB));
    sink.emit(stepEndOk(stepB, 1));
    sink.emit(runEnd('ok', 2, 0, 812));

    const text = capture.text();
    expect(text).toContain(`WORKFLOW ${WORKFLOW} (workspace ${WORKSPACE})`);
    expect(text).toContain('✔');
    expect(text).toContain('sleep-step');
    expect(text).toContain('time/sleep');
    expect(text).toContain('502ms');
    expect(text).toContain('done');
    expect(text).toContain('control-flow/halt');
    expect(text).toContain('RECAP');
    expect(text).toContain('ok=2 failed=0 skipped=0');
    expect(text).toContain('812ms');
    expect(text).toContain(LOG_FILE);
    // A clean run never needs the error log surfaced.
    expect(text).not.toContain(ERROR_LOG_FILE);
  });

  it('marks a failing step with ✘ and prints its error message, and the recap counts it', () => {
    const okStep = step({ index: 0, label: 'sleep-step', operation: 'time/sleep' });
    const failingStep = step({ index: 1, label: 'boom', operation: 'value-ops/compare' });
    const capture = makeCapture();
    const sink = createTerminalSink({
      mode: 'pretty',
      logFilePath: LOG_FILE,
      errorLogFilePath: ERROR_LOG_FILE,
      write: capture.write,
    });

    sink.emit(runStart());
    sink.emit(stepStart(okStep));
    sink.emit(stepEndOk(okStep, 10));
    sink.emit(stepStart(failingStep));
    sink.emit(stepEndError(failingStep, 3, 'comparison operand missing'));
    sink.emit(runEnd('error', 2, 1, 15));

    const text = capture.text();
    expect(text).toContain('✘');
    expect(text).toContain('boom');
    expect(text).toContain('comparison operand missing');
    expect(text).toContain('ok=1 failed=1 skipped=0');
    // A failed run surfaces both paths.
    expect(text).toContain(LOG_FILE);
    expect(text).toContain(ERROR_LOG_FILE);
  });

  it('renders `log` events as indented lines', () => {
    const s = step();
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', write: capture.write });

    sink.emit(runStart());
    sink.emit(stepStart(s));
    sink.emit(logEvent('info', 'counted one pass', s));
    sink.emit(stepEndOk(s, 5));
    sink.emit(runEnd('ok', 1, 0, 5));

    const lines = capture.lines();
    const logLineIndex = lines.findIndex((l) => l.includes('counted one pass'));
    const stepLineIndex = lines.findIndex((l) => l.includes('✔') && l.includes('sleep-step'));
    expect(logLineIndex).toBeGreaterThan(-1);
    expect(stepLineIndex).toBeGreaterThan(-1);
    // The log line is indented, unlike the step summary line.
    expect(lines[logLineIndex]?.startsWith('    ')).toBe(true);
    // It appears before the step's own summary line, since the log operation
    // ran inside the step's start/end window.
    expect(logLineIndex).toBeLessThan(stepLineIndex);
  });

  it('at -v, prints each step\'s input/output storage keys', () => {
    const s = step();
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', verbosity: 1, write: capture.write });

    sink.emit(runStart());
    sink.emit(stepStart(s, { ms: 1 }));
    sink.emit(stepEndOk(s, 5, { timestamp: 123456 }));
    sink.emit(runEnd('ok', 1, 0, 5));

    const text = capture.text();
    expect(text).toContain('in:');
    expect(text).toContain('ms=1');
    expect(text).toContain('out:');
    expect(text).toContain('timestamp=123456');
  });

  it('at -v, drops an oversized value to a byte-count placeholder rather than printing it', () => {
    const s = step();
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', verbosity: 1, write: capture.write });
    const bigValue = 'x'.repeat(1000);

    sink.emit(runStart());
    sink.emit(stepStart(s, { payload: bigValue }));
    sink.emit(stepEndOk(s, 5));
    sink.emit(runEnd('ok', 1, 0, 5));

    const text = capture.text();
    expect(text).not.toContain(bigValue);
    expect(text).toMatch(/payload=<\d+ bytes>/);
  });

  it('at -vv, prints full values but ellipsises past ~500 chars', () => {
    const s = step();
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', verbosity: 2, write: capture.write });
    const bigValue = 'y'.repeat(1000);

    sink.emit(runStart());
    sink.emit(stepStart(s, { payload: bigValue }));
    sink.emit(stepEndOk(s, 5));
    sink.emit(runEnd('ok', 1, 0, 5));

    const text = capture.text();
    expect(text).toContain('y'.repeat(500));
    expect(text).not.toContain(bigValue);
    expect(text).toContain('…');
  });

  it('at -vvv, prints run identity, storage.seed detail, and step registry hashes', () => {
    const s = step({ registry_hash: 'abc123' });
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', verbosity: 3, write: capture.write });

    sink.emit(runStart());
    sink.emit({
      ts: new Date().toISOString(),
      run_id: RUN_ID,
      workspace: WORKSPACE,
      workflow: WORKFLOW,
      event: 'storage.seed',
      seed_count: 3,
      key_count: 2,
      keys: ['counter', 'limit'],
      duration_ms: 2,
    });
    sink.emit(stepStart(s));
    sink.emit(stepEndOk(s, 5));
    sink.emit(runEnd('ok', 1, 0, 5));

    const text = capture.text();
    expect(text).toContain(RUN_ID);
    expect(text).toContain('format=1');
    expect(text).toContain('counter');
    expect(text).toContain('limit');
    expect(text).toContain('abc123');
  });

  it('renders a bootstrap failure clearly, with the log paths, and no WORKFLOW header', () => {
    const capture = makeCapture();
    const sink = createTerminalSink({
      mode: 'pretty',
      logFilePath: LOG_FILE,
      errorLogFilePath: ERROR_LOG_FILE,
      write: capture.write,
    });

    sink.emit(bootstrapError('resolve', 'plugin "acme-widgets" could not be resolved'));

    const text = capture.text();
    expect(text).not.toContain('WORKFLOW');
    expect(text).toContain('bootstrap error');
    expect(text).toContain('resolve');
    expect(text).toContain('plugin "acme-widgets" could not be resolved');
    expect(text).toContain(LOG_FILE);
    expect(text).toContain(ERROR_LOG_FILE);
  });

  it('does not repeat the log paths or the diagnostic when a bootstrap failure is followed by run.end', () => {
    // Only the two earliest preflight stages (workspace/workflow loading)
    // precede `run.start`; every later one — `resolve` here — fails *after*
    // it, so the producer's own contract still emits a `run.end`. The sink
    // must fold the paths and the message into the one RECAP rather than
    // printing them once per event.
    const capture = makeCapture();
    const sink = createTerminalSink({
      mode: 'pretty',
      logFilePath: LOG_FILE,
      errorLogFilePath: ERROR_LOG_FILE,
      write: capture.write,
    });

    sink.emit(runStart());
    sink.emit(bootstrapError('resolve', 'plugin "acme-widgets" could not be resolved'));
    sink.emit({
      ts: new Date().toISOString(),
      run_id: RUN_ID,
      workspace: WORKSPACE,
      workflow: WORKFLOW,
      event: 'run.end',
      outcome: 'error',
      duration_ms: 4,
      steps_total: 0,
      steps_failed: 0,
      error: { message: 'plugin "acme-widgets" could not be resolved' },
    });

    const text = capture.text();
    expect(text).toContain('bootstrap error');
    expect(text).toContain('RECAP');
    expect(countOccurrences(text, LOG_FILE)).toBe(1);
    expect(countOccurrences(text, ERROR_LOG_FILE)).toBe(1);
    expect(countOccurrences(text, 'plugin "acme-widgets" could not be resolved')).toBe(1);
  });
});

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('createTerminalSink — pretty — run.heartbeat / step.progress', () => {
  it('renders a heartbeat as an ephemeral line naming the step and how long it has run', () => {
    const s = step({ label: 'long-step' });
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', write: capture.write });

    sink.emit(runStart());
    sink.emit(stepStart(s));
    sink.emit(runHeartbeat(s, 4500));
    sink.emit(stepEndOk(s, 5000));
    sink.emit(runEnd('ok', 1, 0, 5000));

    const text = capture.text();
    expect(text).toContain('long-step');
    expect(text).toContain('4500ms');
  });

  it('renders step.progress with its message and, at -vv, its data', () => {
    const s = step();
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', verbosity: 2, write: capture.write });

    sink.emit(runStart());
    sink.emit(stepStart(s));
    sink.emit(stepProgress(s, 'halfway there', { processed: 5, total: 10 }));
    sink.emit(stepEndOk(s, 10));
    sink.emit(runEnd('ok', 1, 0, 10));

    const text = capture.text();
    expect(text).toContain('halfway there');
    expect(text).toContain('processed');
  });

  it('renders step.progress with no message using a placeholder rather than printing nothing', () => {
    const s = step();
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', write: capture.write });

    sink.emit(runStart());
    sink.emit(stepStart(s));
    sink.emit(stepProgress(s, undefined, { processed: 1 }));
    sink.emit(stepEndOk(s, 10));
    sink.emit(runEnd('ok', 1, 0, 10));

    // Doesn't throw, and prints a placeholder rather than an empty message.
    expect(capture.text()).toContain('(progress)');
  });
});

describe('createTerminalSink — pretty — log.rotate', () => {
  it('prints nothing for a routine roll that deleted no segment', () => {
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', write: capture.write });

    sink.emit(runStart());
    sink.emit(logRotate(0, 1, undefined));
    sink.emit(runEnd('ok', 0, 0, 10));

    // A human watching a run does not need a line every `maxBytes` — only a
    // roll that actually discarded history is worth interrupting them for.
    expect(capture.text()).not.toContain('rotated');
  });

  it('prints a line naming the sealed, live and deleted segments when history was actually dropped', () => {
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'pretty', write: capture.write });

    sink.emit(runStart());
    sink.emit(logRotate(4, 5, 1, 4));
    sink.emit(runEnd('ok', 0, 0, 10));

    const text = capture.text();
    expect(text).toContain('segment 4 sealed');
    expect(text).toContain('segment 5 now live');
    expect(text).toContain('segment 1 deleted');
    expect(text).toContain('maxFiles=4');
  });
});

describe('createTerminalSink — quiet', () => {
  it('prints only the recap and error-shaped lines, never a passing step or the header', () => {
    const okStep = step({ index: 0, label: 'sleep-step' });
    const failingStep = step({ index: 1, label: 'boom' });
    const capture = makeCapture();
    const sink = createTerminalSink({
      mode: 'quiet',
      logFilePath: LOG_FILE,
      errorLogFilePath: ERROR_LOG_FILE,
      write: capture.write,
    });

    sink.emit(runStart());
    sink.emit(stepStart(okStep));
    sink.emit(stepEndOk(okStep, 10));
    sink.emit(logEvent('info', 'a routine line', okStep));
    sink.emit(stepStart(failingStep));
    sink.emit(stepEndError(failingStep, 3, 'it broke'));
    sink.emit(runEnd('error', 2, 1, 15));

    const text = capture.text();
    expect(text).not.toContain('WORKFLOW');
    expect(text).not.toContain('sleep-step');
    expect(text).not.toContain('a routine line');
    expect(text).toContain('boom');
    expect(text).toContain('it broke');
    expect(text).toContain('RECAP');
    expect(text).toContain('ok=1 failed=1 skipped=0');
  });

  it('still renders a bootstrap failure', () => {
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'quiet', write: capture.write });

    sink.emit(bootstrapError('workspace', 'no workspace document found'));

    expect(capture.text()).toContain('no workspace document found');
  });

  it('never shows a run.heartbeat or step.progress — neither carries severity', () => {
    const s = step();
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'quiet', write: capture.write });

    sink.emit(runStart());
    sink.emit(stepStart(s));
    sink.emit(runHeartbeat(s, 4500));
    sink.emit(stepProgress(s, 'halfway there', { processed: 5 }));
    sink.emit(stepEndOk(s, 5000));
    sink.emit(runEnd('ok', 1, 0, 5000));

    const text = capture.text();
    expect(text).not.toContain('halfway there');
    expect(text).not.toContain('4500');
    expect(text).toContain('RECAP');
  });

  it('shows an error-severity log/step exactly the same whether severity is explicit or (old-format) implicit', () => {
    // Two runs, one with the field the current producer always sets, one
    // without it (an NDJSON line written before `severity` existed) — quiet
    // mode's gate must treat them identically (OBSERVABILITY.md,
    // "Versioning": a reader must ignore an event kind it does not recognise
    // and an envelope field it does not know).
    const failingStep = step({ index: 1, label: 'boom' });

    const withField = makeCapture();
    createTerminalSink({ mode: 'quiet', write: withField.write }).emit(
      stepEndErrorWithSeverity(failingStep, 3, 'it broke'),
    );

    const withoutField = makeCapture();
    createTerminalSink({ mode: 'quiet', write: withoutField.write }).emit(
      stepEndError(failingStep, 3, 'it broke'),
    );

    expect(withField.text()).toContain('it broke');
    expect(withoutField.text()).toContain('it broke');
    expect(withField.text()).toBe(withoutField.text());
  });

  it('never shows a log/step.end that carries no severity at all — an ok outcome, an info log', () => {
    const okStep = step();
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'quiet', write: capture.write });

    sink.emit(runStart());
    sink.emit(stepStart(okStep));
    sink.emit(logEvent('debug', 'a debug line'));
    sink.emit(logEvent('info', 'an info line'));
    sink.emit(stepEndOk(okStep, 5));
    sink.emit(runEnd('ok', 1, 0, 5));

    const text = capture.text();
    expect(text).not.toContain('a debug line');
    expect(text).not.toContain('an info line');
    expect(text).not.toContain('sleep-step');
  });

  it('shows log.rotate only when it deleted a segment — the field that makes it severity-bearing', () => {
    const silent = makeCapture();
    createTerminalSink({ mode: 'quiet', write: silent.write }).emit(logRotate(0, 1, undefined));
    expect(silent.text()).toBe('');

    const loud = makeCapture();
    createTerminalSink({ mode: 'quiet', write: loud.write }).emit(logRotate(4, 5, 1, 4));
    expect(loud.text()).toContain('segment 1 deleted');
  });
});

describe('createTerminalSink — json', () => {
  it('streams every event as one JSON line, matching the file sink\'s own encoding', () => {
    const s = step();
    const capture = makeCapture();
    const sink = createTerminalSink({ mode: 'json', write: capture.write });

    const events = [runStart(), stepStart(s), stepEndOk(s, 5), runEnd('ok', 1, 0, 5)];
    for (const event of events) {
      sink.emit(event);
    }

    const lines = capture.lines();
    expect(lines.length).toBe(events.length);
    lines.forEach((line, index) => {
      expect(JSON.parse(line)).toEqual(events[index]);
    });
  });

  it('ignores verbosity — json is already the full record', () => {
    const s = step();
    const captureLow = makeCapture();
    const captureHigh = makeCapture();
    const sinkLow = createTerminalSink({ mode: 'json', verbosity: 0, write: captureLow.write });
    const sinkHigh = createTerminalSink({ mode: 'json', verbosity: 3, write: captureHigh.write });

    const event = stepEndOk(s, 5, { timestamp: 1 });
    sinkLow.emit(event);
    sinkHigh.emit(event);

    expect(captureLow.text()).toBe(captureHigh.text());
  });
});

describe('resolveDefaultOutputMode', () => {
  it('defaults to pretty on a TTY', () => {
    expect(resolveDefaultOutputMode(true)).toBe('pretty');
  });

  it('defaults to json when piped (not a TTY)', () => {
    expect(resolveDefaultOutputMode(false)).toBe('json');
  });
});
