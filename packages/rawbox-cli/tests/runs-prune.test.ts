import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pruneOptionsFromResolvedLogs, pruneRuns } from '../src/runs/prune.js';
import { segmentPathFor } from '../src/workspace/log-segments.js';
import { listRegistryEntries, registryFilePathFor, runsDirFor } from '../src/runs/registry-io.js';
import { START_TIME_TOLERANCE_MS, type ProbeFn, type ProcessProbe } from '../src/runs/pid-probe.js';
import {
  RUN_REGISTRY_FORMAT,
  RUN_STATUS,
  type RunRegistryEntry,
  type RunStatus,
} from '../src/runs/types.js';
import {
  DEFAULT_PRUNE_KEEP,
  resolveLogsConfig,
  type Workspace,
} from '@rawbox/runner';

// ---------------------------------------------------------------------------
// `pruneRuns` bounds (OBSERVABILITY.md, "Retention") against synthetic
// registry entries and log files of known sizes — no real workflow execution
// needed to exercise the bound arithmetic.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-runs-prune-test');

/** Minute offsets, newest last in the array but each entry independently timestamped. */
function isoAt(minutesAgo: number, nowMs: number): string {
  return new Date(nowMs - minutesAgo * 60_000).toISOString();
}

/** The subset of registry fields the liveness tests need to vary. */
interface RunOverrides {
  status?: RunStatus;
  pid?: number;
  pidStartedAt?: number;
  /** Point two runs at one file, to exercise the shared-log-path guard. */
  logPath?: string;
  /**
   * Bytes of each **numbered** segment of the main log — `[10, 20]` lays down
   * `<run>.1.ndjson` and `<run>.2.ndjson` alongside segment 0, exactly as the
   * sink leaves a run that passed `rotate.maxBytes` twice.
   */
  segmentBytesList?: number[];
}

/**
 * Writes one run's registry entry plus a log file of exactly `logBytes`
 * bytes (and no error log, mirroring a run with no failures).
 *
 * Defaults to a *finished* (`ok`) run, so every pre-existing bounds test keeps
 * describing pure bound arithmetic with no probe involved — a terminal status
 * is never probed at all.
 */
async function makeRun(
  targetFolder: string,
  runId: string,
  startedAt: string,
  logBytes: number,
  overrides: RunOverrides = {},
): Promise<void> {
  const runsDir = runsDirFor(targetFolder);
  await fs.mkdir(runsDir, { recursive: true });

  const logPath = overrides.logPath ?? path.join(targetFolder, 'logs', `${runId}.ndjson`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, 'x'.repeat(logBytes), 'utf-8');
  for (const [index, bytes] of (overrides.segmentBytesList ?? []).entries()) {
    await fs.writeFile(segmentPathFor(logPath, index + 1), 'x'.repeat(bytes), 'utf-8');
  }

  const entry: RunRegistryEntry = {
    format: RUN_REGISTRY_FORMAT,
    run_id: runId,
    workspace: 'ws',
    workflow: 'wf',
    pid: overrides.pid ?? 1,
    pid_started_at: overrides.pidStartedAt ?? 0,
    started_at: startedAt,
    log_path: logPath,
    // No separate error log for this run — same path as the main log is the
    // sentinel `pruneRuns` uses to avoid double-counting/double-deleting.
    error_log_path: logPath,
    status: overrides.status ?? RUN_STATUS.OK,
  };

  await fs.writeFile(registryFilePathFor(targetFolder, runId), JSON.stringify(entry), 'utf-8');
}

// --- Fake probes ------------------------------------------------------------
// Same injection seam `runs list` uses (`classifyDisplayStatus`'s `probe`), so
// liveness is simulated rather than raced against a real process.

/** The pid the fake probes below consider genuinely alive, and its start time. */
const LIVE_PID = 4242;
const LIVE_PID_STARTED_AT = 1_700_000_000_000;

/** Alive-and-matching for {@link LIVE_PID}; dead for every other pid. */
const liveOnlyForLivePid: ProbeFn = (pid): ProcessProbe =>
  pid === LIVE_PID ? { alive: true, startedAtMs: LIVE_PID_STARTED_AT } : { alive: false };

/** Every pid is gone — the crashed-run case. */
const deadProbe: ProbeFn = (): ProcessProbe => ({ alive: false });

