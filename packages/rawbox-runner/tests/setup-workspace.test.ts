import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadAndValidateWorkflows,
  loadAndValidateWorkspace,
  setupNpmPackage,
  setupWorkspace,
} from '../src/tool/setup-workspace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Scratch space inside the repo, following the convention in
// `machine-instance.test.ts` — each test gets its own subdirectory, cleaned
// up in `afterAll`.
const sandboxRoot = path.join(__dirname, 'sandbox', `setup-workspace-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

function uniqueDir(label: string): string {
  return path.join(sandboxRoot, `${label}-${Math.floor(Math.random() * 1e6)}`);
}

async function mkdir(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Writes a minimal, installable local plugin package.json into `dir`. */
async function writeFakePlugin(dir: string, name = 'fake-plugin-package'): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0' }, null, 2),
  );
}

/** Resolves what `node_modules/<key>` points at after an npm install, or `undefined` if absent. */
async function realpathOfInstalled(targetDir: string, key: string): Promise<string | undefined> {
  try {
    return await fs.realpath(path.join(targetDir, 'node_modules', key));
  } catch {
    return undefined;
  }
}

afterAll(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
});

describe('setupNpmPackage', () => {
  it('skips npm install and writes an empty dependencies map when there are no plugins', async () => {
    const targetDir = await mkdir(uniqueDir('empty-target'));
    const workspaceDir = await mkdir(uniqueDir('empty-workspace'));

    const result = await setupNpmPackage(targetDir, {}, workspaceDir);
    expect(result.isOk()).toBe(true);

    const pkg = JSON.parse(await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toEqual({});

    // No install ever ran, so there is nothing in node_modules.
    const nodeModulesExists = await fs.access(path.join(targetDir, 'node_modules')).then(() => true).catch(() => false);
    expect(nodeModulesExists).toBe(false);
  });

  it(
    'passes a registry specifier through unchanged and installs it via npm',
    async () => {
      const targetDir = await mkdir(uniqueDir('registry-target'));
      const workspaceDir = await mkdir(uniqueDir('registry-workspace'));

      // `npm install`'s project config is read only from its own cwd, so the
      // target directory needs its own `.npmrc` to route the `@rawbox` scope
      // to the local Verdaccio registry configured at the repo root.
      await fs.writeFile(path.join(targetDir, '.npmrc'), '@rawbox:registry=http://verdaccio:4873/\n');

      // Tracks the workspace's own version. The packages are published to the
      // local Verdaccio at whatever the repo is versioned at, so a specifier
      // pinned to an older major resolves to a 404 rather than to a package.
      const plugins = { '@rawbox/rawbox-plugin-default': '^0.0.1' };
      const result = await setupNpmPackage(targetDir, plugins, workspaceDir);
      expect(result.isOk()).toBe(true);

      const pkg = JSON.parse(await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'));
      // A registry specifier is not a `file:` spec, so it is spliced verbatim.
      expect(pkg.dependencies).toEqual(plugins);

      const installedPkgJson = await fs
        .readFile(path.join(targetDir, 'node_modules', '@rawbox', 'rawbox-plugin-default', 'package.json'), 'utf-8')
        .then((content) => JSON.parse(content))
        .catch(() => undefined);
      expect(installedPkgJson?.name).toBe('@rawbox/rawbox-plugin-default');
    },
    60_000,
  );

  it('rewrites a relative file: specifier to absolute, resolved against workspaceDir', async () => {
    const workspaceDir = await mkdir(uniqueDir('rel-workspace'));
    const targetDir = await mkdir(uniqueDir('rel-target'));

    // The local plugin lives outside workspaceDir, so the specifier must
    // traverse upward — this is the case that breaks if the rewrite resolves
    // against the wrong base directory.
    const pluginDir = await mkdir(uniqueDir('rel-plugin'));
    await writeFakePlugin(pluginDir, 'local-plugin');

    const relativeSpecPath = path.relative(workspaceDir, pluginDir);
    const plugins = { 'local-plugin': `file:${relativeSpecPath}` };

    const result = await setupNpmPackage(targetDir, plugins, workspaceDir);
    expect(result.isOk()).toBe(true);

    const pkg = JSON.parse(await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'));
    // The written package.json must carry the *absolute* rewrite, resolved
    // against workspaceDir (where the workflow declaring it lives) — not
    // targetDir (where npm would otherwise resolve a relative file: spec).
    expect(pkg.dependencies['local-plugin']).toBe(`file:${path.resolve(workspaceDir, relativeSpecPath)}`);
    expect(pkg.dependencies['local-plugin']).toBe(`file:${pluginDir}`);

    // Prove the rewrite was also functionally correct: npm actually linked it.
    const realpath = await realpathOfInstalled(targetDir, 'local-plugin');
    expect(realpath).toBe(await fs.realpath(pluginDir));
  });

  it('passes an absolute file: specifier through unchanged', async () => {
    // Use a workspaceDir unrelated to the plugin location, to prove an
    // absolute specifier is never re-resolved against it.
    const workspaceDir = await mkdir(uniqueDir('abs-workspace'));
    const targetDir = await mkdir(uniqueDir('abs-target'));

    const pluginDir = await mkdir(uniqueDir('abs-plugin'));
    await writeFakePlugin(pluginDir, 'local-plugin-abs');

    const absoluteSpec = `file:${pluginDir}`;
    const plugins = { 'local-plugin-abs': absoluteSpec };

    const result = await setupNpmPackage(targetDir, plugins, workspaceDir);
    expect(result.isOk()).toBe(true);

    const pkg = JSON.parse(await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['local-plugin-abs']).toBe(absoluteSpec);

    const realpath = await realpathOfInstalled(targetDir, 'local-plugin-abs');
    expect(realpath).toBe(await fs.realpath(pluginDir));
  });

  it('symlinks a file: plugin by default, keeping the local dev loop live', async () => {
    const workspaceDir = await mkdir(uniqueDir('link-workspace'));
    const targetDir = await mkdir(uniqueDir('link-target'));
    const pluginDir = await mkdir(uniqueDir('link-plugin'));
    await writeFakePlugin(pluginDir, 'link-plugin');

    const result = await setupNpmPackage(
      targetDir,
      { 'link-plugin': `file:${pluginDir}` },
      workspaceDir,
    );
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    // A symlink, not a copy: editing and rebuilding the plugin is picked up by
    // the next run with no second `workspace setup`. That is why linking is the
    // default even though it leaves the target non-portable.
    const installed = path.join(targetDir, 'node_modules', 'link-plugin');
    expect((await fs.lstat(installed)).isSymbolicLink()).toBe(true);
  }, 60_000);

  it('copies a file: plugin under --install-links, making the target portable', async () => {
    const workspaceDir = await mkdir(uniqueDir('copy-workspace'));
    const targetDir = await mkdir(uniqueDir('copy-target'));
    const pluginDir = await mkdir(uniqueDir('copy-plugin'));
    await writeFakePlugin(pluginDir, 'copy-plugin');

    const result = await setupNpmPackage(
      targetDir,
      { 'copy-plugin': `file:${pluginDir}` },
      workspaceDir,
      { installLinks: true },
    );
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    // The opposite trade: a real directory in the target, so the folder can be
    // moved to a machine that never installed the plugin — at the cost of being
    // a snapshot of the plugin as it was at setup time.
    const installed = path.join(targetDir, 'node_modules', 'copy-plugin');
    expect((await fs.lstat(installed)).isSymbolicLink()).toBe(false);
    expect(await fs.realpath(installed)).not.toBe(await fs.realpath(pluginDir));
  }, 60_000);

  it('merges into an existing package.json instead of overwriting it', async () => {
    // The target folder now defaults to the *workspace* directory, which an
    // author may already have made an npm package of. Clobbering their manifest
    // as a side effect of `workspace setup` would be a data-loss bug.
    const workspaceDir = await mkdir(uniqueDir('merge-manifest-workspace'));
    const targetDir = await mkdir(uniqueDir('merge-manifest-target'));

    await fs.writeFile(
      path.join(targetDir, 'package.json'),
      JSON.stringify({
        name: 'authored-by-hand',
        version: '4.2.0',
        scripts: { test: 'vitest run' },
        dependencies: { 'kept-dependency': '^1.0.0' },
      }),
    );

    const result = await setupNpmPackage(targetDir, {}, workspaceDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    const pkg = JSON.parse(await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('authored-by-hand');
    expect(pkg.version).toBe('4.2.0');
    expect(pkg.scripts).toEqual({ test: 'vitest run' });
    expect(pkg.dependencies).toEqual({ 'kept-dependency': '^1.0.0' });
  });
});

describe('setupWorkspace', () => {
  it('merges plugins declared across every workflow in the workspace', async () => {
    const workspaceDir = await mkdir(uniqueDir('merge-workspace'));
    const workflowsDir = await mkdir(path.join(workspaceDir, 'workflows'));
    const targetDir = await mkdir(uniqueDir('merge-target'));

    const pluginADir = await mkdir(uniqueDir('merge-plugin-a'));
    await writeFakePlugin(pluginADir, 'plugin-a');
    const pluginBDir = await mkdir(uniqueDir('merge-plugin-b'));
    await writeFakePlugin(pluginBDir, 'plugin-b');

    const relA = path.relative(workspaceDir, pluginADir);
    const relB = path.relative(workspaceDir, pluginBDir);

    const workflowA = {
      kind: 'Workflow',
      formatVersion: '1.0',
      name: 'workflow-a',
      plugins: { 'plugin-a': `file:${relA}` },
      storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
      steps: [],
    };
    const workflowB = {
      kind: 'Workflow',
      formatVersion: '1.0',
      name: 'workflow-b',
      plugins: { 'plugin-b': `file:${relB}` },
      storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
      steps: [],
    };

    await fs.writeFile(path.join(workflowsDir, 'a.workflow.json'), JSON.stringify(workflowA, null, 2));
    await fs.writeFile(path.join(workflowsDir, 'b.workflow.json'), JSON.stringify(workflowB, null, 2));

    const workspacePath = path.join(workspaceDir, 'workspace.json');
    await fs.writeFile(
      workspacePath,
      JSON.stringify(
        {
          kind: 'Workspace' as const,
          name: 'merge-workspace',
          workflowPathList: ['./workflows/a.workflow.json', './workflows/b.workflow.json'],
        },
        null,
        2,
      ),
    );

    const result = await setupWorkspace(workspacePath, targetDir);
    expect(result.isOk()).toBe(true);

    const pkg = JSON.parse(await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toEqual({
      'plugin-a': `file:${pluginADir}`,
      'plugin-b': `file:${pluginBDir}`,
    });

    const realpathA = await realpathOfInstalled(targetDir, 'plugin-a');
    const realpathB = await realpathOfInstalled(targetDir, 'plugin-b');
    expect(realpathA).toBe(await fs.realpath(pluginADir));
    expect(realpathB).toBe(await fs.realpath(pluginBDir));
  });

  it('installs into `<workspace directory>/.rawbox` when no target folder is given anywhere', async () => {
    // The default that makes `workspace setup` and `workflow run` agree with no
    // configuration at all: the runner already resolves plugins from
    // `resolveTargetFolder`'s default, `.rawbox` under the workspace directory.
    const workspaceDir = await mkdir(uniqueDir('default-target-workspace'));
    const workflowsDir = await mkdir(path.join(workspaceDir, 'workflows'));

    const pluginDir = await mkdir(uniqueDir('default-target-plugin'));
    await writeFakePlugin(pluginDir, 'default-target-plugin');

    await fs.writeFile(
      path.join(workflowsDir, 'a.workflow.json'),
      JSON.stringify({
        kind: 'Workflow',
        formatVersion: '1.0',
        name: 'workflow-a',
        plugins: { 'default-target-plugin': `file:${pluginDir}` },
        storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
        steps: [],
      }),
    );

    const workspacePath = path.join(workspaceDir, 'workspace.json');
    await fs.writeFile(
      workspacePath,
      JSON.stringify({
        kind: 'Workspace',
        name: 'default-target-workspace',
        workflowPathList: ['./workflows/a.workflow.json'],
      }),
    );

    const result = await setupWorkspace(workspacePath);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    const expectedTargetFolder = path.join(workspaceDir, '.rawbox');
    expect(result._unsafeUnwrap()).toBe(path.resolve(expectedTargetFolder));

    const realpath = await realpathOfInstalled(expectedTargetFolder, 'default-target-plugin');
    expect(realpath).toBe(await fs.realpath(pluginDir));
  }, 60_000);

  it('installs once, silently, when two workflows declare the same package with the identical specifier', async () => {
    const workspaceDir = await mkdir(uniqueDir('identical-spec-workspace'));
    const workflowsDir = await mkdir(path.join(workspaceDir, 'workflows'));
    const targetDir = await mkdir(uniqueDir('identical-spec-target'));

    const pluginDir = await mkdir(uniqueDir('identical-spec-plugin'));
    await writeFakePlugin(pluginDir, 'shared-plugin');
    const relPlugin = path.relative(workspaceDir, pluginDir);

    const makeWorkflow = (name: string) => ({
      kind: 'Workflow',
      formatVersion: '1.0',
      name,
      // Both workflows declare the exact same package name and specifier
      // string — the harmless, common case that must keep merging silently.
      plugins: { 'shared-plugin': `file:${relPlugin}` },
      storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
      steps: [],
    });

    await fs.writeFile(path.join(workflowsDir, 'a.workflow.json'), JSON.stringify(makeWorkflow('workflow-a'), null, 2));
    await fs.writeFile(path.join(workflowsDir, 'b.workflow.json'), JSON.stringify(makeWorkflow('workflow-b'), null, 2));

    const workspacePath = path.join(workspaceDir, 'workspace.json');
    await fs.writeFile(
      workspacePath,
      JSON.stringify(
        {
          kind: 'Workspace',
          name: 'identical-spec-workspace',
          workflowPathList: ['./workflows/a.workflow.json', './workflows/b.workflow.json'],
        },
        null,
        2,
      ),
    );

    const result = await setupWorkspace(workspacePath, targetDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    const pkg = JSON.parse(await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'));
    // One entry, not an error and not a duplicate — the two identical
    // declarations collapse into the single dependency npm actually needs.
    expect(pkg.dependencies).toEqual({ 'shared-plugin': `file:${pluginDir}` });

    const realpath = await realpathOfInstalled(targetDir, 'shared-plugin');
    expect(realpath).toBe(await fs.realpath(pluginDir));
  }, 60_000);

  it('fails before npm runs when two workflows declare the same package with different specifiers, naming both workflow files', async () => {
    const workspaceDir = await mkdir(uniqueDir('conflict-workspace'));
    const workflowsDir = await mkdir(path.join(workspaceDir, 'workflows'));
    const targetDir = await mkdir(uniqueDir('conflict-target'));

    const workflowA = {
      kind: 'Workflow',
      formatVersion: '1.0',
      name: 'workflow-a',
      plugins: { '@scope/pkg': '^1.0.0' },
      storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
      steps: [],
    };
    const workflowB = {
      kind: 'Workflow',
      formatVersion: '1.0',
      name: 'workflow-b',
      plugins: { '@scope/pkg': 'file:../x' },
      storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
      steps: [],
    };

    await fs.writeFile(path.join(workflowsDir, 'a.workflow.json'), JSON.stringify(workflowA, null, 2));
    await fs.writeFile(path.join(workflowsDir, 'b.workflow.json'), JSON.stringify(workflowB, null, 2));

    const workspacePath = path.join(workspaceDir, 'workspace.json');
    await fs.writeFile(
      workspacePath,
      JSON.stringify(
        {
          kind: 'Workspace',
          name: 'conflict-workspace',
          workflowPathList: ['./workflows/a.workflow.json', './workflows/b.workflow.json'],
        },
        null,
        2,
      ),
    );

    const result = await setupWorkspace(workspacePath, targetDir);
    expect(result.isErr()).toBe(true);
    const message = result.isErr() ? result.error : '';

    expect(message).toContain('Conflicting specifiers for "@scope/pkg"');
    expect(message).toContain('"^1.0.0" (./workflows/a.workflow.json)');
    expect(message).toContain('"file:../x" (./workflows/b.workflow.json)');
    expect(message).toContain(
      'Workflows in one workspace share one install; align the specifiers or split the workspaces.',
    );

    // The conflict is caught before npm is ever invoked — no package.json was
    // written into the target folder, let alone an install attempted.
    const packageJsonExists = await fs
      .access(path.join(targetDir, 'package.json'))
      .then(() => true)
      .catch(() => false);
    expect(packageJsonExists).toBe(false);
  });

  it('reports every conflicting package in one error, not just the first', async () => {
    const workspaceDir = await mkdir(uniqueDir('multi-conflict-workspace'));
    const workflowsDir = await mkdir(path.join(workspaceDir, 'workflows'));
    const targetDir = await mkdir(uniqueDir('multi-conflict-target'));

    const workflowA = {
      kind: 'Workflow',
      formatVersion: '1.0',
      name: 'workflow-a',
      plugins: {
        'pkg-one': '^1.0.0',
        'pkg-two': '^2.0.0',
        // Declared identically in both workflows — must not be reported.
        'pkg-shared': '^3.0.0',
      },
      storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
      steps: [],
    };
    const workflowB = {
      kind: 'Workflow',
      formatVersion: '1.0',
      name: 'workflow-b',
      plugins: {
        'pkg-one': '^1.1.0',
        'pkg-two': '^2.1.0',
        'pkg-shared': '^3.0.0',
      },
      storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
      steps: [],
    };

    await fs.writeFile(path.join(workflowsDir, 'a.workflow.json'), JSON.stringify(workflowA, null, 2));
    await fs.writeFile(path.join(workflowsDir, 'b.workflow.json'), JSON.stringify(workflowB, null, 2));

    const workspacePath = path.join(workspaceDir, 'workspace.json');
    await fs.writeFile(
      workspacePath,
      JSON.stringify(
        {
          kind: 'Workspace',
          name: 'multi-conflict-workspace',
          workflowPathList: ['./workflows/a.workflow.json', './workflows/b.workflow.json'],
        },
        null,
        2,
      ),
    );

    const result = await setupWorkspace(workspacePath, targetDir);
    expect(result.isErr()).toBe(true);
    const message = result.isErr() ? result.error : '';

    expect(message).toContain('Conflicting specifiers for "pkg-one"');
    expect(message).toContain('Conflicting specifiers for "pkg-two"');
    expect(message).not.toContain('pkg-shared');
  });

  it('honours `targetFolder:` from the workspace document, relative to it', async () => {
    const workspaceDir = await mkdir(uniqueDir('declared-target-workspace'));
    const workflowsDir = await mkdir(path.join(workspaceDir, 'workflows'));

    const pluginDir = await mkdir(uniqueDir('declared-target-plugin'));
    await writeFakePlugin(pluginDir, 'declared-target-plugin');

    await fs.writeFile(
      path.join(workflowsDir, 'a.workflow.json'),
      JSON.stringify({
        kind: 'Workflow',
        formatVersion: '1.0',
        name: 'workflow-a',
        plugins: { 'declared-target-plugin': `file:${pluginDir}` },
        storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
        steps: [],
      }),
    );

    const workspacePath = path.join(workspaceDir, 'workspace.json');
    await fs.writeFile(
      workspacePath,
      JSON.stringify({
        kind: 'Workspace',
        name: 'declared-target-workspace',
        targetFolder: './run-target',
        workflowPathList: ['./workflows/a.workflow.json'],
      }),
    );

    const result = await setupWorkspace(workspacePath);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    expect(result._unsafeUnwrap()).toBe(path.join(workspaceDir, 'run-target'));

    // An explicit argument still wins over the declaration.
    const overrideDir = uniqueDir('declared-target-override');
    const override = await setupWorkspace(workspacePath, overrideDir);
    expect(override.isOk(), override.isErr() ? override.error : '').toBe(true);
    expect(override._unsafeUnwrap()).toBe(path.resolve(overrideDir));
  }, 60_000);
});

describe('setupNpmPackage — workspace .npmrc propagation', () => {
  it('copies the workspace `.npmrc` into the target folder, overwriting a stale copy', async () => {
    const workspaceDir = await mkdir(uniqueDir('npmrc-workspace'));
    const targetDir = await mkdir(uniqueDir('npmrc-target'));

    // The workspace's file is authoritative and must arrive byte-for-byte —
    // comment line included — over whatever an earlier setup left behind.
    const npmrc =
      '# scaffolded by --registry; scoped, so third-party packages still come from npmjs\n' +
      '@rawbox:registry=http://localhost:4873\n';
    await fs.writeFile(path.join(workspaceDir, '.npmrc'), npmrc);
    await fs.writeFile(
      path.join(targetDir, '.npmrc'),
      '@rawbox:registry=http://stale.invalid\n',
    );

    const result = await setupNpmPackage(targetDir, {}, workspaceDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    expect(await fs.readFile(path.join(targetDir, '.npmrc'), 'utf-8')).toBe(npmrc);
  });

  it('writes no target `.npmrc` when the workspace has none', async () => {
    const workspaceDir = await mkdir(uniqueDir('no-npmrc-workspace'));
    const targetDir = await mkdir(uniqueDir('no-npmrc-target'));

    const result = await setupNpmPackage(targetDir, {}, workspaceDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    const npmrcExists = await fs
      .access(path.join(targetDir, '.npmrc'))
      .then(() => true)
      .catch(() => false);
    expect(npmrcExists).toBe(false);
  });

  it('fails the install when the copied `.npmrc` routes @rawbox to a dead port — proof the setting reached npm', async () => {
    const workspaceDir = await mkdir(uniqueDir('dead-port-workspace'));
    const targetDir = await mkdir(uniqueDir('dead-port-target'));

    // Port 9 (discard) on loopback: nothing listens there, so npm gets an
    // immediate connection refusal with no network dependency. The retry caps
    // are test-fixture-only settings that keep the failure fast; a scaffolded
    // `.npmrc` carries none of them. The plugin name is chosen so it cannot
    // resolve from anywhere else either — if the `.npmrc` copy were forgotten,
    // this install would fail with an npmjs 404 instead, and the dead-port
    // assertion below would catch the difference.
    await fs.writeFile(
      path.join(workspaceDir, '.npmrc'),
      '@rawbox:registry=http://127.0.0.1:9\n' +
        'fetch-retries=0\n' +
        'fetch-retry-mintimeout=1\n' +
        'fetch-retry-maxtimeout=1\n',
    );

    const result = await setupNpmPackage(
      targetDir,
      { '@rawbox/rawbox-plugin-nonexistent-zz9': '^1.0.0' },
      workspaceDir,
    );

    expect(result.isErr()).toBe(true);
    const message = result.isErr() ? result.error : '';

    // Not just "the install failed" — the failure must name the dead
    // registry, proving npm actually consulted the propagated `.npmrc`.
    expect(message).toContain('npm reported:');
    expect(message).toMatch(/127\.0\.0\.1:9|ECONNREFUSED/);
  }, 120_000);
});

describe('setupNpmPackage — install failure diagnostics', () => {
  it("surfaces npm's own error instead of a bare 'Command failed'", async () => {
    const targetDir = await mkdir(uniqueDir('failing-target'));
    const workspaceDir = await mkdir(uniqueDir('failing-workspace'));

    // An invalid specifier: npm rejects it locally with EINVALIDTAGNAME, no
    // network involved, which keeps this test honest about *why* the install
    // failed rather than merely that it did. (A `file:` pointing at a missing
    // directory is not usable here — npm creates a dangling link and exits 0.)
    const result = await setupNpmPackage(
      targetDir,
      { 'missing-plugin': '@@invalid spec@@' },
      workspaceDir,
    );

    expect(result.isErr()).toBe(true);
    const message = result.isErr() ? result.error : '';

    // The regression this guards: the install ran with stdio 'ignore', so the
    // only thing a caller ever saw was "Command failed: npm install" — naming no
    // cause, no package, and no next step. npm's stderr is the sole explanation
    // of an install failure, so it must reach the caller.
    expect(message).toContain('npm reported:');
    expect(message).toContain('EINVALIDTAGNAME');
    expect(message).toContain(targetDir);
    expect(message.length).toBeGreaterThan(
      'Failed to setup target npm package directory: Command failed: npm install'.length,
    );
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Document validation on the setup path
// pins FORMAT.md, "Validation"
//
// `workspace setup` reads both documents, so it is one of the doors an
// unrecognised field has to be reported at. It used to run the bare `Workflow`
// schema, which made it the one path that could still answer a mistyped
// strategy with a union branch dump.
// ---------------------------------------------------------------------------

describe('loadAndValidateWorkspace / loadAndValidateWorkflows', () => {
  async function writeWorkspace(document: unknown): Promise<string> {
    const workspaceDir = await mkdir(uniqueDir('strict-workspace'));
    const workspacePath = path.join(workspaceDir, 'workspace.json');
    await fs.writeFile(workspacePath, JSON.stringify(document, null, 2));
    return workspacePath;
  }

  it('rejects an unknown field on the workspace document, naming it', async () => {
    const workspacePath = await writeWorkspace({
      kind: 'Workspace',
      name: 'strict',
      workflowPathList: [],
      metadata: { owner: 'someone' },
    });

    const result = await loadAndValidateWorkspace(workspacePath);

    expect(result.isErr()).toBe(true);
    expect(result.isErr() ? result.error : '').toContain(
      'must not have additional properties: "metadata"',
    );
  });

  it('accepts the same document without it', async () => {
    const workspacePath = await writeWorkspace({
      kind: 'Workspace',
      name: 'strict',
      workflowPathList: [],
    });

    expect((await loadAndValidateWorkspace(workspacePath)).isOk()).toBe(true);
  });

  it('gives a workflow the full diagnostic, not the bare schema error', async () => {
    const workspaceDir = await mkdir(uniqueDir('strict-workflow'));
    const workflowPath = path.join(workspaceDir, 'a.workflow.json');
    await fs.writeFile(
      workflowPath,
      JSON.stringify({
        kind: 'Workflow',
        formatVersion: '1.0',
        name: 'strict',
        plugins: {},
        storage: {
          defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900, queueSizeMax: 4 },
        },
        steps: [],
      }),
    );

    const workspacePath = path.join(workspaceDir, 'workspace.json');
    await fs.writeFile(
      workspacePath,
      JSON.stringify({
        kind: 'Workspace',
        name: 'strict',
        workflowPathList: ['./a.workflow.json'],
      }),
    );

    const workspaceResult = await loadAndValidateWorkspace(workspacePath);
    expect(workspaceResult.isOk()).toBe(true);

    const result = await loadAndValidateWorkflows(
      workspacePath,
      workspaceResult._unsafeUnwrap(),
    );

    expect(result.isErr()).toBe(true);
    const message = result.isErr() ? result.error : '';
    expect(message).toContain('Did you mean name: lmdb-fifo?');
    expect(message).not.toContain('anyOf');
  });
});
