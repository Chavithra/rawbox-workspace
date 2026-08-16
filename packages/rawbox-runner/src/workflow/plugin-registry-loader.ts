import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ok, err, type Result } from 'neverthrow';
import {
  ContractRegistryCache,
  type Contract,
  type ContractRegistry,
} from '@rawbox/plugin/core';

import { getErrorMessage } from '../utils/error.js';
import { resolveTypeboxVersionNote } from './typebox-compat.js';

// ---------------------------------------------------------------------------
// The one place a plugin's contract registry is resolved, imported and hashed
//
// Three call sites need "package name → contract registry + its hash":
// `PluginDiscoverer.loadPlugins` (running a workflow), `resolvePluginLockEntries`
// (writing rawbox.lock) and `loadPluginRegistries` (verifying a workflow).
//
// What they do *not* share is policy, and that is deliberately left outside:
//
//   - which base directories to try, and whether a bare specifier is an
//     acceptable last resort (only the runner's is — see `bareSpecifierFallback`);
//   - what to do with a failure — skip the package, or fail the whole batch;
//   - how to word the diagnostic. These messages are the only thing telling a
//     plugin author why their package will not load, and each caller can say
//     something the others cannot ("re-run workspace setup", "install the
//     workspace's plugins first", "build the plugin and retry").
//
// So this module returns a *structured* failure rather than a sentence, and each
// caller renders it with the wording that suits its own context.
// ---------------------------------------------------------------------------

/** Subpath every Rawbox plugin must export to expose its `ContractRegistry`. */
export const CONTRACT_REGISTRY_SUBPATH = 'contract-registry';

/**
 * Filename `createRequire` is anchored at inside a base directory.
 *
 * It never has to exist: only the *directory* participates in Node's
 * `node_modules` walk-up, the basename is discarded.
 */
const RESOLUTION_ANCHOR_FILENAME = '__rawbox_registry_resolution__.cjs';

/** The specifier a plugin's contract registry is always published under. */
export function contractRegistrySpecifier(packageName: string): string {
  return `${packageName}/${CONTRACT_REGISTRY_SUBPATH}`;
}

/** Why {@link loadPluginContractRegistry} could not produce a registry. */
export type PluginRegistryLoadFailure =
  /** No supplied base directory could resolve the specifier. */
  | {
      kind: 'unresolved';
      packageName: string;
      specifier: string;
      /** The bases that were tried, absolute and in order. */
      searchedList: readonly string[];
      /**
       * Node's own resolution error from the **last** base tried, absent only
       * when no base was supplied at all. Kept because with a single base — the
       * locking case — it is the precise "Cannot find module" text naming what
       * Node looked for, and dropping it would flatten that diagnostic.
       */
      cause?: string;
    }
  /** The module was found but `import()` threw. */
  | ({
      kind: 'import-failed';
      packageName: string;
      specifier: string;
      /** Absent when the bare-specifier fallback was what got imported. */
      registryPath?: string;
      cause: string;
    } & TypeboxVersionNote)
  /** The module imported but carries no registry. */
  | ({
      kind: 'not-a-registry';
      packageName: string;
      specifier: string;
      /** Absent when the bare-specifier fallback was what got imported. */
      registryPath?: string;
    } & TypeboxVersionNote);

/**
 * Plain-language typebox version context attached to a failure or a load
 * result when the plugin's own resolved `typebox` differs from the
 * framework's — see `typebox-compat.ts`. Present only when the two versions
 * differ; agreement, or a comparison that could not resolve one side, adds
 * nothing.
 */
type TypeboxVersionNote = { typeboxVersionNote?: string };

