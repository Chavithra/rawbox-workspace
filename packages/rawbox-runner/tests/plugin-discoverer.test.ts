import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractRegistryCache } from '@rawbox/plugin/core';
import { PluginDiscoverer } from '../src/workflow/plugin-discoverer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The plugin every fixture below runs against; a real, built workspace package. */
const DEFAULT_PLUGIN = '@rawbox/rawbox-plugin-default';

/** Writes a package.json into a fake node_modules entry inside `root`. */
async function writeFakePackage(
  root: string,
  name: string,
  pjson: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...pjson }, null, 2),
  );
}

const REGISTRY_EXPORT = {
  './contract-registry': {
    types: './dist/contract-registry.d.ts',
    default: './dist/contract-registry.js',
  },
};

/** A package.json body satisfying every discovery requirement. */
const CONFORMING = {
  keywords: ['rawbox-plugin'],
  exports: REGISTRY_EXPORT,
};

/**
 * Writes a fake node_modules entry inside `root` that is genuinely importable:
 * a package.json with a `./contract-registry` export plus a real ESM module
 * behind it, so `loadPlugin`/`resolveRegistrySpecifier` can resolve *and*
 * import it. `marker` lands in `contractRecord` so a test can tell which
 * installation of the package actually got loaded.
 */
async function writeFakeRegistryPackage(
  root: string,
  name: string,
  marker: string,
): Promise<void> {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        keywords: ['rawbox-plugin'],
        exports: {
          './contract-registry': {
            types: './contract-registry.d.ts',
            default: './contract-registry.mjs',
          },
        },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(dir, 'contract-registry.mjs'),
    [
      'export default {',
      `  contractRecord: { '${marker}': { type: 'marker' } },`,
      `  contractRegistryPath: '${name}/contract-registry',`,
      "  rawboxPluginVersion: '1.0.0',",
      '};',
      '',
    ].join('\n'),
  );
}

describe('PluginDiscoverer.isPlugin', () => {
  it('matches the unscoped naming convention', () => {
    expect(PluginDiscoverer.isPlugin('rawbox-plugin-custom')).toBe(true);
  });

  it('matches the convention inside any scope, including third-party scopes', () => {
    expect(PluginDiscoverer.isPlugin('@rawbox/rawbox-plugin-default')).toBe(true);
    expect(PluginDiscoverer.isPlugin('@acme/rawbox-plugin-kraken')).toBe(true);
  });

  it('rejects a scoped name that drops the rawbox-plugin- prefix', () => {
    // Guards the naming decision: @rawbox/plugin-default would not be discovered.
    expect(PluginDiscoverer.isPlugin('@rawbox/plugin-default')).toBe(false);
  });

  it('rejects the SDK and unrelated packages', () => {
    expect(PluginDiscoverer.isPlugin('@rawbox/plugin')).toBe(false);
    expect(PluginDiscoverer.isPlugin('rawbox-plugin')).toBe(false);
    expect(PluginDiscoverer.isPlugin('neverthrow')).toBe(false);
  });
});