/**
 * The pid number is alive but its start time is far outside the tolerance
 * window: a *different* process recycled the number, so the run is dead.
 */
const recycledPidProbe: ProbeFn = (): ProcessProbe => ({
  alive: true,
  startedAtMs: LIVE_PID_STARTED_AT + START_TIME_TOLERANCE_MS * 100,
});

/** A probe that blows up — e.g. `/proc` and `ps` both unavailable and throwing. */
const throwingProbe: ProbeFn = (): ProcessProbe => {
  throw new Error('probe unavailable');
};

/** Alive, but with no determinable start time — the inconclusive case. */
const inconclusiveProbe: ProbeFn = (): ProcessProbe => ({ alive: true });

async function survivingIds(targetFolder: string): Promise<string[]> {
  const entryList = await listRegistryEntries(targetFolder);
  return entryList.map((entry) => entry.run_id).sort();
}

/**
 * The exact on-disk bytes (registry entry + log file) one run currently
 * occupies — computed rather than guessed, since the registry JSON's size
 * depends on `log_path`'s length, which varies with where the test suite
 * happens to run from.
 */
async function totalBytesOf(targetFolder: string, runId: string): Promise<number> {
  const entry = (await listRegistryEntries(targetFolder)).find((candidate) => candidate.run_id === runId);
  if (!entry) {
    throw new Error(`No such run "${runId}" under ${targetFolder}`);
  }
  const [registryBytes, logBytes] = await Promise.all([
    fs.stat(registryFilePathFor(targetFolder, runId)).then((stats) => stats.size),
    fs.stat(entry.log_path).then((stats) => stats.size),
  ]);
  return registryBytes + logBytes;
}

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('pruneRuns — --keep', () => {
  it('keeps only the N most recently started runs, deleting the rest', async () => {
    const targetFolder = path.join(rootDir, 'keep-scenario');
    const now = Date.now();
    // Oldest to newest: run-5 (100m ago) ... run-1 (20m ago).
    await makeRun(targetFolder, 'run-5', isoAt(100, now), 10);
    await makeRun(targetFolder, 'run-4', isoAt(80, now), 10);
    await makeRun(targetFolder, 'run-3', isoAt(60, now), 10);
    await makeRun(targetFolder, 'run-2', isoAt(40, now), 10);
    await makeRun(targetFolder, 'run-1', isoAt(20, now), 10);

    const result = await pruneRuns(targetFolder, { keep: 2 });

    expect(result.survivorCount).toBe(2);
    expect(result.prunedList.map((p) => p.runId).sort()).toEqual(['run-3', 'run-4', 'run-5']);
    expect(await survivingIds(targetFolder)).toEqual(['run-1', 'run-2']);
  });
});

describe('pruneRuns — --older-than', () => {
  it('deletes everything started before the cutoff, regardless of count', async () => {
    const targetFolder = path.join(rootDir, 'older-than-scenario');
    const now = Date.now();
    await makeRun(targetFolder, 'run-old-1', isoAt(60 * 24 * 10, now), 10); // 10 days ago
    await makeRun(targetFolder, 'run-old-2', isoAt(60 * 24 * 8, now), 10); // 8 days ago
    await makeRun(targetFolder, 'run-recent', isoAt(60, now), 10); // 1 hour ago

    const result = await pruneRuns(targetFolder, { olderThanDays: 1 });

    expect(result.prunedList.map((p) => p.runId).sort()).toEqual(['run-old-1', 'run-old-2']);
    expect(await survivingIds(targetFolder)).toEqual(['run-recent']);
  });
});

