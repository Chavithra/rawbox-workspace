import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

import { runsListCommand } from '../src/commands/runs/list.js';
import { runsShowCommand } from '../src/commands/runs/show.js';
import { runsTailCommand } from '../src/commands/runs/tail.js';
import { runsPruneCommand } from '../src/commands/runs/prune.js';
import { registryFilePathFor, runsDirFor } from '../src/runs/registry-io.js';
import { RUN_REGISTRY_FORMAT, RUN_STATUS, type RunRegistryEntry } from '../src/runs/types.js';
import type { ProcessProbe } from '../src/runs/pid-probe.js';

// ---------------------------------------------------------------------------
// Smoke coverage for the `runs` CLI command surface, over synthetic fixtures
// — no real workflow execution needed to exercise reading, formatting and
// scanning. `runs-lifecycle.test.ts` covers the registry being written by a
// real run.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-runs-cli-test');

let logSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'info').mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(rootDir, { recursive: true, force: true });
});

function loggedText(): string {
  const joined = logSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
  // eslint-disable-next-line no-control-regex
  return joined.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Writes a workspace document, a run's registry entry and its log file, all under `<root>/<name>/.rawbox`. */
async function makeFixture(
  name: string,
  runId: string,
  statusOverrides: Partial<RunRegistryEntry>,
  logLines: string[],
): Promise<{ workspaceDir: string; workspacePath: string; targetFolder: string }> {
  const workspaceDir = path.join(rootDir, name);
  await fs.mkdir(workspaceDir, { recursive: true });
  const workspacePath = path.join(workspaceDir, 'workspace.yaml');
  await fs.writeFile(
    workspacePath,
    `kind: Workspace\nname: ${name}\nworkflowPathList: []\n`,
    'utf-8',
  );

  const targetFolder = path.join(workspaceDir, '.rawbox');
  const logPath = path.join(targetFolder, 'logs', `${runId}.ndjson`);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.writeFile(logPath, logLines.map((line) => `${line}\n`).join(''), 'utf-8');

  await fs.mkdir(runsDirFor(targetFolder), { recursive: true });
  const entry: RunRegistryEntry = {
    format: RUN_REGISTRY_FORMAT,
    run_id: runId,
    workspace: name,
    workflow: 'wf',
    pid: 999999, // presumed not to exist; overridden per-test via a fake probe anyway
    pid_started_at: 0,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    log_path: logPath,
    error_log_path: logPath,
    status: RUN_STATUS.OK,
    ...statusOverrides,
  };
  await fs.writeFile(registryFilePathFor(targetFolder, runId), JSON.stringify(entry), 'utf-8');

  return { workspaceDir, workspacePath, targetFolder };
}

describe('runs list', () => {
  it('lists a workspace\'s runs as text, with a status column', async () => {
    const fixture = await makeFixture('list-text', 'run-1', { status: RUN_STATUS.OK, steps_total: 2, steps_failed: 0, duration_ms: 123 }, []);

    await runsListCommand({ workspace: fixture.workspacePath, output: 'text' });

    expect(exitSpy).not.toHaveBeenCalled();
    const text = loggedText();
    expect(text).toContain('run-1');
    expect(text).toContain('wf');
    expect(text).toContain('ok');
  });

  it('emits machine-readable JSON including the computed display status', async () => {
    const fixture = await makeFixture('list-json', 'run-2', { status: RUN_STATUS.RUNNING }, []);

    const deadProbe = (): ProcessProbe => ({ alive: false });
    await runsListCommand({ workspace: fixture.workspacePath, output: 'json', probe: deadProbe });

    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed).toHaveLength(1);
    expect(printed[0].run_id).toBe('run-2');
    // A `running` entry whose pid the probe reports dead is `crashed`.
    expect(printed[0].displayStatus).toBe('crashed');
  });

  it('accepts a workspace *directory* holding one workspace document, like `workspace status` does', async () => {
    // Passing `workspaces/<name>` instead of `workspaces/<name>/workspace.yaml`
    // used to fall back to the directory's *parent* as the target folder and
    // print "No runs found." with no hint — resolution now goes through
    // `resolveStoreTarget`, the same helper `workspace status`/`store list` use.
    const fixture = await makeFixture('list-dir', 'run-dir-1', { status: RUN_STATUS.OK }, []);

    await runsListCommand({ workspace: fixture.workspaceDir, output: 'json' });

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed).toHaveLength(1);
    expect(printed[0].run_id).toBe('run-dir-1');
  });

  it('fails clearly on a directory holding no workspace document, instead of listing nothing', async () => {
    const emptyDir = path.join(rootDir, 'no-workspace-here');
    await fs.mkdir(emptyDir, { recursive: true });

    await runsListCommand({ workspace: emptyDir, output: 'text' });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('scans project-wide from cwd when no workspace is given', async () => {
    await makeFixture('scan-a', 'run-a', {}, []);
    await makeFixture('scan-b', 'run-b', {}, []);

    await runsListCommand({ output: 'json', cwd: rootDir });

    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed.map((entry: RunRegistryEntry) => entry.run_id).sort()).toEqual(['run-a', 'run-b']);
  });
});