/** A successfully loaded plugin contract registry. */
export interface LoadedPluginRegistry {
  packageName: string;
  registry: ContractRegistry<Contract>;
  /**
   * SHA-256 of the registry. When a cache was supplied this is the value that
   * very `addContractRegistry` call returned, so a caller pairing it with
   * `packageName` gets the name → hash mapping without any path archaeology,
   * and the map can never describe a registry the cache lacks.
   */
  registryHash: string;
  /**
   * Absolute path of the module that was imported. Absent only when the
   * bare-specifier fallback resolved it, since then Node — not this module —
   * decided where it came from.
   */
  registryPath?: string;
  /**
   * Set when this plugin's own resolved `typebox` differs from the
   * framework's — see `typebox-compat.ts`. Reported as context only: it has
   * no bearing on whether the registry loaded, so it is attached here
   * exactly the same way it is attached to a failure below.
   */
  typeboxVersionNote?: string;
}

/** How {@link loadPluginContractRegistry} should look for the registry. */
export interface LoadPluginContractRegistryOptions {
  /**
   * Base directories to resolve against, tried in order; the first that
   * resolves wins. Each is anchored with `createRequire`, which then walks
   * `node_modules` upwards exactly as npm would at run time.
   */
  resolveFrom: readonly string[];
  /**
   * When no base resolves, import the bare specifier — i.e. let Node resolve it
   * relative to *this* module, the installed `@rawbox/runner`.
   *
   * Only `PluginDiscoverer.loadPlugin` enables this, and it is load-bearing
   * there: it is why `@rawbox/rawbox-plugin-default` resolves inside this
   * monorepo, where the plugin is a sibling workspace package rather than
   * something installed under the workflow.
   *
   * It must stay off for locking and verifying: those two answer questions
   * *about a specific workspace*, and silently recording the runner's own
   * dependency tree instead would be a wrong answer rather than a missing one.
   */
  bareSpecifierFallback?: boolean;
  /**
   * Cache to populate. When omitted the hash is computed without caching, for
   * callers that only want the hash.
   */
  registryCache?: ContractRegistryCache;
}

/**
 * Narrows a dynamically imported module to something registry-shaped.
 *
 * The default export is the contract every plugin template emits. The named
 * `contractRegistry` export is accepted too because `setupPluginRegistry`
 * returns it under that name and a plugin may re-export it without a default.
 *
 * `contractRecord` is the discriminator rather than an `instanceof` check: the
 * registry crosses a dynamic-import boundary, so it may come from a different
 * realm, and `computeHash` reads nothing else.
 */
function pickRegistry(module: unknown): ContractRegistry<Contract> | undefined {
  if (typeof module !== 'object' || module === null) return undefined;

  const candidates = [
    (module as { default?: unknown }).default,
    (module as { contractRegistry?: unknown }).contractRegistry,
  ];

  for (const candidate of candidates) {
    if (
      typeof candidate === 'object' &&
      candidate !== null &&
      'contractRecord' in candidate
    ) {
      return candidate as ContractRegistry<Contract>;
    }
  }

  return undefined;
}

/**
 * Resolves `<packageName>/contract-registry` against each base in turn.
 *
 * A bare `import()` cannot do this job: evaluated inside `@rawbox/runner` it
 * resolves against the *runner's* `node_modules`, not against the workspace
 * being locked, verified or run.
 */
function resolveRegistryPath(
  specifier: string,
  baseList: readonly string[],
): { path: string } | { path: undefined; cause?: string } {
  let cause: string | undefined;

  for (const base of baseList) {
    try {
      const requireFrom = createRequire(
        path.join(path.resolve(base), RESOLUTION_ANCHOR_FILENAME),
      );
      return { path: requireFrom.resolve(specifier) };
    } catch (error) {
      // This base cannot see the package — try the next one, remembering why
      // this one failed so a single-base caller can quote Node verbatim.
      cause = getErrorMessage(error);
    }
  }

  return cause === undefined ? { path: undefined } : { path: undefined, cause };
}