describe('pruneRuns — --max-bytes (the primary bound)', () => {
  it('deletes oldest-first until the surviving set fits the byte budget', async () => {
    const targetFolder = path.join(rootDir, 'max-bytes-scenario');
    const now = Date.now();
    // Same-length run ids, so every run occupies exactly the same bytes on
    // disk (the registry JSON's size depends on `log_path`'s length, which
    // includes the run id) — that is what lets a budget be computed from one
    // run and apply exactly to N of them, with no guessed constant.
    await makeRun(targetFolder, 'run-1-oldest', isoAt(40, now), 1000);
    await makeRun(targetFolder, 'run-2-------', isoAt(30, now), 1000);
    await makeRun(targetFolder, 'run-3-------', isoAt(20, now), 1000);
    await makeRun(targetFolder, 'run-4-newest', isoAt(10, now), 1000);

    const perRunBytes = await totalBytesOf(targetFolder, 'run-3-------');
    const result = await pruneRuns(targetFolder, { maxBytes: perRunBytes * 2 });

    expect(await survivingIds(targetFolder)).toEqual(['run-3-------', 'run-4-newest']);
    expect(result.prunedList.map((p) => p.runId).sort()).toEqual(['run-1-oldest', 'run-2-------']);
    expect(result.bytesFreed).toBeGreaterThan(0);
  });

  it('always keeps the single newest run, even if it alone exceeds the budget', async () => {
    const targetFolder = path.join(rootDir, 'max-bytes-single-oversized');
    const now = Date.now();
    await makeRun(targetFolder, 'run-huge-newest', isoAt(5, now), 5000);

    const result = await pruneRuns(targetFolder, { maxBytes: 10 });

    expect(result.survivorCount).toBe(1);
    expect(result.prunedList).toEqual([]);
    expect(await survivingIds(targetFolder)).toEqual(['run-huge-newest']);
  });

  it('composes with --keep: max-bytes can cut further even inside what --keep would have kept', async () => {
    const targetFolder = path.join(rootDir, 'keep-and-max-bytes-scenario');
    const now = Date.now();
    await makeRun(targetFolder, 'run-a-oldest', isoAt(40, now), 1000);
    await makeRun(targetFolder, 'run-b', isoAt(30, now), 1000);
    await makeRun(targetFolder, 'run-c-newest', isoAt(20, now), 1000);

    // --keep 3 alone would keep all three; --max-bytes tightens further, down
    // to less than one run's worth of bytes — leaving only the newest, per
    // the "always keep the single newest" rule.
    const perRunBytes = await totalBytesOf(targetFolder, 'run-c-newest');
    const result = await pruneRuns(targetFolder, { keep: 3, maxBytes: Math.floor(perRunBytes / 2) });

    expect(await survivingIds(targetFolder)).toEqual(['run-c-newest']);
    expect(result.prunedList.map((p) => p.runId).sort()).toEqual(['run-a-oldest', 'run-b']);
  });
});

describe('pruneRuns — deletion side effects', () => {
  it('deletes both the registry entry and its log file, leaving survivors untouched', async () => {
    const targetFolder = path.join(rootDir, 'deletion-scenario');
    const now = Date.now();
    await makeRun(targetFolder, 'run-old', isoAt(100, now), 10);
    await makeRun(targetFolder, 'run-new', isoAt(1, now), 10);

    await pruneRuns(targetFolder, { keep: 1 });

    await expect(fs.stat(registryFilePathFor(targetFolder, 'run-old'))).rejects.toThrow();
    await expect(
      fs.stat(path.join(targetFolder, 'logs', 'run-old.ndjson')),
    ).rejects.toThrow();

    const survivingEntry = await fs.stat(registryFilePathFor(targetFolder, 'run-new'));
    expect(survivingEntry.isFile()).toBe(true);
    const survivingLog = await fs.stat(path.join(targetFolder, 'logs', 'run-new.ndjson'));
    expect(survivingLog.isFile()).toBe(true);
  });

  it('is a no-op when every entry already fits the bound', async () => {
    const targetFolder = path.join(rootDir, 'no-op-scenario');
    const now = Date.now();
    await makeRun(targetFolder, 'run-only', isoAt(1, now), 10);

    const result = await pruneRuns(targetFolder, { keep: 50 });

    expect(result.prunedList).toEqual([]);
    expect(result.survivorCount).toBe(1);
    expect(await survivingIds(targetFolder)).toEqual(['run-only']);
  });
});

// ---------------------------------------------------------------------------
// Liveness exemption (OBSERVABILITY.md, "Retention": "Pruning MUST NOT remove
// an entry whose run is still alive"). The distinction that matters is between
// a live run and a *crashed* one — both are stored `running`, and only
// `classify.ts`'s pid + `pid_started_at` pairing tells them apart.
// ---------------------------------------------------------------------------

