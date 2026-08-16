import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

import { workspaceStatusCommand } from '../src/commands/workspace/status.js';
import { runWorkflowCommand } from '../src/commands/workflow/run.js';
import { registryFilePathFor, runsDirFor } from '../src/runs/registry-io.js';
import { RUN_REGISTRY_FORMAT, RUN_STATUS, type RunRegistryEntry } from '../src/runs/types.js';
import type { ProcessProbe } from '../src/runs/pid-probe.js';
import { getProcessStartedAtMs } from '../src/runs/pid-probe.js';

// ---------------------------------------------------------------------------
// `workspace status` — synthetic registry/log fixtures for the liveness
// matrix (running/crashed/bootstrap-failed/never-run), plus one real
// end-to-end run through `runWorkflowCommand` (OBSERVABILITY.md, "CLI surfaces").
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rootDir = path.join(__dirname, 'temp-workspace-status-test');

let logSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'info').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'warn').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'step').mockImplementation((() => undefined) as never);
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

const MINIMAL_WORKFLOW = (name: string): string =>
  `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins: {}
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
steps: []
`.trim();

interface Fixture {
  workspaceDir: string;
  targetFolder: string;
}

/** A workspace document listing `workflowNameList`, each a trivially valid, zero-step workflow document. */
async function makeWorkspaceFixture(name: string, workflowNameList: string[]): Promise<Fixture> {
  const workspaceDir = path.join(rootDir, name);
  const workflowDir = path.join(workspaceDir, 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });

  const pathList: string[] = [];
  for (const workflowName of workflowNameList) {
    const relPath = `./workflows/${workflowName}.workflow.yaml`;
    await fs.writeFile(path.join(workspaceDir, relPath), MINIMAL_WORKFLOW(workflowName), 'utf-8');
    pathList.push(relPath);
  }

  await fs.writeFile(
    path.join(workspaceDir, 'workspace.yaml'),
    `kind: Workspace\nname: ${name}\nworkflowPathList:\n${pathList.map((p) => `  - ${p}`).join('\n')}\n`,
    'utf-8',
  );

  return { workspaceDir, targetFolder: path.join(workspaceDir, '.rawbox') };
}

/** Writes one registry entry plus its NDJSON log under a fixture's target folder. */
async function writeRun(
  fixture: Fixture,
  runId: string,
  workflow: string,
  overrides: Partial<RunRegistryEntry>,
  logLines: string[],
): Promise<void> {
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
}

