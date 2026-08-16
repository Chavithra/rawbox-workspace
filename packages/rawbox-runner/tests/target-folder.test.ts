import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { ContractRegistryCache } from '@rawbox/plugin/core';

import { PluginDiscoverer } from '../src/workflow/plugin-discoverer.js';
import { setupWorkspace } from '../src/tool/setup-workspace.js';
import { runWorkflowInstance, dedupePathList } from '../src/tool/run-workflow.js';
import { resolveTargetFolder, RAWBOX_DOT_FOLDER } from '../src/workspace/workspace-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root: packages/rawbox-runner/tests -> ../../.. */
const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** The real, built plugin this fixture is cloned from. */
const SOURCE_PLUGIN_DIR = path.join(repoRoot, 'packages', 'rawbox-plugin-default');

const sandboxRoot = path.join(
  __dirname,
  'sandbox',
  `target-folder-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
);

// ---------------------------------------------------------------------------
// The acceptance case for "the target folder is on the run-time resolution path"
// pins FORMAT.md, "The Workspace document"; see `resolveTargetFolder`
// for the precedence.
//
// Before this existed, `workspace setup <ws> ./target` installed into a folder
// the runner never consulted: it resolved from `[workspaceDir, process.cwd()]`
// only, so a plugin installed solely into a separate target was unresolvable
// from any cwd but that target.
//
// This is a **real fixture**, not a weaker assertion about how the base list is
// built. That distinction is the whole point of the file: a test written against
// `@rawbox/rawbox-plugin-default` proves nothing, because that package sits in
// this monorepo's hoisted `node_modules` and resolves by walking up from the
// workspace directory whether or not the target folder is ever consulted. So the
// plugin here is a clone of it under a package name that exists nowhere on disk
// except inside the target folder `workspace setup` produces.
//
// `resolvesFromNowhereElse` below is the guard that keeps that true: it asserts
// the fixture is genuinely unresolvable from the workspace directory and from an
// unrelated cwd, so the passing run afterwards can only have come through the
// target folder.
//
// One thing the fixture does *not* reproduce, deliberately: it has no `npm
// install` of its own, and its `typebox` / `neverthrow` / `@rawbox/plugin`
// imports resolve by walking up from its real location into this monorepo's
// `node_modules`. That is not a shortcut around the defect under test — it is
// exactly what npm's `file:` link behaviour forces in the field (npm symlinks
// the package and does not install its dependencies into the target), and it
// keeps the suite off the network. What the fixture does isolate is the only
// thing that matters here: the *plugin package name*.
// ---------------------------------------------------------------------------

/** Package name that exists nowhere but the target folder. */
const FIXTURE_PLUGIN = 'rawbox-plugin-target-folder-e2e';

const WORKSPACE_NAME = 'target-folder-ws';
const WORKFLOW_NAME = 'target-folder-example';

const pluginDir = path.join(sandboxRoot, 'plugin');
const workspaceDir = path.join(sandboxRoot, 'workspace');
const workspaceFile = path.join(workspaceDir, 'workspace.yaml');
const workflowFile = path.join(workspaceDir, 'workflows', `${WORKFLOW_NAME}.workflow.yaml`);
const targetDir = path.join(sandboxRoot, 'target');

// A second workspace, declaring no `targetFolder:` at all — the acceptance case
// for the `.rawbox` default. It reuses the same fixture plugin
// `buildFixturePlugin` already built, so only the workspace/workflow documents
// differ.
const DEFAULT_WORKSPACE_NAME = 'target-folder-default-ws';
const defaultWorkspaceDir = path.join(sandboxRoot, 'workspace-default');
const defaultWorkspaceFile = path.join(defaultWorkspaceDir, 'workspace.yaml');
const defaultWorkflowFile = path.join(
  defaultWorkspaceDir,
  'workflows',
  `${WORKFLOW_NAME}.workflow.yaml`,
);
const defaultTargetFolder = path.join(defaultWorkspaceDir, '.rawbox');

/**
 * Clones the built default plugin under {@link FIXTURE_PLUGIN}.
 *
 * `dist/` is copied as-is — the contract registry is identical, only the package
 * identity changes — and `dependencies` is emptied because npm never installs a
 * linked package's dependencies into the target anyway; see the header note.
 */
async function buildFixturePlugin(): Promise<void> {
  await fs.cp(SOURCE_PLUGIN_DIR, pluginDir, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== 'node_modules' && base !== 'tsconfig.tsbuildinfo';
    },
  });

  const manifestPath = path.join(pluginDir, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  manifest.name = FIXTURE_PLUGIN;
  manifest.dependencies = {};
  manifest.devDependencies = {};
  manifest.scripts = {};
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // The clone must actually be loadable, or a run that fails would be
  // indistinguishable from the defect this file exists to catch.
  await fs.stat(path.join(pluginDir, 'dist', 'contract-registry.js'));
}