describe('pruneRuns — live runs are exempt from deletion', () => {
  it('never prunes a live run even when keep, olderThanDays and maxBytes would all select it', async () => {
    const targetFolder = path.join(rootDir, 'live-exempt-all-bounds');
    const now = Date.now();
    // Oldest, largest, and outside every bound — the exact entry the old
    // newest-first sort would have picked first.
    await makeRun(targetFolder, 'run-live-daemon', isoAt(60 * 24 * 10, now), 5000, {
      status: RUN_STATUS.RUNNING,
      pid: LIVE_PID,
      pidStartedAt: LIVE_PID_STARTED_AT,
    });
    await makeRun(targetFolder, 'run-finished-newer', isoAt(1, now), 10);

    const result = await pruneRuns(
      targetFolder,
      { keep: 1, olderThanDays: 1, maxBytes: 100 },
      liveOnlyForLivePid,
    );

    expect(result.prunedList.map((pruned) => pruned.runId)).not.toContain('run-live-daemon');
    expect(await survivingIds(targetFolder)).toContain('run-live-daemon');

    // Its log file is untouched — the process is still appending to it.
    const log = await fs.stat(path.join(targetFolder, 'logs', 'run-live-daemon.ndjson'));
    expect(log.size).toBe(5000);
  });

  it('prunes a crashed run — stored "running", but the process is gone', async () => {
    const targetFolder = path.join(rootDir, 'crashed-is-prunable');
    const now = Date.now();
    await makeRun(targetFolder, 'run-crashed', isoAt(100, now), 10, {
      status: RUN_STATUS.RUNNING,
      pid: 999_001,
      pidStartedAt: LIVE_PID_STARTED_AT,
    });
    await makeRun(targetFolder, 'run-newest', isoAt(1, now), 10);

    const result = await pruneRuns(targetFolder, { keep: 1 }, deadProbe);

    expect(result.prunedList.map((pruned) => pruned.runId)).toEqual(['run-crashed']);
    expect(await survivingIds(targetFolder)).toEqual(['run-newest']);
  });

  it('treats a recycled pid as dead, not alive — same pid number, different start time', async () => {
    const targetFolder = path.join(rootDir, 'recycled-pid-is-prunable');
    const now = Date.now();
    // The pid number the probe reports alive, but the entry recorded a
    // different start time for it: an unrelated process holds it now.
    await makeRun(targetFolder, 'run-recycled', isoAt(100, now), 10, {
      status: RUN_STATUS.RUNNING,
      pid: LIVE_PID,
      pidStartedAt: LIVE_PID_STARTED_AT,
    });
    await makeRun(targetFolder, 'run-newest', isoAt(1, now), 10);

    const result = await pruneRuns(targetFolder, { keep: 1 }, recycledPidProbe);

    expect(result.prunedList.map((pruned) => pruned.runId)).toEqual(['run-recycled']);
    expect(await survivingIds(targetFolder)).toEqual(['run-newest']);
  });

  it('leaves an entry alone when the probe throws', async () => {
    const targetFolder = path.join(rootDir, 'probe-throws');
    const now = Date.now();
    await makeRun(targetFolder, 'run-unprobeable', isoAt(100, now), 10, {
      status: RUN_STATUS.RUNNING,
      pid: LIVE_PID,
      pidStartedAt: LIVE_PID_STARTED_AT,
    });
    await makeRun(targetFolder, 'run-newest', isoAt(1, now), 10);

    const result = await pruneRuns(targetFolder, { keep: 1 }, throwingProbe);

    expect(result.prunedList).toEqual([]);
    expect(await survivingIds(targetFolder)).toEqual(['run-newest', 'run-unprobeable']);
  });

  it('leaves an entry alone when the probe is inconclusive about the start time', async () => {
    const targetFolder = path.join(rootDir, 'probe-inconclusive');
    const now = Date.now();
    await makeRun(targetFolder, 'run-unknown-start', isoAt(100, now), 10, {
      status: RUN_STATUS.RUNNING,
      pid: LIVE_PID,
      pidStartedAt: LIVE_PID_STARTED_AT,
    });
    await makeRun(targetFolder, 'run-newest', isoAt(1, now), 10);

    const result = await pruneRuns(targetFolder, { keep: 1 }, inconclusiveProbe);

    expect(result.prunedList).toEqual([]);
    expect(await survivingIds(targetFolder)).toEqual(['run-newest', 'run-unknown-start']);
  });
});

