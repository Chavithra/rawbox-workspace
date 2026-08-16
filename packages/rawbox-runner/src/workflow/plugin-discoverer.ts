import fs from 'node:fs/promises';
import path from 'node:path';
import { ok, err, type Result } from 'neverthrow';
import type { ContractRegistryCache } from '@rawbox/plugin/core';

import {
  CONTRACT_REGISTRY_SUBPATH,
  loadPluginContractRegistry,
  pluginRegistryResolvable,
} from './plugin-registry-loader.js';

/** Subpath every Rawbox plugin must export to expose its ContractRegistry. */
const REGISTRY_SUBPATH = `./${CONTRACT_REGISTRY_SUBPATH}`;

/** Keyword every Rawbox plugin must declare in `package.json`. */
const PLUGIN_KEYWORD = 'rawbox-plugin';

/**
 * Reads a dependency's package.json by walking up the node_modules chain from
 * `workspacePath`.
 *
 * `require.resolve('<dep>/package.json')` cannot be used here: Node's exports
 * encapsulation blocks any deep import a package's "exports" map does not list,
 * and `./package.json` is almost never listed. Since every Rawbox plugin is
 * required to declare "exports", that approach fails for exactly the packages
 * discovery is meant to find.
 */
async function readDependencyPackageJson(
  workspacePath: string,
  dep: string,
): Promise<Record<string, unknown>> {
  let dir = path.resolve(workspacePath);

  for (;;) {
    const candidate = path.join(
      dir,
      'node_modules',
      ...dep.split('/'),
      'package.json',
    );
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf8'));
    } catch {
      // Not installed at this level — keep walking up (handles hoisting).
    }

    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `not installed in any node_modules at or above '${workspacePath}'`,
  );
}

/** A dependency that matched the plugin naming convention but was not loadable. */
export interface SkippedPlugin {
  name: string;
  reason: string;
}

/** Outcome of scanning a workspace's dependencies for plugins. */
export interface PluginDiscoveryResult {
  plugins: string[];
  skipped: SkippedPlugin[];
}

/** Where a plugin's `./contract-registry` subpath should be resolved from. */
export interface PluginLoadOptions {
  /**
   * Directory (or directories, tried in order) to resolve plugin package names
   * against, using Node's ordinary `node_modules` walk-up.
   *
   * Without it a bare specifier resolves relative to *this* module — the
   * installed `@rawbox/runner` — which finds nothing when the plugins live in a
   * `node_modules` produced by `workspace setup` somewhere else on disk. Each
   * base is tried in turn and the bare specifier remains the last resort, so
   * passing this can only widen what is loadable.
   */
  resolveFrom?: string | readonly string[];
}

/**
 * Outcome of loading a set of plugin contract registries into a cache.
 *
 * `registryHashByPlugin` is the mapping `resolveWorkflow` requires:
 * `ContractRegistryCache` is keyed by content hash and a registry's only
 * back-reference is `contractRegistryPath`, which loses the package name
 * whenever the plugin is symlinked — the normal case for npm workspaces and
 * `file:` specifiers. Package identity therefore has to travel out of the
 * loader rather than be reverse-engineered from a path.
 *
 * Every entry is written from the hash returned by the very
 * `addContractRegistry` call that inserted the registry, so the map and the
 * cache are produced in a single pass and cannot disagree. That is what makes
 * the resolver's "stale map" error unreachable through this path.
 */
export interface PluginLoadResult {
  /** Package name → contract-registry hash, for `resolveWorkflow`. */
  registryHashByPlugin: Record<string, string>;
  /** Package names whose registry is now in the cache, in request order. */
  loaded: string[];
  /** Candidates that were not loaded, each with the reason why. */
  skipped: SkippedPlugin[];
}

export class PluginDiscoverer {
  public static isPlugin(pluginName: string): boolean {
    return (
      pluginName.startsWith('rawbox-plugin-') ||
      /^@[^/]+\/rawbox-plugin-/.test(pluginName)
    );
  }

  /** Normalizes {@link PluginLoadOptions.resolveFrom} to an array, defaulting to none. */
  private static normalizeResolveFrom(
    resolveFrom: PluginLoadOptions['resolveFrom'],
  ): string[] {
    return resolveFrom === undefined
      ? []
      : typeof resolveFrom === 'string'
        ? [resolveFrom]
        : [...resolveFrom];
  }