describe('PluginDiscoverer.discoverPlugins', () => {
  let workspace: string;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'rawbox-discover-'));

    await fs.writeFile(
      path.join(workspace, 'package.json'),
      JSON.stringify({
        name: 'fixture-workspace',
        dependencies: {
          'rawbox-plugin-good': '*',
          '@acme/rawbox-plugin-scoped': '*',
          'rawbox-plugin-nokeyword': '*',
          'rawbox-plugin-noexport': '*',
          'rawbox-plugin-absent': '*',
          'not-a-plugin': '*',
        },
      }),
    );

    await writeFakePackage(workspace, 'rawbox-plugin-good', CONFORMING);
    await writeFakePackage(workspace, '@acme/rawbox-plugin-scoped', CONFORMING);
    // Named like a plugin and loadable, but does not declare the keyword.
    await writeFakePackage(workspace, 'rawbox-plugin-nokeyword', {
      exports: REGISTRY_EXPORT,
    });
    // Declares the keyword, but exposes no ./contract-registry subpath.
    await writeFakePackage(workspace, 'rawbox-plugin-noexport', {
      keywords: ['rawbox-plugin'],
      exports: { '.': './dist/index.js' },
    });
    // Declared as a dependency but never installed.
    await writeFakePackage(workspace, 'not-a-plugin', CONFORMING);
  });

  afterAll(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('discovers packages that expose ./contract-registry, scoped or not', async () => {
    const result = await PluginDiscoverer.discoverPlugins(workspace);
    expect(result.isOk()).toBe(true);

    const { plugins } = result._unsafeUnwrap();
    expect(plugins.sort()).toEqual([
      '@acme/rawbox-plugin-scoped',
      'rawbox-plugin-good',
    ]);
  });

  it('requires the rawbox-plugin keyword, reporting the reason when absent', async () => {
    const { plugins, skipped } = (
      await PluginDiscoverer.discoverPlugins(workspace)
    )._unsafeUnwrap();

    expect(plugins).not.toContain('rawbox-plugin-nokeyword');

    const entry = skipped.find((s) => s.name === 'rawbox-plugin-nokeyword');
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain('keywords');
  });

  it('reports a name-matching package that lacks the export, instead of dropping it', async () => {
    const { skipped } = (
      await PluginDiscoverer.discoverPlugins(workspace)
    )._unsafeUnwrap();

    const entry = skipped.find((s) => s.name === 'rawbox-plugin-noexport');
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain('./contract-registry');
  });

  it('reports an unresolvable dependency with its reason', async () => {
    const { skipped } = (
      await PluginDiscoverer.discoverPlugins(workspace)
    )._unsafeUnwrap();

    const entry = skipped.find((s) => s.name === 'rawbox-plugin-absent');
    expect(entry).toBeDefined();
    expect(entry?.reason).toContain('could not resolve');
  });

  it('ignores dependencies that do not match the naming convention', async () => {
    const { plugins, skipped } = (
      await PluginDiscoverer.discoverPlugins(workspace)
    )._unsafeUnwrap();

    expect(plugins).not.toContain('not-a-plugin');
    expect(skipped.map((s) => s.name)).not.toContain('not-a-plugin');
  });

  it('errors when the workspace has no readable package.json', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'rawbox-empty-'));
    const result = await PluginDiscoverer.discoverPlugins(empty);
    expect(result.isErr()).toBe(true);
    await fs.rm(empty, { recursive: true, force: true });
  });
});

describe('PluginDiscoverer.loadPlugin', () => {
  it('imports the ./contract-registry subpath, not ./registry', async () => {
    // Regression guard: loadPlugin previously imported `${name}/registry`,
    // which no plugin has ever exported.
    //
    // The mock is honest about `addContractRegistry`'s real signature: it
    // returns the contract-registry hash (a string), not undefined, because
    // that pairing is what the next test relies on.
    const hash = 'a'.repeat(64);
    const cache = { addContractRegistry: () => hash } as unknown as ContractRegistryCache;
    const result = await PluginDiscoverer.loadPlugin(
      '@rawbox/rawbox-plugin-default',
      cache,
    );

    expect(result.isOk()).toBe(true);
  });

  it('returns exactly the hash that addContractRegistry produced', async () => {
    // A mock returning `undefined` here could not catch a regression that
    // drops the hash on the way out of `loadPlugin` — see PluginLoadResult.
    const hash = 'b'.repeat(64);
    const cache = { addContractRegistry: () => hash } as unknown as ContractRegistryCache;
    const result = await PluginDiscoverer.loadPlugin(
      '@rawbox/rawbox-plugin-default',
      cache,
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(hash);
  });
});

// ---------------------------------------------------------------------------
// Plugin → registry-hash mapping
//
// `run-workflow.ts` is the caller that has to produce this map, so its
// single-pass guarantee is asserted here rather than left implicit.
// ---------------------------------------------------------------------------

describe('PluginDiscoverer.loadPlugins', () => {
  it('returns a hash map whose every entry resolves in the cache it filled', async () => {
    const cache = new ContractRegistryCache();
    const result = await PluginDiscoverer.loadPlugins([DEFAULT_PLUGIN], cache, {
      resolveFrom: __dirname,
    });

    expect(result.skipped).toEqual([]);
    expect(result.loaded).toEqual([DEFAULT_PLUGIN]);

    const hash = result.registryHashByPlugin[DEFAULT_PLUGIN];
    expect(hash).toMatch(/^[a-f0-9]{64}$/);

    // The invariant that makes the resolver's "stale map" error unreachable:
    // every hash in the map came from the `addContractRegistry` call that put
    // the registry in this very cache.
    for (const mappedHash of Object.values(result.registryHashByPlugin)) {
      expect(cache.getContractRegistry(mappedHash)).toBeDefined();
    }
  });

  it('records an unloadable package in `skipped` instead of failing the batch', async () => {
    const cache = new ContractRegistryCache();
    const result = await PluginDiscoverer.loadPlugins(
      [DEFAULT_PLUGIN, '@rawbox/rawbox-plugin-does-not-exist'],
      cache,
      { resolveFrom: __dirname },
    );

    expect(result.loaded).toEqual([DEFAULT_PLUGIN]);
    expect(result.registryHashByPlugin['@rawbox/rawbox-plugin-does-not-exist']).toBeUndefined();
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.name).toBe('@rawbox/rawbox-plugin-does-not-exist');
  });
});

