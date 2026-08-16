import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

import { workspaceLogsCommand } from '../src/commands/workspace/logs.js';
import { registryFilePathFor, runsDirFor } from '../src/runs/registry-io.js';
import { RUN_REGISTRY_FORMAT, RUN_STATUS, type RunRegistryEntry } from '../src/runs/types.js';
import type { ProcessProbe } from '../src/runs/pid-probe.js';
import { parseSince, sortMerged, type MergedEvent } from '../src/workspace/log-merge.js';

// ---------------------------------------------------------------------------
// `workspace logs` — merge ordering (interleaved timestamps, run_id tiebreak),
// `--run` over finished runs, `--since` window filtering, `--output json`
// shapes and `-f` follow, including a run that only appears mid-follow
// (OBSERVABILITY.md, "CLI surfaces"). The historical (`--run`/`--since`) path
// is exercised on purpose against genuinely *terminal* registry entries —
// post-mortem reconstruction across completed runs is a first-class case,
// not a degraded one, and merges through the same reader a live run uses.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-workspace-logs-test');

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
  // `workspace logs` never calls `console.log` (it writes complete lines via
  // the injectable `write`, captured below) — this only silences whatever a
  // friendly-empty-state `p.log.info` fallback might otherwise print through it.
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'info').mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(rootDir, { recursive: true, force: true });
});

interface Fixture {
  workspaceDir: string;
  targetFolder: string;
}

async function makeFixture(name: string): Promise<Fixture> {
  const workspaceDir = path.join(rootDir, name);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, 'workspace.yaml'),
    `kind: Workspace\nname: ${name}\nworkflowPathList: []\n`,
    'utf-8',
  );
  return { workspaceDir, targetFolder: path.join(workspaceDir, '.rawbox') };
}

async function writeRun(
  fixture: Fixture,
  runId: string,
  workflow: string,
  overrides: Partial<RunRegistryEntry>,
  logLines: string[],
): Promise<string> {
  const logPath = path.join(fixture.targetFolder, 'logs', workflow, `${runId}.ndjson`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, logLines.map((line) => `${line}\n`).join(''), 'utf-8');

  await fs.mkdir(runsDirFor(fixture.targetFolder), { recursive: true });
  const entry: RunRegistryEntry = {
    format: RUN_REGISTRY_FORMAT,
    run_id: runId,
    workspace: 'ws',
    workflow,
    pid: 999999,
    pid_started_at: 0,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    log_path: logPath,
    error_log_path: logPath,
    status: RUN_STATUS.OK,
    ...overrides,
  };
  await fs.writeFile(registryFilePathFor(fixture.targetFolder, runId), JSON.stringify(entry), 'utf-8');
  return logPath;
}

function line(runId: string, ts: string, rest: Record<string, unknown>): string {
  return JSON.stringify({ ts, run_id: runId, ...rest });
}

/**
 * `workspace logs` writes complete lines via an injectable `write` (like
 * `runs tail`/`store watch`), not `console.log` — this collects them and
 * parses each as one merged event, the `--output json` shape.
 */
function captureJsonLines(): {
  write: (text: string) => void;
  lines: () => Array<{ run_id: string; event: string; ts: string }>;
} {
  const chunkList: string[] = [];
  return {
    write: (text: string) => chunkList.push(text),
    lines: () =>
      chunkList
        .join('')
        .split('\n')
        .filter((text) => text.length > 0)
        .map((text) => JSON.parse(text) as { run_id: string; event: string; ts: string }),
  };
}