describe('runs show', () => {
  it('reports the registry entry plus a log summary, found without a --workspace flag', async () => {
    await makeFixture(
      'show-scenario',
      'run-show-1',
      { status: RUN_STATUS.OK, steps_total: 1, steps_failed: 0 },
      [
        JSON.stringify({ ts: '2026-01-01T00:00:00Z', run_id: 'run-show-1', event: 'run.start' }),
        JSON.stringify({ ts: '2026-01-01T00:00:01Z', run_id: 'run-show-1', event: 'step.end', outcome: 'ok' }),
        JSON.stringify({ ts: '2026-01-01T00:00:02Z', run_id: 'run-show-1', event: 'run.end', outcome: 'ok' }),
      ],
    );

    await runsShowCommand('run-show-1', { output: 'json', cwd: rootDir });

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed.entry.run_id).toBe('run-show-1');
    expect(printed.entry.displayStatus).toBe('ok');
    expect(printed.summary.totalEvents).toBe(3);
    expect(printed.summary.eventCounts['run.end']).toBe(1);
    expect(printed.summary.lastEvent.event).toBe('run.end');
  });

  it('fails clearly when no run with that id exists anywhere under cwd', async () => {
    await runsShowCommand('run-does-not-exist', { cwd: rootDir });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('summarises a new-format log (run.heartbeat/step.progress/severity) without erroring', async () => {
    // The log-summary reader is a generic line-by-line JSON parse
    // (`../src/runs/log-summary.js`), not a schema check — a stream carrying
    // kinds and fields it predates must not throw, and every parseable line
    // still counts (OBSERVABILITY.md, "Versioning"'s additive rule).
    await makeFixture(
      'show-new-format',
      'run-show-2',
      { status: RUN_STATUS.OK, steps_total: 1, steps_failed: 1 },
      [
        JSON.stringify({ ts: '2026-01-01T00:00:00Z', run_id: 'run-show-2', event: 'run.start', format: 1 }),
        JSON.stringify({
          ts: '2026-01-01T00:00:00.1Z',
          run_id: 'run-show-2',
          event: 'step.start',
          step: { index: 0, iteration: 0, label: 'long-step' },
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:01Z',
          run_id: 'run-show-2',
          event: 'run.heartbeat',
          step: { index: 0, iteration: 0, label: 'long-step' },
          in_flight_ms: 900,
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:01.5Z',
          run_id: 'run-show-2',
          event: 'step.progress',
          message: 'halfway',
          step: { index: 0, iteration: 0, label: 'long-step' },
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:02Z',
          run_id: 'run-show-2',
          event: 'step.end',
          outcome: 'error',
          step: { index: 0, iteration: 0, label: 'long-step' },
          error: { message: 'it broke' },
          severity: 'error',
        }),
        JSON.stringify({
          ts: '2026-01-01T00:00:03Z',
          run_id: 'run-show-2',
          event: 'run.end',
          outcome: 'error',
          severity: 'error',
        }),
      ],
    );

    await expect(runsShowCommand('run-show-2', { output: 'json', cwd: rootDir })).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed.summary.totalEvents).toBe(6);
    expect(printed.summary.eventCounts['run.heartbeat']).toBe(1);
    expect(printed.summary.eventCounts['step.progress']).toBe(1);
    expect(printed.summary.stepsFailed).toBe(1);
    expect(printed.summary.lastEvent.event).toBe('run.end');
  });
});

describe('runs tail', () => {
  it('prints the log\'s current contents without --follow', async () => {
    const writes: string[] = [];
    await makeFixture('tail-scenario', 'run-tail-1', {}, ['{"event":"run.start"}', '{"event":"run.end"}']);

    await runsTailCommand('run-tail-1', { cwd: rootDir, write: (text) => writes.push(text) });

    const combined = writes.join('');
    expect(combined).toContain('"event":"run.start"');
    expect(combined).toContain('"event":"run.end"');
  });

  it('--follow prints appended lines across polls, then stops at maxPolls', async () => {
    const fixture = await makeFixture('tail-follow-scenario', 'run-tail-2', {}, ['{"event":"run.start"}']);
    const entryPath = registryFilePathFor(fixture.targetFolder, 'run-tail-2');
    const entry = JSON.parse(await fs.readFile(entryPath, 'utf-8')) as RunRegistryEntry;

    const writes: string[] = [];
    const tailPromise = runsTailCommand('run-tail-2', {
      cwd: rootDir,
      follow: true,
      write: (text) => writes.push(text),
      pollIntervalMs: 5,
      maxPolls: 3,
    });

    // Append a new line partway through the poll loop.
    await new Promise((resolve) => setTimeout(resolve, 8));
    await fs.appendFile(entry.log_path, '{"event":"run.end"}\n');

    await tailPromise;

    const combined = writes.join('');
    expect(combined).toContain('"event":"run.start"');
    expect(combined).toContain('"event":"run.end"');
  });
});