async function writeWorkspace(): Promise<void> {
  await fs.mkdir(path.join(workspaceDir, 'workflows'), { recursive: true });

  await fs.writeFile(
    workspaceFile,
    YAML.stringify({
      kind: 'Workspace',
      name: WORKSPACE_NAME,
      // A folder outside the workspace directory: the configuration that was
      // unrunnable before this field existed.
      targetFolder: '../target',
      workflowPathList: [`./workflows/${WORKFLOW_NAME}.workflow.yaml`],
    }),
    'utf-8',
  );

  await fs.writeFile(
    workflowFile,
    YAML.stringify({
      kind: 'Workflow',
      formatVersion: '1.0',
      name: WORKFLOW_NAME,
      plugins: { [FIXTURE_PLUGIN]: `file:${pluginDir}` },
      storage: {
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
        keys: {
          sleep_ms: { seed: 1 },
          halt_reason: { seed: 'target folder run finished' },
        },
      },
      steps: [
        {
          label: 'sleep-step',
          plugin: FIXTURE_PLUGIN,
          operation: 'time/sleep',
          inputs: { ms: 'sleep_ms' },
          outputs: { timestamp: 'sleep_done_at' },
          errors: { message: 'sleep_error' },
        },
        {
          label: 'done',
          plugin: FIXTURE_PLUGIN,
          operation: 'control-flow/halt',
          inputs: { reason: 'halt_reason' },
          errors: { message: 'halt_error' },
        },
      ],
    }),
    'utf-8',
  );
}

/**
 * Same fixture as {@link writeWorkspace}, but the workspace document declares
 * no `targetFolder:` at all, so `resolveTargetFolder`'s default —
 * `<workspace directory>/.rawbox` — is what has to carry the plugin.
 */
async function writeDefaultWorkspace(): Promise<void> {
  await fs.mkdir(path.join(defaultWorkspaceDir, 'workflows'), { recursive: true });

  await fs.writeFile(
    defaultWorkspaceFile,
    YAML.stringify({
      kind: 'Workspace',
      name: DEFAULT_WORKSPACE_NAME,
      workflowPathList: [`./workflows/${WORKFLOW_NAME}.workflow.yaml`],
    }),
    'utf-8',
  );

  await fs.writeFile(
    defaultWorkflowFile,
    YAML.stringify({
      kind: 'Workflow',
      formatVersion: '1.0',
      name: WORKFLOW_NAME,
      plugins: { [FIXTURE_PLUGIN]: `file:${pluginDir}` },
      storage: {
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
        keys: {
          sleep_ms: { seed: 1 },
          halt_reason: { seed: 'default target folder run finished' },
        },
      },
      steps: [
        {
          label: 'sleep-step',
          plugin: FIXTURE_PLUGIN,
          operation: 'time/sleep',
          inputs: { ms: 'sleep_ms' },
          outputs: { timestamp: 'sleep_done_at' },
          errors: { message: 'sleep_error' },
        },
        {
          label: 'done',
          plugin: FIXTURE_PLUGIN,
          operation: 'control-flow/halt',
          inputs: { reason: 'halt_reason' },
          errors: { message: 'halt_error' },
        },
      ],
    }),
    'utf-8',
  );
}