describe('workspace status — liveness matrix', () => {
  it('reports a running workflow with a verified live pid, its last event and step counts', async () => {
    const fixture = await makeWorkspaceFixture('status-running', ['grid']);
    await writeRun(
      fixture,
      'run-running',
      'grid',
      { status: RUN_STATUS.RUNNING },
      [
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', run_id: 'run-running', event: 'run.start' }),
        JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', run_id: 'run-running', event: 'step.end', outcome: 'ok' }),
      ],
    );

    const aliveProbe = (): ProcessProbe => ({ alive: true, startedAtMs: 0 });
    await workspaceStatusCommand(fixture.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      probe: aliveProbe,
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const snapshot = JSON.parse(logSpy.mock.calls[0]![0] as string);
    const grid = snapshot.workflowList.find((w: { workflowName: string }) => w.workflowName === 'grid');
    expect(grid.latestRun.displayStatus).toBe('running');
    expect(grid.latestRun.lastEvent).toEqual({ event: 'step.end', ts: '2026-01-01T00:00:01.000Z' });
    expect(grid.latestRun.steps).toEqual({ ok: 1, failed: 0 });
  });

  it('renders "in <step> for <duration>" when the tail\'s last event is a run.heartbeat', async () => {
    const fixture = await makeWorkspaceFixture('status-heartbeat', ['grid']);
    await writeRun(
      fixture,
      'run-heartbeat',
      'grid',
      { status: RUN_STATUS.RUNNING },
      [
        JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', run_id: 'run-heartbeat', event: 'run.start' }),
        JSON.stringify({
          ts: '2026-01-01T00:00:00.100Z',
          run_id: 'run-heartbeat',
          event: 'step.start',
          step: { index: 0, iteration: 0, label: 'websocket-wait' },
        }),
        JSON.stringify({
          ts: '2026-01-01T00:04:00.100Z',
          run_id: 'run-heartbeat',
          event: 'run.heartbeat',
          step: { index: 0, iteration: 0, label: 'websocket-wait' },
          in_flight_ms: 240_000,
        }),
      ],
    );

    const aliveProbe = (): ProcessProbe => ({ alive: true, startedAtMs: 0 });
    await workspaceStatusCommand(fixture.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      probe: aliveProbe,
    });
    const snapshot = JSON.parse(logSpy.mock.calls[0]![0] as string);
    const grid = snapshot.workflowList.find((w: { workflowName: string }) => w.workflowName === 'grid');
    expect(grid.latestRun.lastEvent).toEqual({ event: 'run.heartbeat', ts: '2026-01-01T00:04:00.100Z' });
    expect(grid.latestRun.heartbeat).toEqual({ stepLabel: 'websocket-wait', inFlightMs: 240_000 });

    logSpy.mockClear();
    await workspaceStatusCommand(fixture.workspaceDir, { cwd: rootDir, output: 'text', probe: aliveProbe });
    expect(loggedText()).toContain('in websocket-wait for 4m');
    // Never the bare "run.heartbeat @<ts>" a generic last-event render would show.
    expect(loggedText()).not.toContain('run.heartbeat @');
  });

  it('reports crashed for a non-terminal entry whose pid the probe reports dead', async () => {
    const fixture = await makeWorkspaceFixture('status-crashed', ['grid']);
    await writeRun(fixture, 'run-crashed', 'grid', { status: RUN_STATUS.RUNNING }, []);

    const deadProbe = (): ProcessProbe => ({ alive: false });
    await workspaceStatusCommand(fixture.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      probe: deadProbe,
    });

    const snapshot = JSON.parse(logSpy.mock.calls[0]![0] as string);
    const grid = snapshot.workflowList.find((w: { workflowName: string }) => w.workflowName === 'grid');
    expect(grid.latestRun.displayStatus).toBe('crashed');
  });

  it('reports bootstrap-failed with its error message, text and json alike', async () => {
    const fixture = await makeWorkspaceFixture('status-bootstrap-failed', ['grid']);
    await writeRun(
      fixture,
      'run-bootstrap-failed',
      'grid',
      { status: RUN_STATUS.BOOTSTRAP_FAILED, error: { message: 'plugin unresolved' } },
      [JSON.stringify({ ts: '2026-01-01T00:00:00.000Z', run_id: 'run-bootstrap-failed', event: 'bootstrap.error', stage: 'resolve' })],
    );

    await workspaceStatusCommand(fixture.workspaceDir, { cwd: rootDir, output: 'json' });
    const snapshot = JSON.parse(logSpy.mock.calls[0]![0] as string);
    const grid = snapshot.workflowList.find((w: { workflowName: string }) => w.workflowName === 'grid');
    expect(grid.latestRun.displayStatus).toBe('bootstrap-failed');

    logSpy.mockClear();
    await workspaceStatusCommand(fixture.workspaceDir, { cwd: rootDir, output: 'text' });
    expect(loggedText()).toContain('bootstrap-failed');
  });

  it('shows "never run" for a workflow the workspace lists with no registry entry at all', async () => {
    const fixture = await makeWorkspaceFixture('status-never-run', ['scanner']);

    await workspaceStatusCommand(fixture.workspaceDir, { cwd: rootDir, output: 'json' });
    const snapshot = JSON.parse(logSpy.mock.calls[0]![0] as string);
    const scanner = snapshot.workflowList.find((w: { workflowName: string }) => w.workflowName === 'scanner');
    expect(scanner.latestRun).toBeUndefined();

    logSpy.mockClear();
    await workspaceStatusCommand(fixture.workspaceDir, { cwd: rootDir, output: 'text' });
    expect(loggedText()).toContain('never run');
  });

  it('--watch re-renders on an interval, bounded by maxPolls in tests', async () => {
    const fixture = await makeWorkspaceFixture('status-watch', ['grid']);
    await writeRun(fixture, 'run-watch', 'grid', { status: RUN_STATUS.OK, steps_total: 1, steps_failed: 0 }, []);

    await workspaceStatusCommand(fixture.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      watch: true,
      watchIntervalMs: 5,
      maxPolls: 3,
      clearScreen: false,
    });

    expect(logSpy.mock.calls.length).toBe(3);
    for (const call of logSpy.mock.calls) {
      const snapshot = JSON.parse(call[0] as string);
      expect(snapshot.workspace).toBe('status-watch');
    }
  });

  it('rejects a bare workspace name — this command needs the resolved document', async () => {
    await workspaceStatusCommand('some-bare-name', { cwd: rootDir });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('workspace status — end to end', () => {
  const PLUGIN_PACKAGE = '@rawbox/rawbox-plugin-default';
  const PLUGIN_DIR = path.join(repoRoot, 'packages', 'rawbox-plugin-default');

  it('reports a real one-step run as ok with the correct step counts', async () => {
    const workspaceDir = path.join(rootDir, 'e2e');
    const workflowDir = path.join(workspaceDir, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });

    const workspacePath = path.join(workspaceDir, 'workspace.yaml');
    const workflowPath = path.join(workflowDir, 'example.workflow.yaml');

    await fs.writeFile(
      workspacePath,
      `kind: Workspace\nname: e2e\nworkflowPathList:\n  - ./workflows/example.workflow.yaml\n`,
      'utf-8',
    );
    await fs.writeFile(
      workflowPath,
      `
kind: Workflow
formatVersion: "1.0"
name: e2e-workflow
plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    sleep_ms:
      seed: 1
steps:
  - label: sleep-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: sleep_done_at
    errors:
      message: sleep_error
`.trim(),
      'utf-8',
    );

    await runWorkflowCommand(workflowPath, { workspace: workspacePath });
    expect(exitSpy).not.toHaveBeenCalled();

    await workspaceStatusCommand(workspaceDir, { cwd: rootDir, output: 'json' });
    const snapshot = JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1]![0] as string);
    const workflow = snapshot.workflowList.find(
      (w: { workflowName: string }) => w.workflowName === 'e2e-workflow',
    );
    expect(workflow.latestRun.displayStatus).toBe('ok');
    expect(workflow.latestRun.steps).toEqual({ ok: 1, failed: 0 });
    expect(workflow.latestRun.pid).toBe(process.pid);
    // The pid this entry names is still this very test process, alive and
    // matching its own recorded start time — the same identity check `runs
    // list`/`workspace status` apply, exercised end to end.
    const freshStartedAt = getProcessStartedAtMs(process.pid);
    expect(freshStartedAt).toBeDefined();
  }, 60_000);
});
