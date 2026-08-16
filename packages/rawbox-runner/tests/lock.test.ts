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
} from '../src/workflow/lock.js';
import {
  RAWBOX_LOCK_FILENAME,
  RAWBOX_LOCK_VERSION,
  type RawboxLock,
} from '../src/workflow/lock-types.js';

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

const CLI_ENTRY = path.resolve(__dirname, '..', '..', 'rawbox-cli', 'dist', 'index.js');

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

/** Installs a fake plugin into `<workspaceDir>/node_modules/<name>`. */
async function installFakePlugin(
  workspaceDir: string,
  plugin: FakePlugin,
): Promise<void> {
  const dir = path.join(workspaceDir, 'node_modules', ...plugin.name.split('/'));
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
    'plugins:',
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

interface Fixture {
  workspaceDir: string;
  workspaceFile: string;
  workflowFile: string;
  packageNames: string[];
}

let fixtureCounter = 0;

/**
 * Builds `<sandbox>/<label>/workspaces/<label>/` holding a `workspace.yaml`, a
 * `workflows/<label>.workflow.yaml`, and a `node_modules` containing the given
 * plugins — the layout `workspace create` scaffolds.
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

  for (const plugin of plugins) {
    await installFakePlugin(workspaceDir, plugin);
  }

  return {
    workspaceDir,
    workspaceFile,
    workflowFile,
    packageNames: plugins.map((plugin) => plugin.name),
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
  it('resolves each declared package from the workspace directory', async () => {
    const fixture = await makeFixture('resolve', [SLEEP_PLUGIN, QUEUE_PLUGIN]);

    const result = await resolvePluginLockEntries(
      fixture.packageNames,
      fixture.workspaceDir,
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
      fixture.packageNames,
      fixture.workspaceDir,
    );
    expect(fromWorkspace.isOk()).toBe(true);

    // The same package name resolved from a sibling directory with no
    // node_modules of its own — and no ancestor providing it — must fail.
    const strangerDir = path.join(sandboxRoot, 'stranger');
    await fs.mkdir(strangerDir, { recursive: true });
    const fromElsewhere = await resolvePluginLockEntries(
      fixture.packageNames,
      strangerDir,
    );
    expect(fromElsewhere.isErr()).toBe(true);
  });

  it('names the package and the remedy when a plugin is not installed', async () => {
    const fixture = await makeFixture('missing');

    const result = await resolvePluginLockEntries(
      ['@fixture/rawbox-plugin-absent'],
      fixture.workspaceDir,
    );

    const message = result._unsafeUnwrapErr();
    expect(message).toContain('@fixture/rawbox-plugin-absent');
    expect(message).toContain('workspace setup');
  });

  it('populates a supplied ContractRegistryCache with what it loaded', async () => {
    const fixture = await makeFixture('cache');
    const cache = new ContractRegistryCache();

    const entries = (
      await resolvePluginLockEntries(fixture.packageNames, fixture.workspaceDir, cache)
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
        packageNames: fixture.packageNames,
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
    expect(readBack?.plugins[SLEEP_PLUGIN.name]).toEqual({
      resolved: SLEEP_PLUGIN.version,
      registryHash: expectedHash(SLEEP_PLUGIN),
    });

    // -- verify -----------------------------------------------------------
    const installed = toRegistryHashByPlugin(
      (
        await resolvePluginLockEntries(fixture.packageNames, fixture.workspaceDir)
      )._unsafeUnwrap(),
    );
    expect(verifyRawboxLock(readBack, installed).isOk()).toBe(true);
  });

  it('is written as a commented, key-sorted YAML document', async () => {
    const fixture = await makeFixture('format', [QUEUE_PLUGIN, SLEEP_PLUGIN]);

    await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      packageNames: fixture.packageNames,
    });

    const raw = await fs.readFile(rawboxLockPath(fixture.workspaceDir), 'utf-8');
    expect(raw).toContain('Do not hand-edit');

    // Sorted regardless of declaration order, so re-locking produces no diff
    // noise and "did anything change?" stays answerable.
    const keys = Object.keys(YAML.parse(raw).plugins);
    expect(keys).toEqual([...keys].sort());
  });

  it('re-locking an unchanged workspace is byte-for-byte idempotent', async () => {
    const fixture = await makeFixture('idempotent');
    const lockPath = rawboxLockPath(fixture.workspaceDir);

    await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      packageNames: fixture.packageNames,
    });
    const first = await sha256OfFile(lockPath);

    const second = await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      packageNames: fixture.packageNames,
    });

    expect(await sha256OfFile(lockPath)).toBe(first);
    expect(second._unsafeUnwrap().changed).toEqual([]);
  });

  it('merges into the existing lock instead of replacing it', async () => {
    // The lock is keyed at the *workspace* level but the command takes
    // one workflow, so locking a workflow must never unlock its siblings.
    const fixture = await makeFixture('merge', [SLEEP_PLUGIN, QUEUE_PLUGIN]);

    await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      packageNames: [QUEUE_PLUGIN.name],
    });
    await lockWorkspacePlugins({
      workspaceDir: fixture.workspaceDir,
      packageNames: [SLEEP_PLUGIN.name],
    });

    const lock = (await readRawboxLock(fixture.workspaceDir))._unsafeUnwrap();
    expect(Object.keys(lock?.plugins ?? {}).sort()).toEqual(
      [SLEEP_PLUGIN.name, QUEUE_PLUGIN.name].sort(),
    );
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
      YAML.stringify({ version: '99', plugins: {} }),
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
      plugins: { [SLEEP_PLUGIN.name]: { resolved: '1.0.0', registryHash: 'abc' } },
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
      plugins: {
        [QUEUE_PLUGIN.name]: { resolved: '0.4.0', registryHash: 'ffff' },
        [SLEEP_PLUGIN.name]: { resolved: '1.2.3', registryHash: 'aaaa' },
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
        packageNames: before.packageNames,
      })
    )._unsafeUnwrap().lock;

    const installed = toRegistryHashByPlugin(
      (
        await resolvePluginLockEntries(after.packageNames, after.workspaceDir)
      )._unsafeUnwrap(),
    );

    const result = verifyRawboxLock(lock, installed);
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
      plugins: {
        [SLEEP_PLUGIN.name]: { resolved: '1.0.0', registryHash: 'aaaa' },
        [QUEUE_PLUGIN.name]: { resolved: '1.0.0', registryHash: 'bbbb' },
      },
    };

    const message = verifyRawboxLock(lock, {
      [SLEEP_PLUGIN.name]: 'zzzz',
      [QUEUE_PLUGIN.name]: 'yyyy',
    })._unsafeUnwrapErr();

    expect(message).toContain(SLEEP_PLUGIN.name);
    expect(message).toContain(QUEUE_PLUGIN.name);
  });

  it('treats an absent lock, and an absent entry, as unlocked', () => {
    expect(verifyRawboxLock(undefined, { [SLEEP_PLUGIN.name]: 'aaaa' }).isOk()).toBe(true);

    const partial: RawboxLock = {
      version: RAWBOX_LOCK_VERSION,
      plugins: { [SLEEP_PLUGIN.name]: { resolved: '1.0.0', registryHash: 'aaaa' } },
    };
    // A partially locked workspace stays usable: the unlocked package is not
    // an error, and the locked one still has to agree.
    expect(
      verifyRawboxLock(partial, {
        [SLEEP_PLUGIN.name]: 'aaaa',
        [QUEUE_PLUGIN.name]: 'anything',
      }).isOk(),
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
      packageNames: fixture.packageNames,
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
    expect(lock?.plugins[SLEEP_PLUGIN.name]?.registryHash).toBe(expectedHash(SLEEP_PLUGIN));
    expect(lock?.plugins[QUEUE_PLUGIN.name]?.registryHash).toBe(expectedHash(QUEUE_PLUGIN));
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
    expect(lock?.plugins[SLEEP_PLUGIN.name]?.registryHash).toBe(expectedHash(SLEEP_PLUGIN));
  });
});