describe('workspace logs — merge ordering', () => {
  it('merges three synthetic run logs by ts, breaking a tie by run_id', async () => {
    const fixture = await makeFixture('merge-order');
    const alive = (): ProcessProbe => ({ alive: true, startedAtMs: 0 });

    await writeRun(fixture, 'run-a', 'a', { status: RUN_STATUS.RUNNING }, [
      line('run-a', '2026-01-01T00:00:00.100Z', { event: 'run.start' }),
      line('run-a', '2026-01-01T00:00:00.300Z', { event: 'step.end', outcome: 'ok', step: { label: 'x' } }),
    ]);
    await writeRun(fixture, 'run-b', 'b', { status: RUN_STATUS.RUNNING }, [
      line('run-b', '2026-01-01T00:00:00.200Z', { event: 'run.start' }),
    ]);
    await writeRun(fixture, 'run-c', 'c', { status: RUN_STATUS.RUNNING }, [
      // Same instant as run-b's run.start — run_id tiebreak decides the order.
      line('run-c', '2026-01-01T00:00:00.200Z', { event: 'step.start', step: { label: 'y' } }),
    ]);

    const capture = captureJsonLines();
    await workspaceLogsCommand(fixture.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      probe: alive,
      write: capture.write,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const lines = capture.lines();
    expect(lines.map((l) => [l.run_id, l.event])).toEqual([
      ['run-a', 'run.start'],
      ['run-b', 'run.start'],
      ['run-c', 'step.start'],
      ['run-a', 'step.end'],
    ]);
  });

  it('passes run.heartbeat / step.progress / severity through untouched — the additive-format contract', async () => {
    // The merged-log parser reads event-shaped JSON generically
    // (OBSERVABILITY.md, "Versioning"'s
    // additive/backward-tolerance rule): a new-format stream carrying kinds
    // and fields older readers never had must not throw, and every line —
    // known kind or not — must still come through in order.
    const fixture = await makeFixture('new-format-tolerance');
    const alive = (): ProcessProbe => ({ alive: true, startedAtMs: 0 });

    await writeRun(fixture, 'run-new', 'grid', { status: RUN_STATUS.RUNNING }, [
      line('run-new', '2026-01-01T00:00:00.000Z', { event: 'run.start', format: 1 }),
      line('run-new', '2026-01-01T00:00:00.100Z', {
        event: 'step.start',
        step: { index: 0, iteration: 0, label: 'long-step' },
      }),
      line('run-new', '2026-01-01T00:00:00.200Z', {
        event: 'run.heartbeat',
        step: { index: 0, iteration: 0, label: 'long-step' },
        in_flight_ms: 100,
      }),
      line('run-new', '2026-01-01T00:00:00.300Z', {
        event: 'step.progress',
        message: 'halfway there',
        data: { processed: 5 },
        step: { index: 0, iteration: 0, label: 'long-step' },
      }),
      line('run-new', '2026-01-01T00:00:00.400Z', {
        event: 'step.end',
        outcome: 'error',
        step: { index: 0, iteration: 0, label: 'long-step' },
        error: { message: 'it broke' },
        severity: 'error',
      }),
    ]);

    const capture = captureJsonLines();
    await expect(
      workspaceLogsCommand(fixture.workspaceDir, {
        cwd: rootDir,
        output: 'json',
        probe: alive,
        write: capture.write,
      }),
    ).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(capture.lines().map((l) => l.event)).toEqual([
      'run.start',
      'step.start',
      'run.heartbeat',
      'step.progress',
      'step.end',
    ]);
  });

  it('sortMerged is a pure stable sort on (tsMs, runId) — unit-level guard for the tiebreak', () => {
    const eventList: MergedEvent[] = [
      { ts: 't', tsMs: 100, runId: 'z', workflow: 'w', event: {} },
      { ts: 't', tsMs: 50, runId: 'a', workflow: 'w', event: {} },
      { ts: 't', tsMs: 100, runId: 'a', workflow: 'w', event: {} },
    ];
    const sorted = sortMerged(eventList);
    expect(sorted.map((e) => `${e.tsMs}:${e.runId}`)).toEqual(['50:a', '100:a', '100:z']);
  });
});

describe('workspace logs — --run over finished runs (the post-mortem path)', () => {
  it('selecting two FINISHED runs by id merges them exactly as a live merge would', async () => {
    const fixture = await makeFixture('run-finished');

    await writeRun(
      fixture,
      'run-done-1',
      'reconciler',
      { status: RUN_STATUS.OK, ended_at: new Date().toISOString() },
      [
        line('run-done-1', '2026-02-01T00:00:00.000Z', { event: 'run.start' }),
        line('run-done-1', '2026-02-01T00:00:02.000Z', { event: 'run.end', outcome: 'ok', steps_total: 1, steps_failed: 0, duration_ms: 2000 }),
      ],
    );
    await writeRun(
      fixture,
      'run-done-2',
      'grid',
      { status: RUN_STATUS.ERROR, ended_at: new Date().toISOString(), error: { message: 'boom' } },
      [
        line('run-done-2', '2026-02-01T00:00:01.000Z', { event: 'run.start' }),
        line('run-done-2', '2026-02-01T00:00:01.500Z', { event: 'run.end', outcome: 'error', steps_total: 1, steps_failed: 1, error: { message: 'boom' } }),
      ],
    );

    const capture = captureJsonLines();
    await workspaceLogsCommand(fixture.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      runIdList: ['run-done-1', 'run-done-2'],
      write: capture.write,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const lines = capture.lines();
    // Interleaved by ts regardless of which run finished "first" in wall time —
    // the same ordering rule a merge of two still-live runs would apply.
    expect(lines.map((l) => [l.run_id, l.event])).toEqual([
      ['run-done-1', 'run.start'],
      ['run-done-2', 'run.start'],
      ['run-done-2', 'run.end'],
      ['run-done-1', 'run.end'],
    ]);
  });

  it('errors clearly when a requested --run id has no registry entry', async () => {
    const fixture = await makeFixture('run-missing');
    await workspaceLogsCommand(fixture.workspaceDir, {
      cwd: rootDir,
      runIdList: ['does-not-exist'],
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('workspace logs — --since window filtering', () => {
  it('parses relative shorthand and ISO instants', () => {
    const now = Date.parse('2026-01-01T00:10:00.000Z');
    expect(parseSince('15m', now)).toBe(now - 15 * 60_000);
    expect(parseSince('2h', now)).toBe(now - 2 * 3_600_000);
    expect(parseSince('2026-01-01T00:00:00.000Z')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(parseSince('not-a-time')).toBeUndefined();
  });

  it('includes only runs whose lifetime overlaps the window, finished or still live', async () => {
    const fixture = await makeFixture('since-window');
    const now = Date.now();

    // Ended 20 minutes ago: entirely before a 10-minute window.
    await writeRun(
      fixture,
      'run-too-old',
      'a',
      { status: RUN_STATUS.OK, ended_at: new Date(now - 20 * 60_000).toISOString() },
      [line('run-too-old', new Date(now - 21 * 60_000).toISOString(), { event: 'run.start' })],
    );
    // Ended 2 minutes ago: inside a 10-minute window.
    await writeRun(
      fixture,
      'run-recent',
      'b',
      { status: RUN_STATUS.OK, ended_at: new Date(now - 2 * 60_000).toISOString() },
      [line('run-recent', new Date(now - 3 * 60_000).toISOString(), { event: 'run.start' })],
    );
    // Still running (no `ended_at`): always overlaps, regardless of when it started.
    await writeRun(
      fixture,
      'run-still-live',
      'c',
      { status: RUN_STATUS.RUNNING, started_at: new Date(now - 60 * 60_000).toISOString() },
      [line('run-still-live', new Date(now - 60 * 60_000).toISOString(), { event: 'run.start' })],
    );

    const capture = captureJsonLines();
    await workspaceLogsCommand(fixture.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      since: '10m',
      write: capture.write,
    });

    const runIdSet = new Set(capture.lines().map((l) => l.run_id));
    expect(runIdSet.has('run-too-old')).toBe(false);
    expect(runIdSet.has('run-recent')).toBe(true);
    expect(runIdSet.has('run-still-live')).toBe(true);
  });

  it('rejects an unparseable --since value', async () => {
    const fixture = await makeFixture('since-invalid');
    await workspaceLogsCommand(fixture.workspaceDir, { cwd: rootDir, since: 'nonsense' });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('workspace logs — friendly empty states', () => {
  it('reports no live runs rather than erroring, when none are live', async () => {
    const fixture = await makeFixture('no-live');
    const dead = (): ProcessProbe => ({ alive: false });
    await writeRun(fixture, 'run-x', 'a', { status: RUN_STATUS.RUNNING }, []);

    await workspaceLogsCommand(fixture.workspaceDir, { cwd: rootDir, probe: dead });

    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('workspace logs — -f follow', () => {
  it('follows appended lines and picks up a run that only appears mid-follow', async () => {
    const fixture = await makeFixture('follow-scenario');
    const alive = (): ProcessProbe => ({ alive: true, startedAtMs: 0 });

    const logPathA = await writeRun(fixture, 'run-follow-a', 'a', { status: RUN_STATUS.RUNNING }, [
      line('run-follow-a', '2026-03-01T00:00:00.000Z', { event: 'run.start' }),
    ]);

    const writes: string[] = [];
    const followPromise = workspaceLogsCommand(fixture.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      follow: true,
      probe: alive,
      pollIntervalMs: 10,
      maxPolls: 4,
      write: (text) => writes.push(text),
    });

    // Append to the already-selected run, and register a brand-new live run,
    // both partway through the poll loop.
    await new Promise((resolve) => setTimeout(resolve, 15));
    await fs.appendFile(logPathA, `${line('run-follow-a', '2026-03-01T00:00:01.000Z', { event: 'run.end', outcome: 'ok', steps_total: 0, steps_failed: 0, duration_ms: 1000 })}\n`);
    await writeRun(fixture, 'run-follow-b', 'b', { status: RUN_STATUS.RUNNING }, [
      line('run-follow-b', '2026-03-01T00:00:02.000Z', { event: 'run.start' }),
    ]);

    await followPromise;

    const combined = writes.join('');
    const parsedList = combined
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { run_id: string; event: string });

    expect(parsedList.some((e) => e.run_id === 'run-follow-a' && e.event === 'run.start')).toBe(true);
    expect(parsedList.some((e) => e.run_id === 'run-follow-a' && e.event === 'run.end')).toBe(true);
    // The run created *after* -f started is picked up without restarting the command.
    expect(parsedList.some((e) => e.run_id === 'run-follow-b' && e.event === 'run.start')).toBe(true);
  });
});
