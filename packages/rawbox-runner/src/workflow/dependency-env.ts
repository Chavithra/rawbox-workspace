import crypto from 'node:crypto';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Dependency environments — `<targetFolder>/envs/<hash16>/`
//
// Every distinct `dependencies:` map is installed into its own npm project
// root, named by a hash of its normalized contents. This is the isolation
// pattern `npx` (`_npx/<hash16>/`), Snakemake (`.snakemake/conda/<hash>/`),
// `pre-commit` and `uv` use, and it is what lets two workflows of one
// workspace pin different versions of the same package: each set resolves in
// its own `node_modules`, so neither versions nor peers can collide.
//
// This module is the single source of truth for the three derived values the
// rest of the system keys on:
//   - the **normalized** specifier, which decides which env a set lands in
//     (machine-local: relative `file:` paths are made absolute);
//   - the **canonical lock** specifier, which keys `rawbox.lock` (portable:
//     relative `file:` paths stay relative, so a committed lock means the same
//     thing on every checkout);
//   - the env hash and directory, derived from the normalized set.
// ---------------------------------------------------------------------------

/** Directory under the target folder holding one subdirectory per env. */
export const DEPENDENCY_ENVS_DIRNAME = 'envs';

/**
 * Written into an env after its `npm install` succeeded, and removed before
 * an install starts.
 *
 * A `node_modules` that exists is not proof of a finished install — an
 * interrupted one leaves a partial tree behind — so readiness is a separate,
 * last-written fact rather than something inferred from what resolves.
 */
export const DEPENDENCY_ENV_READY_FILENAME = '.rawbox-env-ready.json';

/**
 * The per-env install lock `@rawbox/cli` takes around an install. The runner
 * never creates it; it only has to recognise it, so that pruning never deletes
 * an env some other process is installing into right now.
 */
export const DEPENDENCY_ENV_SETUP_LOCK_FILENAME = '.rawbox-setup.lock';

/** The shape of an env directory's name: 16 lower-case hex characters. */
export const DEPENDENCY_ENV_HASH_PATTERN = /^[0-9a-f]{16}$/;

/** Number of hex characters of the SHA-256 digest an env is named by. */
const DEPENDENCY_ENV_HASH_LENGTH = 16;

/** Prefix identifying an npm `file:` dependency specifier. */
const FILE_SPEC_PREFIX = 'file:';

/**
 * Normalizes a relative path for use as a portable key: forward slashes, no
 * `.` segments, no trailing slash, and no leading `./`.
 */
function canonicalRelativePath(target: string): string {
  const normalized = path.posix.normalize(target.replace(/\\/g, '/'));
  const withoutTrailing =
    normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  return withoutTrailing.startsWith('./') ? withoutTrailing.slice(2) : withoutTrailing;
}

/**
 * Machine-independent form of a specifier, as `rawbox.lock` keys it.
 *
 * Trimmed; a relative `file:` path is slash-normalized but **never resolved**
 * against a directory, because the lock is committed and an absolute path in
 * it would only ever match on the machine that wrote it. `file:./a/` and
 * `file:a` therefore share one key. An absolute `file:` path is normalized
 * the same way and otherwise kept, and every other specifier form (registry
 * ranges, `git+...`, tarball URLs) is only trimmed.
 */
export function canonicalLockSpecifier(specifier: string): string {
  const trimmed = specifier.trim();
  if (!trimmed.startsWith(FILE_SPEC_PREFIX)) {
    return trimmed;
  }

  const target = trimmed.slice(FILE_SPEC_PREFIX.length);
  if (path.isAbsolute(target)) {
    let normalized = path.normalize(target);
    const rootLength = path.parse(normalized).root.length;
    while (normalized.length > rootLength && /[\\/]$/.test(normalized)) {
      normalized = normalized.slice(0, -1);
    }
    return `${FILE_SPEC_PREFIX}${normalized}`;
  }
  return `${FILE_SPEC_PREFIX}${canonicalRelativePath(target)}`;
}

/**
 * Trims a specifier and rewrites a relative `file:` one to an absolute one,
 * resolved against `baseDir` — the directory containing the workspace file.
 *
 * npm resolves a relative `file:` specifier against the *generated* env
 * `package.json`, not the workflow file that declared it, so splicing
 * `dependencies:` verbatim would silently break relative local paths. Absolute
 * `file:` specs and every other specifier form pass through, trimmed.
 *
 * Without a `baseDir` there is nothing to resolve against, and the result is
 * {@link canonicalLockSpecifier}'s portable form instead.
 */
