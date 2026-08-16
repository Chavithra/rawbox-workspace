import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

import { runsTailCommand } from '../src/commands/runs/tail.js';
import { workspaceLogsCommand } from '../src/commands/workspace/logs.js';
import { summarizeRunLog } from '../src/runs/log-summary.js';
import { pruneRuns } from '../src/runs/prune.js';
import { listRegistryEntries, registryFilePathFor, runsDirFor } from '../src/runs/registry-io.js';
import type { ProcessProbe } from '../src/runs/pid-probe.js';
import { RUN_REGISTRY_FORMAT, RUN_STATUS, type RunRegistryEntry } from '../src/runs/types.js';
import {
  initTailState,
  readAllMerged,
  readNewEvents,
  type LogSource,
  type TailState,
} from '../src/workspace/log-merge.js';
import { listLogSegments, segmentPathFor } from '../src/workspace/log-segments.js';

// ---------------------------------------------------------------------------
// Rotated log segments, from the READING side only — nothing in the tree
// rotates yet, so every fixture here lays the segments down by hand exactly as
// `@rawbox/runner`'s `LogRotate` specifies them: `<run_id>.ndjson` is segment
// 0 and the OLDEST, `<run_id>.N.ndjson` is newer, and the highest-numbered
// file is the live one.
//
// These tests are the guard that the readers understand that layout *before*
// anything produces it. The failure they exist to prevent is silent: a reader
// that opens `log_path` alone shows a rotated run's oldest events and stops,
// with no error and no gap in the output to notice.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-log-segments-test');

let exitSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'info').mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures — real files on disk, laid out the way rotation will lay them out
// ---------------------------------------------------------------------------

/** `<root>/<name>/logs`, plus the `<run_id>.ndjson` path inside it. */
async function makeLogDir(name: string, runId = 'run-1'): Promise<{ logDir: string; logPath: string }> {
  const logDir = path.join(rootDir, name, 'logs');
  await fs.mkdir(logDir, { recursive: true });
  return { logDir, logPath: path.join(logDir, `${runId}.ndjson`) };
}

/** One NDJSON event line, with the `ts`/`run_id` envelope every reader keys on. */
function line(runId: string, ts: string, rest: Record<string, unknown> = { event: 'log' }): string {
  return JSON.stringify({ ts, run_id: runId, ...rest });
}

/** Writes one segment of `logPath` — segment 0 is `logPath` itself. */
async function writeSegment(logPath: string, segment: number, lineList: string[]): Promise<string> {
  const segmentPath = segmentPathFor(logPath, segment);
  await fs.writeFile(segmentPath, lineList.map((text) => `${text}\n`).join(''), 'utf-8');
  return segmentPath;
}

function sourceFor(logPath: string, runId = 'run-1'): LogSource {
  return { runId, workflow: 'wf', logPath };
}

/** Every event's `seq` field, in the order the reader produced them. */
function seqListOf(eventList: readonly { event: Record<string, unknown> }[]): number[] {
  return eventList.map((merged) => merged.event['seq'] as number);
}

/**
 * `n` events with a strictly increasing `ts` and a `seq` counter, so a test can
 * assert on order and on "read exactly once" at the same time.
 */
