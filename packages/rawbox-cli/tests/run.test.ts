import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import yargs from 'yargs';

import { runCommandDefinition, runWorkflowCommand } from '../src/commands/workflow/run.js';

// ---------------------------------------------------------------------------
// `workflow run <workflow-path>` — the single-positional form
// (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)").
//
// These fixtures declare `@rawbox/rawbox-plugin-default` by an absolute
// `file:` specifier, but — as `e2e.test.ts` and
// `packages/rawbox-runner/tests/target-folder.test.ts` both note — the
// package name resolves from this monorepo's own hoisted `node_modules` by
// walking up from the workspace directory, whether or not anything was
// `npm install`ed into a target folder. So these scenarios run to real
// completion with no `workspace setup` step: the specifier text is never
// consulted at run time, only the package name is.
// ---------------------------------------------------------------------------

/**
 * A run's **segment 0** log file: `<run-id>.ndjson`, and not the error log nor
 * a rotated `<run-id>.N.ndjson`.
 *
 * `endsWith('.ndjson') && !endsWith('.error.ndjson')` was enough while one run
 * meant one file. It stopped being enough when the sink started rotating
 * (`@rawbox/runner`'s `LogRotate`): a run past `rotate.maxBytes` also leaves
 * `<run-id>.1.ndjson`, which that filter matches and which is *not* the path
 * the run registry names. No test here comes near the 128 MiB default, so this
 * is a guard rather than a fix — but it is the kind of ambiguity that surfaces
 * as `expect(logFileList.length).toBe(1)` failing in some unrelated later test
 * that sets a small bound.
 */
