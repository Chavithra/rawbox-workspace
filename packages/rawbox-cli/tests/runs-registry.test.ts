import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BOOTSTRAP_STAGE, OUTCOME, RUN_EVENT, type RunEvent } from '@rawbox/runner';

import { createRunRegistrySink } from '../src/runs/registry-sink.js';
import { readRegistryEntry, writeRegistryEntrySync } from '../src/runs/registry-io.js';
import { RUN_REGISTRY_FORMAT, RUN_STATUS, DISPLAY_STATUS, isTerminalStatus, type RunRegistryEntry } from '../src/runs/types.js';
import { classifyDisplayStatus } from '../src/runs/classify.js';
import { START_TIME_TOLERANCE_MS, type ProcessProbe } from '../src/runs/pid-probe.js';

// ---------------------------------------------------------------------------
// Registry lifecycle — `createRunRegistrySink` following the event stream
// (OBSERVABILITY.md, "Lifecycle and crash detection").
//
// Unit-level rather than a full `runWorkflowCommand` run: the sink's own
// transition logic is what has to get every terminal status right, and
// feeding it a synthetic event sequence exercises that precisely and fast,
// without spinning up a real plugin/workflow per scenario. `runs-lifecycle.
// test.ts` covers the same lifecycle end-to-end through the real CLI wiring.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-runs-registry-test');

function baseEntry(runId: string): RunRegistryEntry {
  return {
    format: RUN_REGISTRY_FORMAT,
    run_id: runId,
    workspace: 'ws',
    workflow: 'wf',
    pid: 12345,
    pid_started_at: 1_700_000_000_000,
    started_at: '2026-08-09T00:00:00.000Z',
    log_path: '/tmp/does-not-matter.ndjson',
    error_log_path: '/tmp/does-not-matter.error.ndjson',
    status: RUN_STATUS.BOOTSTRAPPING,
  };
}

function runStart(runId: string): RunEvent {
  return {
    ts: '2026-08-09T00:00:01.000Z',
    run_id: runId,
    workspace: 'ws',
    workflow: 'wf',
    event: RUN_EVENT.RUN_START,
    format: 1,
  };
}

function runEnd(runId: string, outcome: (typeof OUTCOME)[keyof typeof OUTCOME]): RunEvent {
  return {
    ts: '2026-08-09T00:00:02.000Z',
    run_id: runId,
    workspace: 'ws',
    workflow: 'wf',
    event: RUN_EVENT.RUN_END,
    outcome,
    duration_ms: 1000,
    steps_total: 2,
    steps_failed: outcome === OUTCOME.ERROR ? 1 : 0,
    ...(outcome === OUTCOME.ERROR ? { error: { message: 'step failed' } } : {}),
  };
}

