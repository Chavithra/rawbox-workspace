import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Package version resolution across the plugin boundary
//
// `@rawbox/plugin` depends on `typebox` directly and re-exports it at
// `@rawbox/plugin/typebox`, so a plugin importing its schema library from there
// has no copy of its own and shares the framework's by construction. Such a
// plugin makes this module report nothing at all — `resolveTypeboxVersionFrom`
// finds no typebox in its resolution chain and returns `undefined`, which is the
// intended outcome rather than a failure.
//
// A plugin may still declare its own `typebox` (contracts are plain JSON Schema;
// nothing forces the passthrough), and that copy can resolve to a *different*
// version than the one the framework was built against — two separate copies,
// npm's dedup only works within one resolution tree. Those are the plugins this
// module still has something to say about.
//
// That disagreement is not, on its own, a hazard: `@rawbox/plugin`'s public
// generics do not constrain on typebox's `TObject`, so a plugin's schemas
// typecheck and run the same regardless of which copy built them (typebox
// schemas are plain JSON with no symbols or identity to lose crossing a
// package boundary). The actual guard against a *future* cross-copy
// regression is a type-level test in `packages/rawbox-plugin`, not this
// module.
//
// What this module does is answer, from the two packages' own resolved
// `node_modules`, which `typebox` versions each of them sees — and report
// that as plain-language context wherever a plugin is resolved, useful to
// attach to some other error but asserting nothing wrong by itself.
// ---------------------------------------------------------------------------

/** The schema library both the framework and its plugins build contracts with. */
export const TYPEBOX_PACKAGE_NAME = 'typebox';

/**
 * The plugin SDK itself — the one package every plugin must resolve, and the
 * package whose version a freshly scaffolded plugin floors its peer range at.
 */
export const PLUGIN_SDK_PACKAGE_NAME = '@rawbox/plugin';

/**
 * Filename `createRequire` is anchored at inside a directory.
 *
 * It never has to exist: only the *directory* participates in Node's
 * `node_modules` walk-up, the basename is discarded. Mirrors the same trick
 * `plugin-registry-loader.ts` uses to resolve a plugin's contract registry.
 */
const RESOLUTION_ANCHOR_FILENAME = '__rawbox_resolution__.cjs';

/**
 * Walks up from `startPath` to the nearest `package.json` naming `packageName`
 * and returns its `version`.
 *
 * `require.resolve('<pkg>/package.json')` cannot be used here: typebox's own
 * `package.json` declares an `exports` map with no `./package.json` entry, so
 * Node's exports encapsulation blocks that deep import outright (the same
 * constraint `readInstalledVersion` in `lock.ts` documents for a plugin's own
 * package.json). Walking up from a file Node *did* resolve inside the
 * package — its main entry — sidesteps the encapsulation entirely.
 */