describe('runs prune (CLI wrapper)', () => {
  it('prunes a workspace down to --keep, reporting the deleted run', async () => {
    const fixtureOld = await makeFixture('prune-cli', 'run-old', { started_at: new Date(Date.now() - 100_000).toISOString() }, []);
    await makeFixture('prune-cli', 'run-new', { started_at: new Date().toISOString() }, []);

    await runsPruneCommand({ workspace: fixtureOld.workspacePath, keep: 1, output: 'json' });

    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed).toHaveLength(1);
    expect(printed[0].result.prunedList.map((pruned: { runId: string }) => pruned.runId)).toEqual(['run-old']);

    await expect(fs.stat(registryFilePathFor(fixtureOld.targetFolder, 'run-old'))).rejects.toThrow();
    await expect(fs.stat(registryFilePathFor(fixtureOld.targetFolder, 'run-new'))).resolves.toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // `logs.prune:` — the workspace document's own bounds, replacing the old
  // project-wide `rawbox.config.json`. Resolved by `@rawbox/runner`'s
  // `resolveLogsConfig`: an explicit flag wins, then the document, then the
  // built-in default.
  // ---------------------------------------------------------------------------

  it('picks up logs.prune from the workspace document when no --keep flag is given', async () => {
    const fixtureOld = await makeFixture('prune-logs-doc', 'run-old', { started_at: new Date(Date.now() - 100_000).toISOString() }, []);
    await makeFixture('prune-logs-doc', 'run-new', { started_at: new Date().toISOString() }, []);

    await fs.writeFile(
      fixtureOld.workspacePath,
      'kind: Workspace\nname: prune-logs-doc\nworkflowPathList: []\nlogs:\n  prune:\n    keep: 1\n',
      'utf-8',
    );

    await runsPruneCommand({ workspace: fixtureOld.workspacePath, output: 'json' });

    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed[0].result.prunedList.map((pruned: { runId: string }) => pruned.runId)).toEqual(['run-old']);
  });

  it('an explicit --keep flag wins over the workspace document\'s logs.prune', async () => {
    const fixtureOld = await makeFixture('prune-logs-flag-wins', 'run-old', { started_at: new Date(Date.now() - 100_000).toISOString() }, []);
    await makeFixture('prune-logs-flag-wins', 'run-new', { started_at: new Date().toISOString() }, []);

    // The document alone would keep both runs.
    await fs.writeFile(
      fixtureOld.workspacePath,
      'kind: Workspace\nname: prune-logs-flag-wins\nworkflowPathList: []\nlogs:\n  prune:\n    keep: 5\n',
      'utf-8',
    );

    await runsPruneCommand({ workspace: fixtureOld.workspacePath, keep: 1, output: 'json' });

    const printed = JSON.parse(logSpy.mock.calls[0]![0] as string);
    expect(printed[0].result.prunedList.map((pruned: { runId: string }) => pruned.runId)).toEqual(['run-old']);
  });

  it('the no-argument scan reads each workspace\'s own logs.prune independently', async () => {
    // Workspace A declares `logs.prune.keep: 1`.
    const fixtureA = await makeFixture('prune-scan-a', 'run-a-old', { started_at: new Date(Date.now() - 100_000).toISOString() }, []);
    await makeFixture('prune-scan-a', 'run-a-new', { started_at: new Date().toISOString() }, []);
    await fs.writeFile(
      fixtureA.workspacePath,
      'kind: Workspace\nname: prune-scan-a\nworkflowPathList: []\nlogs:\n  prune:\n    keep: 1\n',
      'utf-8',
    );

    // Workspace B declares no `logs:` block at all — both runs stay under
    // the built-in `keep` default (20), so nothing is pruned.
    const fixtureB = await makeFixture('prune-scan-b', 'run-b-old', { started_at: new Date(Date.now() - 100_000).toISOString() }, []);
    await makeFixture('prune-scan-b', 'run-b-new', { started_at: new Date().toISOString() }, []);

    await runsPruneCommand({ cwd: rootDir, output: 'json' });

    const printed: Array<{ targetFolder: string; result: { prunedList: Array<{ runId: string }> } }> =
      JSON.parse(logSpy.mock.calls[0]![0] as string);
    const resultByTarget = new Map(printed.map((entry) => [entry.targetFolder, entry.result]));

    expect(resultByTarget.get(fixtureA.targetFolder)?.prunedList.map((p) => p.runId)).toEqual([
      'run-a-old',
    ]);
    expect(resultByTarget.get(fixtureB.targetFolder)?.prunedList).toEqual([]);
  });
});