export function normalizeDependencySpecifier(specifier: string, baseDir?: string): string {
  const trimmed = specifier.trim();
  if (!trimmed.startsWith(FILE_SPEC_PREFIX)) {
    return trimmed;
  }

  const target = trimmed.slice(FILE_SPEC_PREFIX.length);
  if (path.isAbsolute(target) || baseDir === undefined) {
    return canonicalLockSpecifier(trimmed);
  }
  return `${FILE_SPEC_PREFIX}${path.resolve(baseDir, target)}`;
}

/**
 * Key-sorted copy of `dependencies`, every specifier passed through
 * {@link normalizeDependencySpecifier}.
 *
 * Sorted because the result is both hashed and written into an env's
 * `package.json`: two workflows listing the same packages in a different
 * order are one dependency set and must produce one byte-identical manifest.
 */
export function normalizeDependencyRecord(
  dependencies: Readonly<Record<string, string>>,
  baseDir?: string,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const name of Object.keys(dependencies).sort()) {
    // Guarded: `name` comes from `Object.keys(dependencies)`.
    normalized[name] = normalizeDependencySpecifier(dependencies[name] as string, baseDir);
  }
  return normalized;
}

/**
 * Names the env a dependency set installs into: the first 16 hex characters
 * of SHA-256 over `JSON.stringify` of its sorted `[name, normalizedSpecifier]`
 * pairs.
 *
 * Hashing the **normalized** specifiers is what makes `file:./a/`, `file:a`
 * and `file:/abs/ws/a` one env on one machine. 64 bits is far beyond the
 * handful of sets a workspace ever declares; the short name keeps
 * `node_modules` paths readable in a stack trace.
 */
export function dependencyEnvHash(
  dependencies: Readonly<Record<string, string>>,
  baseDir?: string,
): string {
  const pairs = Object.entries(normalizeDependencyRecord(dependencies, baseDir));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(pairs))
    .digest('hex')
    .slice(0, DEPENDENCY_ENV_HASH_LENGTH);
}

/**
 * `<targetFolder>/envs/<hash16>`, absolute — or `undefined` when
 * `dependencies` is empty.
 *
 * An empty set has nothing to install, and giving it a directory anyway would
 * create an npm project whose only purpose is to exist.
 */
export function resolveDependencyEnvDir(
  targetFolder: string,
  dependencies: Readonly<Record<string, string>>,
  baseDir?: string,
): string | undefined {
  if (Object.keys(dependencies).length === 0) {
    return undefined;
  }
  return path.join(
    path.resolve(targetFolder),
    DEPENDENCY_ENVS_DIRNAME,
    dependencyEnvHash(dependencies, baseDir),
  );
}

/** One env a workspace needs, and which of its workflows need it. */
export interface DependencyEnvGroup {
  readonly hash: string;
  /** Absolute `<targetFolder>/envs/<hash>`. */
  readonly envDir: string;
  /** The normalized, key-sorted dependency set installed into `envDir`. */
  readonly dependencies: Record<string, string>;
  /** `workflowPathList` entries that hash to this env, for diagnostics. */
  readonly workflowPathList: readonly string[];
}

/**
 * Deduplicates workflows into env groups, in first-seen order.
 *
 * Workflows with an empty `dependencies:` map belong to no env and are
 * skipped. Identical normalized sets collapse into one group listing every
 * workflow that declared it, so a failed install can name all of them.
 */
export function groupDependencyEnvs(
  targetFolder: string,
  workflows: ReadonlyArray<{
    readonly path: string;
    readonly dependencies: Readonly<Record<string, string>>;
  }>,
  baseDir?: string,
): DependencyEnvGroup[] {
  const groupByHash = new Map<
    string,
    { hash: string; envDir: string; dependencies: Record<string, string>; workflowPathList: string[] }
  >();

  for (const workflow of workflows) {
    const envDir = resolveDependencyEnvDir(targetFolder, workflow.dependencies, baseDir);
    if (envDir === undefined) continue;

    const hash = path.basename(envDir);
    const existing = groupByHash.get(hash);
    if (existing) {
      existing.workflowPathList.push(workflow.path);
      continue;
    }

    groupByHash.set(hash, {
      hash,
      envDir,
      dependencies: normalizeDependencyRecord(workflow.dependencies, baseDir),
      workflowPathList: [workflow.path],
    });
  }

  return [...groupByHash.values()];
}