async function readPackageVersionByWalkUp(
  startPath: string,
  packageName: string,
): Promise<string | undefined> {
  let dir = path.dirname(startPath);

  for (;;) {
    try {
      const raw = await fs.readFile(path.join(dir, 'package.json'), 'utf-8');
      const pjson = JSON.parse(raw) as { name?: unknown; version?: unknown };
      if (pjson.name === packageName) {
        return typeof pjson.version === 'string' && pjson.version.length > 0
          ? pjson.version
          : undefined;
      }
    } catch {
      // No readable package.json at this level — keep walking up.
    }

    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolves the version of `packageName` that `require(packageName)` would see
 * when resolved from `anchorDir` — i.e. the copy whatever lives in `anchorDir`
 * actually builds and runs against.
 *
 * Returns `undefined`, never throws, when `anchorDir`'s own resolution chain has
 * no such package at all. That absence is not a fault for this helper to report:
 * every caller here treats "cannot tell" as "say nothing", and manufacturing a
 * version would be worse than declining to answer.
 */
export async function resolvePackageVersionFrom(
  anchorDir: string,
  packageName: string,
): Promise<string | undefined> {
  let mainEntry: string;
  try {
    const requireFrom = createRequire(
      path.join(path.resolve(anchorDir), RESOLUTION_ANCHOR_FILENAME),
    );
    mainEntry = requireFrom.resolve(packageName);
  } catch {
    return undefined;
  }
  return readPackageVersionByWalkUp(mainEntry, packageName);
}

/**
 * Resolves the version of `typebox` visible from `anchorDir`.
 *
 * Returns `undefined` for a plugin with no typebox of its own — which, since
 * `@rawbox/plugin` began re-exporting the library at `@rawbox/plugin/typebox`,
 * is the expected shape for a well-behaved plugin rather than an unusual one.
 */
export async function resolveTypeboxVersionFrom(
  anchorDir: string,
): Promise<string | undefined> {
  return resolvePackageVersionFrom(anchorDir, TYPEBOX_PACKAGE_NAME);
}

/** Directory this module's own resolution is anchored at — the framework's install. */
const FRAMEWORK_ANCHOR_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the `typebox` version the framework itself resolves and was built
 * against — i.e. the copy `@rawbox/plugin` and `@rawbox/runner` share via
 * `@rawbox/plugin`'s peer dependency.
 *
 * Anchored at this module's own installed location rather than at any
 * plugin's, so it always answers "what does the framework see", independent
 * of whatever plugin is being checked against it.
 */
export async function resolveFrameworkTypeboxVersion(): Promise<string | undefined> {
  return resolveTypeboxVersionFrom(FRAMEWORK_ANCHOR_DIR);
}

/**
 * Resolves the version of `@rawbox/plugin` this framework install actually
 * resolves — the SDK a plugin scaffolded by *this* CLI will be built against.
 *
 * `rawbox-cli plugin create` floors the generated `peerDependencies` range at
 * this, so a scaffold is born matching the framework that produced it rather
 * than a version hardcoded in a template that nobody remembers to bump. This is
 * the one range in a scaffolded plugin that genuinely must track the framework:
 * `typebox` and `neverthrow` now arrive through `@rawbox/plugin`'s own
 * passthrough subpaths, so a plugin declares neither.
 *
 * Returns `undefined` only when the SDK cannot be resolved from the framework's
 * own install, which means something is badly wrong with the installation — the
 * caller falls back to a constant rather than failing the scaffold.
 */
export async function resolveFrameworkPluginVersion(): Promise<string | undefined> {
  return resolvePackageVersionFrom(FRAMEWORK_ANCHOR_DIR, PLUGIN_SDK_PACKAGE_NAME);
}

/**
 * Renders a one-line, factual note of a plugin/framework typebox version
 * difference, or `undefined` when the versions agree (nothing to report).
 *
 * States the two versions and nothing else — no diagnosis, no suggested
 * fix. See the module header for why: the versions differing is no longer
 * known to cause any problem, so this is context to attach to some other
 * error, not an error of its own.
 */
export function typeboxVersionNote(
  packageName: string,
  pluginTypeboxVersion: string,
  frameworkTypeboxVersion: string,
): string | undefined {
  if (pluginTypeboxVersion === frameworkTypeboxVersion) return undefined;

  return (
    `plugin "${packageName}" resolves typebox ${pluginTypeboxVersion}; ` +
    `@rawbox/plugin resolves ${frameworkTypeboxVersion}.`
  );
}

/**
 * Resolves the plugin's and the framework's typebox versions independently
 * and, when they differ, returns a one-line factual note pairing them.
 *
 * @param packageName - The plugin's package name, for the note.
 * @param pluginAnchorDir - A directory inside the plugin's own install (its
 *   resolved contract-registry module, typically) — resolution walks *its*
 *   `node_modules` chain, not the framework's, so the plugin's real installed
 *   version is what gets compared.
 * @returns The note, or `undefined` when there is nothing to report — either
 *   the versions agree, or one side has no typebox to compare (e.g. a
 *   hand-written JSON Schema plugin, or the framework check itself failing to
 *   resolve, which should never silently manufacture a false difference).
 */
export async function resolveTypeboxVersionNote(
  packageName: string,
  pluginAnchorDir: string,
): Promise<string | undefined> {
  const pluginVersion = await resolveTypeboxVersionFrom(pluginAnchorDir);
  if (!pluginVersion) return undefined;

  const frameworkVersion = await resolveFrameworkTypeboxVersion();
  if (!frameworkVersion) return undefined;

  return typeboxVersionNote(packageName, pluginVersion, frameworkVersion);
}