function eventLineList(runId: string, fromSeq: number, count: number): string[] {
  const lineList: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const seq = fromSeq + index;
    lineList.push(
      line(runId, `2026-03-01T00:00:${String(seq).padStart(2, '0')}.000Z`, { event: 'log', seq }),
    );
  }
  return lineList;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe('listLogSegments — discovery', () => {
  it('returns the run\'s single log path unchanged when nothing has rotated', async () => {
    const { logPath } = await makeLogDir('unrotated');
    await writeSegment(logPath, 0, eventLineList('run-1', 0, 2));

    expect(await listLogSegments(logPath)).toEqual([logPath]);
  });

  it('returns a never-written log\'s path unchanged rather than an empty list', async () => {
    // Every caller already treats a missing log as "no events"/"zero bytes";
    // answering `[]` would push a new empty case into all of them.
    const { logPath } = await makeLogDir('never-written');

    expect(await listLogSegments(logPath)).toEqual([logPath]);
  });

  it('returns the log path unchanged when the whole log directory is missing', async () => {
    const logPath = path.join(rootDir, 'no-such-dir', 'logs', 'run-1.ndjson');

    expect(await listLogSegments(logPath)).toEqual([logPath]);
  });

  it('enumerates three segments oldest-first: segment 0, then .1, then .2', async () => {
    const { logPath } = await makeLogDir('three');
    await writeSegment(logPath, 0, eventLineList('run-1', 0, 1));
    await writeSegment(logPath, 1, eventLineList('run-1', 1, 1));
    await writeSegment(logPath, 2, eventLineList('run-1', 2, 1));

    expect((await listLogSegments(logPath)).map((each) => path.basename(each))).toEqual([
      'run-1.ndjson',
      'run-1.1.ndjson',
      'run-1.2.ndjson',
    ]);
  });

  it('sorts numerically, so .10 comes after .9 rather than after .1', async () => {
    const { logPath } = await makeLogDir('eleven');
    for (let segment = 0; segment <= 10; segment += 1) {
      await writeSegment(logPath, segment, eventLineList('run-1', segment, 1));
    }

    expect((await listLogSegments(logPath)).map((each) => path.basename(each))).toEqual([
      'run-1.ndjson',
      'run-1.1.ndjson',
      'run-1.2.ndjson',
      'run-1.3.ndjson',
      'run-1.4.ndjson',
      'run-1.5.ndjson',
      'run-1.6.ndjson',
      'run-1.7.ndjson',
      'run-1.8.ndjson',
      'run-1.9.ndjson',
      'run-1.10.ndjson',
    ]);
  });

  it('starts at the lowest surviving segment when rotation deleted the oldest ones', async () => {
    // `maxFiles` retires from the LOW end, so {2, 3} with 0 and 1 gone is an
    // ordinary retained window, not corruption.
    const { logPath } = await makeLogDir('low-gap');
    await writeSegment(logPath, 2, eventLineList('run-1', 2, 1));
    await writeSegment(logPath, 3, eventLineList('run-1', 3, 1));

    expect((await listLogSegments(logPath)).map((each) => path.basename(each))).toEqual([
      'run-1.2.ndjson',
      'run-1.3.ndjson',
    ]);
  });

  it('ignores other runs\' files in the same directory, including a run id that is a prefix of this one', async () => {
    const { logDir, logPath } = await makeLogDir('neighbours', 'run-1');
    await writeSegment(logPath, 0, eventLineList('run-1', 0, 1));
    await writeSegment(logPath, 1, eventLineList('run-1', 1, 1));

    const neighbourPath = path.join(logDir, 'run-12.ndjson');
    await writeSegment(neighbourPath, 0, eventLineList('run-12', 90, 1));
    await writeSegment(neighbourPath, 1, eventLineList('run-12', 91, 1));
    await fs.writeFile(path.join(logDir, 'unrelated.txt'), 'not a log\n', 'utf-8');
    await fs.writeFile(path.join(logDir, 'run-1.notanumber.ndjson'), '{}\n', 'utf-8');

    expect((await listLogSegments(logPath)).map((each) => path.basename(each))).toEqual([
      'run-1.ndjson',
      'run-1.1.ndjson',
    ]);
  });

  it('enumerates the error log independently of the main log, in both directions', async () => {
    const { logDir, logPath } = await makeLogDir('error-log');
    const errorLogPath = path.join(logDir, 'run-1.error.ndjson');

    await writeSegment(logPath, 0, eventLineList('run-1', 0, 1));
    await writeSegment(logPath, 1, eventLineList('run-1', 1, 1));
    await writeSegment(logPath, 2, eventLineList('run-1', 2, 1));
    await writeSegment(errorLogPath, 0, eventLineList('run-1', 50, 1));
    await writeSegment(errorLogPath, 1, eventLineList('run-1', 51, 1));

    // The main log never picks up `.error.` files…
    expect((await listLogSegments(logPath)).map((each) => path.basename(each))).toEqual([
      'run-1.ndjson',
      'run-1.1.ndjson',
      'run-1.2.ndjson',
    ]);
    // …and the error log has its own, shorter sequence.
    expect((await listLogSegments(errorLogPath)).map((each) => path.basename(each))).toEqual([
      'run-1.error.ndjson',
      'run-1.error.1.ndjson',
    ]);
  });

  it('names an error log\'s segments <run>.error.N.ndjson, not <run>.N.error.ndjson', async () => {
    const errorLogPath = path.join(rootDir, 'naming', 'run-1.error.ndjson');
    expect(path.basename(segmentPathFor(errorLogPath, 3))).toBe('run-1.error.3.ndjson');
    // Segment 0 is the registry's own path, byte-for-byte.
    expect(segmentPathFor(errorLogPath, 0)).toBe(errorLogPath);
  });
});