/** Loads the fixture from a given base list, returning the skip reason if any. */
async function loadFrom(baseList: readonly string[]): Promise<string | undefined> {
  const result = await PluginDiscoverer.loadPlugins(
    [FIXTURE_PLUGIN],
    new ContractRegistryCache(),
    { resolveFrom: baseList },
  );
  return result.skipped[0]?.reason;
}

beforeAll(async () => {
  await fs.mkdir(sandboxRoot, { recursive: true });
  await buildFixturePlugin();
  await writeWorkspace();
  await writeDefaultWorkspace();
}, 120_000);

afterAll(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
});

describe('resolveTargetFolder', () => {
  it('prefers an explicit argument over everything else', () => {
    expect(
      resolveTargetFolder('/ws', { targetFolder: './declared' }, '/explicit'),
    ).toBe(path.resolve('/explicit'));
  });

  it('falls back to `targetFolder:`, resolved against the workspace directory', () => {
    // Relative to the workspace directory, matching the base a relative `file:`
    // plugin specifier already uses — not the cwd, and not the target itself.
    expect(resolveTargetFolder('/ws/nested', { targetFolder: '../target' })).toBe(
      path.resolve('/ws/target'),
    );
  });

  it('defaults to `<workspace directory>/.rawbox` when nothing is declared', () => {
    expect(resolveTargetFolder('/ws', {})).toBe(
      path.resolve('/ws', RAWBOX_DOT_FOLDER),
    );
  });

  it('treats a blank declaration or argument as absent', () => {
    expect(resolveTargetFolder('/ws', { targetFolder: '   ' })).toBe(
      path.resolve('/ws', RAWBOX_DOT_FOLDER),
    );
    expect(resolveTargetFolder('/ws', {}, '')).toBe(
      path.resolve('/ws', RAWBOX_DOT_FOLDER),
    );
  });
});

describe('dedupePathList', () => {
  it('keeps the first occurrence of each distinct absolute path, in order', () => {
    expect(dedupePathList(['/a', '/b', '/a/../a', '/c'])).toEqual([
      path.resolve('/a'),
      path.resolve('/b'),
      path.resolve('/c'),
    ]);
  });
});