describe('pruneRuns — live bytes and the maxBytes budget', () => {
  it('charges a live run’s bytes to the budget, pruning every deletable run and staying over budget', async () => {
    const targetFolder = path.join(rootDir, 'live-bytes-charged');
    const now = Date.now();
    await makeRun(targetFolder, 'run-live-huge', isoAt(50, now), 5000, {
      status: RUN_STATUS.RUNNING,
      pid: LIVE_PID,
      pidStartedAt: LIVE_PID_STARTED_AT,
    });
    await makeRun(targetFolder, 'run-finished-a', isoAt(40, now), 10);
    await makeRun(targetFolder, 'run-finished-b', isoAt(30, now), 10);

    // A budget the live run alone already blows through.
    const result = await pruneRuns(targetFolder, { maxBytes: 1000 }, liveOnlyForLivePid);

    // Everything deletable goes...
    expect(result.prunedList.map((pruned) => pruned.runId).sort()).toEqual([
      'run-finished-a',
      'run-finished-b',
    ]);
    expect(await survivingIds(targetFolder)).toEqual(['run-live-huge']);

    // ...and the directory is *still* over budget. That is the documented,
    // deliberate consequence: honouring the bound here would mean deleting a
    // file a running process is writing.
    const survivingBytes = await totalBytesOf(targetFolder, 'run-live-huge');
    expect(survivingBytes).toBeGreaterThan(1000);
  });

  it('does not let a live survivor buy a finished run a free pass past the budget', async () => {
    const targetFolder = path.join(rootDir, 'live-satisfies-newest-guarantee');
    const now = Date.now();
    // The newest entry is the live one, so the "at least one survivor"
    // guarantee is already met — the older finished run gets no exemption.
    await makeRun(targetFolder, 'run-live-newest', isoAt(5, now), 5000, {
      status: RUN_STATUS.RUNNING,
      pid: LIVE_PID,
      pidStartedAt: LIVE_PID_STARTED_AT,
    });
    await makeRun(targetFolder, 'run-finished-older', isoAt(50, now), 5000);

    const result = await pruneRuns(targetFolder, { maxBytes: 10 }, liveOnlyForLivePid);

    expect(result.prunedList.map((pruned) => pruned.runId)).toEqual(['run-finished-older']);
    expect(await survivingIds(targetFolder)).toEqual(['run-live-newest']);
  });

  it('still keeps the single newest entry when every run is finished and over budget', async () => {
    const targetFolder = path.join(rootDir, 'newest-guarantee-all-dead');
    const now = Date.now();
    await makeRun(targetFolder, 'run-older', isoAt(50, now), 5000, {
      status: RUN_STATUS.RUNNING,
      pid: 999_002,
    });
    await makeRun(targetFolder, 'run-newest', isoAt(5, now), 5000, {
      status: RUN_STATUS.RUNNING,
      pid: 999_003,
    });

    // Both classify as crashed, so nothing is exempt — the guarantee is the
    // only thing keeping a survivor at all.
    const result = await pruneRuns(targetFolder, { maxBytes: 10 }, deadProbe);

    expect(result.survivorCount).toBe(1);
    expect(await survivingIds(targetFolder)).toEqual(['run-newest']);
    expect(result.prunedList.map((pruned) => pruned.runId)).toEqual(['run-older']);
  });
});