// ---------------------------------------------------------------------------
// Reading across segments
// ---------------------------------------------------------------------------

describe('readNewEvents — reading across segments', () => {
  it('reads an unrotated run exactly as it did before segments existed', async () => {
    const { logPath } = await makeLogDir('read-unrotated');
    await writeSegment(logPath, 0, eventLineList('run-1', 0, 3));

    const { events, state } = await readNewEvents(initTailState(sourceFor(logPath)));

    expect(seqListOf(events)).toEqual([0, 1, 2]);
    expect(state.cursor.segment).toBe(0);
    expect(state.cursor.offset).toBe((await fs.stat(logPath)).size);
    expect(state.leftover).toBe('');

    // A second poll with nothing appended yields nothing and moves nothing.
    const again = await readNewEvents(state);
    expect(again.events).toEqual([]);
    expect(again.state.cursor).toEqual(state.cursor);
  });

  it('treats a missing log as "nothing new" rather than an error', async () => {
    const { logPath } = await makeLogDir('read-missing');

    const { events, state } = await readNewEvents(initTailState(sourceFor(logPath)));

    expect(events).toEqual([]);
    expect(state.cursor).toEqual({ segment: 0, offset: 0 });
  });

  it('reads a three-segment run in chronological order, 0 then 1 then 2', async () => {
    const { logPath } = await makeLogDir('read-three');
    await writeSegment(logPath, 0, eventLineList('run-1', 0, 2));
    await writeSegment(logPath, 1, eventLineList('run-1', 2, 2));
    await writeSegment(logPath, 2, eventLineList('run-1', 4, 2));

    const { events, state } = await readNewEvents(initTailState(sourceFor(logPath)));

    expect(seqListOf(events)).toEqual([0, 1, 2, 3, 4, 5]);
    // Left standing on the live (highest) segment, at its end.
    expect(state.cursor.segment).toBe(2);
    expect(state.cursor.offset).toBe((await fs.stat(segmentPathFor(logPath, 2))).size);
  });

  it('does not put .10 before .9 when reading an eleven-segment run', async () => {
    const { logPath } = await makeLogDir('read-eleven');
    for (let segment = 0; segment <= 10; segment += 1) {
      await writeSegment(logPath, segment, eventLineList('run-1', segment, 1));
    }

    const { events } = await readNewEvents(initTailState(sourceFor(logPath)));

    expect(seqListOf(events)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('reads a run whose oldest segments were deleted, starting at the lowest survivor', async () => {
    const { logPath } = await makeLogDir('read-low-gap');
    await writeSegment(logPath, 2, eventLineList('run-1', 2, 2));
    await writeSegment(logPath, 3, eventLineList('run-1', 4, 2));

    const { events, state } = await readNewEvents(initTailState(sourceFor(logPath)));

    expect(seqListOf(events)).toEqual([2, 3, 4, 5]);
    expect(state.cursor.segment).toBe(3);
  });

  it('merges a rotated run with an unrotated one by ts, through the same reader', async () => {
    // The post-mortem/live identity `log-merge.ts` promises: a segmented run is
    // not a second code path.
    const { logPath: rotatedPath } = await makeLogDir('merge-rotated', 'run-a');
    const { logPath: plainPath } = await makeLogDir('merge-plain', 'run-b');
    await writeSegment(rotatedPath, 0, [line('run-a', '2026-03-01T00:00:00.000Z', { event: 'log', seq: 0 })]);
    await writeSegment(rotatedPath, 1, [line('run-a', '2026-03-01T00:00:02.000Z', { event: 'log', seq: 2 })]);
    await writeSegment(plainPath, 0, [
      line('run-b', '2026-03-01T00:00:01.000Z', { event: 'log', seq: 1 }),
      line('run-b', '2026-03-01T00:00:03.000Z', { event: 'log', seq: 3 }),
    ]);

    const { eventList } = await readAllMerged([
      sourceFor(rotatedPath, 'run-a'),
      sourceFor(plainPath, 'run-b'),
    ]);

    expect(seqListOf(eventList)).toEqual([0, 1, 2, 3]);
    expect(eventList.map((each) => each.runId)).toEqual(['run-a', 'run-b', 'run-a', 'run-b']);
  });

  it('picks up a new segment from its start across -f polls, reading no event twice and skipping none', async () => {
    const { logPath } = await makeLogDir('follow-boundary');
    await writeSegment(logPath, 0, eventLineList('run-1', 0, 2));

    const seen: number[] = [];
    let state: TailState = initTailState(sourceFor(logPath));

    const poll = async (): Promise<void> => {
      const result = await readNewEvents(state);
      state = result.state;
      seen.push(...seqListOf(result.events));
    };

    // Poll 1: the live segment as it stands.
    await poll();
    expect(seen).toEqual([0, 1]);

    // Poll 2: more lines appended to the still-live segment 0.
    await fs.appendFile(logPath, `${eventLineList('run-1', 2, 1).join('\n')}\n`, 'utf-8');
    await poll();
    expect(seen).toEqual([0, 1, 2]);
    expect(state.cursor.segment).toBe(0);

    // Poll 3: rotation — segment 0 is sealed and segment 1 becomes live.
    await writeSegment(logPath, 1, eventLineList('run-1', 3, 2));
    await poll();
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(state.cursor.segment).toBe(1);

    // Poll 4: the new live segment keeps growing and is followed in place.
    await fs.appendFile(segmentPathFor(logPath, 1), `${eventLineList('run-1', 5, 1).join('\n')}\n`, 'utf-8');
    await poll();

    // Every event exactly once, in order, with no gap at the boundary.
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('does not lose the last lines of a segment written just before its successor appeared', async () => {
    // The race the second drain exists for: bytes land in segment 0 after the
    // reader's last poll but before it notices segment 1.
    const { logPath } = await makeLogDir('boundary-race');
    await writeSegment(logPath, 0, eventLineList('run-1', 0, 1));

    let state: TailState = initTailState(sourceFor(logPath));
    const first = await readNewEvents(state);
    state = first.state;
    expect(seqListOf(first.events)).toEqual([0]);

    // Between polls: segment 0 gets a final line AND segment 1 is created.
    await fs.appendFile(logPath, `${eventLineList('run-1', 1, 1).join('\n')}\n`, 'utf-8');
    await writeSegment(logPath, 1, eventLineList('run-1', 2, 1));

    const second = await readNewEvents(state);
    expect(seqListOf(second.events)).toEqual([1, 2]);
    expect(second.state.cursor.segment).toBe(1);
  });

  it('keeps an unterminated final line in the LIVE segment for the next poll', async () => {
    // Unchanged from before segments existed: a write caught mid-line is
    // completed by the next poll, never dropped.
    const { logPath } = await makeLogDir('live-partial');
    const complete = line('run-1', '2026-03-01T00:00:00.000Z', { event: 'log', seq: 0 });
    const partial = line('run-1', '2026-03-01T00:00:01.000Z', { event: 'log', seq: 1 });
    await fs.writeFile(logPath, `${complete}\n${partial.slice(0, 12)}`, 'utf-8');

    const first = await readNewEvents(initTailState(sourceFor(logPath)));
    expect(seqListOf(first.events)).toEqual([0]);
    expect(first.state.leftover).toBe(partial.slice(0, 12));

    await fs.appendFile(logPath, `${partial.slice(12)}\n`, 'utf-8');
    const second = await readNewEvents(first.state);
    expect(seqListOf(second.events)).toEqual([1]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('drops an unterminated final line in a SEALED segment, with a diagnostic, and resynchronises', async () => {
    // Rotation closes a segment between lines, so this is damage rather than a
    // mid-write — carrying the fragment into segment 1 would splice it onto
    // that segment's first event and corrupt a second line too.
    const { logPath } = await makeLogDir('sealed-partial');
    const complete = line('run-1', '2026-03-01T00:00:00.000Z', { event: 'log', seq: 0 });
    await fs.writeFile(logPath, `${complete}\n{"ts":"2026-03-01T00:00:01.0`, 'utf-8');
    await writeSegment(logPath, 1, eventLineList('run-1', 2, 2));

    const { events, state } = await readNewEvents(initTailState(sourceFor(logPath)));

    expect(seqListOf(events)).toEqual([0, 2, 3]);
    expect(state.leftover).toBe('');
    expect(errorSpy).toHaveBeenCalled();
    const said = errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
    expect(said).toContain('sealed log segment 0');
    expect(said).toContain('run-1');
  });
});

// ---------------------------------------------------------------------------
// `workspace logs -f`, end to end
// ---------------------------------------------------------------------------

/** A registry entry plus its log directory, under `<root>/<name>/.rawbox`. */
async function makeWorkspace(name: string): Promise<{ workspaceDir: string; targetFolder: string }> {
  const workspaceDir = path.join(rootDir, name);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, 'workspace.yaml'),
    `kind: Workspace\nname: ${name}\nworkflowPathList: []\n`,
    'utf-8',
  );
  return { workspaceDir, targetFolder: path.join(workspaceDir, '.rawbox') };
}

async function registerRun(
  targetFolder: string,
  runId: string,
  overrides: Partial<RunRegistryEntry> = {},
): Promise<string> {
  const logPath = path.join(targetFolder, 'logs', 'wf', `${runId}.ndjson`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.mkdir(runsDirFor(targetFolder), { recursive: true });
  const entry: RunRegistryEntry = {
    format: RUN_REGISTRY_FORMAT,
    run_id: runId,
    workspace: 'ws',
    workflow: 'wf',
    pid: 999999,
    pid_started_at: 0,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    log_path: logPath,
    error_log_path: path.join(path.dirname(logPath), `${runId}.error.ndjson`),
    status: RUN_STATUS.OK,
    ...overrides,
  };
  await fs.writeFile(registryFilePathFor(targetFolder, runId), JSON.stringify(entry), 'utf-8');
  return logPath;
}

describe('workspace logs — rotated runs', () => {
  it('prints every segment of a rotated run in chronological order', async () => {
    const workspace = await makeWorkspace('logs-rotated');
    const logPath = await registerRun(workspace.targetFolder, 'run-rot');
    await writeSegment(logPath, 0, eventLineList('run-rot', 0, 2));
    await writeSegment(logPath, 1, eventLineList('run-rot', 2, 2));
    await writeSegment(logPath, 2, eventLineList('run-rot', 4, 2));

    const writes: string[] = [];
    await workspaceLogsCommand(workspace.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      runIdList: ['run-rot'],
      write: (text) => writes.push(text),
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const seqList = writes
      .join('')
      .split('\n')
      .filter((text) => text.length > 0)
      .map((text) => (JSON.parse(text) as { seq: number }).seq);
    expect(seqList).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('-f picks up a segment that appears mid-follow, without repeating or skipping an event', async () => {
    const workspace = await makeWorkspace('logs-follow-rotated');
    const logPath = await registerRun(workspace.targetFolder, 'run-follow', {
      status: RUN_STATUS.RUNNING,
    });
    await writeSegment(logPath, 0, eventLineList('run-follow', 0, 1));

    const alive = (): ProcessProbe => ({ alive: true, startedAtMs: 0 });
    const writes: string[] = [];
    const followPromise = workspaceLogsCommand(workspace.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      follow: true,
      probe: alive,
      pollIntervalMs: 10,
      maxPolls: 8,
      write: (text) => writes.push(text),
    });

    // Append to the live segment…
    await new Promise((resolve) => setTimeout(resolve, 25));
    await fs.appendFile(logPath, `${eventLineList('run-follow', 1, 1).join('\n')}\n`, 'utf-8');
    // …then rotate: segment 0 is sealed, segment 1 takes over.
    await new Promise((resolve) => setTimeout(resolve, 25));
    await writeSegment(logPath, 1, eventLineList('run-follow', 2, 1));

    await followPromise;

    const seqList = writes
      .join('')
      .split('\n')
      .filter((text) => text.length > 0)
      .map((text) => (JSON.parse(text) as { seq: number }).seq);
    expect(seqList).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// The other readers of `log_path`
// ---------------------------------------------------------------------------

describe('runs tail — rotated runs', () => {
  it('prints the bytes of every segment, oldest first', async () => {
    const workspace = await makeWorkspace('tail-rotated');
    const logPath = await registerRun(workspace.targetFolder, 'run-tail');
    await writeSegment(logPath, 0, eventLineList('run-tail', 0, 1));
    await writeSegment(logPath, 1, eventLineList('run-tail', 1, 1));
    await writeSegment(logPath, 2, eventLineList('run-tail', 2, 1));

    const writes: string[] = [];
    await runsTailCommand('run-tail', { cwd: rootDir, write: (text) => writes.push(text) });

    expect(exitSpy).not.toHaveBeenCalled();
    const combined = writes.join('');
    expect(combined).toContain('"seq":0');
    expect(combined).toContain('"seq":1');
    expect(combined).toContain('"seq":2');
    expect(combined.indexOf('"seq":0')).toBeLessThan(combined.indexOf('"seq":2'));
  });
});

describe('summarizeRunLog — rotated runs', () => {
  it('counts events across every segment and takes lastEvent from the newest', async () => {
    // This `run.end` carries no `steps_total`/`steps_failed` of its own, so
    // there is nothing authoritative to prefer and the function falls back to
    // counting `step.end` lines — the same fallback exercised deliberately
    // (and by name) in 'falls back to counting step.end when there is no
    // run.end' below. Kept as-is (rather than folding steps_total into this
    // fixture) so the fallback path still has independent coverage even if a
    // later change adds those fields to every `run.end` fixture in this file.
    const { logPath } = await makeLogDir('summary');
    await writeSegment(logPath, 0, [
      line('run-1', '2026-03-01T00:00:00.000Z', { event: 'run.start' }),
      line('run-1', '2026-03-01T00:00:01.000Z', { event: 'step.end', outcome: 'ok' }),
    ]);
    await writeSegment(logPath, 1, [
      line('run-1', '2026-03-01T00:00:02.000Z', { event: 'step.end', outcome: 'ok' }),
      line('run-1', '2026-03-01T00:00:03.000Z', { event: 'step.end', outcome: 'error' }),
    ]);
    await writeSegment(logPath, 2, [
      line('run-1', '2026-03-01T00:00:04.000Z', { event: 'run.end', outcome: 'error' }),
    ]);

    const summary = await summarizeRunLog(logPath);

    expect(summary.totalEvents).toBe(5);
    expect(summary.eventCounts['step.end']).toBe(3);
    expect(summary.stepsOk).toBe(2);
    expect(summary.stepsFailed).toBe(1);
    expect(summary.readable).toBe(true);
    expect(summary.lastEvent?.['event']).toBe('run.end');
  });

  it('prefers run.end\'s steps_total/steps_failed over counting, even when they disagree with the log', async () => {
    // The log itself says 2 ok / 1 failed if you count `step.end` lines. The
    // `run.end` deliberately disagrees (1 / 1) so the assertion can only pass
    // if the function is reading the authoritative fields rather than
    // counting — this is the case rotation breaks: a workflow whose earlier
    // segments were retired by `logs.rotate.maxFiles` would under-count this
    // way for real, with `run.end` as the only surviving source of truth.
    const { logPath } = await makeLogDir('summary-prefers-run-end');
    await writeSegment(logPath, 0, [
      line('run-1', '2026-03-01T00:00:00.000Z', { event: 'run.start' }),
      line('run-1', '2026-03-01T00:00:01.000Z', { event: 'step.end', outcome: 'ok' }),
      line('run-1', '2026-03-01T00:00:02.000Z', { event: 'step.end', outcome: 'ok' }),
      line('run-1', '2026-03-01T00:00:03.000Z', { event: 'step.end', outcome: 'error' }),
      line('run-1', '2026-03-01T00:00:04.000Z', {
        event: 'run.end',
        outcome: 'error',
        steps_total: 2,
        steps_failed: 1,
      }),
    ]);

    const summary = await summarizeRunLog(logPath);

    expect(summary.stepsFailed).toBe(1);
    expect(summary.stepsOk).toBe(1);
  });

  it('falls back to counting step.end when there is no run.end (run still in flight, or crashed without one)', async () => {
    // No `run.end` at all — the honest record of a run that is either still
    // running or died mid-flight (OBSERVABILITY.md: a missing `run.end` means
    // "the process died", not "the run failed"). The only source of truth
    // left is the `step.end` lines themselves, so the fallback count must be
    // what `workspace status` sees.
    const { logPath } = await makeLogDir('summary-no-run-end');
    await writeSegment(logPath, 0, [
      line('run-1', '2026-03-01T00:00:00.000Z', { event: 'run.start' }),
      line('run-1', '2026-03-01T00:00:01.000Z', { event: 'step.end', outcome: 'ok' }),
      line('run-1', '2026-03-01T00:00:02.000Z', { event: 'step.end', outcome: 'ok' }),
      line('run-1', '2026-03-01T00:00:03.000Z', { event: 'step.end', outcome: 'error' }),
    ]);

    const summary = await summarizeRunLog(logPath);

    expect(summary.stepsOk).toBe(2);
    expect(summary.stepsFailed).toBe(1);
  });

  it('finds run.end in a later segment than the step.end lines it accounts for', async () => {
    // The step.end lines live in segment 0; run.end — with the authoritative
    // totals — only shows up in segment 2, once the run has rotated twice
    // more. The function must still find and prefer it: the per-segment loop
    // has to run to completion (not stop at the first segment holding a
    // step.end) before the run.end/counting decision is made.
    const { logPath } = await makeLogDir('summary-run-end-later-segment');
    await writeSegment(logPath, 0, [
      line('run-1', '2026-03-01T00:00:00.000Z', { event: 'run.start' }),
      line('run-1', '2026-03-01T00:00:01.000Z', { event: 'step.end', outcome: 'ok' }),
      line('run-1', '2026-03-01T00:00:02.000Z', { event: 'step.end', outcome: 'ok' }),
      line('run-1', '2026-03-01T00:00:03.000Z', { event: 'step.end', outcome: 'error' }),
    ]);
    await writeSegment(logPath, 1, [
      line('run-1', '2026-03-01T00:00:04.000Z', { event: 'log', message: 'unrelated' }),
    ]);
    await writeSegment(logPath, 2, [
      line('run-1', '2026-03-01T00:00:05.000Z', {
        event: 'run.end',
        outcome: 'error',
        steps_total: 3,
        steps_failed: 1,
      }),
    ]);

    const summary = await summarizeRunLog(logPath);

    expect(summary.stepsFailed).toBe(1);
    expect(summary.stepsOk).toBe(2);
    expect(summary.lastEvent?.['event']).toBe('run.end');
  });

  it('a step.end never reports outcome "interrupted" (run-level only), so steps_total - steps_failed is exactly stepsOk', async () => {
    // Guards the derivation itself, not just its output on ordinary input:
    // event-types.ts reserves `interrupted` for `run.end`'s RunOutcome and
    // gives `step.end` only the two-value Outcome (ok | error), so there is
    // no third bucket for `run.end`'s steps_total to have silently absorbed.
    // A `step.end` carrying `outcome: "interrupted"` here would be malformed
    // per that schema — this fixture is deliberately the well-formed case,
    // demonstrating that steps_total's split is exhaustive over ok/error.
    const { logPath } = await makeLogDir('summary-no-third-outcome');
    await writeSegment(logPath, 0, [
      line('run-1', '2026-03-01T00:00:00.000Z', { event: 'run.start' }),
      line('run-1', '2026-03-01T00:00:01.000Z', { event: 'step.end', outcome: 'ok' }),
      line('run-1', '2026-03-01T00:00:02.000Z', { event: 'step.end', outcome: 'error' }),
      line('run-1', '2026-03-01T00:00:03.000Z', {
        event: 'run.end',
        outcome: 'interrupted',
        steps_total: 2,
        steps_failed: 1,
      }),
    ]);

    const summary = await summarizeRunLog(logPath);

    // steps_total (2) - steps_failed (1) = 1, matching the single "ok" step.end.
    expect(summary.stepsOk).toBe(1);
    expect(summary.stepsFailed).toBe(1);
  });

  it('takes lastError from the newest error segment, enumerated separately from the main log', async () => {
    const { logDir, logPath } = await makeLogDir('summary-error');
    const errorLogPath = path.join(logDir, 'run-1.error.ndjson');
    await writeSegment(logPath, 0, [line('run-1', '2026-03-01T00:00:00.000Z', { event: 'run.start' })]);
    await writeSegment(errorLogPath, 0, [
      line('run-1', '2026-03-01T00:00:01.000Z', { event: 'step.end', message: 'older failure' }),
    ]);
    await writeSegment(errorLogPath, 1, [
      line('run-1', '2026-03-01T00:00:02.000Z', { event: 'step.end', message: 'newest failure' }),
    ]);

    const summary = await summarizeRunLog(logPath, errorLogPath);

    expect(summary.totalEvents).toBe(1);
    expect(summary.lastError?.message).toBe('newest failure');
  });
});

describe('runs prune — measuring a rotated run', () => {
  it('charges every segment to the maxBytes budget, not just segment 0', async () => {
    // Sized so the two answers differ: measuring only segment 0 leaves the
    // older run comfortably inside the budget, while the true size of the
    // rotated run consumes it entirely.
    const workspace = await makeWorkspace('prune-rotated');
    const nowMs = Date.now();

    const newLogPath = await registerRun(workspace.targetFolder, 'run-new', {
      started_at: new Date(nowMs - 5 * 60_000).toISOString(),
    });
    await fs.writeFile(newLogPath, 'x'.repeat(100), 'utf-8');
    await fs.writeFile(segmentPathFor(newLogPath, 1), 'x'.repeat(5000), 'utf-8');

    const oldLogPath = await registerRun(workspace.targetFolder, 'run-old', {
      started_at: new Date(nowMs - 50 * 60_000).toISOString(),
    });
    await fs.writeFile(oldLogPath, 'x'.repeat(100), 'utf-8');

    const deadProbe = (): ProcessProbe => ({ alive: false });
    await pruneRuns(workspace.targetFolder, { maxBytes: 3000 }, deadProbe);

    const survivorList = (await listRegistryEntries(workspace.targetFolder)).map(
      (entry) => entry.run_id,
    );
    expect(survivorList).toEqual(['run-new']);
  });

  it('still measures an unrotated run exactly as before', async () => {
    const workspace = await makeWorkspace('prune-unrotated');
    const nowMs = Date.now();

    const newLogPath = await registerRun(workspace.targetFolder, 'run-new', {
      started_at: new Date(nowMs - 5 * 60_000).toISOString(),
    });
    await fs.writeFile(newLogPath, 'x'.repeat(100), 'utf-8');
    const oldLogPath = await registerRun(workspace.targetFolder, 'run-old', {
      started_at: new Date(nowMs - 50 * 60_000).toISOString(),
    });
    await fs.writeFile(oldLogPath, 'x'.repeat(100), 'utf-8');

    const deadProbe = (): ProcessProbe => ({ alive: false });
    await pruneRuns(workspace.targetFolder, { maxBytes: 3000 }, deadProbe);

    const survivorList = (await listRegistryEntries(workspace.targetFolder))
      .map((entry) => entry.run_id)
      .sort();
    expect(survivorList).toEqual(['run-new', 'run-old']);
  });
});
