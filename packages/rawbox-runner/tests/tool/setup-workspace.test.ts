import { describe, it, expect, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadAndValidateWorkflows,
  loadAndValidateWorkspace,
  resolveWorkspaceTargetFolder,
  setupDependencyEnv,
  setupWorkspace,
} from '../../src/tool/setup-workspace.js';
import {
  DEPENDENCY_ENV_READY_FILENAME,
  DEPENDENCY_ENV_SETUP_LOCK_FILENAME,
  dependencyEnvHash,
  resolveDependencyEnvDir,
} from '../../src/workflow/dependency-env.js';

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

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

/** Writes a minimal, installable local plugin package.json into `dir`. */
async function writeFakePlugin(
  dir: string,
  name = 'fake-plugin-package',
  version = '1.0.0',
  extra: Record<string, unknown> = {},
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version, ...extra }, null, 2),
  );
}

/** Writes a fake package into a fresh directory and `npm pack`s it, returning the tarball path. */
async function packFakePackage(
  label: string,
  name: string,
  version: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const dir = await mkdir(uniqueDir(label));
  await writeFakePlugin(dir, name, version, extra);
  const tarballName = execSync('npm pack --quiet', { cwd: dir, encoding: 'utf-8' })
    .trim()
    .split(/\r?\n/)
    .pop()!;
  return path.join(dir, tarballName);
}

/** Resolves what `node_modules/<key>` points at after an npm install, or `undefined` if absent. */
async function realpathOfInstalled(rootDir: string, key: string): Promise<string | undefined> {
  try {
    return await fs.realpath(path.join(rootDir, 'node_modules', key));
  } catch {
    return undefined;
  }
}

/** `version` of the package installed at `<rootDir>/node_modules/<key>`. */
async function installedVersion(rootDir: string, key: string): Promise<string | undefined> {
  return fs
    .readFile(path.join(rootDir, 'node_modules', ...key.split('/'), 'package.json'), 'utf-8')
    .then((content) => (JSON.parse(content) as { version?: string }).version)
    .catch(() => undefined);
}

/** The env `setupDependencyEnv` installs `dependencies` into. */
function envDirOf(
  targetDir: string,
  dependencies: Record<string, string>,
  workspaceDir: string,
): string {
  return resolveDependencyEnvDir(targetDir, dependencies, workspaceDir) as string;
}

/**
 * Writes `<workspaceDir>/workspace.json` plus one workflow per entry of
 * `workflows` under `<workspaceDir>/workflows/`, returning the workspace path.
 */
async function writeWorkspace(
  workspaceDir: string,
  workflows: Record<string, Record<string, string>>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const workflowsDir = await mkdir(path.join(workspaceDir, 'workflows'));
  const workflowPathList: string[] = [];

  for (const [name, dependencies] of Object.entries(workflows)) {
    await fs.writeFile(
      path.join(workflowsDir, `${name}.workflow.json`),
      JSON.stringify(
        {
          kind: 'Workflow',
          formatVersion: '1.0',
          name,
          dependencies,
          storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
          steps: [],
        },
        null,
        2,
      ),
    );
    workflowPathList.push(`./workflows/${name}.workflow.json`);
  }

  const workspacePath = path.join(workspaceDir, 'workspace.json');
  await fs.writeFile(
    workspacePath,
    JSON.stringify(
      { kind: 'Workspace', name: path.basename(workspaceDir), workflowPathList, ...extra },
      null,
      2,
    ),
  );
  return workspacePath;
}

afterAll(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
});

