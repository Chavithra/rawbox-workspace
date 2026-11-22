import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDependencyEnvDir } from '@rawbox/runner';

// ---------------------------------------------------------------------------
// THE HAZARD this proves fixed: starting several workflows of ONE workspace
// concurrently — the documented multi-workflow pattern
// (.agents/skills/rawbox-workflow-creation/SKILL.md, "Setup and Execution" / "Watching a Run") — used to race
// auto-setup. Workflows declaring the same `dependencies:` map share one env,
// `.rawbox/envs/<hash>/`; each `rawbox-cli run` process independently finds
// that env not yet installed and would invoke its own `npm install` into it;
// npm does not tolerate two concurrent installs into one prefix.
//
// This is that exact scenario, driven as REAL, SEPARATE OS processes against
// the built `dist/index.js` — the race is between npm invocations in
// different processes, which a single Node process's event loop could never
// reproduce (a synchronous `execSync('npm install')` blocks that process
// entirely, so two calls in one process could never even attempt to overlap).
//
// The workspace lists three workflows, each declaring the SAME plugin by a
// `file:` specifier that resolves nowhere except an env this test's own
// auto-setup installs into (the same "clone the built plugin under a name
// that exists nowhere else" technique `run.test.ts` uses) — so the plugin is
// genuinely missing at the moment all three processes start, and a completed
// run is genuine proof the install actually happened. A second workspace
// proves the converse: workflows with different maps lock different envs and
// both install.
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
const CLI_ENTRY = path.join(repoRoot, 'packages', 'rawbox-cli', 'dist', 'index.js');
const DEFAULT_PLUGIN_DIR = path.join(repoRoot, 'packages', 'rawbox-plugin-default');

const tempDir = path.join(__dirname, 'temp-auto-setup-race-test');
const RACE_PLUGIN = 'rawbox-plugin-autosetup-race-e2e';
const racePluginDir = path.join(tempDir, '_race-plugin');
/** A second copy of {@link RACE_PLUGIN}: same name, different `file:` specifier, so a different env. */
const racePluginDirB = path.join(tempDir, '_race-plugin-b');

/** Clones the built default plugin under {@link RACE_PLUGIN} — resolvable nowhere but an env this test installs into. */
async function buildRacePlugin(destination: string): Promise<void> {
  await fs.cp(DEFAULT_PLUGIN_DIR, destination, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== 'node_modules' && base !== 'tsconfig.tsbuildinfo';
    },
  });

  const manifestPath = path.join(destination, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  manifest.name = RACE_PLUGIN;
  manifest.dependencies = {};
  manifest.devDependencies = {};
  manifest.scripts = {};
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // Must actually be loadable, or a "passing" run would prove nothing.
  await fs.stat(path.join(destination, 'dist', 'contract-registry.js'));
}

