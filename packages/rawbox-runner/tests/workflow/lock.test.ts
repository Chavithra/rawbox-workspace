import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';
import { ContractRegistryCache } from '@rawbox/plugin/core';

import {
  lockWorkspacePlugins,
  rawboxLockPath,
  readRawboxLock,
  resolvePluginLockEntries,
  toRegistryHashByPlugin,
  verifyRawboxLock,
  writeRawboxLock,
} from '../../src/workflow/lock.js';
import {
  RAWBOX_LOCK_FILENAME,
  RAWBOX_LOCK_VERSION,
  type RawboxLock,
} from '../../src/workflow/lock-types.js';
import { resolveDependencyEnvDir } from '../../src/workflow/dependency-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Scratch space inside the repo, following the convention in
// `setup-workspace.test.ts` — each run gets its own subdirectory, removed in
// `afterAll`.
const sandboxRoot = path.join(
  __dirname,
  'sandbox',
  `lock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
);

const CLI_ENTRY = path.resolve(__dirname, '..', '..', '..', 'rawbox-cli', 'dist', 'index.js');

afterAll(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true }).catch(() => {});
});

// ---------------------------------------------------------------------------
// Fixtures
//
// A "plugin" here is a hand-written package directory: a `package.json` whose
// `exports` map lists `./contract-registry`, plus a plain ESM module default-
// exporting `{ contractRecord }`. Nothing more is needed — `computeHash` reads
// only `contractRecord`, and resolution reads only `exports`. Keeping the
// fixture build-free is what lets these tests run without an npm install.
// ---------------------------------------------------------------------------

interface FakePlugin {
  name: string;
  version: string;
  /** Distinguishes one registry's contents from another's, hence its hash. */
  operation: string;
}

const SLEEP_PLUGIN: FakePlugin = {
  name: '@fixture/rawbox-plugin-alpha',
  version: '1.2.3',
  operation: 'time/sleep',
};

const QUEUE_PLUGIN: FakePlugin = {
  name: '@fixture/rawbox-plugin-beta',
  version: '0.4.0',
  operation: 'queue/drain',
};

function contractRecordFor(operation: string): Record<string, unknown> {
  return {
    [`./${operation}.definition.js`]: {
      type: 'operation',
      description: `Fixture contract for ${operation}`,
      inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
      outputSchema: { type: 'object', properties: { at: { type: 'number' } } },
      errorSchema: { type: 'object', properties: { message: { type: 'string' } } },
      version: '1.0.0',
    },
  };
}

/** Installs a fake plugin into `<rootDir>/node_modules/<name>`. */
async function installFakePlugin(
  rootDir: string,
  plugin: FakePlugin,
): Promise<void> {
  const dir = path.join(rootDir, 'node_modules', ...plugin.name.split('/'));
  await fs.mkdir(dir, { recursive: true });

  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: plugin.name,
        version: plugin.version,
        type: 'module',
        keywords: ['rawbox-plugin'],
        exports: { './contract-registry': './contract-registry.js' },
      },
      null,
      2,
    ),
  );

  const record = contractRecordFor(plugin.operation);
  await fs.writeFile(
    path.join(dir, 'contract-registry.js'),
    `export default ${JSON.stringify(
      {
        contractRecord: record,
        contractRegistryPath: path.join(dir, 'contract-registry.js'),
      },
      null,
      2,
    )};\n`,
  );
}

/** The hash `resolvePluginLockEntries` must produce for a given fake plugin. */
function expectedHash(plugin: FakePlugin): string {
  return ContractRegistryCache.computeHash({
    contractRecord: contractRecordFor(plugin.operation),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function workflowYaml(name: string, plugins: readonly FakePlugin[]): string {
  const pluginLines = plugins
    .map((plugin) => `  "${plugin.name}": "^1.0.0"`)
    .join('\n');
  const step = plugins[0];
  return [
    'kind: Workflow',
    'formatVersion: "1.0"',
    `name: ${name}`,
    '',
    'dependencies:',
    pluginLines,
    '',
    'storage:',
    '  defaultStrategy:',
    '    name: lmdb-kv',
    '    valueSizeMax: 1900',
    '  keys:',
    '    sleep_ms:',
    '      seed: 500',
    '',
    'steps:',
    '  - label: only-step',
    `    plugin: "${step?.name ?? 'missing'}"`,
    `    operation: ${step?.operation ?? 'missing'}`,
    '    inputs:',
    '      ms: sleep_ms',
    '    outputs:',
    '      at: sleep_done_at',
    '    errors:',
    '      message: sleep_error',
    '',
  ].join('\n');
}

/** The `dependencies:` map {@link workflowYaml} declares for `plugins`. */
function dependenciesFor(
  plugins: readonly FakePlugin[],
  specifier = '^1.0.0',
): Record<string, string> {
  return Object.fromEntries(plugins.map((plugin) => [plugin.name, specifier]));
}

/** The env `workspace setup` would install `dependencies` into, under the default target folder. */
function envDirFor(workspaceDir: string, dependencies: Record<string, string>): string {
  return resolveDependencyEnvDir(
    path.join(workspaceDir, '.rawbox'),
    dependencies,
    workspaceDir,
  ) as string;
}

interface Fixture {
  workspaceDir: string;
  workspaceFile: string;
  workflowFile: string;
  packageNames: string[];
  dependencies: Record<string, string>;
  /** `<workspaceDir>/.rawbox/envs/<hash>`, holding the plugins' `node_modules`. */
  envDir: string;
}

let fixtureCounter = 0;

/**
 * Builds `<sandbox>/<label>/workspaces/<label>/` holding a `workspace.yaml`, a
 * `workflows/<label>.workflow.yaml`, and the workflow's env under
 * `.rawbox/envs/<hash>/node_modules` containing the given plugins — the layout
 * `workspace create` scaffolds and `workspace setup` installs.
 */
async function makeFixture(
  label: string,
  plugins: readonly FakePlugin[] = [SLEEP_PLUGIN],
): Promise<Fixture> {
  const unique = `${label}-${fixtureCounter++}`;
  const workspaceDir = path.join(sandboxRoot, unique, 'workspaces', unique);
  const workflowsDir = path.join(workspaceDir, 'workflows');
  await fs.mkdir(workflowsDir, { recursive: true });

  const workflowFile = path.join(workflowsDir, `${unique}.workflow.yaml`);
  await fs.writeFile(workflowFile, workflowYaml(unique, plugins), 'utf-8');

  const workspaceFile = path.join(workspaceDir, 'workspace.yaml');
  await fs.writeFile(
    workspaceFile,
    YAML.stringify({
      kind: 'Workspace',
      name: unique,
      workflowPathList: [`./workflows/${unique}.workflow.yaml`],
    }),
    'utf-8',
  );

  const dependencies = dependenciesFor(plugins);
  const envDir = envDirFor(workspaceDir, dependencies);
  for (const plugin of plugins) {
    await installFakePlugin(envDir, plugin);
  }

  return {
    workspaceDir,
    workspaceFile,
    workflowFile,
    packageNames: plugins.map((plugin) => plugin.name),
    dependencies,
    envDir,
  };
}

async function sha256OfFile(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function exists(filePath: string): Promise<boolean> {
  return fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

describe('resolvePluginLockEntries', () => {
  it('resolves each declared package from the workflow env', async () => {
    const fixture = await makeFixture('resolve', [SLEEP_PLUGIN, QUEUE_PLUGIN]);

    const result = await resolvePluginLockEntries(
      fixture.dependencies,
      fixture.envDir,
    );

    const entries = result._unsafeUnwrap();
    expect(entries.map((entry) => entry.name)).toEqual(fixture.packageNames);
    expect(entries[0]?.resolved).toBe(SLEEP_PLUGIN.version);
    expect(entries[0]?.registryHash).toBe(expectedHash(SLEEP_PLUGIN));
    expect(entries[1]?.resolved).toBe(QUEUE_PLUGIN.version);
    expect(entries[1]?.registryHash).toBe(expectedHash(QUEUE_PLUGIN));

    // Two plugins with different contracts must not collide.
    expect(entries[0]?.registryHash).not.toBe(entries[1]?.registryHash);
  });

  it('resolves against the workspace, not against @rawbox/runner', async () => {
    // The fixture plugin exists only in the workspace's own node_modules. A
    // bare `import('<pkg>/contract-registry')` from inside the runner would
    // resolve against the runner's dependency tree and fail here, which is the
    // bug `createRequire(workspaceDir)` exists to prevent.
    const fixture = await makeFixture('scoped-resolution');

    const fromWorkspace = await resolvePluginLockEntries(
      fixture.dependencies,
      fixture.envDir,
    );
    expect(fromWorkspace.isOk()).toBe(true);

    // The same package name resolved from a sibling directory with no
    // node_modules of its own — and no ancestor providing it — must fail.
    const strangerDir = path.join(sandboxRoot, 'stranger');
    await fs.mkdir(strangerDir, { recursive: true });
    const fromElsewhere = await resolvePluginLockEntries(
      fixture.dependencies,
      strangerDir,
    );
    expect(fromElsewhere.isErr()).toBe(true);
  });

  it('names the package and the remedy when a plugin is not installed', async () => {
    const fixture = await makeFixture('missing');

    const result = await resolvePluginLockEntries(
      { '@fixture/rawbox-plugin-absent': '^1.0.0' },
      fixture.envDir,
    );

    const message = result._unsafeUnwrapErr();
    expect(message).toContain('@fixture/rawbox-plugin-absent');
    expect(message).toContain('workspace setup');
  });

  it('populates a supplied ContractRegistryCache with what it loaded', async () => {
    const fixture = await makeFixture('cache');
    const cache = new ContractRegistryCache();

    const entries = (
      await resolvePluginLockEntries(fixture.dependencies, fixture.envDir, cache)
    )._unsafeUnwrap();

    const hash = entries[0]?.registryHash as string;
    expect(cache.getContractRegistry(hash)).toBeDefined();

    // The mapping `resolveWorkflow` takes as its third argument.
    expect(toRegistryHashByPlugin(entries)).toEqual({ [SLEEP_PLUGIN.name]: hash });
  });
});

describe('rawbox.lock round-trip', () => {
  it('writes, reads back, and verifies against what is installed', async () => {
    const fixture = await makeFixture('round-trip', [SLEEP_PLUGIN, QUEUE_PLUGIN]);

    // -- write ------------------------------------------------------------
    const locked = (
      await lockWorkspacePlugins({
        workspaceDir: fixture.workspaceDir,
        dependencies: fixture.dependencies,
      })
    )._unsafeUnwrap();

    expect(locked.lockPath).toBe(rawboxLockPath(fixture.workspaceDir));
    expect(path.basename(locked.lockPath)).toBe(RAWBOX_LOCK_FILENAME);
    expect(locked.changed.sort()).toEqual([...fixture.packageNames].sort());

    // -- read -------------------------------------------------------------
    const readBack = (await readRawboxLock(fixture.workspaceDir))._unsafeUnwrap();
    expect(readBack).toBeDefined();
    expect(readBack).toEqual(locked.lock);
    expect(readBack?.version).toBe(RAWBOX_LOCK_VERSION);
    expect(readBack?.dependencies[SLEEP_PLUGIN.name]?.['^1.0.0']).toEqual({
      resolved: SLEEP_PLUGIN.version,
      registryHash: expectedHash(SLEEP_PLUGIN),
    });

    // -- verify -----------------------------------------------------------
    const installed = toRegistryHashByPlugin(
      (
        await resolvePluginLockEntries(fixture.dependencies, fixture.envDir)
      )._unsafeUnwrap(),
    );
    expect(verifyRawboxLock(readBack, installed, fixture.dependencies).isOk()).toBe(true);
  });

  it('is written as a commented, key-sorted YAML document', async () => {
    const fixture = await makeFixture('format', [QUEUE_PLUGIN, SLEEP_PLUGIN]);

    await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      dependencies: fixture.dependencies,
    });

    const raw = await fs.readFile(rawboxLockPath(fixture.workspaceDir), 'utf-8');
    expect(raw).toContain('Do not hand-edit');

    // Sorted regardless of declaration order, so re-locking produces no diff
    // noise and "did anything change?" stays answerable.
    const keys = Object.keys(YAML.parse(raw).dependencies);
    expect(keys).toEqual([...keys].sort());
  });

  it('re-locking an unchanged workspace is byte-for-byte idempotent', async () => {
    const fixture = await makeFixture('idempotent');
    const lockPath = rawboxLockPath(fixture.workspaceDir);

    await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      dependencies: fixture.dependencies,
    });
    const first = await sha256OfFile(lockPath);

    const second = await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      dependencies: fixture.dependencies,
    });

    expect(await sha256OfFile(lockPath)).toBe(first);
    expect(second._unsafeUnwrap().changed).toEqual([]);
  });

  it('merges into the existing lock instead of replacing it', async () => {
    // The lock is keyed at the *workspace* level but the command takes
    // one workflow, so locking a workflow must never unlock its siblings.
    const fixture = await makeFixture('merge', [SLEEP_PLUGIN, QUEUE_PLUGIN]);

    // Each one-package set is its own env, installed separately.
    for (const plugin of [QUEUE_PLUGIN, SLEEP_PLUGIN]) {
      await installFakePlugin(envDirFor(fixture.workspaceDir, dependenciesFor([plugin])), plugin);
    }

    await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      dependencies: dependenciesFor([QUEUE_PLUGIN]),
    });
    await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      dependencies: dependenciesFor([SLEEP_PLUGIN]),
    });

    const lock = (await readRawboxLock(fixture.workspaceDir))._unsafeUnwrap();
    expect(Object.keys(lock?.dependencies ?? {}).sort()).toEqual(
      [SLEEP_PLUGIN.name, QUEUE_PLUGIN.name].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Version 2: one entry per (package, canonical specifier)
//
// Two workflows of one workspace may pin different versions of one package,
// each installed into its own env. A lock keyed by name alone could describe
// only one of them, so the second level is the specifier.
// ---------------------------------------------------------------------------

describe('rawbox.lock version 2', () => {
  const SLEEP_V2: FakePlugin = { ...SLEEP_PLUGIN, version: '2.0.0', operation: 'time/sleep-v2' };

  /** Locks `plugin` at `specifier`, having installed it into that set's env. */
  async function lockAt(fixture: Fixture, plugin: FakePlugin, specifier: string) {
    const dependencies = dependenciesFor([plugin], specifier);
    await installFakePlugin(envDirFor(fixture.workspaceDir, dependencies), plugin);
    return (
      await lockWorkspacePlugins({ workspaceDir: fixture.workspaceDir, dependencies })
    )._unsafeUnwrap();
  }

  it('keeps one entry per specifier when two sets pin one package differently', async () => {
    const fixture = await makeFixture('two-specifiers');

    const first = await lockAt(fixture, SLEEP_PLUGIN, '^1.0.0');
    const second = await lockAt(fixture, SLEEP_V2, '^2.0.0');
    expect(first.envDir).not.toBe(second.envDir);
    expect(second.entries[0]?.specifier).toBe('^2.0.0');

    const lock = (await readRawboxLock(fixture.workspaceDir))._unsafeUnwrap();
    expect(lock?.version).toBe('2');
    expect(lock?.dependencies[SLEEP_PLUGIN.name]).toEqual({
      '^1.0.0': { resolved: SLEEP_PLUGIN.version, registryHash: expectedHash(SLEEP_PLUGIN) },
      '^2.0.0': { resolved: SLEEP_V2.version, registryHash: expectedHash(SLEEP_V2) },
    });
  });

  it('re-locking one specifier leaves sibling specifiers and packages untouched', async () => {
    const fixture = await makeFixture('sibling-entries');
    const sibling = { resolved: '9.9.9', registryHash: 'sibling-hash' };
    await writeRawboxLock(fixture.workspaceDir, {
      version: RAWBOX_LOCK_VERSION,
      dependencies: {
        [SLEEP_PLUGIN.name]: { '^0.1.0': sibling },
        [QUEUE_PLUGIN.name]: { '^0.4.0': sibling },
      },
    });

    const result = await lockAt(fixture, SLEEP_PLUGIN, '^1.0.0');
    expect(result.changed).toEqual([SLEEP_PLUGIN.name]);

    const lock = (await readRawboxLock(fixture.workspaceDir))._unsafeUnwrap();
    expect(lock?.dependencies[SLEEP_PLUGIN.name]?.['^0.1.0']).toEqual(sibling);
    expect(lock?.dependencies[SLEEP_PLUGIN.name]?.['^1.0.0']?.registryHash).toBe(
      expectedHash(SLEEP_PLUGIN),
    );
    expect(lock?.dependencies[QUEUE_PLUGIN.name]).toEqual({ '^0.4.0': sibling });
  });

  it('sorts package names, then specifiers, so the file is byte-stable', async () => {
    const fixture = await makeFixture('sorted');
    const entry = { resolved: '1.0.0', registryHash: 'h' };
    const unsorted: RawboxLock = {
      version: RAWBOX_LOCK_VERSION,
      dependencies: {
        'zeta-plugin': { '^2.0.0': entry, '^1.0.0': entry },
        'alpha-plugin': { 'file:b': entry, 'file:a': entry, '^3.0.0': entry },
      },
    };
    const reordered: RawboxLock = {
      version: RAWBOX_LOCK_VERSION,
      dependencies: {
        'alpha-plugin': { '^3.0.0': entry, 'file:a': entry, 'file:b': entry },
        'zeta-plugin': { '^1.0.0': entry, '^2.0.0': entry },
      },
    };

    const lockPath = rawboxLockPath(fixture.workspaceDir);
    await writeRawboxLock(fixture.workspaceDir, unsorted);
    const first = await fs.readFile(lockPath, 'utf-8');
    await writeRawboxLock(fixture.workspaceDir, reordered);
    expect(await fs.readFile(lockPath, 'utf-8')).toBe(first);

    const parsed = YAML.parse(first) as RawboxLock;
    expect(Object.keys(parsed.dependencies)).toEqual(['alpha-plugin', 'zeta-plugin']);
    expect(Object.keys(parsed.dependencies['alpha-plugin'] ?? {})).toEqual([
      '^3.0.0',
      'file:a',
      'file:b',
    ]);
    expect(Object.keys(parsed.dependencies['zeta-plugin'] ?? {})).toEqual(['^1.0.0', '^2.0.0']);
  });

  it('verifies against the entry matching the declared specifier only', () => {
    const lock: RawboxLock = {
      version: RAWBOX_LOCK_VERSION,
      dependencies: {
        [SLEEP_PLUGIN.name]: {
          '^1.0.0': { resolved: '1.2.3', registryHash: 'hash-v1' },
          '^2.0.0': { resolved: '2.0.0', registryHash: 'hash-v2' },
        },
      },
    };

    const installed = { [SLEEP_PLUGIN.name]: 'hash-v2' };
    expect(verifyRawboxLock(lock, installed, { [SLEEP_PLUGIN.name]: '^2.0.0' }).isOk()).toBe(true);

    const mismatch = verifyRawboxLock(lock, installed, { [SLEEP_PLUGIN.name]: '^1.0.0' });
    expect(mismatch._unsafeUnwrapErr()).toContain('hash-v1');

    // A specifier with no entry is unlocked, not a mismatch.
    expect(verifyRawboxLock(lock, installed, { [SLEEP_PLUGIN.name]: '^3.0.0' }).isOk()).toBe(true);
  });

  it('looks `file:` specifiers up by their canonical, relative form', () => {
    const lock: RawboxLock = {
      version: RAWBOX_LOCK_VERSION,
      dependencies: {
        [SLEEP_PLUGIN.name]: { 'file:plugins/alpha': { resolved: '1.0.0', registryHash: 'locked' } },
      },
    };

    const result = verifyRawboxLock(
      lock,
      { [SLEEP_PLUGIN.name]: 'different' },
      { [SLEEP_PLUGIN.name]: 'file:./plugins/alpha/' },
    );
    expect(result._unsafeUnwrapErr()).toContain('specifier: file:plugins/alpha');
  });
});

describe('readRawboxLock', () => {
  it('treats an absent lock as "resolve whatever is installed"', async () => {
    const fixture = await makeFixture('absent-lock');
    expect(await exists(rawboxLockPath(fixture.workspaceDir))).toBe(false);

    const result = await readRawboxLock(fixture.workspaceDir);
    expect(result._unsafeUnwrap()).toBeUndefined();
  });

  it('rejects a lock that exists but does not validate', async () => {
    // A corrupt lock must not degrade to "unlocked": that would turn an
    // integrity failure into a successful run.
    const fixture = await makeFixture('corrupt-lock');
    await fs.writeFile(
      rawboxLockPath(fixture.workspaceDir),
      YAML.stringify({ version: '99', dependencies: {} }),
      'utf-8',
    );

    const message = (await readRawboxLock(fixture.workspaceDir))._unsafeUnwrapErr();
    expect(message).toContain(RAWBOX_LOCK_FILENAME);
    expect(message).toContain('workflow lock');
  });

  it('accepts a JSON lock as well as a YAML one', async () => {
    const fixture = await makeFixture('json-lock');
    const lock: RawboxLock = {
      version: RAWBOX_LOCK_VERSION,
      dependencies: {
        [SLEEP_PLUGIN.name]: { '^1.0.0': { resolved: '1.0.0', registryHash: 'abc' } },
      },
    };
    await fs.writeFile(
      rawboxLockPath(fixture.workspaceDir),
      JSON.stringify(lock, null, 2),
      'utf-8',
    );

    expect((await readRawboxLock(fixture.workspaceDir))._unsafeUnwrap()).toEqual(lock);
  });

  it('round-trips a lock written directly with writeRawboxLock', async () => {
    const fixture = await makeFixture('direct-write');
    const lock: RawboxLock = {
      version: RAWBOX_LOCK_VERSION,
      dependencies: {
        [QUEUE_PLUGIN.name]: { '^0.4.0': { resolved: '0.4.0', registryHash: 'ffff' } },
        [SLEEP_PLUGIN.name]: { '^1.2.0': { resolved: '1.2.3', registryHash: 'aaaa' } },
      },
    };

    const written = (await writeRawboxLock(fixture.workspaceDir, lock))._unsafeUnwrap();
    expect(written).toBe(rawboxLockPath(fixture.workspaceDir));
    expect((await readRawboxLock(fixture.workspaceDir))._unsafeUnwrap()).toEqual(lock);
  });
});

describe('verifyRawboxLock', () => {
  it('is a hard error naming the package and the remedy when a hash moved', async () => {
    // Realistic shape of the failure: the workspace was locked, then the
    // installed plugin's contracts changed. Two workspaces stand in for
    // "before" and "after" so each registry is a distinct module URL — an
    // in-place edit would be masked by the ESM module cache.
    const before = await makeFixture('mismatch-before', [SLEEP_PLUGIN]);
    const after = await makeFixture('mismatch-after', [
      { ...SLEEP_PLUGIN, version: '2.0.0', operation: 'time/sleep-v2' },
    ]);

    const lock = (
      await lockWorkspacePlugins({
        workspaceDir: before.workspaceDir,
        dependencies: before.dependencies,
      })
    )._unsafeUnwrap().lock;

    const installed = toRegistryHashByPlugin(
      (
        await resolvePluginLockEntries(after.dependencies, after.envDir)
      )._unsafeUnwrap(),
    );

    const result = verifyRawboxLock(lock, installed, after.dependencies);
    expect(result.isErr()).toBe(true);

    const message = result._unsafeUnwrapErr();
    // Names the package...
    expect(message).toContain(SLEEP_PLUGIN.name);
    // ...shows both sides of the disagreement...
    expect(message).toContain(expectedHash(SLEEP_PLUGIN));
    expect(message).toContain(installed[SLEEP_PLUGIN.name] as string);
    // ...and states the remedy.
    expect(message).toContain('npx rawbox-cli workflow lock');
  });

  it('reports every mismatched package, not just the first', () => {
    const lock: RawboxLock = {
      version: RAWBOX_LOCK_VERSION,
      dependencies: {
        [SLEEP_PLUGIN.name]: { '^1.0.0': { resolved: '1.0.0', registryHash: 'aaaa' } },
        [QUEUE_PLUGIN.name]: { '^1.0.0': { resolved: '1.0.0', registryHash: 'bbbb' } },
      },
    };

    const message = verifyRawboxLock(
      lock,
      {
        [SLEEP_PLUGIN.name]: 'zzzz',
        [QUEUE_PLUGIN.name]: 'yyyy',
      },
      dependenciesFor([SLEEP_PLUGIN, QUEUE_PLUGIN]),
    )._unsafeUnwrapErr();

    expect(message).toContain(SLEEP_PLUGIN.name);
    expect(message).toContain(QUEUE_PLUGIN.name);
  });

  it('treats an absent lock, and an absent entry, as unlocked', () => {
    expect(
      verifyRawboxLock(
        undefined,
        { [SLEEP_PLUGIN.name]: 'aaaa' },
        dependenciesFor([SLEEP_PLUGIN]),
      ).isOk(),
    ).toBe(true);

    const partial: RawboxLock = {
      version: RAWBOX_LOCK_VERSION,
      dependencies: {
        [SLEEP_PLUGIN.name]: { '^1.0.0': { resolved: '1.0.0', registryHash: 'aaaa' } },
      },
    };
    // A partially locked workspace stays usable: the unlocked package is not
    // an error, and the locked one still has to agree.
    expect(
      verifyRawboxLock(
        partial,
        {
          [SLEEP_PLUGIN.name]: 'aaaa',
          [QUEUE_PLUGIN.name]: 'anything',
        },
        dependenciesFor([SLEEP_PLUGIN, QUEUE_PLUGIN]),
      ).isOk(),
    ).toBe(true);
  });
});

describe('locking never touches the workflow file', () => {
  it('leaves the workflow byte-identical across a full lock run', async () => {
    const fixture = await makeFixture('untouched', [SLEEP_PLUGIN, QUEUE_PLUGIN]);

    const before = await fs.readFile(fixture.workflowFile);
    const beforeHash = await sha256OfFile(fixture.workflowFile);
    const beforeStat = await fs.stat(fixture.workflowFile);

    const result = await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      dependencies: fixture.dependencies,
    });
    expect(result.isOk()).toBe(true);

    const after = await fs.readFile(fixture.workflowFile);
    expect(await sha256OfFile(fixture.workflowFile)).toBe(beforeHash);
    expect(after.equals(before)).toBe(true);
    // Not even rewritten with identical bytes.
    expect((await fs.stat(fixture.workflowFile)).mtimeMs).toBe(beforeStat.mtimeMs);

    // The lock is the only thing that appeared next to it.
    expect(await exists(rawboxLockPath(fixture.workspaceDir))).toBe(true);
  });

  it('leaves the workflow byte-identical after `rawbox-cli workflow lock`', async () => {
    // End-to-end through the real command, because "never modify the workflow"
    // is a property of the CLI entry point, not only of the runner helper.
    //
    // An unbuilt dist fails rather than skips. `build:all` precedes `test:all`,
    // so this always holds; the point is that a warn-and-return would let the
    // guarantee stop being checked without anything going red — the same way
    // the `validateStorageBoundaries` no-op and the unsatisfiable workspace
    // heuristic both survived for so long.
    expect(
      await exists(CLI_ENTRY),
      `${CLI_ENTRY} is not built — run \`npm run build:all\` before \`test:all\`.`,
    ).toBe(true);

    const fixture = await makeFixture('cli-untouched', [SLEEP_PLUGIN, QUEUE_PLUGIN]);
    const beforeHash = await sha256OfFile(fixture.workflowFile);
    const beforeStat = await fs.stat(fixture.workflowFile);

    execFileSync(
      process.execPath,
      [
        CLI_ENTRY,
        'workflow',
        'lock',
        fixture.workflowFile,
        '--workspace',
        fixture.workspaceFile,
      ],
      { cwd: fixture.workspaceDir, encoding: 'utf-8', stdio: 'pipe' },
    );

    expect(await sha256OfFile(fixture.workflowFile)).toBe(beforeHash);
    expect((await fs.stat(fixture.workflowFile)).mtimeMs).toBe(beforeStat.mtimeMs);

    // ...and the lock it was supposed to write is there, with the right hashes.
    const lock = (await readRawboxLock(fixture.workspaceDir))._unsafeUnwrap();
    expect(lock?.dependencies[SLEEP_PLUGIN.name]?.['^1.0.0']?.registryHash).toBe(expectedHash(SLEEP_PLUGIN));
    expect(lock?.dependencies[QUEUE_PLUGIN.name]?.['^1.0.0']?.registryHash).toBe(expectedHash(QUEUE_PLUGIN));
  });

  it('discovers the workspace without --workspace', async () => {
    expect(
      await exists(CLI_ENTRY),
      `${CLI_ENTRY} is not built — run \`npm run build:all\` before \`test:all\`.`,
    ).toBe(true);

    const fixture = await makeFixture('cli-discovery');

    execFileSync(
      process.execPath,
      [CLI_ENTRY, 'workflow', 'lock', fixture.workflowFile],
      { cwd: sandboxRoot, encoding: 'utf-8', stdio: 'pipe' },
    );

    const lock = (await readRawboxLock(fixture.workspaceDir))._unsafeUnwrap();
    expect(lock?.dependencies[SLEEP_PLUGIN.name]?.['^1.0.0']?.registryHash).toBe(expectedHash(SLEEP_PLUGIN));
  });
});