describe('a plugin installed only into a separate target folder', () => {
  it('is installed there by `workspace setup` with no target-folder argument', async () => {
    // No second argument: the folder comes from `targetFolder:` in the document.
    const result = await setupWorkspace(workspaceFile);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    expect(result._unsafeUnwrap()).toBe(path.resolve(targetDir));

    const manifest = JSON.parse(
      await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'),
    );
    expect(manifest.dependencies[FIXTURE_PLUGIN]).toBe(`file:${pluginDir}`);
    expect(
      await fs.stat(path.join(targetDir, 'node_modules', FIXTURE_PLUGIN)),
    ).toBeDefined();
  }, 300_000);

  it('resolves from nowhere else — not the workspace directory, not an unrelated cwd', async () => {
    // The guard that makes the run below meaningful. Both of these are the bases
    // `runWorkflowInstance` used *before* the target folder was threaded in, so
    // if either one started succeeding this file would silently stop testing
    // anything.
    expect(await loadFrom([workspaceDir])).toContain(FIXTURE_PLUGIN);
    expect(await loadFrom([repoRoot])).toContain(FIXTURE_PLUGIN);
    expect(await loadFrom([workspaceDir, repoRoot])).toMatch(/Cannot find package/);

    // ...and resolves from the target folder, which is the only place it lives.
    expect(await loadFrom([targetDir])).toBeUndefined();
  });

  it('runs to completion from an unrelated cwd', async () => {
    const logFile = path.join(sandboxRoot, 'run.log');
    const errorLogFile = path.join(sandboxRoot, 'run.error.log');

    // The failing case: cwd is neither the target folder nor the workspace
    // directory. Before the target folder joined the resolution bases this
    // returned `Cannot find package '<plugin>'`.
    const originalCwd = process.cwd();
    process.chdir(repoRoot);
    let result;
    try {
      result = await runWorkflowInstance(workspaceFile, workflowFile, logFile, errorLogFile);
    } finally {
      process.chdir(originalCwd);
    }

    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    const log = await fs.readFile(logFile, 'utf-8');
    // The run's own summary event, from the NDJSON stream the runner emits.
    expect(log).toContain(`"workflow":"${WORKFLOW_NAME}"`);
    expect(log).toContain('"event":"run.end","outcome":"ok"');
    // `__EXIT__` is the label `halt` returns: evidence both steps ran rather
    // than the run falling off the end of the list.
    expect(log).toContain('__EXIT__');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The acceptance case for the default target folder (rawbox-cli README,
// "Workspace Initialization (`workspace setup`)"): `resolveTargetFolder` defaults to `<workspace directory>/.rawbox`,
// while the *order* plugin resolution leads with — target folder, then
// workspace directory, then cwd — is independent of that default, since
// `run-workflow.ts` resolves through `resolveTargetFolder` rather than
// hardcoding the workspace directory. This reruns the same fixture as above
// with no `targetFolder:` declared at all, so the only thing carrying the
// plugin is the default.
// ---------------------------------------------------------------------------

describe('a plugin installed only into the default `.rawbox` target folder', () => {
  it('is installed there by `workspace setup` with no target-folder argument and no `targetFolder:` declared', async () => {
    const result = await setupWorkspace(defaultWorkspaceFile);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    expect(result._unsafeUnwrap()).toBe(path.resolve(defaultTargetFolder));

    const manifest = JSON.parse(
      await fs.readFile(path.join(defaultTargetFolder, 'package.json'), 'utf-8'),
    );
    expect(manifest.dependencies[FIXTURE_PLUGIN]).toBe(`file:${pluginDir}`);
    expect(
      await fs.stat(path.join(defaultTargetFolder, 'node_modules', FIXTURE_PLUGIN)),
    ).toBeDefined();
  }, 300_000);

  it('resolves from nowhere else — proving resolution leads with the resolved (default) target folder', async () => {
    expect(await loadFrom([defaultWorkspaceDir])).toContain(FIXTURE_PLUGIN);
    expect(await loadFrom([repoRoot])).toContain(FIXTURE_PLUGIN);

    // ...and resolves from `.rawbox/`, which is the only place it lives.
    expect(await loadFrom([defaultTargetFolder])).toBeUndefined();
  });

  it('runs to completion from an unrelated cwd, using the default target folder', async () => {
    const logFile = path.join(sandboxRoot, 'run-default.log');
    const errorLogFile = path.join(sandboxRoot, 'run-default.error.log');

    const originalCwd = process.cwd();
    process.chdir(repoRoot);
    let result;
    try {
      result = await runWorkflowInstance(defaultWorkspaceFile, defaultWorkflowFile, logFile, errorLogFile);
    } finally {
      process.chdir(originalCwd);
    }

    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    const log = await fs.readFile(logFile, 'utf-8');
    expect(log).toContain(`"workflow":"${WORKFLOW_NAME}"`);
    expect(log).toContain('"event":"run.end","outcome":"ok"');
    expect(log).toContain('__EXIT__');

    // The LMDB data directory landed under the resolved (default) target
    // folder, not directly beside `workspace.yaml`.
    expect(
      await fs.stat(path.join(defaultTargetFolder, 'data')),
    ).toBeDefined();
    await expect(
      fs.stat(path.join(defaultWorkspaceDir, 'data')),
    ).rejects.toThrow();
  }, 120_000);
});