/**
 * Cheaply checks whether a plugin's contract registry would resolve from the
 * given bases — without importing it.
 *
 * Mirrors exactly the resolution {@link loadPluginContractRegistry} performs:
 * the same `createRequire` walk over `resolveFrom`, then (when enabled) the
 * same bare-specifier fallback — but stops short of the `import()` call,
 * which is the expensive, side-effecting part. This is the primitive
 * `workflow run`'s auto-setup pre-check is built on
 * (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)"): whether a declared plugin is already
 * installed, answered without paying to load it twice.
 *
 * The bare-specifier fallback is approximated with `require.resolve` anchored
 * at *this* module, the same anchor `import(specifier)` would resolve a bare
 * specifier against — so a plugin only reachable that way (e.g. a sibling
 * workspace package of `@rawbox/runner` itself, the case
 * `bareSpecifierFallback` exists for) is correctly reported as resolvable.
 *
 * @param packageName - The package name to check (a workflow's `plugins:` key).
 * @param options - Same resolution knobs as {@link loadPluginContractRegistry}.
 * @returns Whether the plugin's contract registry would resolve.
 */
export function pluginRegistryResolvable(
  packageName: string,
  options: LoadPluginContractRegistryOptions,
): boolean {
  const specifier = contractRegistrySpecifier(packageName);
  const resolution = resolveRegistryPath(specifier, options.resolveFrom);
  if (resolution.path !== undefined) {
    return true;
  }
  if (options.bareSpecifierFallback !== true) {
    return false;
  }
  try {
    createRequire(import.meta.url).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves, imports and hashes one plugin's contract registry.
 *
 * The hash is taken from the `addContractRegistry` call that inserted the
 * registry, so cache and hash are produced in a single pass and cannot disagree
 * — the invariant that makes the resolver's "stale map" error unreachable
 * through every one of these paths.
 *
 * Failures are returned as data, not prose: see the module header for why.
 */
export async function loadPluginContractRegistry(
  packageName: string,
  options: LoadPluginContractRegistryOptions,
): Promise<Result<LoadedPluginRegistry, PluginRegistryLoadFailure>> {
  const specifier = contractRegistrySpecifier(packageName);
  const resolution = resolveRegistryPath(specifier, options.resolveFrom);
  const registryPath = resolution.path;

  if (registryPath === undefined && options.bareSpecifierFallback !== true) {
    const cause = 'cause' in resolution ? resolution.cause : undefined;
    return err({
      kind: 'unresolved',
      packageName,
      specifier,
      searchedList: options.resolveFrom.map((base) => path.resolve(base)),
      ...(cause === undefined ? {} : { cause }),
    });
  }

  // `registryPath === undefined` here means the fallback is in play: hand Node
  // the bare specifier and let it resolve from this module's own graph.
  const importTarget =
    registryPath === undefined ? specifier : pathToFileURL(registryPath).href;

  // Cheap and purely informational — see `typebox-compat.ts`. Only possible
  // when a base actually resolved the registry on disk: the bare-specifier
  // fallback has no path of the *plugin's* own to anchor the walk-up at, so
  // it is skipped rather than accidentally comparing the framework against
  // itself.
  const typeboxVersionNote =
    registryPath !== undefined
      ? await resolveTypeboxVersionNote(packageName, path.dirname(registryPath))
      : undefined;

  let module: unknown;
  try {
    module = await import(importTarget);
  } catch (error) {
    return err({
      kind: 'import-failed',
      packageName,
      specifier,
      ...(registryPath === undefined ? {} : { registryPath }),
      ...(typeboxVersionNote === undefined ? {} : { typeboxVersionNote }),
      cause: getErrorMessage(error),
    });
  }

  const registry = pickRegistry(module);
  if (!registry) {
    return err({
      kind: 'not-a-registry',
      packageName,
      specifier,
      ...(registryPath === undefined ? {} : { registryPath }),
      ...(typeboxVersionNote === undefined ? {} : { typeboxVersionNote }),
    });
  }

  const registryHash = options.registryCache
    ? options.registryCache.addContractRegistry(registry)
    : ContractRegistryCache.computeHash(registry);

  return ok({
    packageName,
    registry,
    registryHash,
    ...(registryPath === undefined ? {} : { registryPath }),
    ...(typeboxVersionNote === undefined ? {} : { typeboxVersionNote }),
  });
}
