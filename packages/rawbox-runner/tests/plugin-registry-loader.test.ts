import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ContractRegistryCache } from '@rawbox/plugin/core';

import {
  contractRegistrySpecifier,
  loadPluginContractRegistry,
} from '../src/workflow/plugin-registry-loader.js';
import { PluginDiscoverer } from '../src/workflow/plugin-discoverer.js';
import { resolvePluginLockEntries } from '../src/workflow/lock.js';

// ---------------------------------------------------------------------------
// The shared core behind `PluginDiscoverer.loadPlugins`,
// `resolvePluginLockEntries` and `workflow verify`'s `loadPluginRegistries`.
//
// The interesting part of this file is the *asymmetry* the three callers keep:
// only the runner may fall back to the bare specifier. See the second describe
// block — that is the property a naive unification silently destroys, in either
// direction (removing it breaks running a workflow against a workspace-linked
// plugin; leaking it makes locking and verifying record the runner's own
// dependency tree instead of the workspace's).
// ---------------------------------------------------------------------------

/**
 * A package that really is installed for `@rawbox/runner` — it is a sibling
 * workspace package of it — but is *not* installed under any temp directory.
 * That gap is exactly what tells a bare-specifier resolution apart from a
 * base-directory one.
 */
const RUNNER_VISIBLE_PLUGIN = '@rawbox/rawbox-plugin-default';

let sandbox: string;
/** Two bases with no `node_modules` anywhere at or above them. */
let emptyBaseA: string;
let emptyBaseB: string;
/** A base holding a hand-written, importable plugin. */
let installedBase: string;

const FIXTURE_PLUGIN = '@fixture/rawbox-plugin-loader';

/**
 * Writes a build-free plugin into `<base>/node_modules/<name>`: a package.json
 * exporting `./contract-registry` plus a plain ESM module behind it. `body` is
 * the module source, so a test can make it default-export a registry, export
 * something registry-shaped under another name, export nothing usable, or throw
 * on evaluation.
 */
async function installPlugin(
  base: string,
  name: string,
  body: string,
): Promise<string> {
  const dir = path.join(base, 'node_modules', ...name.split('/'));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
        version: '3.1.4',
        type: 'module',
        exports: { './contract-registry': './contract-registry.js' },
      },
      null,
      2,
    ),
    'utf-8',
  );
  await fs.writeFile(path.join(dir, 'contract-registry.js'), body, 'utf-8');
  return path.join(dir, 'contract-registry.js');
}

function registrySource(marker: string): string {
  return `export default { contractRecord: { './${marker}.definition.js': { type: 'operation' } } };\n`;
}

beforeAll(async () => {
  // `os.tmpdir()` matters: a directory *inside* this repo would resolve
  // `@rawbox/rawbox-plugin-default` through the ordinary node_modules walk-up
  // to the monorepo root, and every assertion below would pass for the wrong
  // reason.
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'rawbox-registry-loader-'));
  emptyBaseA = path.join(sandbox, 'empty-a');
  emptyBaseB = path.join(sandbox, 'empty-b');
  installedBase = path.join(sandbox, 'installed');
  await fs.mkdir(emptyBaseA, { recursive: true });
  await fs.mkdir(emptyBaseB, { recursive: true });
  await fs.mkdir(installedBase, { recursive: true });
  await installPlugin(installedBase, FIXTURE_PLUGIN, registrySource('alpha'));
});

afterAll(async () => {
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
});

