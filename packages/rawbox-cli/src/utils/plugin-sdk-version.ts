import { resolveFrameworkPluginVersion } from '@rawbox/runner';

/**
 * Fallback used only when `@rawbox/plugin` cannot be resolved from wherever
 * `rawbox-cli` itself is running (a broken install) — kept in sync with this
 * package's own `@rawbox/plugin` dependency by hand for that one case. Every
 * normal run resolves the real, current version instead.
 */
const FALLBACK_PLUGIN_SDK_VERSION = '0.1.0';

/**
 * The `@rawbox/plugin` version a newly scaffolded plugin's **peer** range floors
 * at. Templates render it as a caret range.
 *
 * This is the only version in a scaffolded plugin that has to track the
 * framework, and it is resolved rather than hardcoded for a reason this repo has
 * already paid for once: a range written into a template is a range nobody
 * remembers to bump, and it silently produces scaffolds pinned to a release that
 * is no longer current. Resolving it means a scaffold is always born matching the
 * framework that produced it.
 *
 * There is no corresponding `typebox` floor any more, and there should not be
 * one: `@rawbox/plugin` re-exports both `typebox` and `neverthrow` at its own
 * subpaths (`@rawbox/plugin/typebox`, `@rawbox/plugin/neverthrow`), so a
 * scaffolded plugin declares neither and cannot drift from the framework's copy
 * of either.
 *
 * It lives here rather than beside one command because **both** `plugin create`
 * and `project create` render `templates/plugin/package.json.ejs`. When only the
 * first supplied the value, the second rendered the range as `^undefined` — a
 * scaffold that installs nothing and fails at its first import.
 */
export async function resolvePluginSdkFloorVersion(): Promise<string> {
  return (await resolveFrameworkPluginVersion()) ?? FALLBACK_PLUGIN_SDK_VERSION;
}