describe('setupDependencyEnv', () => {
  it('creates nothing and runs no install for an empty dependency set', async () => {
    const targetDir = await mkdir(uniqueDir('empty-target'));
    const workspaceDir = await mkdir(uniqueDir('empty-workspace'));

    const result = await setupDependencyEnv(targetDir, {}, workspaceDir);
    expect(result._unsafeUnwrap()).toBeUndefined();

    expect(await fs.readdir(targetDir)).toEqual([]);
  });

  it(
    'passes a non-file: specifier through unchanged and installs it via npm into its own env',
    async () => {
      const targetDir = await mkdir(uniqueDir('tarball-target'));
      const workspaceDir = await mkdir(uniqueDir('tarball-workspace'));

      // Pack a minimal `@rawbox/rawbox-plugin-default@0.1.0` tarball locally so
      // `npm install` exercises a real non-`file:` specifier offline without
      // requiring an external Verdaccio container.
      const tarballPath = await packFakePackage('tarball-plugin', '@rawbox/rawbox-plugin-default', '0.1.0');

      const dependencies = { '@rawbox/rawbox-plugin-default': tarballPath };
      const result = await setupDependencyEnv(targetDir, dependencies, workspaceDir);
      expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

      const envDir = envDirOf(targetDir, dependencies, workspaceDir);
      expect(result._unsafeUnwrap()).toBe(envDir);

      const pkg = JSON.parse(await fs.readFile(path.join(envDir, 'package.json'), 'utf-8'));
      expect(pkg).toEqual({
        name: `rawbox-env-${path.basename(envDir)}`,
        version: '1.0.0',
        type: 'module',
        private: true,
        // A non-`file:` specifier is spliced verbatim into `dependencies`.
        dependencies,
      });

      expect(await installedVersion(envDir, '@rawbox/rawbox-plugin-default')).toBe('0.1.0');
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
    const dependencies = { 'local-plugin': `file:${relativeSpecPath}` };

    const result = await setupDependencyEnv(targetDir, dependencies, workspaceDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    const envDir = result._unsafeUnwrap() as string;

    const pkg = JSON.parse(await fs.readFile(path.join(envDir, 'package.json'), 'utf-8'));
    // The written package.json must carry the *absolute* rewrite, resolved
    // against workspaceDir (where the workflow declaring it lives) — not
    // the env (where npm would otherwise resolve a relative file: spec).
    expect(pkg.dependencies['local-plugin']).toBe(`file:${pluginDir}`);

    // Prove the rewrite was also functionally correct: npm actually linked it.
    expect(await realpathOfInstalled(envDir, 'local-plugin')).toBe(await fs.realpath(pluginDir));
  });

  it('passes an absolute file: specifier through unchanged', async () => {
    // Use a workspaceDir unrelated to the plugin location, to prove an
    // absolute specifier is never re-resolved against it.
    const workspaceDir = await mkdir(uniqueDir('abs-workspace'));
    const targetDir = await mkdir(uniqueDir('abs-target'));

    const pluginDir = await mkdir(uniqueDir('abs-plugin'));
    await writeFakePlugin(pluginDir, 'local-plugin-abs');

    const absoluteSpec = `file:${pluginDir}`;
    const result = await setupDependencyEnv(targetDir, { 'local-plugin-abs': absoluteSpec }, workspaceDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    const envDir = result._unsafeUnwrap() as string;

    const pkg = JSON.parse(await fs.readFile(path.join(envDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies['local-plugin-abs']).toBe(absoluteSpec);
    expect(await realpathOfInstalled(envDir, 'local-plugin-abs')).toBe(await fs.realpath(pluginDir));
  });

  it('symlinks a file: plugin by default, keeping the local dev loop live', async () => {
    const workspaceDir = await mkdir(uniqueDir('link-workspace'));
    const targetDir = await mkdir(uniqueDir('link-target'));
    const pluginDir = await mkdir(uniqueDir('link-plugin'));
    await writeFakePlugin(pluginDir, 'link-plugin');

    const result = await setupDependencyEnv(
      targetDir,
      { 'link-plugin': `file:${pluginDir}` },
      workspaceDir,
    );
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    // A symlink, not a copy: editing and rebuilding the plugin is picked up by
    // the next run with no second `workspace setup`. That is why linking is the
    // default even though it leaves the env non-portable.
    const installed = path.join(result._unsafeUnwrap() as string, 'node_modules', 'link-plugin');
    expect((await fs.lstat(installed)).isSymbolicLink()).toBe(true);
  }, 60_000);

  it('copies a file: plugin under --install-links, making the env portable', async () => {
    const workspaceDir = await mkdir(uniqueDir('copy-workspace'));
    const targetDir = await mkdir(uniqueDir('copy-target'));
    const pluginDir = await mkdir(uniqueDir('copy-plugin'));
    await writeFakePlugin(pluginDir, 'copy-plugin');

    const result = await setupDependencyEnv(
      targetDir,
      { 'copy-plugin': `file:${pluginDir}` },
      workspaceDir,
      { installLinks: true },
    );
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    // The opposite trade: a real directory in the env, so the folder can be
    // moved to a machine that never installed the plugin — at the cost of being
    // a snapshot of the plugin as it was at setup time.
    const installed = path.join(result._unsafeUnwrap() as string, 'node_modules', 'copy-plugin');
    expect((await fs.lstat(installed)).isSymbolicLink()).toBe(false);
    expect(await fs.realpath(installed)).not.toBe(await fs.realpath(pluginDir));
  }, 60_000);

  it('never creates or modifies `<targetFolder>/package.json`', async () => {
    // A declared `targetFolder:` can point at a directory an author already
    // made an npm package of; only the env directory below it is rawbox's.
    const workspaceDir = await mkdir(uniqueDir('untouched-manifest-workspace'));
    const pluginDir = await mkdir(uniqueDir('untouched-manifest-plugin'));
    await writeFakePlugin(pluginDir, 'untouched-plugin');
    const dependencies = { 'untouched-plugin': `file:${pluginDir}` };

    // Absent before: still absent after.
    const bareTarget = await mkdir(uniqueDir('untouched-manifest-bare'));
    expect((await setupDependencyEnv(bareTarget, dependencies, workspaceDir)).isOk()).toBe(true);
    expect(await exists(path.join(bareTarget, 'package.json'))).toBe(false);

    // Present before, with user content: byte-identical after.
    const authoredTarget = await mkdir(uniqueDir('untouched-manifest-authored'));
    const authored = `${JSON.stringify(
      {
        name: 'authored-by-hand',
        version: '4.2.0',
        scripts: { test: 'vitest run' },
        dependencies: { 'kept-dependency': '^1.0.0' },
      },
      null,
      4,
    )}\n`;
    await fs.writeFile(path.join(authoredTarget, 'package.json'), authored);

    const result = await setupDependencyEnv(authoredTarget, dependencies, workspaceDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    expect(await fs.readFile(path.join(authoredTarget, 'package.json'), 'utf-8')).toBe(authored);
    expect(await exists(path.join(authoredTarget, 'node_modules'))).toBe(false);
  }, 60_000);

  it('writes the ready marker only after a successful install, and removes a stale one first', async () => {
    const workspaceDir = await mkdir(uniqueDir('ready-workspace'));
    const targetDir = await mkdir(uniqueDir('ready-target'));
    const pluginDir = await mkdir(uniqueDir('ready-plugin'));
    await writeFakePlugin(pluginDir, 'ready-plugin');

    const dependencies = { 'ready-plugin': `file:${pluginDir}` };
    const envDir = (await setupDependencyEnv(targetDir, dependencies, workspaceDir))._unsafeUnwrap() as string;
    const marker = JSON.parse(
      await fs.readFile(path.join(envDir, DEPENDENCY_ENV_READY_FILENAME), 'utf-8'),
    );
    expect(marker).toMatchObject({
      hash: path.basename(envDir),
      dependencies,
      installLinks: false,
    });
    expect(typeof marker.installedAt).toBe('string');

    // A failing install into an env that already carries a marker (planted
    // here at the failing set's own env) must not leave the marker behind.
    const failing = { 'missing-plugin': '@@invalid spec@@' };
    const failingEnvDir = envDirOf(targetDir, failing, workspaceDir);
    await mkdir(failingEnvDir);
    await fs.writeFile(path.join(failingEnvDir, DEPENDENCY_ENV_READY_FILENAME), '{}');

    const failed = await setupDependencyEnv(targetDir, failing, workspaceDir);
    expect(failed.isErr()).toBe(true);
    expect(await exists(path.join(failingEnvDir, DEPENDENCY_ENV_READY_FILENAME))).toBe(false);
  }, 120_000);
});

describe('setupWorkspace', () => {
  it('installs workflows declaring different packages into one env each', async () => {
    const workspaceDir = await mkdir(uniqueDir('split-workspace'));
    const targetDir = await mkdir(uniqueDir('split-target'));

    const pluginADir = await mkdir(uniqueDir('split-plugin-a'));
    await writeFakePlugin(pluginADir, 'plugin-a');
    const pluginBDir = await mkdir(uniqueDir('split-plugin-b'));
    await writeFakePlugin(pluginBDir, 'plugin-b');

    const depsA = { 'plugin-a': `file:${path.relative(workspaceDir, pluginADir)}` };
    const depsB = { 'plugin-b': `file:${path.relative(workspaceDir, pluginBDir)}` };
    const workspacePath = await writeWorkspace(workspaceDir, { 'workflow-a': depsA, 'workflow-b': depsB });

    const result = await setupWorkspace(workspacePath, targetDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    const { envs, targetFolder } = result._unsafeUnwrap();

    expect(targetFolder).toBe(path.resolve(targetDir));
    expect(envs.map((env) => env.envDir)).toEqual([
      envDirOf(targetDir, depsA, workspaceDir),
      envDirOf(targetDir, depsB, workspaceDir),
    ]);
    expect(envs.map((env) => env.workflowPathList)).toEqual([
      ['./workflows/workflow-a.workflow.json'],
      ['./workflows/workflow-b.workflow.json'],
    ]);

    // Each env holds its own set and nothing else.
    expect(await realpathOfInstalled(envs[0]!.envDir, 'plugin-a')).toBe(await fs.realpath(pluginADir));
    expect(await realpathOfInstalled(envs[0]!.envDir, 'plugin-b')).toBeUndefined();
    expect(await realpathOfInstalled(envs[1]!.envDir, 'plugin-b')).toBe(await fs.realpath(pluginBDir));
  }, 60_000);

  it('installs two specifiers of one package side by side, each at its own version', async () => {
    // The case that used to be a hard "conflicting specifiers" error: two
    // workflows pinning different versions of the same package.
    const workspaceDir = await mkdir(uniqueDir('two-versions-workspace'));
    const targetDir = await mkdir(uniqueDir('two-versions-target'));

    const v1Dir = await mkdir(path.join(workspaceDir, 'plugins', 'v1'));
    await writeFakePlugin(v1Dir, 'shared-plugin', '1.0.0');
    const v2Dir = await mkdir(path.join(workspaceDir, 'plugins', 'v2'));
    await writeFakePlugin(v2Dir, 'shared-plugin', '2.0.0');

    const workspacePath = await writeWorkspace(workspaceDir, {
      'workflow-a': { 'shared-plugin': 'file:./plugins/v1' },
      'workflow-b': { 'shared-plugin': 'file:./plugins/v2' },
    });

    const result = await setupWorkspace(workspacePath, targetDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    const { envs } = result._unsafeUnwrap();

    expect(envs).toHaveLength(2);
    expect(envs[0]!.hash).not.toBe(envs[1]!.hash);
    expect(await installedVersion(envs[0]!.envDir, 'shared-plugin')).toBe('1.0.0');
    expect(await installedVersion(envs[1]!.envDir, 'shared-plugin')).toBe('2.0.0');
  }, 60_000);

  it('installs once when two workflows declare an identical dependency map', async () => {
    const workspaceDir = await mkdir(uniqueDir('identical-spec-workspace'));
    const targetDir = await mkdir(uniqueDir('identical-spec-target'));

    const pluginDir = await mkdir(uniqueDir('identical-spec-plugin'));
    await writeFakePlugin(pluginDir, 'shared-plugin');
    const relPlugin = path.relative(workspaceDir, pluginDir);

    // Equivalent spellings of one path normalize to one set, hence one env.
    const workspacePath = await writeWorkspace(workspaceDir, {
      'workflow-a': { 'shared-plugin': `file:${relPlugin}` },
      'workflow-b': { 'shared-plugin': `file:./${relPlugin}/` },
    });

    const result = await setupWorkspace(workspacePath, targetDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    const { envs } = result._unsafeUnwrap();

    expect(envs).toHaveLength(1);
    expect(envs[0]!.workflowPathList).toEqual([
      './workflows/workflow-a.workflow.json',
      './workflows/workflow-b.workflow.json',
    ]);
    expect(await fs.readdir(path.join(targetDir, 'envs'))).toEqual([envs[0]!.hash]);
    expect(await realpathOfInstalled(envs[0]!.envDir, 'shared-plugin')).toBe(await fs.realpath(pluginDir));
  }, 60_000);

  it('creates no env for a workflow with empty dependencies', async () => {
    const workspaceDir = await mkdir(uniqueDir('no-deps-workspace'));
    const targetDir = await mkdir(uniqueDir('no-deps-target'));
    const workspacePath = await writeWorkspace(workspaceDir, { 'workflow-empty': {} });

    const result = await setupWorkspace(workspacePath, targetDir);
    expect(result._unsafeUnwrap().envs).toEqual([]);
    expect(await exists(path.join(targetDir, 'envs'))).toBe(false);
    expect(await exists(path.join(targetDir, 'package.json'))).toBe(false);
  });

  it('installs into `<workspace directory>/.rawbox/envs/` when no target folder is given anywhere', async () => {
    // The default that makes `workspace setup` and `workflow run` agree with no
    // configuration at all: the runner already resolves plugins from
    // `resolveTargetFolder`'s default, `.rawbox` under the workspace directory.
    const workspaceDir = await mkdir(uniqueDir('default-target-workspace'));
    const pluginDir = await mkdir(uniqueDir('default-target-plugin'));
    await writeFakePlugin(pluginDir, 'default-target-plugin');

    const dependencies = { 'default-target-plugin': `file:${pluginDir}` };
    const workspacePath = await writeWorkspace(workspaceDir, { 'workflow-a': dependencies });

    const result = await setupWorkspace(workspacePath);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    const expectedTargetFolder = path.join(workspaceDir, '.rawbox');
    expect(result._unsafeUnwrap().targetFolder).toBe(path.resolve(expectedTargetFolder));

    const envDir = envDirOf(expectedTargetFolder, dependencies, workspaceDir);
    expect(await realpathOfInstalled(envDir, 'default-target-plugin')).toBe(await fs.realpath(pluginDir));
  }, 60_000);

  it('honours `targetFolder:` from the workspace document, relative to it', async () => {
    const workspaceDir = await mkdir(uniqueDir('declared-target-workspace'));
    const pluginDir = await mkdir(uniqueDir('declared-target-plugin'));
    await writeFakePlugin(pluginDir, 'declared-target-plugin');

    const workspacePath = await writeWorkspace(
      workspaceDir,
      { 'workflow-a': { 'declared-target-plugin': `file:${pluginDir}` } },
      { targetFolder: './run-target' },
    );

    const result = await setupWorkspace(workspacePath);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    expect(result._unsafeUnwrap().targetFolder).toBe(path.join(workspaceDir, 'run-target'));

    // An explicit argument still wins over the declaration.
    const overrideDir = uniqueDir('declared-target-override');
    const override = await setupWorkspace(workspacePath, overrideDir);
    expect(override.isOk(), override.isErr() ? override.error : '').toBe(true);
    expect(override._unsafeUnwrap().targetFolder).toBe(path.resolve(overrideDir));
  }, 60_000);

  it('reports a failed install by env hash and the workflows using it, after attempting every env', async () => {
    const workspaceDir = await mkdir(uniqueDir('failing-env-workspace'));
    const targetDir = await mkdir(uniqueDir('failing-env-target'));
    const pluginDir = await mkdir(uniqueDir('failing-env-plugin'));
    await writeFakePlugin(pluginDir, 'good-plugin');

    const good = { 'good-plugin': `file:${pluginDir}` };
    const broken = { 'missing-plugin': '@@invalid spec@@' };
    const workspacePath = await writeWorkspace(workspaceDir, {
      'workflow-good': good,
      'workflow-broken': broken,
      'workflow-broken-too': broken,
    });

    const result = await setupWorkspace(workspacePath, targetDir);
    const message = result._unsafeUnwrapErr();

    expect(message).toContain(`Env ${dependencyEnvHash(broken, workspaceDir)}`);
    expect(message).toContain(
      'used by ./workflows/workflow-broken.workflow.json, ./workflows/workflow-broken-too.workflow.json',
    );
    expect(message).toContain('EINVALIDTAGNAME');
    expect(message).not.toContain(dependencyEnvHash(good, workspaceDir));

    // The healthy env was still installed: one bad declaration does not
    // stop the rest of the workspace from being set up.
    expect(
      await realpathOfInstalled(envDirOf(targetDir, good, workspaceDir), 'good-plugin'),
    ).toBe(await fs.realpath(pluginDir));
  }, 120_000);

  it('runs every install through `withEnvLock`, bounded by `concurrency`', async () => {
    const workspaceDir = await mkdir(uniqueDir('with-lock-workspace'));
    const targetDir = await mkdir(uniqueDir('with-lock-target'));
    const pluginADir = await mkdir(uniqueDir('with-lock-plugin-a'));
    await writeFakePlugin(pluginADir, 'lock-plugin-a');
    const pluginBDir = await mkdir(uniqueDir('with-lock-plugin-b'));
    await writeFakePlugin(pluginBDir, 'lock-plugin-b');

    const workspacePath = await writeWorkspace(workspaceDir, {
      'workflow-a': { 'lock-plugin-a': `file:${pluginADir}` },
      'workflow-b': { 'lock-plugin-b': `file:${pluginBDir}` },
    });

    const lockedEnvDirs: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const result = await setupWorkspace(workspacePath, targetDir, {
      concurrency: 1,
      withEnvLock: async <T>(envDir: string, fn: () => Promise<T>): Promise<T> => {
        lockedEnvDirs.push(envDir);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          return await fn();
        } finally {
          inFlight -= 1;
        }
      },
    });

    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    expect(lockedEnvDirs).toEqual(result._unsafeUnwrap().envs.map((env) => env.envDir));
    expect(maxInFlight).toBe(1);
  }, 60_000);
});

describe('setupWorkspace — pruning unreferenced envs', () => {
  const STALE = 'aaaaaaaaaaaaaaaa';
  const LOCKED = 'bbbbbbbbbbbbbbbb';

  async function workspaceWithStaleEnvs(label: string) {
    const workspaceDir = await mkdir(uniqueDir(`${label}-workspace`));
    const targetDir = await mkdir(uniqueDir(`${label}-target`));
    const pluginDir = await mkdir(uniqueDir(`${label}-plugin`));
    await writeFakePlugin(pluginDir, 'prune-plugin');
    const workspacePath = await writeWorkspace(workspaceDir, {
      'workflow-a': { 'prune-plugin': `file:${pluginDir}` },
    });

    const envsDir = path.join(targetDir, 'envs');
    await mkdir(path.join(envsDir, STALE, 'node_modules'));
    await mkdir(path.join(envsDir, LOCKED));
    await fs.writeFile(path.join(envsDir, LOCKED, DEPENDENCY_ENV_SETUP_LOCK_FILENAME), '{}');
    await mkdir(path.join(envsDir, 'not-an-env'));
    await fs.writeFile(path.join(envsDir, 'cccccccccccccccc'), 'a file, not an env');

    return { workspacePath, targetDir, envsDir };
  }

  it('removes unreferenced hash dirs, skipping locked ones and leaving other entries alone', async () => {
    const { workspacePath, targetDir, envsDir } = await workspaceWithStaleEnvs('prune');

    const result = await setupWorkspace(workspacePath, targetDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    const { envs, prunedEnvs } = result._unsafeUnwrap();

    expect(prunedEnvs).toEqual([path.join(envsDir, STALE)]);
    expect((await fs.readdir(envsDir)).sort()).toEqual(
      [envs[0]!.hash, LOCKED, 'cccccccccccccccc', 'not-an-env'].sort(),
    );
  }, 60_000);

  it('keeps every env with `pruneStaleEnvs: false`', async () => {
    const { workspacePath, targetDir, envsDir } = await workspaceWithStaleEnvs('no-prune');

    const result = await setupWorkspace(workspacePath, targetDir, { pruneStaleEnvs: false });
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    expect(result._unsafeUnwrap().prunedEnvs).toEqual([]);
    expect(await exists(path.join(envsDir, STALE))).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Peer-dependency isolation
//
// Two plugins requiring incompatible versions of one peer cannot share a
// `node_modules`. The packages are packed tarballs rather than `file:`
// directories because npm only *links* a directory and never reads its
// peers, which would make the conflict invisible; a tarball is installed for
// real, peers included, and still needs no registry.
// ---------------------------------------------------------------------------

describe('setupWorkspace — peer-dependency isolation', () => {
  it('installs plugins with conflicting peers cleanly into separate envs', async () => {
    const workspaceDir = await mkdir(uniqueDir('peer-workspace'));
    const targetDir = await mkdir(uniqueDir('peer-target'));

    const peerV1 = await packFakePackage('peer-v1', 'peer-lib', '1.0.0');
    const peerV2 = await packFakePackage('peer-v2', 'peer-lib', '2.0.0');
    const pluginOld = await packFakePackage('plugin-old', 'plugin-old', '1.0.0', {
      peerDependencies: { 'peer-lib': '^1.0.0' },
    });
    const pluginNew = await packFakePackage('plugin-new', 'plugin-new', '1.0.0', {
      peerDependencies: { 'peer-lib': '^2.0.0' },
    });

    // Sanity: the two really do conflict in one install, so the split below
    // is what makes them work rather than the fixture being lenient.
    const shared = await setupDependencyEnv(
      targetDir,
      { 'plugin-old': pluginOld, 'plugin-new': pluginNew, 'peer-lib': peerV2 },
      workspaceDir,
    );
    expect(shared._unsafeUnwrapErr()).toContain('ERESOLVE');

    const workspacePath = await writeWorkspace(workspaceDir, {
      'workflow-old': { 'plugin-old': pluginOld, 'peer-lib': peerV1 },
      'workflow-new': { 'plugin-new': pluginNew, 'peer-lib': peerV2 },
    });

    const result = await setupWorkspace(workspacePath, targetDir, { pruneStaleEnvs: false });
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    const [oldEnv, newEnv] = result._unsafeUnwrap().envs;

    expect(await installedVersion(oldEnv!.envDir, 'plugin-old')).toBe('1.0.0');
    expect(await installedVersion(oldEnv!.envDir, 'peer-lib')).toBe('1.0.0');
    expect(await installedVersion(newEnv!.envDir, 'plugin-new')).toBe('1.0.0');
    expect(await installedVersion(newEnv!.envDir, 'peer-lib')).toBe('2.0.0');
  }, 120_000);
});

describe('setupDependencyEnv — workspace .npmrc propagation', () => {
  const dependencies = { 'npmrc-plugin': '^1.0.0' };

  it('copies the workspace `.npmrc` into the env, overwriting a stale copy', async () => {
    const workspaceDir = await mkdir(uniqueDir('npmrc-workspace'));
    const targetDir = await mkdir(uniqueDir('npmrc-target'));

    // The workspace's file is authoritative and must arrive byte-for-byte —
    // comment line included — over whatever an earlier setup left behind.
    // Every install below fails offline (the scoped registry is a dead port),
    // which is irrelevant here: the copy happens before npm runs.
    const npmrc =
      '# scaffolded by --registry; scoped, so third-party packages still come from npmjs\n' +
      '@rawbox:registry=http://127.0.0.1:9\n' +
      'registry=http://127.0.0.1:9\n' +
      'fetch-retries=0\n';
    await fs.writeFile(path.join(workspaceDir, '.npmrc'), npmrc);
    const envDir = envDirOf(targetDir, dependencies, workspaceDir);
    await mkdir(envDir);
    await fs.writeFile(path.join(envDir, '.npmrc'), '@rawbox:registry=http://stale.invalid\n');

    await setupDependencyEnv(targetDir, dependencies, workspaceDir);

    expect(await fs.readFile(path.join(envDir, '.npmrc'), 'utf-8')).toBe(npmrc);
    // Never into the target folder itself: the env is the npm project root.
    expect(await exists(path.join(targetDir, '.npmrc'))).toBe(false);
  }, 120_000);

  it('writes no env `.npmrc` when the workspace has none', async () => {
    const workspaceDir = await mkdir(uniqueDir('no-npmrc-workspace'));
    const targetDir = await mkdir(uniqueDir('no-npmrc-target'));
    const pluginDir = await mkdir(uniqueDir('no-npmrc-plugin'));
    await writeFakePlugin(pluginDir, 'no-npmrc-plugin');

    const result = await setupDependencyEnv(
      targetDir,
      { 'no-npmrc-plugin': `file:${pluginDir}` },
      workspaceDir,
    );
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    expect(await exists(path.join(result._unsafeUnwrap() as string, '.npmrc'))).toBe(false);
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

    const failing = { '@rawbox/rawbox-plugin-nonexistent-zz9': '^1.0.0' };
    const result = await setupDependencyEnv(targetDir, failing, workspaceDir);

    expect(result.isErr()).toBe(true);
    const envDir = envDirOf(targetDir, failing, workspaceDir);
    const pkg = JSON.parse(await fs.readFile(path.join(envDir, 'package.json'), 'utf-8'));
    expect(pkg.dependencies).toEqual(failing);
    const message = result.isErr() ? result.error : '';

    // Not just "the install failed" — the failure must name the dead
    // registry, proving npm actually consulted the propagated `.npmrc`.
    expect(message).toContain('npm reported:');
    expect(message).toMatch(/127\.0\.0\.1:9|ECONNREFUSED/);
  }, 120_000);
});

describe('setupDependencyEnv — install failure diagnostics', () => {
  it("surfaces npm's own error instead of a bare 'Command failed'", async () => {
    const targetDir = await mkdir(uniqueDir('failing-target'));
    const workspaceDir = await mkdir(uniqueDir('failing-workspace'));

    // An invalid specifier: npm rejects it locally with EINVALIDTAGNAME, no
    // network involved, which keeps this test honest about *why* the install
    // failed rather than merely that it did. (A `file:` pointing at a missing
    // directory is not usable here — npm creates a dangling link and exits 0.)
    const result = await setupDependencyEnv(
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
        dependencies: {},
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

// ---------------------------------------------------------------------------
// The target-folder fallback is named, never silent
//
// A document that cannot be loaded resolves to the workspace directory, which
// is the right answer for a path lookup that must not fail — but a workspace
// declaring `targetFolder:` with one schema error would then resolve plugins
// and state from a place its author never wrote. `fallbackReason` is what
// lets a caller say so.
// ---------------------------------------------------------------------------

describe('resolveWorkspaceTargetFolder', () => {
  it('applies a declared targetFolder with no fallback reason', async () => {
    const dir = await mkdir(uniqueDir('target-declared'));
    const workspacePath = path.join(dir, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      ['kind: Workspace', 'name: declared', 'targetFolder: custom-target', 'workflowPathList: []', ''].join('\n'),
    );

    const resolved = await resolveWorkspaceTargetFolder(workspacePath);

    expect(resolved.targetFolder).toBe(path.join(dir, 'custom-target'));
    expect(resolved.fallbackReason).toBeUndefined();
  });

  it('falls back to the workspace directory and says why when the document cannot be loaded', async () => {
    const dir = await mkdir(uniqueDir('target-fallback'));
    const workspacePath = path.join(dir, 'workspace.yaml');
    // Malformed YAML: the tab is the mistake an author actually makes.
    await fs.writeFile(workspacePath, 'kind: Workspace\n\tname: broken\ntargetFolder: custom-target\n');

    const resolved = await resolveWorkspaceTargetFolder(workspacePath);

    expect(resolved.targetFolder).toBe(dir);
    expect(resolved.fallbackReason).toBeDefined();
    expect(resolved.fallbackReason).toContain(workspacePath);
  });
});