   /**
   * Scans workspace dependencies for Rawbox plugins. A dependency qualifies when it:
   *
   * 1. matches the `rawbox-plugin-*` naming convention (in any scope),
   * 2. declares the `rawbox-plugin` keyword in its `package.json`, and
   * 3. exposes a `./contract-registry` entry under `exports`.
   *
   * (1) and (2) are the opt-in signals a plugin author declares. (3) is a
   * loadability precondition: without it the subsequent `loadPlugin` import
   * would throw, so it is reported as a skip rather than left to fail later.
   *
   * Candidates failing any check are reported via `skipped` with a reason
   * instead of being dropped silently.
   *
   * @param workspacePath - The workspace directory to search.
   * @returns A promise resolving to the discovered plugins and any skipped candidates.
   */
  public static async discoverPlugins(
    workspacePath: string,
  ): Promise<Result<PluginDiscoveryResult, string>> {
    const pjsonPath = path.join(workspacePath, 'package.json');

    let pjson;
    try {
      const content = await fs.readFile(pjsonPath, 'utf8');
      pjson = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to read or parse package.json: ${message}`);
    }

    const dependencies = Object.keys({
      ...(typeof pjson.dependencies === 'object' ? pjson.dependencies : null),
    });

    const plugins: string[] = [];
    const skipped: SkippedPlugin[] = [];

    const checks = dependencies
      .filter((dep) => PluginDiscoverer.isPlugin(dep))
      .map(async (dep) => {
        let depPjson;
        try {
          depPjson = await readDependencyPackageJson(workspacePath, dep);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push({
            name: dep,
            reason: `could not resolve its package.json: ${message}`,
          });
          return;
        }

        const keywords: unknown = depPjson.keywords;
        if (
          !Array.isArray(keywords) ||
          !keywords.includes(PLUGIN_KEYWORD)
        ) {
          skipped.push({
            name: dep,
            reason: `its package.json "keywords" does not include "${PLUGIN_KEYWORD}"`,
          });
          return;
        }

        const pkgExports: unknown = depPjson.exports;
        if (
          typeof pkgExports !== 'object' ||
          pkgExports === null ||
          !(REGISTRY_SUBPATH in pkgExports)
        ) {
          skipped.push({
            name: dep,
            reason: `its package.json has no "${REGISTRY_SUBPATH}" entry under "exports"`,
          });
          return;
        }

        plugins.push(dep);
      });

    await Promise.all(checks);

    return ok({ plugins, skipped });
  }

  /**
   * Imports the ContractRegistry of a plugin package, adds it to the cache, and
   * returns the hash it was keyed under.
   *
   * The hash is the return value of `addContractRegistry`, so a caller pairing
   * it with `pluginName` obtains the name → hash mapping without any path
   * archaeology — see {@link PluginLoadResult}.
   *
   * @param pluginName - The package name of the plugin.
   * @param registryCache - The ContractRegistryCache to populate.
   * @param options - Optional resolution base, see {@link PluginLoadOptions}.
   * @returns The contract-registry hash the plugin was cached under.
   */
  public static async loadPlugin(
    pluginName: string,
    registryCache: ContractRegistryCache,
    options?: PluginLoadOptions,
  ): Promise<Result<string, string>> {
    const baseList = PluginDiscoverer.normalizeResolveFrom(options?.resolveFrom);

    const result = await loadPluginContractRegistry(pluginName, {
      resolveFrom: baseList,
      registryCache,
      // The last resort described on `PluginLoadOptions`, and the only reason
      // this caller enables it: with no base supplied, or none that resolves,
      // the bare specifier still finds a plugin that is a sibling workspace
      // package of the runner. `unresolved` is therefore unreachable here —
      // a package nobody can find surfaces as `import-failed` carrying Node's
      // own "Cannot find package" text, which names the specifier it tried.
      bareSpecifierFallback: true,
    });

    if (result.isOk()) {
      return ok(result.value.registryHash);
    }

    const failure = result.error;
    if (failure.kind === 'not-a-registry') {
      return err(
        `Module at '${pluginName}' does not have a default export ContractRegistry.`,
      );
    }
    if (failure.kind === 'import-failed') {
      return err(`Failed to import registry for '${pluginName}': ${failure.cause}`);
    }
    // Defensive: with the fallback on, the loader never reports `unresolved`.
    return err(
      `Failed to import registry for '${pluginName}': could not resolve ` +
        `'${failure.specifier}'.`,
    );
  }

  /**
   * Loads a known list of plugin packages into the cache and returns the
   * package → registry-hash mapping alongside it.
   *
   * The packages are named by the workflow's `plugins:` map, so
   * a caller usually knows them without scanning a `package.json`; that is what
   * this entry point exists for, and {@link discoverAndLoadPlugins} layers
   * discovery on top of it.
   *
   * A package that fails to load is recorded in `skipped` rather than aborting
   * the batch. A partial result is genuinely more useful than a hard failure
   * here: `resolveWorkflow` turns a declared-but-missing package into a
   * diagnostic that lists what *did* load, and `plugin info` has to report
   * per-package status, which it could not do if the first broken plugin ended
   * the walk.
   *
   * @param pluginNameList - Package names to load.
   * @param registryCache - The ContractRegistryCache to populate.
   * @param options - Optional resolution base, see {@link PluginLoadOptions}.
   */
  public static async loadPlugins(
    pluginNameList: readonly string[],
    registryCache: ContractRegistryCache,
    options?: PluginLoadOptions,
  ): Promise<PluginLoadResult> {
    const loadResults = await Promise.all(
      pluginNameList.map((pluginName) =>
        PluginDiscoverer.loadPlugin(pluginName, registryCache, options),
      ),
    );

    const registryHashByPlugin: Record<string, string> = {};
    const loaded: string[] = [];
    const skipped: SkippedPlugin[] = [];

    // Iterating the request list keeps the output order deterministic even
    // though the imports themselves ran concurrently.
    pluginNameList.forEach((pluginName, index) => {
      const result = loadResults[index]!;
      if (result.isErr()) {
        skipped.push({ name: pluginName, reason: result.error });
        return;
      }
      registryHashByPlugin[pluginName] = result.value;
      loaded.push(pluginName);
    });

    return { registryHashByPlugin, loaded, skipped };
  }

  /**
   * Cheaply checks which of the named plugins would NOT resolve from the
   * given bases, without importing any of them.
   *
   * This is `loadPlugins`' resolution step alone (see
   * {@link pluginRegistryResolvable}), used as a pre-flight probe: `workflow
   * run` calls it before deciding whether auto-setup is needed
   * (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)"), so a workspace whose declared plugins are
   * already installed never pays for a redundant install, and this check
   * never pays for a redundant `import()` either. It intentionally does *not*
   * duplicate `loadPlugins`' loading/caching behaviour — it answers "would
   * this resolve", nothing more.
   *
   * @param pluginNameList - Package names to check (a workflow's `plugins:` keys).
   * @param options - Optional resolution base, see {@link PluginLoadOptions}.
   * @returns Names, in request order, of the plugins that would NOT resolve.
   *   Empty means every plugin resolves.
   */
  public static findUnresolvedPlugins(
    pluginNameList: readonly string[],
    options?: PluginLoadOptions,
  ): string[] {
    const baseList = PluginDiscoverer.normalizeResolveFrom(options?.resolveFrom);
    return pluginNameList.filter(
      (pluginName) =>
        !pluginRegistryResolvable(pluginName, {
          resolveFrom: baseList,
          // Same reasoning as `loadPlugin`: a package resolvable only as a
          // sibling workspace package of `@rawbox/runner` itself must not be
          // reported as missing, since the real load would find it too.
          bareSpecifierFallback: true,
        }),
    );
  }

  /**
   * Scans workspace dependencies for plugins matching the naming convention,
   * verifies each declares the `rawbox-plugin` keyword and exposes
   * `./contract-registry`, imports their ContractRegistry instances into the
   * provided cache, and returns the package → registry-hash mapping produced by
   * that same walk.
   *
   * Errors only when discovery itself cannot proceed — an unreadable
   * `package.json`. Individual candidates that do not qualify, or that qualify
   * but fail to import, are reported through `skipped` with a reason.
   *
   * @param workspacePath - The workspace directory to search. It also becomes
   *   the default resolution base, so a package found in this directory's
   *   dependency graph is imported from that same graph.
   * @param registryCache - The ContractRegistryCache to populate.
   * @param options - Optional resolution base, see {@link PluginLoadOptions}.
   */
  public static async discoverAndLoadPlugins(
    workspacePath: string,
    registryCache: ContractRegistryCache,
    options?: PluginLoadOptions,
  ): Promise<Result<PluginLoadResult, string>> {
    const pluginsResult = await PluginDiscoverer.discoverPlugins(workspacePath);
    if (pluginsResult.isErr()) {
      return err(pluginsResult.error);
    }

    const { plugins, skipped } = pluginsResult.value;
    const loadResult = await PluginDiscoverer.loadPlugins(plugins, registryCache, {
      resolveFrom: options?.resolveFrom ?? workspacePath,
    });

    // A failed load is usually explained by the near-misses discovery found, so
    // the two skip lists are reported together rather than separately.
    return ok({
      registryHashByPlugin: loadResult.registryHashByPlugin,
      loaded: loadResult.loaded,
      skipped: [...skipped, ...loadResult.skipped],
    });
  }
}