describe('loadPluginContractRegistry', () => {
  it('builds the specifier every plugin publishes its registry under', () => {
    expect(contractRegistrySpecifier('@acme/rawbox-plugin-kraken')).toBe(
      '@acme/rawbox-plugin-kraken/contract-registry',
    );
  });

  it('resolves from a base directory and reports the path it imported', async () => {
    const cache = new ContractRegistryCache();
    const result = await loadPluginContractRegistry(FIXTURE_PLUGIN, {
      resolveFrom: [installedBase],
      registryCache: cache,
    });

    const loaded = result._unsafeUnwrap();
    expect(loaded.packageName).toBe(FIXTURE_PLUGIN);
    expect(loaded.registryPath).toBe(
      path.join(installedBase, 'node_modules', ...FIXTURE_PLUGIN.split('/'), 'contract-registry.js'),
    );

    // The single-pass invariant every caller depends on: the hash came from the
    // `addContractRegistry` call that filled this very cache.
    expect(cache.getContractRegistry(loaded.registryHash)).toBeDefined();
    expect(loaded.registryHash).toBe(
      ContractRegistryCache.computeHash(loaded.registry),
    );
  });

  it('hashes without caching when no cache is supplied', async () => {
    const result = await loadPluginContractRegistry(FIXTURE_PLUGIN, {
      resolveFrom: [installedBase],
    });
    expect(result._unsafeUnwrap().registryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('tries bases in order, taking the first that resolves', async () => {
    const winner = path.join(sandbox, 'ordered-winner');
    const loser = path.join(sandbox, 'ordered-loser');
    await fs.mkdir(winner, { recursive: true });
    await fs.mkdir(loser, { recursive: true });
    await installPlugin(winner, 'rawbox-plugin-ordered', registrySource('winner'));
    await installPlugin(loser, 'rawbox-plugin-ordered', registrySource('loser'));

    const result = await loadPluginContractRegistry('rawbox-plugin-ordered', {
      resolveFrom: [emptyBaseA, winner, loser],
    });

    expect(Object.keys(result._unsafeUnwrap().registry.contractRecord)).toEqual([
      './winner.definition.js',
    ]);
  });

  it('reports every base it searched when nothing resolves', async () => {
    const failure = (
      await loadPluginContractRegistry(FIXTURE_PLUGIN, {
        resolveFrom: [emptyBaseA, emptyBaseB],
      })
    )._unsafeUnwrapErr();

    expect(failure.kind).toBe('unresolved');
    if (failure.kind !== 'unresolved') return;
    expect(failure.specifier).toBe(`${FIXTURE_PLUGIN}/contract-registry`);
    expect(failure.searchedList).toEqual([emptyBaseA, emptyBaseB]);
    // Node's own text is carried through so a single-base caller can quote it
    // verbatim rather than inventing a vaguer sentence.
    expect(failure.cause).toBeDefined();
  });

  it('separates "found but broken" from "not found"', async () => {
    const throwing = path.join(sandbox, 'throwing');
    await fs.mkdir(throwing, { recursive: true });
    const registryPath = await installPlugin(
      throwing,
      'rawbox-plugin-throwing',
      'throw new Error("registry blew up at import time");\n',
    );

    const failure = (
      await loadPluginContractRegistry('rawbox-plugin-throwing', {
        resolveFrom: [throwing],
      })
    )._unsafeUnwrapErr();

    expect(failure.kind).toBe('import-failed');
    if (failure.kind !== 'import-failed') return;
    expect(failure.registryPath).toBe(registryPath);
    expect(failure.cause).toContain('registry blew up at import time');
  });

  it('rejects a module whose default export carries no contractRecord', async () => {
    const notARegistry = path.join(sandbox, 'not-a-registry');
    await fs.mkdir(notARegistry, { recursive: true });
    const registryPath = await installPlugin(
      notARegistry,
      'rawbox-plugin-empty',
      'export default { somethingElse: true };\n',
    );

    const failure = (
      await loadPluginContractRegistry('rawbox-plugin-empty', {
        resolveFrom: [notARegistry],
      })
    )._unsafeUnwrapErr();

    expect(failure.kind).toBe('not-a-registry');
    if (failure.kind !== 'not-a-registry') return;
    expect(failure.registryPath).toBe(registryPath);
  });
});

// ---------------------------------------------------------------------------
// The bare-specifier fallback belongs to exactly one caller
//
// `PluginDiscoverer.loadPlugin` falls back to importing the bare specifier from
// the runner's own module graph. That is why a workflow can name
// `@rawbox/rawbox-plugin-default` and have it load inside this monorepo, where
// the plugin is a linked sibling package rather than something installed under
// the workspace.
//
// `resolvePluginLockEntries` and `workflow verify` must NOT inherit it: both
// answer a question about one specific workspace's install, and a fallback would
// turn "not installed here" into a confident wrong answer — a lock recording the
// runner's dependency tree, or a verify that passes for a workspace where the
// plugin is genuinely absent.
//
// Every assertion below runs against the same two empty temp bases, so the only
// variable is whether the fallback is enabled.
// ---------------------------------------------------------------------------

describe('bare-specifier fallback', () => {
  it('is off by default: a runner-visible package does not resolve from an unrelated base', async () => {
    const failure = (
      await loadPluginContractRegistry(RUNNER_VISIBLE_PLUGIN, {
        resolveFrom: [emptyBaseA, emptyBaseB],
      })
    )._unsafeUnwrapErr();

    expect(failure.kind).toBe('unresolved');
  });

  it('resolves that same package once explicitly enabled', async () => {
    const cache = new ContractRegistryCache();
    const loaded = (
      await loadPluginContractRegistry(RUNNER_VISIBLE_PLUGIN, {
        resolveFrom: [emptyBaseA, emptyBaseB],
        registryCache: cache,
        bareSpecifierFallback: true,
      })
    )._unsafeUnwrap();

    expect(loaded.registryHash).toMatch(/^[a-f0-9]{64}$/);
    // No `registryPath`: Node, not this loader, decided where it came from.
    expect(loaded.registryPath).toBeUndefined();
    expect(cache.getContractRegistry(loaded.registryHash)).toBeDefined();
  });

  it('still applies to PluginDiscoverer.loadPlugins, which owns it', async () => {
    const cache = new ContractRegistryCache();
    const result = await PluginDiscoverer.loadPlugins(
      [RUNNER_VISIBLE_PLUGIN],
      cache,
      { resolveFrom: [emptyBaseA, emptyBaseB] },
    );

    expect(result.skipped).toEqual([]);
    expect(result.loaded).toEqual([RUNNER_VISIBLE_PLUGIN]);
    expect(result.registryHashByPlugin[RUNNER_VISIBLE_PLUGIN]).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it('does not leak into resolvePluginLockEntries', async () => {
    // Same package, same empty base the runner just succeeded from. Locking must
    // fail rather than record a version and hash that describe the runner's own
    // installation of the plugin instead of the workspace's.
    const result = await resolvePluginLockEntries(
      [RUNNER_VISIBLE_PLUGIN],
      emptyBaseA,
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();
    expect(message).toContain(RUNNER_VISIBLE_PLUGIN);
    expect(message).toContain(emptyBaseA);
    expect(message).toContain('workspace setup');
  });

  it('does not leak into the option shape `workflow verify` uses', async () => {
    // `loadPluginRegistries` is module-private to the CLI, so what is pinned
    // here is the contract it calls the loader with: a directory *list* and no
    // fallback. If the default ever flipped, this fails and verify would start
    // passing for workspaces whose plugins are not installed.
    const result = await loadPluginContractRegistry(RUNNER_VISIBLE_PLUGIN, {
      resolveFrom: [emptyBaseA, emptyBaseB],
      registryCache: new ContractRegistryCache(),
    });

    expect(result.isErr()).toBe(true);
  });
});