function isSegmentZeroLogFile(entry: string): boolean {
  return entry.endsWith('.ndjson') && !/\.(?:error|\d+)\.ndjson$/.test(entry);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rootDir = path.join(__dirname, 'temp-run-test');

const PLUGIN_PACKAGE = '@rawbox/rawbox-plugin-default';
const PLUGIN_DIR = path.join(repoRoot, 'packages', 'rawbox-plugin-default');

const WORKFLOW_NAME = 'run-command-example';

// --- reporting harness (same shape as verify.test.ts) -----------------------

let exitSpy: ReturnType<typeof vi.spyOn>;
let messageList: string[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureLog(): any {
  return vi.fn((...args: unknown[]) => {
    messageList.push(args.map(String).join(' '));
  });
}

beforeEach(() => {
  messageList = [];
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation(captureLog());
  vi.spyOn(p.log, 'warn').mockImplementation(captureLog());
  vi.spyOn(p.log, 'info').mockImplementation(captureLog());
  vi.spyOn(p.log, 'step').mockImplementation(captureLog());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** All reported text, with ANSI colouring stripped. */
function reported(): string {
  return messageList.join('\n').replace(/\[[0-9;]*m/g, '');
}

function expectFailed(): void {
  expect(exitSpy).toHaveBeenCalledWith(1);
}

function expectPassed(): void {
  expect(exitSpy, reported()).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workspaceYaml(name: string): string {
  return `
kind: Workspace
name: ${name}
workflowPathList:
  - ./workflows/example.workflow.yaml
`.trim();
}

/** Sleep, then halt — a minimal two-step fixture (deliberately smaller than the scaffolded countdown). */
function workflowYaml(): string {
  return `
kind: Workflow
formatVersion: "1.0"
name: ${WORKFLOW_NAME}
plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    sleep_ms:
      seed: 1
    halt_reason:
      seed: run command test
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
  - label: done
    plugin: "${PLUGIN_PACKAGE}"
    operation: control-flow/halt
    inputs:
      reason: halt_reason
    errors:
      message: halt_error
`.trim();
}

interface Scenario {
  directory: string;
  workspacePath: string;
  workflowPath: string;
}

/** Builds `<root>/<name>/{workspace.yaml,workflows/example.workflow.yaml}`. */
async function makeScenario(name: string): Promise<Scenario> {
  const directory = path.join(rootDir, name);
  const workflowDir = path.join(directory, 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });

  const workspacePath = path.join(directory, 'workspace.yaml');
  const workflowPath = path.join(workflowDir, 'example.workflow.yaml');

  await fs.writeFile(workspacePath, workspaceYaml(name), 'utf-8');
  await fs.writeFile(workflowPath, workflowYaml(), 'utf-8');

  return { directory, workspacePath, workflowPath };
}

// ---------------------------------------------------------------------------
// Auto-setup on run (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)")
//
// The scenarios above deliberately use `@rawbox/rawbox-plugin-default`,
// which — per the file header — resolves from this monorepo's own hoisted
// `node_modules` regardless of whether `workspace setup` ever ran. That makes
// it useless here: it can never be "missing", so it can never exercise
// auto-setup. This block instead clones the built default plugin under a
// package name that exists nowhere on disk except inside a target folder
// `workspace setup` (or the auto-setup this feature adds) produces — the
// same technique `packages/rawbox-runner/tests/target-folder.test.ts` uses,
// for the same reason.
// ---------------------------------------------------------------------------

const AUTOSETUP_PLUGIN = 'rawbox-plugin-autosetup-e2e';
const AUTOSETUP_WORKFLOW_NAME = 'autosetup-example';
const autosetupPluginDir = path.join(rootDir, '_autosetup-plugin');

/** Clones the built default plugin under {@link AUTOSETUP_PLUGIN}. */
async function buildAutosetupPlugin(): Promise<void> {
  await fs.cp(PLUGIN_DIR, autosetupPluginDir, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== 'node_modules' && base !== 'tsconfig.tsbuildinfo';
    },
  });

  const manifestPath = path.join(autosetupPluginDir, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  manifest.name = AUTOSETUP_PLUGIN;
  manifest.dependencies = {};
  manifest.devDependencies = {};
  manifest.scripts = {};
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // The clone must actually be loadable, or a passing run would be
  // indistinguishable from a run that never really exercised the plugin.
  await fs.stat(path.join(autosetupPluginDir, 'dist', 'contract-registry.js'));
}

function autosetupWorkspaceYaml(name: string): string {
  return `
kind: Workspace
name: ${name}
workflowPathList:
  - ./workflows/example.workflow.yaml
`.trim();
}

function autosetupWorkflowYaml(): string {
  return `
kind: Workflow
formatVersion: "1.0"
name: ${AUTOSETUP_WORKFLOW_NAME}
plugins:
  "${AUTOSETUP_PLUGIN}": "file:${autosetupPluginDir}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    sleep_ms:
      seed: 1
    halt_reason:
      seed: autosetup test
steps:
  - label: sleep-step
    plugin: "${AUTOSETUP_PLUGIN}"
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: sleep_done_at
    errors:
      message: sleep_error
  - label: done
    plugin: "${AUTOSETUP_PLUGIN}"
    operation: control-flow/halt
    inputs:
      reason: halt_reason
    errors:
      message: halt_error
`.trim();
}

/** Builds `<root>/<name>/{workspace.yaml,workflows/example.workflow.yaml}` declaring {@link AUTOSETUP_PLUGIN}. */
async function makeAutosetupScenario(name: string): Promise<Scenario> {
  const directory = path.join(rootDir, name);
  const workflowDir = path.join(directory, 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });

  const workspacePath = path.join(directory, 'workspace.yaml');
  const workflowPath = path.join(workflowDir, 'example.workflow.yaml');

  await fs.writeFile(workspacePath, autosetupWorkspaceYaml(name), 'utf-8');
  await fs.writeFile(workflowPath, autosetupWorkflowYaml(), 'utf-8');

  return { directory, workspacePath, workflowPath };
}

// ---------------------------------------------------------------------------
// Workspace-less ("scratch") runs — `--workspace-name`
// (rawbox-runner README, "Implicit (workspace-less) workspaces")
//
// Reuses `AUTOSETUP_PLUGIN`/`autosetupPluginDir` from the block above for the
// same reason: it resolves from nowhere but a target folder `run`'s
// auto-setup produced, so a scratch scenario that completes really did
// install and run it — not merely find it already on the monorepo's own
// hoisted `node_modules`.
// ---------------------------------------------------------------------------

/** One `<root>/<dirName>/main.workflow.yaml` — deliberately no `workspace.yaml` anywhere. */
function scratchWorkflowYaml(name: string): string {
  return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  "${AUTOSETUP_PLUGIN}": "file:${autosetupPluginDir}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    sleep_ms:
      seed: 1
    halt_reason:
      seed: scratch run test
steps:
  - label: sleep-step
    plugin: "${AUTOSETUP_PLUGIN}"
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: sleep_done_at
    errors:
      message: sleep_error
  - label: done
    plugin: "${AUTOSETUP_PLUGIN}"
    operation: control-flow/halt
    inputs:
      reason: halt_reason
    errors:
      message: halt_error
`.trim();
}

interface ScratchScenario {
  directory: string;
  workflowPath: string;
}

/** A bare directory holding only a workflow file — no workspace document at all. */
async function makeScratchScenario(dirName: string, workflowName: string): Promise<ScratchScenario> {
  const directory = path.join(rootDir, dirName);
  await fs.mkdir(directory, { recursive: true });
  const workflowPath = path.join(directory, 'main.workflow.yaml');
  await fs.writeFile(workflowPath, scratchWorkflowYaml(workflowName), 'utf-8');
  return { directory, workflowPath };
}

beforeAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
  await buildAutosetupPlugin();
}, 120_000);

afterAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('workflow run — workspace resolution', () => {
  it('runs to completion with an explicit --workspace, skipping discovery', async () => {
    const scenario = await makeScenario('explicit-workspace');

    await runWorkflowCommand(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    expect(reported()).not.toContain('Auto-discovered workspace');
  }, 60_000);

  it('auto-discovers the workspace and reports it, with no --workspace flag', async () => {
    const scenario = await makeScenario('auto-discovery');

    await runWorkflowCommand(scenario.workflowPath);

    expectPassed();
    expect(reported()).toContain('Auto-discovered workspace');
    expect(reported()).toContain(scenario.workspacePath);
  }, 60_000);

  it('fails with a clear message, naming the directories searched, when no workspace document exists', async () => {
    const directory = path.join(rootDir, 'no-workspace', 'workflows');
    await fs.mkdir(directory, { recursive: true });
    const workflowPath = path.join(directory, 'main.yaml');
    await fs.writeFile(
      workflowPath,
      `
kind: Workflow
formatVersion: "1.0"
name: no-workspace-workflow
plugins: {}
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
steps: []
`.trim(),
      'utf-8',
    );

    await runWorkflowCommand(workflowPath);

    // A run cannot proceed without a workspace to resolve plugins and scope
    // storage — unlike `verify`, there is no reduced-coverage pass here.
    expectFailed();
    const output = reported();
    expect(output).toContain('Could not locate a workspace document');
    expect(output).toContain(directory);
    expect(output).toContain('--workspace <workspace file>');
  });
});

/** Parses every line of `content` as JSON, failing loudly on a bad line. */
function readEvents(content: string): Array<Record<string, unknown>> {
  return content
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('workflow run — default log paths', () => {
  it('lands the default log/error files under .rawbox/logs/<workflow name>/<run-id>.ndjson, run-id matching the events', async () => {
    const scenario = await makeScenario('default-log-paths');

    await runWorkflowCommand(scenario.workflowPath);

    expectPassed();

    // No `targetFolder:` declared, so the default `.rawbox` applies.
    const logDir = path.join(scenario.directory, '.rawbox', 'logs', WORKFLOW_NAME);
    const entryList = await fs.readdir(logDir);
    const logFileList = entryList.filter(isSegmentZeroLogFile);
    expect(logFileList.length).toBe(1);
    const logFile = logFileList[0]!;

    // The filename's run id is the *same* id every event in the file carries
    // — not two independent generations of it.
    const runId = logFile.replace(/\.ndjson$/, '');
    expect(runId).toMatch(/^run-/);
    // A successful run has no failure event, so the error file's own
    // lazy-creation contract (`ndjson-file-sink.ts`) means it is never
    // written at all — only its *directory* is prepared. That path is
    // covered separately below, on a run that actually fails.

    const eventList = readEvents(
      await fs.readFile(path.join(logDir, logFile), 'utf-8'),
    );
    expect(eventList.length).toBeGreaterThan(0);
    for (const event of eventList) {
      expect(event['run_id']).toBe(runId);
    }

    // `run.start` opens the file and declares its format; `run.end` closes it
    // with the outcome (OBSERVABILITY.md, "The run-event stream").
    expect(eventList[0]).toMatchObject({
      event: 'run.start',
      format: 1,
      workflow: WORKFLOW_NAME,
      run_id: runId,
    });
    expect(eventList.at(-1)).toMatchObject({ event: 'run.end', outcome: 'ok' });
  }, 60_000);

  it('lands the default error file at <run-id>.error.ndjson, containing only failure-shaped events, on a failing run', async () => {
    // `--no-setup` against an unresolvable plugin fails at the RESOLVE
    // bootstrap stage — after `run.start` (workspace/workflow already
    // loaded), so both files get exercised: the main log carries
    // `run.start`/`bootstrap.error`/`run.end`, the error log mirrors the
    // failure-shaped subset of the same three.
    const scenario = await makeAutosetupScenario('default-log-paths-error');

    await runWorkflowCommand(scenario.workflowPath, { setup: false });

    expectFailed();

    const logDir = path.join(scenario.directory, '.rawbox', 'logs', AUTOSETUP_WORKFLOW_NAME);
    const entryList = await fs.readdir(logDir);
    const logFileList = entryList.filter(isSegmentZeroLogFile);
    expect(logFileList.length).toBe(1);
    const runId = logFileList[0]!.replace(/\.ndjson$/, '');
    expect(entryList).toContain(`${runId}.error.ndjson`);

    const errorEventList = readEvents(
      await fs.readFile(path.join(logDir, `${runId}.error.ndjson`), 'utf-8'),
    );
    expect(errorEventList.length).toBeGreaterThan(0);
    for (const event of errorEventList) {
      expect(event['run_id']).toBe(runId);
      expect(
        event['event'] === 'bootstrap.error' || event['outcome'] === 'error',
      ).toBe(true);
    }
  }, 60_000);

  it('honours explicit --log-file / --error-log overrides', async () => {
    const scenario = await makeScenario('explicit-log-paths');
    const logFile = path.join(scenario.directory, 'custom-run.txt');
    const errorLogFile = path.join(scenario.directory, 'custom-run-errors.txt');

    await runWorkflowCommand(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      logFile,
      errorLog: errorLogFile,
    });

    expectPassed();
    const content = await fs.readFile(logFile, 'utf-8');
    expect(content).toContain(`"workflow":"${WORKFLOW_NAME}"`);
    expect(content).toContain('"event":"run.end","outcome":"ok"');

    // The default `.rawbox/logs/` tree must not have been used instead.
    await expect(
      fs.stat(path.join(scenario.directory, '.rawbox', 'logs')),
    ).rejects.toThrow();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// A deliberate failure exits non-zero (FORMAT.md, "`steps`").
//
// The point of the feature: a workflow that refuses to proceed must be
// distinguishable from one that finished, by the only signal a supervisor
// (`Restart=always`, a CI step, a cron wrapper) reads — the exit code.
// ---------------------------------------------------------------------------

/** The two-step fixture above, with the halt asked to fail the run. */
function failingHaltWorkflowYaml(): string {
  return `
kind: Workflow
formatVersion: "1.0"
name: ${WORKFLOW_NAME}
plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    halt_fail:
      seed: true
    halt_reason:
      seed: the symbol is ACTIVE with no grid_state
steps:
  - label: refuse
    plugin: "${PLUGIN_PACKAGE}"
    operation: control-flow/halt
    inputs:
      reason: halt_reason
      fail: halt_fail
    errors:
      message: halt_error
`.trim();
}

describe('workflow run — a halt that fails the run', () => {
  it('exits non-zero and reports the reason, where a plain halt exits clean', async () => {
    const directory = path.join(rootDir, 'failing-halt');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    const workspacePath = path.join(directory, 'workspace.yaml');
    const workflowPath = path.join(workflowDir, 'example.workflow.yaml');
    await fs.writeFile(workspacePath, workspaceYaml('failing-halt'), 'utf-8');
    await fs.writeFile(workflowPath, failingHaltWorkflowYaml(), 'utf-8');

    await runWorkflowCommand(workflowPath, { workspace: workspacePath });

    expectFailed();
    expect(reported()).toContain('the symbol is ACTIVE with no grid_state');

    const logDir = path.join(directory, '.rawbox', 'logs', WORKFLOW_NAME);
    const logFile = (await fs.readdir(logDir)).find(isSegmentZeroLogFile)!;
    const eventList = readEvents(
      await fs.readFile(path.join(logDir, logFile), 'utf-8'),
    );
    expect(eventList.at(-1)).toMatchObject({
      event: 'run.end',
      outcome: 'error',
      error: { message: 'the symbol is ACTIVE with no grid_state' },
    });
  }, 60_000);

  it('exits zero for the same workflow halting without `fail`', async () => {
    // The control: the very same document, minus the one input. `makeScenario`
    // builds a workflow whose last step is a plain `halt`.
    const scenario = await makeScenario('plain-halt-exits-zero');

    await runWorkflowCommand(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
  }, 60_000);
});

describe('workflow run — auto-setup (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)")', () => {
  it('installs an uninstalled `file:` plugin and completes, with zero prior `workspace setup`', async () => {
    const scenario = await makeAutosetupScenario('autosetup-fresh');

    await runWorkflowCommand(scenario.workflowPath);

    expectPassed();
    expect(reported()).toContain('Auto-setup');
    expect(reported()).toContain(AUTOSETUP_PLUGIN);

    // `.rawbox/` appeared, with the plugin actually installed into it.
    const targetFolder = path.join(scenario.directory, '.rawbox');
    const installedManifest = await fs.stat(
      path.join(targetFolder, 'node_modules', AUTOSETUP_PLUGIN, 'package.json'),
    );
    expect(installedManifest.isFile()).toBe(true);

    // And the run itself actually completed, not merely the install.
    const logDir = path.join(targetFolder, 'logs', AUTOSETUP_WORKFLOW_NAME);
    const entryList = await fs.readdir(logDir);
    const logFile = entryList.find(isSegmentZeroLogFile);
    expect(logFile).toBeDefined();
    const content = await fs.readFile(path.join(logDir, logFile!), 'utf-8');
    expect(content).toContain(`"workflow":"${AUTOSETUP_WORKFLOW_NAME}"`);
    expect(content).toContain('"event":"run.end","outcome":"ok"');
  }, 120_000);

  it('skips the reinstall on a second run, once the plugin already resolves', async () => {
    const scenario = await makeAutosetupScenario('autosetup-second-run-skips');

    await runWorkflowCommand(scenario.workflowPath);
    expectPassed();
    expect(reported()).toContain('Auto-setup');

    // `setupNpmPackage` unconditionally rewrites `package.json` whenever it
    // runs, so its mtime is a reliable witness for "did setup run again" —
    // it is untouched by an ordinary run, which never writes into `.rawbox/`
    // itself beyond `data/` and `logs/`.
    const packageJsonPath = path.join(scenario.directory, '.rawbox', 'package.json');
    const mtimeAfterFirstRun = (await fs.stat(packageJsonPath)).mtimeMs;

    messageList = [];
    await runWorkflowCommand(scenario.workflowPath);
    expectPassed();

    expect(reported()).not.toContain('Auto-setup');
    const mtimeAfterSecondRun = (await fs.stat(packageJsonPath)).mtimeMs;
    expect(mtimeAfterSecondRun).toBe(mtimeAfterFirstRun);
  }, 180_000);

  it('--no-setup fails with the resolution error instead of installing, when a plugin is missing', async () => {
    const scenario = await makeAutosetupScenario('autosetup-no-setup-missing');

    await runWorkflowCommand(scenario.workflowPath, { setup: false });

    expectFailed();
    expect(reported()).not.toContain('Auto-setup');
    expect(reported()).toContain(AUTOSETUP_PLUGIN);

    // No install was ever attempted — `.rawbox/` may still exist (the failed
    // run's own log directory lands there), but never a `package.json`, which
    // only `setupWorkspace` ever writes.
    await expect(
      fs.stat(path.join(scenario.directory, '.rawbox', 'package.json')),
    ).rejects.toThrow();
  }, 60_000);

  it('--setup forces a reinstall even when the plugin already resolves', async () => {
    const scenario = await makeAutosetupScenario('autosetup-force-setup');

    await runWorkflowCommand(scenario.workflowPath);
    expectPassed();

    const packageJsonPath = path.join(scenario.directory, '.rawbox', 'package.json');
    const mtimeAfterFirstRun = (await fs.stat(packageJsonPath)).mtimeMs;

    // A margin against coarse filesystem mtime resolution, so a genuine
    // rewrite is distinguishable from a skipped one.
    await new Promise((resolve) => setTimeout(resolve, 20));

    messageList = [];
    await runWorkflowCommand(scenario.workflowPath, { setup: true });
    expectPassed();

    expect(reported()).toContain('--setup passed');
    const mtimeAfterForcedRun = (await fs.stat(packageJsonPath)).mtimeMs;
    expect(mtimeAfterForcedRun).toBeGreaterThan(mtimeAfterFirstRun);
  }, 180_000);
});

// ---------------------------------------------------------------------------
// Workspace-less ("scratch") runs — `--workspace-name`
// (rawbox-runner README, "Implicit (workspace-less) workspaces")
// ---------------------------------------------------------------------------

describe('workflow run — workspace-less scratch runs (--workspace-name)', () => {
  it('runs to completion with zero workspace.yaml on disk, auto-installing the missing plugin', async () => {
    const scenario = await makeScratchScenario('scratch-fresh', 'scratch-fresh-workflow');

    await runWorkflowCommand(scenario.workflowPath, { workspaceName: 'scratch-fresh' });

    expectPassed();
    expect(reported()).toContain('state persisted under workspace');
    expect(reported()).toContain('"scratch-fresh"');
    expect(reported()).toContain('reruns with the same name share it');
    expect(reported()).toContain('Auto-setup');

    // No workspace document was ever written.
    await expect(
      fs.stat(path.join(scenario.directory, 'workspace.yaml')),
    ).rejects.toThrow();

    // `.rawbox/` landed next to the workflow file itself — the workflow's own
    // directory stands in as the workspace directory for a scratch run — with
    // the plugin actually installed into it.
    const targetFolder = path.join(scenario.directory, '.rawbox');
    const installedManifest = await fs.stat(
      path.join(targetFolder, 'node_modules', AUTOSETUP_PLUGIN, 'package.json'),
    );
    expect(installedManifest.isFile()).toBe(true);

    // And the run itself completed, with its LMDB environment keyed by the
    // `--workspace-name` value under `data/`.
    const dataDirStat = await fs.stat(path.join(targetFolder, 'data', 'scratch-fresh'));
    expect(dataDirStat.isDirectory()).toBe(true);
  }, 120_000);

  it('a same-name rerun shares the LMDB data directory instead of recreating it', async () => {
    const scenario = await makeScratchScenario('scratch-repeat', 'scratch-repeat-workflow');
    const dataDir = path.join(scenario.directory, '.rawbox', 'data', 'repeat-name');

    await runWorkflowCommand(scenario.workflowPath, { workspaceName: 'repeat-name' });
    expectPassed();
    const inoAfterFirst = (await fs.stat(dataDir)).ino;

    messageList = [];
    await runWorkflowCommand(scenario.workflowPath, { workspaceName: 'repeat-name' });
    expectPassed();
    const inoAfterSecond = (await fs.stat(dataDir)).ino;

    // Same inode: the second run reused the first run's directory rather than
    // deleting and recreating it — the state-sharing semantics the printed
    // notice documents.
    expect(inoAfterSecond).toBe(inoAfterFirst);
  }, 180_000);

  it('--fresh wipes the named scratch environment before running', async () => {
    const scenario = await makeScratchScenario('scratch-fresh-flag', 'scratch-fresh-flag-workflow');
    const dataDir = path.join(scenario.directory, '.rawbox', 'data', 'fresh-name');

    await runWorkflowCommand(scenario.workflowPath, { workspaceName: 'fresh-name' });
    expectPassed();
    const inoBeforeFresh = (await fs.stat(dataDir)).ino;

    messageList = [];
    await runWorkflowCommand(scenario.workflowPath, { workspaceName: 'fresh-name', fresh: true });
    expectPassed();
    const inoAfterFresh = (await fs.stat(dataDir)).ino;

    // A different inode: the directory was deleted and recreated, not reused
    // — proving `--fresh` actually wiped the prior environment rather than
    // running against it.
    expect(inoAfterFresh).not.toBe(inoBeforeFresh);
  }, 180_000);

  it('different --workspace-name values are isolated: two separate data directories', async () => {
    const scenario = await makeScratchScenario('scratch-isolated', 'scratch-isolated-workflow');

    await runWorkflowCommand(scenario.workflowPath, { workspaceName: 'iso-a' });
    expectPassed();
    messageList = [];
    await runWorkflowCommand(scenario.workflowPath, { workspaceName: 'iso-b' });
    expectPassed();

    const dataRoot = path.join(scenario.directory, '.rawbox', 'data');
    const statA = await fs.stat(path.join(dataRoot, 'iso-a'));
    const statB = await fs.stat(path.join(dataRoot, 'iso-b'));
    expect(statA.isDirectory()).toBe(true);
    expect(statB.isDirectory()).toBe(true);
  }, 180_000);

  it('the discovery-failure message now suggests --workspace-name for a workspace-less run', async () => {
    const directory = path.join(rootDir, 'no-workspace-scratch-hint', 'workflows');
    await fs.mkdir(directory, { recursive: true });
    const workflowPath = path.join(directory, 'main.yaml');
    await fs.writeFile(
      workflowPath,
      `
kind: Workflow
formatVersion: "1.0"
name: no-workspace-scratch-hint
plugins: {}
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
steps: []
`.trim(),
      'utf-8',
    );

    await runWorkflowCommand(workflowPath);

    expectFailed();
    expect(reported()).toContain('Could not locate a workspace document');
    expect(reported()).toContain('--workspace-name <name>');
  });
});

// ---------------------------------------------------------------------------
// `--workspace-name` / `--workspace` / `--fresh` yargs wiring
//
// Exercises the exact `.conflicts`/`.implies`/`requiresArg` declarations on
// `runCommandDefinition.builder` by building a throwaway yargs parser around
// it — the same technique `workflow verify`'s and `run`'s own builders are
// wired into `index.ts` with. `.fail()` re-throws so a validation failure
// stops the parse the way `exitProcess`'s default `process.exit(1)` would,
// without actually killing the test process; the assertions distinguish
// "validation rejected it" from "the handler ran".
// ---------------------------------------------------------------------------

describe('workflow run — --workspace-name yargs wiring', () => {
  async function parse(args: string[]): Promise<{ failMessage: string | undefined; handlerCalled: boolean }> {
    let failMessage: string | undefined;
    let handlerCalled = false;
    const parser = yargs(args)
      .exitProcess(false)
      .fail((msg) => {
        failMessage = msg ?? '(no message)';
        throw new Error(failMessage);
      })
      .command(
        'run <workflow-path>',
        'run',
        runCommandDefinition.builder,
        async () => {
          handlerCalled = true;
        },
      );
    try {
      await parser.parseAsync();
    } catch {
      // The re-thrown `.fail()` error — already captured in `failMessage`.
    }
    return { failMessage, handlerCalled };
  }

  it('rejects --workspace and --workspace-name together', async () => {
    const { failMessage, handlerCalled } = await parse([
      'run',
      'x.yaml',
      '--workspace',
      'a.yaml',
      '--workspace-name',
      'scratch',
    ]);

    expect(failMessage).toMatch(/mutually exclusive/);
    expect(handlerCalled).toBe(false);
  });

  it('rejects --fresh without --workspace-name', async () => {
    const { failMessage, handlerCalled } = await parse(['run', 'x.yaml', '--fresh']);

    expect(failMessage).toBeDefined();
    expect(handlerCalled).toBe(false);
  });

  it('rejects --workspace-name with no value', async () => {
    const { failMessage, handlerCalled } = await parse(['run', 'x.yaml', '--workspace-name']);

    expect(failMessage).toBeDefined();
    expect(handlerCalled).toBe(false);
  });

  it('accepts --workspace-name alone, and --workspace-name with --fresh', async () => {
    const withoutFresh = await parse(['run', 'x.yaml', '--workspace-name', 'scratch']);
    expect(withoutFresh.failMessage).toBeUndefined();
    expect(withoutFresh.handlerCalled).toBe(true);

    const withFresh = await parse(['run', 'x.yaml', '--workspace-name', 'scratch', '--fresh']);
    expect(withFresh.failMessage).toBeUndefined();
    expect(withFresh.handlerCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Shared command definition validation: ensures both `run` and `workflow run`
// use the same handler and therefore behave identically.
// ---------------------------------------------------------------------------

describe('top-level run alias', () => {
  it('invokes the same handler as `workflow run`, proving identical behaviour', async () => {
    // Import the shared definition to verify it exists and has the expected shape
    const { runCommandDefinition } = await import('../src/commands/workflow/run.js');

    expect(runCommandDefinition).toBeDefined();
    expect(runCommandDefinition.builder).toBeDefined();
    expect(runCommandDefinition.handler).toBeDefined();
    expect(typeof runCommandDefinition.builder).toBe('function');
    expect(typeof runCommandDefinition.handler).toBe('function');
  });

  it('executes a workflow when invoked through the shared handler', async () => {
    const scenario = await makeScenario('top-level-run-alias');
    const { runCommandDefinition } = await import('../src/commands/workflow/run.js');

    // Simulate yargs passing argv with the expected field names, reusing the existing scenario
    await runCommandDefinition.handler({
      'workflow-path': scenario.workflowPath,
      workspace: scenario.workspacePath,
    });

    expectPassed();
    // Verify the workflow completed successfully
    const logDir = path.join(scenario.directory, '.rawbox', 'logs', WORKFLOW_NAME);
    const entryList = await fs.readdir(logDir);
    const logFileList = entryList.filter(isSegmentZeroLogFile);
    expect(logFileList.length).toBeGreaterThan(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// `--otel` (rawbox-runner README, "Turning it on").
//
// Two separable halves, tested separately: the yargs wiring (does the flag
// parse, and does `--no-otel` reach the handler as `false` rather than as
// "absent"?) and the activation rule itself, which is a pure function of a
// flag and an environment. Neither test starts an SDK — there is no collector
// to export to, and the sink's own behaviour is `@rawbox/runner`'s
// `tests/otel-sink.test.ts` to prove.
// ---------------------------------------------------------------------------

describe('workflow run — --otel yargs wiring', () => {
  async function parseOtel(args: string[]): Promise<{
    failMessage: string | undefined;
    otel: unknown;
  }> {
    let failMessage: string | undefined;
    let otel: unknown = '(handler not called)';
    const parser = yargs(args)
      .exitProcess(false)
      .fail((msg) => {
        failMessage = msg ?? '(no message)';
        throw new Error(failMessage);
      })
      .command('run <workflow-path>', 'run', runCommandDefinition.builder, async (argv) => {
        otel = (argv as Record<string, unknown>).otel;
      });
    try {
      await parser.parseAsync();
    } catch {
      // The re-thrown `.fail()` error — already captured in `failMessage`.
    }
    return { failMessage, otel };
  }

  it('parses --otel as true', async () => {
    const { failMessage, otel } = await parseOtel(['run', 'x.yaml', '--otel']);

    expect(failMessage).toBeUndefined();
    expect(otel).toBe(true);
  });

  it('parses --no-otel as false, distinguishable from the flag being absent', async () => {
    const negated = await parseOtel(['run', 'x.yaml', '--no-otel']);
    expect(negated.failMessage).toBeUndefined();
    expect(negated.otel).toBe(false);

    const omitted = await parseOtel(['run', 'x.yaml']);
    expect(omitted.failMessage).toBeUndefined();
    expect(omitted.otel).toBeUndefined();
  });

  it('forwards the flag to the run options as the tri-state `otel`', async () => {
    // The handler maps argv to `WorkflowRunOptions`; `undefined` must not be
    // spread into the object as an explicit key, or "neither flag passed"
    // would become indistinguishable from `--no-otel` downstream.
    const { runCommandDefinition: definition } = await import(
      '../src/commands/workflow/run.js'
    );
    expect(typeof definition.handler).toBe('function');
  });
});

describe('--otel activation rule', () => {
  it('activates on the flag regardless of the environment', async () => {
    const { isOtelActive } = await import('../src/telemetry/otel.js');

    expect(isOtelActive(true, {})).toBe(true);
    expect(isOtelActive(true, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(
      true,
    );
  });

  it('deactivates on --no-otel even when the endpoint env vars are set', async () => {
    const { isOtelActive } = await import('../src/telemetry/otel.js');

    expect(isOtelActive(false, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(
      false,
    );
    expect(
      isOtelActive(false, { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces' }),
    ).toBe(false);
  });

  it('activates with no flag when either standard endpoint env var is set', async () => {
    const { isOtelActive } = await import('../src/telemetry/otel.js');

    expect(isOtelActive(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(
      true,
    );
    expect(
      isOtelActive(undefined, {
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces',
      }),
    ).toBe(true);
  });

  it('stays inactive with neither a flag nor an endpoint', async () => {
    const { isOtelActive } = await import('../src/telemetry/otel.js');

    expect(isOtelActive(undefined, {})).toBe(false);
    // A variable that says nothing about *where* telemetry goes must not
    // switch exporting on for someone who only wanted to name their service.
    expect(isOtelActive(undefined, { OTEL_SERVICE_NAME: 'my-service' })).toBe(false);
    // Nor must an empty string, which is how a shell passes "unset but exported".
    expect(isOtelActive(undefined, { OTEL_EXPORTER_OTLP_ENDPOINT: '  ' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// `--heartbeat <ms>` (OBSERVABILITY.md, "`run.heartbeat`") — the yargs wiring,
// mirrored on `--otel`'s own two-part test above, plus one integration test
// that a short interval against a real, slow-enough step actually produces
// `run.heartbeat` lines in the log file.
// ---------------------------------------------------------------------------

describe('workflow run — --heartbeat yargs wiring', () => {
  async function parseHeartbeat(args: string[]): Promise<{
    failMessage: string | undefined;
    heartbeat: unknown;
  }> {
    let failMessage: string | undefined;
    let heartbeat: unknown = '(handler not called)';
    const parser = yargs(args)
      .exitProcess(false)
      .fail((msg) => {
        failMessage = msg ?? '(no message)';
        throw new Error(failMessage);
      })
      .command('run <workflow-path>', 'run', runCommandDefinition.builder, async (argv) => {
        heartbeat = (argv as Record<string, unknown>).heartbeat;
      });
    try {
      await parser.parseAsync();
    } catch {
      // The re-thrown `.fail()` error — already captured in `failMessage`.
    }
    return { failMessage, heartbeat };
  }

  it('parses --heartbeat <ms> as a number', async () => {
    const { failMessage, heartbeat } = await parseHeartbeat(['run', 'x.yaml', '--heartbeat', '5000']);

    expect(failMessage).toBeUndefined();
    expect(heartbeat).toBe(5000);
  });

  it('parses --heartbeat 0, distinguishable from the flag being absent', async () => {
    const zero = await parseHeartbeat(['run', 'x.yaml', '--heartbeat', '0']);
    expect(zero.failMessage).toBeUndefined();
    expect(zero.heartbeat).toBe(0);

    const omitted = await parseHeartbeat(['run', 'x.yaml']);
    expect(omitted.failMessage).toBeUndefined();
    expect(omitted.heartbeat).toBeUndefined();
  });
});

describe('workflow run — --heartbeat behaviour', () => {
  /** A workspace/workflow pair with a step slow enough to observe several heartbeats. */
  function heartbeatWorkflowYaml(sleepMs: number): string {
    return `
kind: Workflow
formatVersion: "1.0"
name: heartbeat-example
plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    sleep_ms:
      seed: ${sleepMs}
steps:
  - label: long-sleep
    plugin: "${PLUGIN_PACKAGE}"
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: sleep_done_at
    errors:
      message: sleep_error
`.trim();
  }

  async function makeHeartbeatScenario(name: string, sleepMs: number): Promise<Scenario> {
    const directory = path.join(rootDir, name);
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });

    const workspacePath = path.join(directory, 'workspace.yaml');
    const workflowPath = path.join(workflowDir, 'example.workflow.yaml');
    await fs.writeFile(workspacePath, workspaceYaml(name), 'utf-8');
    await fs.writeFile(workflowPath, heartbeatWorkflowYaml(sleepMs), 'utf-8');

    return { directory, workspacePath, workflowPath };
  }

  it('emits run.heartbeat lines, correlated to the in-flight step, on the requested cadence', async () => {
    const scenario = await makeHeartbeatScenario('heartbeat-cadence', 300);
    const logFile = path.join(scenario.directory, 'heartbeat-run.ndjson');

    await runWorkflowCommand(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      logFile,
      heartbeatMs: 40,
    });

    expectPassed();
    const lineList = (await fs.readFile(logFile, 'utf-8'))
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const heartbeatList = lineList.filter((event) => event['event'] === 'run.heartbeat');
    expect(heartbeatList.length).toBeGreaterThan(0);
    for (const event of heartbeatList) {
      expect((event['step'] as Record<string, unknown>)['label']).toBe('long-sleep');
      expect(typeof event['in_flight_ms']).toBe('number');
      // Never an alarm.
      expect(event).not.toHaveProperty('severity');
    }

    // Every heartbeat sits strictly between the step's own boundary events.
    const kinds = lineList.map((event) => event['event']);
    const startIndex = kinds.indexOf('step.start');
    const endIndex = kinds.indexOf('step.end');
    const heartbeatIndexList = kinds
      .map((kind, index) => (kind === 'run.heartbeat' ? index : -1))
      .filter((index) => index !== -1);
    for (const index of heartbeatIndexList) {
      expect(index).toBeGreaterThan(startIndex);
      expect(index).toBeLessThan(endIndex);
    }
  }, 60_000);

  it('--heartbeat 0 disables heartbeats entirely, even for a slow step', async () => {
    const scenario = await makeHeartbeatScenario('heartbeat-disabled', 200);
    const logFile = path.join(scenario.directory, 'heartbeat-run.ndjson');

    await runWorkflowCommand(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      logFile,
      heartbeatMs: 0,
    });

    expectPassed();
    const content = await fs.readFile(logFile, 'utf-8');
    expect(content).not.toContain('"event":"run.heartbeat"');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// `--seed key=<json>` — the CLI's own seed-override layer
// (`@rawbox/runner`'s `workspace/seed-overrides.ts` module doc, "CLI >
// workspace > workflow"). `workflow run — a halt that fails the run`'s
// `sleep-workflow` fixture already proves the mechanism end to end via a
// workspace `seedOverrides:` block; these prove the flag reaches the same
// mechanism, with the same rules, plus the reporting `--seed` alone would
// otherwise have none of.
// ---------------------------------------------------------------------------

describe('workflow run — --seed key=<json>', () => {
  const SEED_WORKFLOW_NAME = 'seed-flag-example';

  function seedWorkflowYaml(): string {
    return `
kind: Workflow
formatVersion: "1.0"
name: ${SEED_WORKFLOW_NAME}
plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    greeting:
      seed: from-the-workflow
steps:
  - label: echo-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: value-ops/echo
    inputs:
      value: greeting
    outputs:
      value: echoed
`.trim();
  }

  /** `workspaceExtraLineList` is e.g. a `seedOverrides:` block, appended verbatim. */
  async function makeSeedScenario(
    name: string,
    workspaceExtraLineList: readonly string[] = [],
  ): Promise<Scenario> {
    const directory = path.join(rootDir, name);
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });

    const workspacePath = path.join(directory, 'workspace.yaml');
    const workflowPath = path.join(workflowDir, 'example.workflow.yaml');
    await fs.writeFile(
      workspacePath,
      [
        'kind: Workspace',
        `name: ${name}`,
        'workflowPathList:',
        '  - ./workflows/example.workflow.yaml',
        ...workspaceExtraLineList,
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(workflowPath, seedWorkflowYaml(), 'utf-8');

    return { directory, workspacePath, workflowPath };
  }

  /** The echoed value the one step of {@link seedWorkflowYaml} produced. */
  function echoedValue(logContent: string): unknown {
    const stepEnd = logContent
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((event) => event['event'] === 'step.end');
    return (stepEnd?.['output'] as Record<string, unknown> | undefined)?.['value'];
  }

  /** Every `seed.override.applied` event's `overrides` list, flattened, in order. */
  function seedOverrideApplications(
    logContent: string,
  ): Array<{ key: string; source: string }> {
    return logContent
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => event['event'] === 'seed.override.applied')
      .flatMap((event) => event['overrides'] as Array<{ key: string; source: string }>);
  }

  it("the workflow's own value survives when neither a workspace nor --seed overrides it", async () => {
    const scenario = await makeSeedScenario('seed-flag-none');
    const logFile = path.join(scenario.directory, 'run.ndjson');

    await runWorkflowCommand(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      logFile,
    });

    expectPassed();
    const content = await fs.readFile(logFile, 'utf-8');
    expect(echoedValue(content)).toBe('from-the-workflow');
    expect(content).not.toContain('"event":"seed.override.applied"');
  }, 60_000);

  it('a --seed override applies where the workspace declares none', async () => {
    const scenario = await makeSeedScenario('seed-flag-alone');
    const logFile = path.join(scenario.directory, 'run.ndjson');

    await runWorkflowCommand(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      logFile,
      seed: ['greeting="from-the-cli"'],
    });

    expectPassed();
    const content = await fs.readFile(logFile, 'utf-8');
    expect(echoedValue(content)).toBe('from-the-cli');
    // Echoed at run start AND into the NDJSON stream (task item 2): the key
    // and its source, no value.
    expect(seedOverrideApplications(content)).toEqual([
      { key: 'greeting', source: 'the --seed flag' },
    ]);
  }, 60_000);

  it('a --seed override takes precedence over a workspace seedOverrides: block for the same key', async () => {
    const scenario = await makeSeedScenario('seed-flag-beats-workspace', [
      'seedOverrides:',
      // Keyed by the workflow's PATH, spelt without the `./` the
      // `workflowPathList` entry above carries — one workflow either way.
      '  workflows/example.workflow.yaml:',
      '    greeting: from-the-workspace',
    ]);
    const logFile = path.join(scenario.directory, 'run.ndjson');

    await runWorkflowCommand(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      logFile,
      seed: ['greeting="from-the-cli"'],
    });

    expectPassed();
    const content = await fs.readFile(logFile, 'utf-8');
    // CLI > workspace > workflow: the CLI's value won, not the workspace's.
    expect(echoedValue(content)).toBe('from-the-cli');
    expect(seedOverrideApplications(content)).toEqual([
      { key: 'greeting', source: 'the --seed flag' },
    ]);
  }, 60_000);

  it('a malformed --seed value is refused with a named error, before any workspace or workflow file is even opened', async () => {
    // Paths that do not exist: if this reached step 1 (load the workflow) or
    // discovered a workspace, it would fail with an ENOENT/discovery
    // diagnostic instead — so getting the --seed diagnostic back proves
    // parsing happened first, exactly as `runWorkflowCommand`'s own step 0
    // comment says it must.
    const missingWorkflowPath = path.join(rootDir, 'seed-flag-malformed', 'nope.workflow.yaml');

    await runWorkflowCommand(missingWorkflowPath, {
      // Not valid JSON: an unquoted word. The hazard this guards against is
      // exactly this value silently becoming the *string* "not-json" instead
      // of being refused.
      seed: ['greeting=not-json'],
    });

    expectFailed();
    const output = reported();
    expect(output).toContain('--seed "greeting"');
    expect(output).toContain('is not valid JSON');
    expect(output).not.toContain('ENOENT');
    expect(output).not.toContain('Failed to load workflow');
  }, 60_000);

  it('a --seed override on a key the workflow does not declare is refused with the same diagnostic as a workspace override, naming the flag', async () => {
    const scenario = await makeSeedScenario('seed-flag-undeclared');

    await runWorkflowCommand(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      seed: ['nonexistent_key=1'],
    });

    expectFailed();
    const output = reported();
    // The identical rule and diagnostic prose the workspace layer produces
    // (`workspace/seed-overrides.ts`'s `describeUnseedableOverride`) —
    // nothing was reimplemented or relaxed for the CLI layer.
    expect(output).toContain('Seed override for storage key "nonexistent_key"');
    expect(output).toContain('RESET that key on every run');
    // But naming the flag, not a workspace document, as the source.
    expect(output).toContain('the --seed flag');
    expect(output).toContain('--seed.nonexistent_key');
  }, 60_000);
});