// ---------------------------------------------------------------------------
// PluginDiscoverer.resolveRegistrySpecifier (private, exercised via loadPlugin's
// `resolveFrom` option) — this is what decides whether a plugin declared by a
// workflow is actually found at run time.
// ---------------------------------------------------------------------------

describe('PluginDiscoverer resolution fallback (resolveFrom)', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rawbox-resolve-'));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses the first base directory when it can resolve the package', async () => {
    const pluginName = 'rawbox-plugin-resolve-first';
    const baseA = path.join(root, 'base-a-wins');
    const baseB = path.join(root, 'base-b-loses');
    await fs.mkdir(baseA, { recursive: true });
    await fs.mkdir(baseB, { recursive: true });
    await writeFakeRegistryPackage(baseA, pluginName, 'from-base-a');
    await writeFakeRegistryPackage(baseB, pluginName, 'from-base-b');

    const cache = new ContractRegistryCache();
    const result = await PluginDiscoverer.loadPlugin(pluginName, cache, {
      resolveFrom: [baseA, baseB],
    });

    expect(result.isOk()).toBe(true);
    const registry = cache.getContractRegistry(result._unsafeUnwrap());
    expect(registry?.contractRecord).toHaveProperty('from-base-a');
    expect(registry?.contractRecord).not.toHaveProperty('from-base-b');
  });

  it('falls through to a later base when an earlier one cannot resolve the package', async () => {
    const pluginName = 'rawbox-plugin-resolve-later';
    const baseEmpty = path.join(root, 'base-empty');
    const baseB = path.join(root, 'base-b-wins');
    await fs.mkdir(baseEmpty, { recursive: true });
    await fs.mkdir(baseB, { recursive: true });
    await writeFakeRegistryPackage(baseB, pluginName, 'from-base-b');

    const cache = new ContractRegistryCache();
    const result = await PluginDiscoverer.loadPlugin(pluginName, cache, {
      resolveFrom: [baseEmpty, baseB],
    });

    expect(result.isOk()).toBe(true);
    const registry = cache.getContractRegistry(result._unsafeUnwrap());
    expect(registry?.contractRecord).toHaveProperty('from-base-b');
  });

  it('falls back to the bare specifier when no supplied base can resolve it', async () => {
    // Neither base has the package installed, so resolution must fall through
    // to the bare specifier, resolved relative to plugin-discoverer.ts's own
    // module graph — which does find the real, workspace-linked default
    // plugin, proving the fallback (not one of the bases) is what succeeded.
    const baseEmptyA = path.join(root, 'bare-fallback-a');
    const baseEmptyB = path.join(root, 'bare-fallback-b');
    await fs.mkdir(baseEmptyA, { recursive: true });
    await fs.mkdir(baseEmptyB, { recursive: true });

    const cache = new ContractRegistryCache();
    const result = await PluginDiscoverer.loadPlugin(DEFAULT_PLUGIN, cache, {
      resolveFrom: [baseEmptyA, baseEmptyB],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// PluginDiscoverer.findUnresolvedPlugins — the cheap, import-free pre-check
// `workflow run`'s auto-setup decision is built on
// (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)"). It must agree with what `loadPlugin` would
// actually do, without paying to import anything.
// ---------------------------------------------------------------------------

describe('PluginDiscoverer.findUnresolvedPlugins', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rawbox-unresolved-'));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports nothing missing when every plugin resolves from a supplied base', async () => {
    const pluginName = 'rawbox-plugin-findunresolved-present';
    const base = path.join(root, 'present-base');
    await fs.mkdir(base, { recursive: true });
    await writeFakeRegistryPackage(base, pluginName, 'marker');

    expect(
      PluginDiscoverer.findUnresolvedPlugins([pluginName], { resolveFrom: [base] }),
    ).toEqual([]);
  });

  it('reports a plugin installed nowhere as missing', () => {
    const missing = PluginDiscoverer.findUnresolvedPlugins(
      ['rawbox-plugin-findunresolved-nowhere'],
      { resolveFrom: [path.join(root, 'empty-base')] },
    );
    expect(missing).toEqual(['rawbox-plugin-findunresolved-nowhere']);
  });

  it('never flags the runner\'s own sibling workspace package, matching the bare-specifier fallback loadPlugin takes', () => {
    // Same reasoning `PluginDiscoverer resolution fallback` above pins for
    // `loadPlugin`: this package resolves with no base supplied at all,
    // because it is a sibling workspace package of `@rawbox/runner`. The
    // pre-check must agree, or auto-setup would trigger on every run of the
    // fixtures this monorepo's own tests use.
    expect(
      PluginDiscoverer.findUnresolvedPlugins([DEFAULT_PLUGIN], {
        resolveFrom: [path.join(root, 'unrelated-empty-base')],
      }),
    ).toEqual([]);
  });

  it('reports only the plugins that are actually missing out of a mixed list', async () => {
    const presentName = 'rawbox-plugin-findunresolved-mixed-present';
    const base = path.join(root, 'mixed-base');
    await fs.mkdir(base, { recursive: true });
    await writeFakeRegistryPackage(base, presentName, 'marker');

    const missing = PluginDiscoverer.findUnresolvedPlugins(
      [presentName, 'rawbox-plugin-findunresolved-mixed-absent', DEFAULT_PLUGIN],
      { resolveFrom: [base] },
    );
    expect(missing).toEqual(['rawbox-plugin-findunresolved-mixed-absent']);
  });

  it('never imports the plugin module — a package that throws on import still counts as resolvable', async () => {
    // The whole point of the pre-check is to stop short of `import()`. A
    // package that resolves but throws when actually loaded proves the
    // distinction: `findUnresolvedPlugins` must not report it as missing.
    const pluginName = 'rawbox-plugin-findunresolved-throws-on-import';
    const base = path.join(root, 'throws-base');
    const dir = path.join(base, 'node_modules', pluginName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: pluginName,
        version: '1.0.0',
        keywords: ['rawbox-plugin'],
        exports: {
          './contract-registry': { default: './contract-registry.mjs' },
        },
      }),
    );
    await fs.writeFile(
      path.join(dir, 'contract-registry.mjs'),
      "throw new Error('boom: this module must never actually be imported by the pre-check');\n",
    );

    expect(
      PluginDiscoverer.findUnresolvedPlugins([pluginName], { resolveFrom: [base] }),
    ).toEqual([]);

    // Sanity: the real load *does* fail on this fixture, proving the pre-check
    // above genuinely stopped short of importing rather than the fixture being
    // accidentally importable.
    const cache = new ContractRegistryCache();
    const loadResult = await PluginDiscoverer.loadPlugin(pluginName, cache, {
      resolveFrom: [base],
    });
    expect(loadResult.isErr()).toBe(true);
  });
});
