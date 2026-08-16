import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

import { runWorkflowCommand } from '../src/commands/workflow/run.js';
import { readRegistryEntry, runsDirFor } from '../src/runs/registry-io.js';
import { RUN_STATUS } from '../src/runs/types.js';
import { getProcessStartedAtMs, isProcessAlive } from '../src/runs/pid-probe.js';

// ---------------------------------------------------------------------------
// End-to-end run registry lifecycle, through the real CLI wiring
// (`commands/workflow/run.ts`) — a successful run, a run that fails a step at
// runtime, and a bootstrap failure, each checked for the registry status it
// must end in (OBSERVABILITY.md, "Lifecycle and crash detection"). `runs-registry.test.ts`
// covers the same three transitions at the sink's own unit level; this file
// is what proves `run.ts` actually wires the sink and the initial
// `bootstrapping` entry the way that unit covers assume.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rootDir = path.join(__dirname, 'temp-runs-lifecycle-test');

const PLUGIN_PACKAGE = '@rawbox/rawbox-plugin-default';
const PLUGIN_DIR = path.join(repoRoot, 'packages', 'rawbox-plugin-default');

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'warn').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'info').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'step').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

beforeAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

interface Scenario {
  directory: string;
  workspacePath: string;
  workflowPath: string;
}

async function makeScenario(name: string, workflowContent: string): Promise<Scenario> {
  const directory = path.join(rootDir, name);
  const workflowDir = path.join(directory, 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });

  const workspacePath = path.join(directory, 'workspace.yaml');
  const workflowPath = path.join(workflowDir, 'example.workflow.yaml');

  await fs.writeFile(
    workspacePath,
    `
kind: Workspace
name: ${name}
workflowPathList:
  - ./workflows/example.workflow.yaml
`.trim(),
    'utf-8',
  );
  await fs.writeFile(workflowPath, workflowContent, 'utf-8');

  return { directory, workspacePath, workflowPath };
}

/** Finds the one registry entry a scenario's run wrote, under its default `.rawbox/runs/`. */
async function findRegistryEntry(scenario: Scenario) {
  const runsDir = runsDirFor(path.join(scenario.directory, '.rawbox'));
  const fileList = await fs.readdir(runsDir);
  expect(fileList.length).toBe(1);
  const entry = await readRegistryEntry(path.join(runsDir, fileList[0]!));
  expect(entry).toBeDefined();
  return entry!;
}

describe('run registry — end-to-end lifecycle', () => {
  it('a successful run leaves a registry entry ending "ok"', async () => {
    const scenario = await makeScenario(
      'lifecycle-ok',
      `
kind: Workflow
formatVersion: "1.0"
name: lifecycle-ok-workflow
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
    );

    const startedBefore = Date.now();
    await runWorkflowCommand(scenario.workflowPath, { workspace: scenario.workspacePath });
    expect(exitSpy).not.toHaveBeenCalled();

    const entry = await findRegistryEntry(scenario);
    expect(entry.status).toBe(RUN_STATUS.OK);
    expect(entry.workflow).toBe('lifecycle-ok-workflow');
    expect(entry.workspace).toBe('lifecycle-ok');
    expect(entry.pid).toBe(process.pid);
    expect(entry.steps_total).toBe(1);
    expect(entry.steps_failed).toBe(0);
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0);
    expect(entry.error).toBeUndefined();
    expect(Date.parse(entry.started_at)).toBeGreaterThanOrEqual(startedBefore - 1000);

    // The pid identity this entry was written with is this very process,
    // still alive and matching its own recorded start time — the same check
    // `runs list` applies to report liveness.
    expect(isProcessAlive(entry.pid)).toBe(true);
    const freshStartedAt = getProcessStartedAtMs(process.pid);
    if (freshStartedAt !== undefined) {
      expect(Math.abs(entry.pid_started_at - freshStartedAt)).toBeLessThan(5000);
    }

    // And the log paths the entry names are real, existing files.
    await expect(fs.stat(entry.log_path)).resolves.toBeDefined();
  }, 60_000);

  it('a run that fails a step at runtime leaves a registry entry ending "error", with no bootstrap failure involved', async () => {
    // `value-ops/echo` writing into a key whose declared `valueSizeMax` is far
    // smaller than the echoed value fails inside `syncDbActor`'s `putSync` —
    // a genuine mid-run failure, resolved and running well past every
    // preflight stage, so this exercises the plain "error" status distinctly
    // from "bootstrap-failed" below.
    const scenario = await makeScenario(
      'lifecycle-error',
      `
kind: Workflow
formatVersion: "1.0"
name: lifecycle-error-workflow
plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    echoed_value:
      strategy:
        name: lmdb-kv
        valueSizeMax: 5
    echo_input:
      seed: "this value is deliberately far longer than five bytes"
steps:
  - label: echo-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: value-ops/echo
    inputs:
      value: echo_input
    outputs:
      value: echoed_value
`.trim(),
    );

    await runWorkflowCommand(scenario.workflowPath, { workspace: scenario.workspacePath });
    expect(exitSpy).toHaveBeenCalledWith(1);

    const entry = await findRegistryEntry(scenario);
    expect(entry.status).toBe(RUN_STATUS.ERROR);
    expect(entry.error).toBeDefined();
  }, 60_000);

  it('a bootstrap failure (unresolvable plugin) leaves a registry entry ending "bootstrap-failed"', async () => {
    const scenario = await makeScenario(
      'lifecycle-bootstrap-failed',
      `
kind: Workflow
formatVersion: "1.0"
name: lifecycle-bootstrap-failed-workflow
plugins:
  "rawbox-plugin-nonexistent-e2e": "file:${path.join(rootDir, 'no-such-plugin-dir')}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
steps:
  - label: unreachable-step
    plugin: "rawbox-plugin-nonexistent-e2e"
    operation: whatever/op
    inputs: {}
`.trim(),
    );

    await runWorkflowCommand(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      setup: false,
    });
    expect(exitSpy).toHaveBeenCalledWith(1);

    const entry = await findRegistryEntry(scenario);
    expect(entry.status).toBe(RUN_STATUS.BOOTSTRAP_FAILED);
    expect(entry.error).toBeDefined();
  }, 60_000);
});