function bootstrapError(runId: string): RunEvent {
  return {
    ts: '2026-08-09T00:00:01.500Z',
    run_id: runId,
    workspace: 'ws',
    workflow: 'wf',
    event: RUN_EVENT.BOOTSTRAP_ERROR,
    stage: BOOTSTRAP_STAGE.RESOLVE,
    message: 'plugin not found',
    severity: 'error',
  };
}

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('run registry — lifecycle transitions', () => {
  it('a successful run ends "ok", with duration and step counts recorded', async () => {
    const runId = 'run-ok-1';
    const filePath = path.join(rootDir, `${runId}.json`);
    writeRegistryEntrySync(filePath, baseEntry(runId));

    const sink = createRunRegistrySink(filePath);
    sink.emit(runStart(runId));

    // Between `run.start` and `run.end`, the entry is `running` — this is
    // what makes a crash mid-run distinguishable from one in bootstrap.
    const mid = await readRegistryEntry(filePath);
    expect(mid?.status).toBe(RUN_STATUS.RUNNING);

    sink.emit(runEnd(runId, OUTCOME.OK));

    const final = await readRegistryEntry(filePath);
    expect(final?.status).toBe(RUN_STATUS.OK);
    expect(final?.duration_ms).toBe(1000);
    expect(final?.steps_total).toBe(2);
    expect(final?.steps_failed).toBe(0);
    expect(final?.ended_at).toBeDefined();
    expect(final?.error).toBeUndefined();
  });

  it('a failing run ends "error", with the error message recorded', async () => {
    const runId = 'run-error-1';
    const filePath = path.join(rootDir, `${runId}.json`);
    writeRegistryEntrySync(filePath, baseEntry(runId));

    const sink = createRunRegistrySink(filePath);
    sink.emit(runStart(runId));
    sink.emit(runEnd(runId, OUTCOME.ERROR));

    const final = await readRegistryEntry(filePath);
    expect(final?.status).toBe(RUN_STATUS.ERROR);
    expect(final?.error?.message).toBe('step failed');
    expect(final?.steps_failed).toBe(1);
  });

  it('an interrupted run ends "interrupted" — terminal, with duration and step counts but no error', async () => {
    // A graceful operator stop (SIGTERM/SIGINT): the run still wrote its
    // `run.end`, with `outcome: "interrupted"` (OBSERVABILITY.md,
    // "Event kinds" and "Lifecycle and crash detection"). The registry records it as its own terminal status —
    // ended_at/duration/steps exactly as for ok/error, never an `error`
    // field, because an operator stop is intent, not a failure.
    const runId = 'run-interrupted-1';
    const filePath = path.join(rootDir, `${runId}.json`);
    writeRegistryEntrySync(filePath, baseEntry(runId));

    const sink = createRunRegistrySink(filePath);
    sink.emit(runStart(runId));
    sink.emit(runEnd(runId, OUTCOME.INTERRUPTED));

    const final = await readRegistryEntry(filePath);
    expect(final?.status).toBe(RUN_STATUS.INTERRUPTED);
    expect(final?.ended_at).toBeDefined();
    expect(final?.duration_ms).toBe(1000);
    expect(final?.steps_total).toBe(2);
    expect(final?.steps_failed).toBe(0);
    expect(final?.error).toBeUndefined();

    expect(isTerminalStatus(RUN_STATUS.INTERRUPTED)).toBe(true);
  });

  it('a bootstrap failure ends "bootstrap-failed" even when a `run.end` follows it', async () => {
    // The `lock`/`resolve`/`seed-validation`/`store`/`seed` preflight stages fail
    // *after* `run.start` has already fired, so `RunEventProducer.end` still
    // emits a `run.end` with `outcome: "error"` right behind the
    // `bootstrap.error` (see `event-types.ts`'s `BOOTSTRAP_STAGE` and
    // `producer.ts`'s `end()`). The registry must keep the more specific
    // `bootstrap-failed` status, not let that `run.end` overwrite it with
    // plain `error`.
    const runId = 'run-bootstrap-failed-1';
    const filePath = path.join(rootDir, `${runId}.json`);
    writeRegistryEntrySync(filePath, baseEntry(runId));

    const sink = createRunRegistrySink(filePath);
    sink.emit(runStart(runId));
    sink.emit(bootstrapError(runId));

    const afterBootstrapError = await readRegistryEntry(filePath);
    expect(afterBootstrapError?.status).toBe(RUN_STATUS.BOOTSTRAP_FAILED);

    sink.emit(runEnd(runId, OUTCOME.ERROR));

    const final = await readRegistryEntry(filePath);
    expect(final?.status).toBe(RUN_STATUS.BOOTSTRAP_FAILED);
    expect(final?.error?.message).toBe('plugin not found');
  });

  it('a bootstrap failure with no `run.start` at all (pre-identity) still ends "bootstrap-failed"', async () => {
    const runId = 'run-bootstrap-failed-early';
    const filePath = path.join(rootDir, `${runId}.json`);
    writeRegistryEntrySync(filePath, baseEntry(runId));

    const sink = createRunRegistrySink(filePath);
    sink.emit(bootstrapError(runId));

    const final = await readRegistryEntry(filePath);
    expect(final?.status).toBe(RUN_STATUS.BOOTSTRAP_FAILED);
  });
});