function workflowYaml(name: string, pluginDir: string = racePluginDir): string {
  return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
dependencies:
  "${RACE_PLUGIN}": "file:${pluginDir}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    sleep_ms:
      seed: 1
    halt_reason:
      seed: "auto-setup race test"
steps:
  - label: sleep-step
    plugin: "${RACE_PLUGIN}"
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: sleep_done_at
    errors:
      message: sleep_error
  - label: done
    plugin: "${RACE_PLUGIN}"
    operation: control-flow/halt
    inputs:
      reason: halt_reason
    errors:
      message: halt_error
`.trim();
}

const workspaceDir = path.join(tempDir, 'race-ws');
const workspaceFile = path.join(workspaceDir, 'workspace.yaml');
const workflowsDir = path.join(workspaceDir, 'workflows');
const WORKFLOW_NAMES = ['race-one', 'race-two', 'race-three'];

const WORKSPACE_YAML = `
kind: Workspace
name: auto-setup-race
workflowPathList:
${WORKFLOW_NAMES.map((name) => `  - ./workflows/${name}.workflow.yaml`).join('\n')}
`.trim();

interface CliRunResult {
  code: number | null;
  combinedOutput: string;
}

/** Spawns the real BUILT CLI's `run` command as a one-shot child process and waits for it to exit. */
function spawnRun(
  workflowName: string,
  workspace: { file: string; workflowsDir: string } = { file: workspaceFile, workflowsDir },
): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const workflowFile = path.join(workspace.workflowsDir, `${workflowName}.workflow.yaml`);
    const child = spawn(
      process.execPath,
      [CLI_ENTRY, 'run', workflowFile, '--workspace', workspace.file, '--output', 'quiet'],
      { cwd: tempDir, stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let combinedOutput = '';
    child.stdout.on('data', (chunk: Buffer) => {
      combinedOutput += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      combinedOutput += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, combinedOutput }));
  });
}

/** Strips ANSI colour codes so a substring search doesn't have to account for them. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Counts non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('auto-setup race — concurrent `run` processes against one workspace', () => {
  beforeAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(workflowsDir, { recursive: true });
    await buildRacePlugin(racePluginDir);
    await buildRacePlugin(racePluginDirB);

    await fs.writeFile(workspaceFile, WORKSPACE_YAML, 'utf-8');
    for (const name of WORKFLOW_NAMES) {
      await fs.writeFile(path.join(workflowsDir, `${name}.workflow.yaml`), workflowYaml(name), 'utf-8');
    }

    // Sanity: this file drives the real BUILT artifact — `npm run build:all`
    // (and `@rawbox/cli`'s own `build`) must have run first.
    await expect(fs.stat(CLI_ENTRY)).resolves.toBeDefined();

    // Deliberately NO `workspace setup` here — the plugin must still be
    // missing the moment all three `run` processes start, which is exactly
    // what makes this the auto-setup race rather than a no-op.
    await expect(fs.stat(path.join(workspaceDir, '.rawbox', 'envs'))).rejects.toThrow();
  }, 120_000);

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('all three concurrent runs succeed, and exactly one auto-setup install occurred', async () => {
    const results = await Promise.all(WORKFLOW_NAMES.map((name) => spawnRun(name)));

    for (const [index, result] of results.entries()) {
      expect(result.code, `${WORKFLOW_NAMES[index]} exited non-zero:\n${result.combinedOutput}`).toBe(0);
    }

    // The winner's install prints "...not yet installed (...) — installing
    // into ..." exactly once per real `npm install` attempt. A loser either
    // never touches this message at all (its own pre-check found nothing
    // missing) or, having waited, finds the winner already satisfied it
    // (the "joined" message below) — neither path ever prints "installing
    // into" a second time. Counted across all three processes' combined
    // output, this is the single robust witness that only one `npm install`
    // ever ran, without depending on timing or sleeps.
    const combined = results.map((result) => stripAnsi(result.combinedOutput)).join('\n---\n');
    const installAttempts = countOccurrences(combined, 'installing into');
    expect(installAttempts, combined).toBe(1);

    // Functional proof the one install actually worked: the plugin now
    // resolves from the shared env, and every run's own NDJSON
    // log completed with `run.end`/`outcome: "ok"` — not merely that the
    // process exited 0.
    const targetFolder = path.join(workspaceDir, '.rawbox');
    const envDir = resolveDependencyEnvDir(
      targetFolder,
      { [RACE_PLUGIN]: `file:${racePluginDir}` },
      workspaceDir,
    ) as string;
    await expect(
      fs.stat(path.join(envDir, 'node_modules', RACE_PLUGIN, 'package.json')),
    ).resolves.toBeDefined();

    // package.json must be valid JSON naming the plugin — a corrupted
    // manifest is exactly the failure mode two racing `npm install`s into
    // one prefix used to produce.
    const packageJson = JSON.parse(
      await fs.readFile(path.join(envDir, 'package.json'), 'utf-8'),
    );
    expect(packageJson.dependencies[RACE_PLUGIN]).toBeDefined();

    for (const name of WORKFLOW_NAMES) {
      const logDir = path.join(targetFolder, 'logs', name);
      const entryList = await fs.readdir(logDir);
      const logFile = entryList.find(isSegmentZeroLogFile);
      expect(logFile, `no NDJSON log for ${name}`).toBeDefined();
      const content = await fs.readFile(path.join(logDir, logFile!), 'utf-8');
      expect(content, `${name} did not complete ok`).toContain('"event":"run.end","outcome":"ok"');
    }

    // No leftover lock file — every acquirer released it, winner and any
    // stale-recovery path alike.
    await expect(fs.stat(path.join(envDir, '.rawbox-setup.lock'))).rejects.toThrow();

    // One env, and nothing installed at the target folder's own top level.
    expect(await fs.readdir(path.join(targetFolder, 'envs'))).toEqual([path.basename(envDir)]);
    await expect(fs.stat(path.join(targetFolder, 'node_modules'))).rejects.toThrow();
  }, 180_000);

  it('two concurrent runs with different dependencies both install, each into its own env', async () => {
    const splitWorkspaceDir = path.join(tempDir, 'split-ws');
    const splitWorkflowsDir = path.join(splitWorkspaceDir, 'workflows');
    const splitWorkspaceFile = path.join(splitWorkspaceDir, 'workspace.yaml');
    const pluginDirByWorkflow: Record<string, string> = {
      'split-a': racePluginDir,
      'split-b': racePluginDirB,
    };

    await fs.mkdir(splitWorkflowsDir, { recursive: true });
    await fs.writeFile(
      splitWorkspaceFile,
      [
        'kind: Workspace',
        'name: auto-setup-split',
        'workflowPathList:',
        ...Object.keys(pluginDirByWorkflow).map((name) => `  - ./workflows/${name}.workflow.yaml`),
        '',
      ].join('\n'),
      'utf-8',
    );
    for (const [name, pluginDir] of Object.entries(pluginDirByWorkflow)) {
      await fs.writeFile(
        path.join(splitWorkflowsDir, `${name}.workflow.yaml`),
        workflowYaml(name, pluginDir),
        'utf-8',
      );
    }

    const results = await Promise.all(
      Object.keys(pluginDirByWorkflow).map((name) =>
        spawnRun(name, { file: splitWorkspaceFile, workflowsDir: splitWorkflowsDir }),
      ),
    );

    for (const result of results) {
      expect(result.code, result.combinedOutput).toBe(0);
    }

    // Neither waited on the other: they hash to different envs, so each
    // process ran its own install.
    const combined = results.map((result) => stripAnsi(result.combinedOutput)).join('\n---\n');
    expect(countOccurrences(combined, 'installing into'), combined).toBe(2);
    expect(combined).not.toContain('Auto-setup already in progress');

    const targetFolder = path.join(splitWorkspaceDir, '.rawbox');
    const envDirList = Object.values(pluginDirByWorkflow).map(
      (pluginDir) =>
        resolveDependencyEnvDir(
          targetFolder,
          { [RACE_PLUGIN]: `file:${pluginDir}` },
          splitWorkspaceDir,
        ) as string,
    );
    expect(new Set(envDirList).size).toBe(2);
    expect((await fs.readdir(path.join(targetFolder, 'envs'))).sort()).toEqual(
      envDirList.map((envDir) => path.basename(envDir)).sort(),
    );

    for (const [index, envDir] of envDirList.entries()) {
      // Linked, not copied: each env's package points at its own source.
      const installed = path.join(envDir, 'node_modules', RACE_PLUGIN);
      expect(await fs.realpath(installed)).toBe(
        await fs.realpath(Object.values(pluginDirByWorkflow)[index]!),
      );
      await expect(fs.stat(path.join(envDir, '.rawbox-setup.lock'))).rejects.toThrow();
    }
  }, 180_000);
});