describe('pruneRuns — a surviving entry’s log file is never deleted', () => {
  it('keeps a shared log file when two entries point at it and only one is pruned', async () => {
    const targetFolder = path.join(rootDir, 'shared-log-path');
    const now = Date.now();
    // Reachable in practice: `workflow run --log-file <path>` lets two runs
    // name the same file, so the per-run-id default is not a guarantee.
    const sharedLog = path.join(targetFolder, 'logs', 'shared.ndjson');
    await makeRun(targetFolder, 'run-shared-old', isoAt(50, now), 100, { logPath: sharedLog });
    await makeRun(targetFolder, 'run-shared-new', isoAt(5, now), 100, { logPath: sharedLog });

    const result = await pruneRuns(targetFolder, { keep: 1 });

    expect(result.prunedList.map((pruned) => pruned.runId)).toEqual(['run-shared-old']);
    expect(await survivingIds(targetFolder)).toEqual(['run-shared-new']);

    // The survivor's log — the same file — is still there.
    const log = await fs.stat(sharedLog);
    expect(log.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Rotated runs. A run's log is one or more segments (`@rawbox/runner`'s
// `LogRotate`), and `sizeOf` charges the budget for all of them — so deletion
// has to remove all of them. Removing only `log_path` would leave
// `<run_id>.1.ndjson` and up on disk with no registry entry naming them:
// invisible to `runs list`, uncounted by every later pass, and reported as
// freed bytes that were never freed.
// ---------------------------------------------------------------------------

describe('pruneRuns — a rotated run', () => {
  it('deletes every segment, leaving nothing orphaned', async () => {
    const targetFolder = path.join(rootDir, 'rotated-deletion');
    const now = Date.now();
    await makeRun(targetFolder, 'run-rotated', isoAt(100, now), 100, {
      segmentBytesList: [200, 300],
    });
    await makeRun(targetFolder, 'run-new', isoAt(1, now), 10);

    const result = await pruneRuns(targetFolder, { keep: 1 });

    expect(result.prunedList.map((pruned) => pruned.runId)).toEqual(['run-rotated']);
    // The whole sequence is gone — not just the path the registry named.
    const logDir = path.join(targetFolder, 'logs');
    expect((await fs.readdir(logDir)).sort()).toEqual(['run-new.ndjson']);
  });

  it('charges and frees the same bytes — every segment, not just segment 0', async () => {
    const targetFolder = path.join(rootDir, 'rotated-accounting');
    const now = Date.now();
    await makeRun(targetFolder, 'run-rotated', isoAt(100, now), 100, {
      segmentBytesList: [200, 300],
    });
    await makeRun(targetFolder, 'run-new', isoAt(1, now), 10);

    const registryBytes = (
      await fs.stat(registryFilePathFor(targetFolder, 'run-rotated'))
    ).size;
    const result = await pruneRuns(targetFolder, { keep: 1 });

    // 100 + 200 + 300 of segments, plus the registry entry: the number
    // reported as freed is the number that actually left the disk.
    expect(result.bytesFreed).toBe(600 + registryBytes);
  });

  it('keeps every segment of a shared log when a surviving entry still points at it', async () => {
    // The `--log-file` case again, now rotated: the survivor is still
    // appending to `<shared>.1.ndjson`, which the doomed entry names too.
    const targetFolder = path.join(rootDir, 'rotated-shared-log');
    const now = Date.now();
    const sharedLog = path.join(targetFolder, 'logs', 'shared.ndjson');
    await makeRun(targetFolder, 'run-shared-old', isoAt(50, now), 100, {
      logPath: sharedLog,
      segmentBytesList: [150],
    });
    await makeRun(targetFolder, 'run-shared-new', isoAt(5, now), 100, {
      logPath: sharedLog,
    });

    const result = await pruneRuns(targetFolder, { keep: 1 });

    expect(result.prunedList.map((pruned) => pruned.runId)).toEqual(['run-shared-old']);
    expect((await fs.stat(sharedLog)).size).toBe(100);
    expect((await fs.stat(segmentPathFor(sharedLog, 1))).size).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Rotation-aware POLICY (task 7). Segment rotation (`@rawbox/runner`'s
// `LogRotate`) makes one run self-bounding at `rotate.maxBytes *
// rotate.maxFiles`, which is what lets a directory's own ceiling become a run
// *count* — `keep` — instead of a byte total nobody configured. These tests
// go through the exact bridge every real caller does —
// `resolveLogsConfig` (`@rawbox/runner`) into `pruneOptionsFromResolvedLogs`
// (`../src/runs/prune.js`) into `pruneRuns` — rather than constructing
// `PruneOptions` by hand, so a regression in the *resolution* (not just
// `pruneRuns`'s own arithmetic, already covered above) would be caught here.
// ---------------------------------------------------------------------------

/** A minimal, schema-shaped `Workspace`, with or without a `logs:` block. */
function ws(logs?: Workspace['logs']): Workspace {
  return {
    kind: 'Workspace',
    name: 'demo',
    workflowPathList: [],
    ...(logs !== undefined ? { logs } : {}),
  };
}

describe('pruneRuns — rotation-aware defaults (resolveLogsConfig → pruneOptionsFromResolvedLogs)', () => {
  it('the built-in `keep` default applies when nothing configures it, keeping only the newest DEFAULT_PRUNE_KEEP', async () => {
    const targetFolder = path.join(rootDir, 'default-keep-applies');
    const now = Date.now();
    const total = DEFAULT_PRUNE_KEEP + 3;
    // Oldest to newest, one minute apart; run ids sort the same way their
    // start times do, so the surviving set is easy to state.
    for (let index = 0; index < total; index += 1) {
      await makeRun(targetFolder, `run-${String(index).padStart(3, '0')}`, isoAt(total - index, now), 10);
    }

    const options = pruneOptionsFromResolvedLogs(resolveLogsConfig({ workspace: undefined }).prune);
    const result = await pruneRuns(targetFolder, options);

    expect(result.survivorCount).toBe(DEFAULT_PRUNE_KEEP);
    // The newest DEFAULT_PRUNE_KEEP survive — ids 003..023 for 23 runs.
    const expectedSurvivors = Array.from({ length: DEFAULT_PRUNE_KEEP }, (_, offset) =>
      `run-${String(total - DEFAULT_PRUNE_KEEP + offset).padStart(3, '0')}`,
    );
    expect(await survivingIds(targetFolder)).toEqual(expectedSurvivors.sort());
  });

  it('`maxBytes` does NOT apply when nothing configures it — the retired unconditional default', async () => {
    const targetFolder = path.join(rootDir, 'default-max-bytes-retired');
    const now = Date.now();
    // Every run is far bigger than the old 50 MB unconditional default, and
    // there are only 3 of them — nowhere near DEFAULT_PRUNE_KEEP either — so
    // the only way any of this survives is if `maxBytes` truly has no
    // built-in fallback of its own.
    const bigBytes = 20 * 1024 * 1024;
    await makeRun(targetFolder, 'run-a', isoAt(30, now), bigBytes);
    await makeRun(targetFolder, 'run-b', isoAt(20, now), bigBytes);
    await makeRun(targetFolder, 'run-c', isoAt(10, now), bigBytes);

    const options = pruneOptionsFromResolvedLogs(resolveLogsConfig({ workspace: undefined }).prune);
    expect(options.maxBytes).toBeUndefined();

    const result = await pruneRuns(targetFolder, options);

    expect(result.prunedList).toEqual([]);
    expect(await survivingIds(targetFolder)).toEqual(['run-a', 'run-b', 'run-c']);
  });

  it('an explicit `maxBytes` from the workspace document still bounds the directory', async () => {
    const targetFolder = path.join(rootDir, 'default-max-bytes-from-document');
    const now = Date.now();
    await makeRun(targetFolder, 'run-1-oldest', isoAt(30, now), 1000);
    await makeRun(targetFolder, 'run-2-newest', isoAt(10, now), 1000);

    const perRunBytes = await totalBytesOf(targetFolder, 'run-2-newest');
    const workspace = ws({ prune: { maxBytes: perRunBytes } });
    const options = pruneOptionsFromResolvedLogs(resolveLogsConfig({ workspace }).prune);
    expect(options.maxBytes).toBe(perRunBytes);

    const result = await pruneRuns(targetFolder, options);

    expect(result.prunedList.map((pruned) => pruned.runId)).toEqual(['run-1-oldest']);
    expect(await survivingIds(targetFolder)).toEqual(['run-2-newest']);
  });

  it('an explicit `--max-bytes` flag (the CLI override) still bounds the directory', async () => {
    const targetFolder = path.join(rootDir, 'default-max-bytes-from-flag');
    const now = Date.now();
    await makeRun(targetFolder, 'run-1-oldest', isoAt(30, now), 1000);
    await makeRun(targetFolder, 'run-2-newest', isoAt(10, now), 1000);

    const perRunBytes = await totalBytesOf(targetFolder, 'run-2-newest');
    const options = pruneOptionsFromResolvedLogs(
      resolveLogsConfig({ workspace: undefined, override: { prune: { maxBytes: perRunBytes } } })
        .prune,
    );
    expect(options.maxBytes).toBe(perRunBytes);

    const result = await pruneRuns(targetFolder, options);

    expect(result.prunedList.map((pruned) => pruned.runId)).toEqual(['run-1-oldest']);
    expect(await survivingIds(targetFolder)).toEqual(['run-2-newest']);
  });

  it('the newest-entry guarantee holds under the resolved default, even with an explicit tiny maxBytes', async () => {
    const targetFolder = path.join(rootDir, 'default-newest-entry-guarantee');
    const now = Date.now();
    await makeRun(targetFolder, 'run-huge-newest', isoAt(5, now), 5000);

    const options = pruneOptionsFromResolvedLogs(
      resolveLogsConfig({ workspace: undefined, override: { prune: { maxBytes: 10 } } }).prune,
    );
    // `keep` still resolved to its default alongside the overridden `maxBytes`.
    expect(options.keep).toBe(DEFAULT_PRUNE_KEEP);

    const result = await pruneRuns(targetFolder, options);

    expect(result.survivorCount).toBe(1);
    expect(result.prunedList).toEqual([]);
    expect(await survivingIds(targetFolder)).toEqual(['run-huge-newest']);
  });

  it('a live run is still exempt from deletion under the resolved default `keep`', async () => {
    const targetFolder = path.join(rootDir, 'default-live-run-exempt');
    const now = Date.now();
    // Oldest, and outside the default `keep` window on its own — everything
    // else here is newer and there are more than DEFAULT_PRUNE_KEEP of them.
    await makeRun(targetFolder, 'run-live', isoAt(60 * 24, now), 10, {
      status: RUN_STATUS.RUNNING,
      pid: LIVE_PID,
      pidStartedAt: LIVE_PID_STARTED_AT,
    });
    for (let index = 0; index < DEFAULT_PRUNE_KEEP + 2; index += 1) {
      await makeRun(targetFolder, `run-finished-${index}`, isoAt(DEFAULT_PRUNE_KEEP + 1 - index, now), 10);
    }

    const options = pruneOptionsFromResolvedLogs(resolveLogsConfig({ workspace: undefined }).prune);
    const result = await pruneRuns(targetFolder, options, liveOnlyForLivePid);

    expect(result.prunedList.map((pruned) => pruned.runId)).not.toContain('run-live');
    expect(await survivingIds(targetFolder)).toContain('run-live');
  });

  it('composition order is unchanged under resolved defaults: olderThanDays → keep → maxBytes', async () => {
    const targetFolder = path.join(rootDir, 'default-composition-order');
    const now = Date.now();
    // Five runs, oldest to newest; `olderThanDays` drops the oldest two
    // outright, `keep: 2` (an explicit override, so the default never
    // applies) then trims what's left to the newest two, and a `maxBytes`
    // tight enough to admit only one cuts even inside what `keep` kept.
    await makeRun(targetFolder, 'run-1-oldest', isoAt(60 * 24 * 10, now), 1000); // 10 days
    await makeRun(targetFolder, 'run-2-------', isoAt(60 * 24 * 8, now), 1000); // 8 days
    await makeRun(targetFolder, 'run-3-------', isoAt(40, now), 1000);
    await makeRun(targetFolder, 'run-4-------', isoAt(20, now), 1000);
    await makeRun(targetFolder, 'run-5-newest', isoAt(10, now), 1000);

    const perRunBytes = await totalBytesOf(targetFolder, 'run-5-newest');
    const options = pruneOptionsFromResolvedLogs(
      resolveLogsConfig({
        workspace: undefined,
        override: {
          prune: { keep: 2, olderThanDays: 1, maxBytes: Math.floor(perRunBytes * 1.5) },
        },
      }).prune,
    );

    const result = await pruneRuns(targetFolder, options);

    // olderThanDays drops run-1/run-2; keep:2 would leave run-4/run-5;
    // maxBytes (room for 1.5 runs) then cuts down to run-5 alone.
    expect(await survivingIds(targetFolder)).toEqual(['run-5-newest']);
    expect(result.prunedList.map((pruned) => pruned.runId).sort()).toEqual([
      'run-1-oldest',
      'run-2-------',
      'run-3-------',
      'run-4-------',
    ]);
  });
});