// ---------------------------------------------------------------------------
// Crash detection (`classifyDisplayStatus`) — dead pid and pid-reuse
// simulations, via an injected fake probe rather than a real process.
// ---------------------------------------------------------------------------

describe('run registry — crash detection', () => {
  it('reports "crashed" for a non-terminal entry whose pid is dead', () => {
    const entry = baseEntry('run-dead-pid');
    const runningEntry: RunRegistryEntry = { ...entry, status: RUN_STATUS.RUNNING };

    const deadProbe = (): ProcessProbe => ({ alive: false });

    expect(classifyDisplayStatus(runningEntry, deadProbe)).toBe(DISPLAY_STATUS.CRASHED);
  });

  it('reports "crashed" for a recycled pid — same number, alive, wrong start time', () => {
    const entry = baseEntry('run-recycled-pid');
    const runningEntry: RunRegistryEntry = {
      ...entry,
      status: RUN_STATUS.RUNNING,
      pid_started_at: 1_700_000_000_000,
    };

    // Alive, but a *different* process now holds this pid: its start time is
    // far outside the tolerance window.
    const recycledProbe = (): ProcessProbe => ({
      alive: true,
      startedAtMs: 1_700_000_000_000 + START_TIME_TOLERANCE_MS * 100,
    });

    expect(classifyDisplayStatus(runningEntry, recycledProbe)).toBe(DISPLAY_STATUS.CRASHED);
  });

  it('reports the true status when the pid is alive and its start time matches within tolerance', () => {
    const entry = baseEntry('run-alive');
    const runningEntry: RunRegistryEntry = {
      ...entry,
      status: RUN_STATUS.RUNNING,
      pid_started_at: 1_700_000_000_000,
    };

    const matchingProbe = (): ProcessProbe => ({
      alive: true,
      startedAtMs: 1_700_000_000_000 + 500, // well within START_TIME_TOLERANCE_MS
    });

    expect(classifyDisplayStatus(runningEntry, matchingProbe)).toBe(RUN_STATUS.RUNNING);
  });

  it('reports "bootstrapping" as-is when its pid is alive and matches', () => {
    const entry = baseEntry('run-still-bootstrapping');
    const matchingProbe = (): ProcessProbe => ({
      alive: true,
      startedAtMs: entry.pid_started_at,
    });

    expect(classifyDisplayStatus(entry, matchingProbe)).toBe(RUN_STATUS.BOOTSTRAPPING);
  });

  it('never probes a terminal status — "ok"/"error"/"interrupted"/"bootstrap-failed" are trusted as-is', () => {
    const deadProbe = (): ProcessProbe => ({ alive: false });

    for (const status of [
      RUN_STATUS.OK,
      RUN_STATUS.ERROR,
      RUN_STATUS.INTERRUPTED,
      RUN_STATUS.BOOTSTRAP_FAILED,
    ] as const) {
      const entry: RunRegistryEntry = { ...baseEntry(`run-${status}`), status };
      expect(classifyDisplayStatus(entry, deadProbe)).toBe(status);
    }
  });

  it('a terminal "interrupted" entry is never reclassified "crashed", even with its pid long gone', () => {
    // The whole point of the distinction (OBSERVABILITY.md, "Lifecycle and crash detection"): a
    // SIGTERMed run wrote its `run.end` and its terminal status — its process
    // being gone is expected, not a crash. SIGKILL, which writes nothing,
    // still leaves a non-terminal entry and still classifies `crashed`.
    const entry: RunRegistryEntry = {
      ...baseEntry('run-interrupted-dead-pid'),
      status: RUN_STATUS.INTERRUPTED,
      ended_at: '2026-08-09T00:00:02.000Z',
      duration_ms: 1000,
      steps_total: 2,
      steps_failed: 0,
    };
    const deadProbe = (): ProcessProbe => ({ alive: false });

    expect(classifyDisplayStatus(entry, deadProbe)).toBe(DISPLAY_STATUS.INTERRUPTED);
    expect(classifyDisplayStatus(entry, deadProbe)).not.toBe(DISPLAY_STATUS.CRASHED);
  });
});
