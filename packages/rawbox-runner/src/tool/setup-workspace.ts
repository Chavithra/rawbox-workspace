import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Compile } from 'typebox/compile';
import { ok, err, type Result } from 'neverthrow';

import { Workspace, resolveTargetFolder, workspaceKindError } from '../workspace/workspace-types.js';
import { resolveWorkspaceWorkflowPath } from '../workspace/workflow-path.js';
import { type Workflow, type DependencySpecifierRecord } from '../workflow/workflow-types.js';
import {
  DEPENDENCY_ENVS_DIRNAME,
  DEPENDENCY_ENV_HASH_PATTERN,
  DEPENDENCY_ENV_READY_FILENAME,
  DEPENDENCY_ENV_SETUP_LOCK_FILENAME,
  groupDependencyEnvs,
  normalizeDependencyRecord,
  resolveDependencyEnvDir,
  type DependencyEnvGroup,
} from '../workflow/dependency-env.js';
import { formatValidationErrors, validateWorkflowType } from '../workflow/validation.js';
import { parseConfig } from '../utils/config.js';
import { getErrorMessage } from '../utils/error.js';


const workspaceValidator = Compile(Workspace);

const execFileAsync = promisify(execFile);

/** Env installs `setupWorkspace` runs at once when `SetupOptions.concurrency` is unset. */
const DEFAULT_SETUP_CONCURRENCY = 2;

/**
 * Upper bound on the output buffered from one `npm install`. Only stderr is
 * ever read, but `execFile` buffers both streams and kills the child when
 * either overflows, so the bound has to be generous rather than tight.
 */
const NPM_INSTALL_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Why `--install-links` fails more often than it looks like it should.
 *
 * Without the flag npm *links* a `file:` dependency: it symlinks the directory
 * and never looks at that package's own dependencies, so an unpublished one is
 * simply never consulted. `--install-links` copies instead, which forces npm to
 * build a real dependency tree for the copied package — and a workspace-internal
 * dependency that was only ever resolved by hoisting (`@rawbox/plugin: "*"` in
 * this monorepo) is then looked up in the registry and 404s.
 *
 * So the flag works for a self-contained plugin whose dependencies are all
 * published, and cannot work for a local monorepo plugin. That is worth stating
 * outright, because the failure surfaces as a 404 for a package the user never
 * wrote down.
 */
const INSTALL_LINKS_HINT =
  `\`--install-links\` copies each \`file:\` plugin instead of linking it, so npm must ` +
  `resolve that plugin's own dependencies — including its peers — from the registry. A ` +
  `plugin needing an unpublished package cannot be installed this way; the 404 above ` +
  `names it. Re-run without \`--install-links\` to link the plugin instead, which ` +
  `resolves its dependencies from where it already lives.\n\n` +
  `Do not reach for \`--legacy-peer-deps\` to force this through: it makes the install ` +
  `succeed while leaving the peer absent, so the copied plugin fails later with ` +
  `"Cannot find package" at the moment it is imported. An install-time 404 is the better ` +
  `of the two failures.`;

export async function loadAndValidateWorkspace(workspacePath: string): Promise<Result<Workspace, string>> {
  const absoluteWorkspacePath = path.resolve(workspacePath);
  
  try {
    const content = await fs.readFile(absoluteWorkspacePath, 'utf-8');
    const parsed = parseConfig(content, absoluteWorkspacePath);
    if (parsed.isErr()) {
      return err(parsed.error);
    }
    const workspaceData: unknown = parsed.value;

    // Identity before schema, for the same reason `validateWorkflowType` checks
    // it first: a document with no `kind:` is missing exactly one line, and
    // saying so beats a schema error reading `Path "/kind" : Expected required
    // property`.
    const kindError = workspaceKindError(workspaceData, absoluteWorkspacePath);
    if (kindError !== undefined) {
      return err(kindError);
    }

    if (!workspaceValidator.Check(workspaceData)) {
      const errorDetails = formatValidationErrors(
        workspaceValidator.Errors(workspaceData),
        workspaceData,
      );
      return err(`Workspace JSON validation failed for "${absoluteWorkspacePath}":\n${errorDetails}`);
    }
    
    return ok(workspaceData);
  } catch (e) {
    return err(`Failed to read or parse workspace JSON at "${absoluteWorkspacePath}": ${getErrorMessage(e)}`);
  }
}

/**
 * Reads a workspace document and answers where its plugins live on disk.
 *
 * Every command that resolves a declared package — `workflow verify`,
 * `workflow lock`, `plugin info` — has to agree with `workflow run` about this,
 * or a workspace that declares `targetFolder:` would run fine while the tooling
 * meant to check it ahead of time reported the plugins as missing.
 *
 * An unreadable or invalid document falls back to the workspace directory
 * rather than failing: every caller already reports document problems through
 * its own validation path, and none of them should die inside a path lookup.
 * The fallback is **named**, though — `fallbackReason` carries why — because a
 * document that declares `targetFolder: ../shared` and has one schema error
 * would otherwise send plugin resolution and the LMDB data directory
 * somewhere its author never wrote, with nothing saying so.
 */
export interface ResolvedWorkspaceTargetFolder {
  readonly targetFolder: string;
  /**
   * Set when the workspace document could not be loaded and `targetFolder`
   * is the workspace directory by fallback rather than by declaration.
   */
  readonly fallbackReason?: string;
}

export async function resolveWorkspaceTargetFolder(
  workspacePath: string,
): Promise<ResolvedWorkspaceTargetFolder> {
  const workspaceDir = path.dirname(path.resolve(workspacePath));
  const workspaceResult = await loadAndValidateWorkspace(workspacePath);
  return workspaceResult.isOk()
    ? { targetFolder: resolveTargetFolder(workspaceDir, workspaceResult.value) }
    : { targetFolder: workspaceDir, fallbackReason: workspaceResult.error };
}

/**
 * A validated workflow paired with the relative path — as written in the
 * workspace's `workflowPathList` — it was loaded from.
 *
 * The path travels with the workflow (rather than being re-derived later)
 * because {@link setupWorkspace} needs it to name *which* workflows use an env
 * whose install failed, and by then the workflow object alone no longer
 * carries that information.
 */
export interface LoadedWorkflow {
  /** As declared in `workspace.workflowPathList`, e.g. `./workflows/a.workflow.yaml`. */
  readonly path: string;
  readonly workflow: Workflow;
}

/**
 * Loads and validates all workflows listed in the workspace from their relative
 * paths.
 *
 * Goes through `validateWorkflowType` rather than compiling `Workflow` here, so
 * that every entry point that reads a workflow document gets the same
 * diagnostics rather than a union branch dump.
 */
export async function loadAndValidateWorkflows(workspacePath: string, workspace: Workspace): Promise<Result<LoadedWorkflow[], string>> {
  const workspaceDir = path.dirname(path.resolve(workspacePath));
  const workflows: LoadedWorkflow[] = [];

  for (const relWorkflowPath of workspace.workflowPathList) {
    const absoluteWorkflowPath = resolveWorkspaceWorkflowPath(
      workspaceDir,
      relWorkflowPath,
    );
    try {
      const content = await fs.readFile(absoluteWorkflowPath, 'utf-8');
      const parsed = parseConfig(content, absoluteWorkflowPath);
      if (parsed.isErr()) {
        return err(`Workflow "${relWorkflowPath}" could not be parsed: ${parsed.error}`);
      }
      const workflowData: unknown = parsed.value;

      const typeResult = validateWorkflowType(workflowData, absoluteWorkflowPath);
      if (typeResult.isErr()) {
        return err(
          `Workflow validation failed for "${relWorkflowPath}":\n${typeResult.error.message}`,
        );
      }

      workflows.push({ path: relWorkflowPath, workflow: workflowData as Workflow });
    } catch (e) {
      return err(`Failed to read or parse workflow JSON at "${relWorkflowPath}": ${getErrorMessage(e)}`);
    }
  }

  return ok(workflows);
}

/** Knobs shared by `setupDependencyEnv` and `setupWorkspace`. */
export interface SetupOptions {
  /**
   * Pass `--install-links` to `npm install`.
   *
   * npm treats a `file:` dependency as a **link**: it symlinks the package and
   * does not install that package's own dependencies into the env, so the env
   * holds the symlink and nothing else. That is the default here on purpose —
   * a symlinked plugin keeps the local development loop live, since editing
   * and rebuilding the plugin is picked up by the next run with no second
   * `workspace setup`.
   *
   * `--install-links` makes npm *copy* the package and install its transitive
   * dependencies, producing an env that is self-contained and portable at the
   * cost of being a snapshot: further edits to the plugin are invisible until
   * setup is run again. Opt in when the target folder is going to be moved to a
   * machine that has not installed the plugin independently.
   */
  installLinks?: boolean | undefined;
  /**
   * `setupWorkspace` only: after every install succeeded, delete each
   * `envs/<16-hex>/` directory no workflow of the workspace references.
   * Defaults to `true`.
   *
   * An env holding `.rawbox-setup.lock` is skipped, since some process is
   * installing into it right now. Nothing else is checked — in particular not
   * whether a running daemon still resolves from an unreferenced env, because
   * the run registry belongs to `@rawbox/cli`. That is acceptable because only
   * an explicit `workspace setup` prunes, never a run's auto-setup.
   */
  pruneStaleEnvs?: boolean | undefined;
  /**
   * `setupWorkspace` only: how many env installs may run at once. Defaults
   * to 2 — enough to overlap one install's network wait with another's
   * linking, without several npm processes contending for one tarball cache.
   */
  concurrency?: number | undefined;
  /**
   * `setupWorkspace` only: wraps each env's install, so a caller can hold a
   * per-env lock around it. The runner has no lock implementation of its own
   * — `@rawbox/cli` already has one with pid-probing stale recovery, and the
   * same lock must serialize `workspace setup` against `run`'s auto-setup.
   */
  withEnvLock?: (<T>(envDir: string, fn: () => Promise<T>) => Promise<T>) | undefined;
}

/** What `.rawbox-env-ready.json` records about a finished install. */
interface DependencyEnvReadyMarker {
  hash: string;
  dependencies: Record<string, string>;
  installLinks: boolean;
  installedAt: string;
}

/**
 * Installs one dependency set into its own env, `<targetFolder>/envs/<hash>/`,
 * and returns that directory — or `ok(undefined)` for an empty set, without
 * creating anything or running npm.
 *
 * The env is a complete npm project of its own: a generated `package.json`
 * holding exactly this set's normalized specifiers, and a copy of the
 * workspace's `.npmrc`. `npm install` then resolves registry, `file:` and
 * `git+...` specifiers alike, with no per-plugin loop or local-directory
 * probe: npm performs resolution instead of us.
 *
 * `<targetFolder>/package.json` is never read or written. A declared
 * `targetFolder:` can point anywhere, including at a directory an author
 * already made an npm package of, and only the env directory is rawbox's.
 *
 * The ready marker is removed before npm runs and written only after it
 * succeeded, so an interrupted or failed install never leaves an env that
 * looks finished.
 */
export async function setupDependencyEnv(
  targetFolder: string,
  dependencies: DependencySpecifierRecord,
  workspaceDir: string,
  options: SetupOptions = {},
): Promise<Result<string | undefined, string>> {
  const envDir = resolveDependencyEnvDir(targetFolder, dependencies, workspaceDir);
  if (envDir === undefined) {
    return ok(undefined);
  }
  const hash = path.basename(envDir);
  const normalizedDependencies = normalizeDependencyRecord(dependencies, workspaceDir);
  const readyMarkerPath = path.join(envDir, DEPENDENCY_ENV_READY_FILENAME);

  try {
    await fs.mkdir(envDir, { recursive: true });
    await fs.rm(readyMarkerPath, { force: true });

    // The env's own `package.json` makes it an npm project root, so npm never
    // climbs up into the target folder or the monorepo above it.
    await fs.writeFile(
      path.join(envDir, 'package.json'),
      `${JSON.stringify(
        {
          name: `rawbox-env-${hash}`,
          version: '1.0.0',
          type: 'module',
          private: true,
          dependencies: normalizedDependencies,
        },
        null,
        2,
      )}\n`,
    );

    // Propagate the workspace's `.npmrc` into the env before npm runs. The
    // env is its own npm project root, so npm will not walk up to the
    // workspace's `.npmrc`; this copy is what makes a scaffolded registry
    // (`project create` / `workspace create --registry`) govern every install
    // rawbox performs. The workspace's file is authoritative: it is copied
    // byte-for-byte on every setup, overwriting any earlier copy.
    try {
      await fs.copyFile(path.join(path.resolve(workspaceDir), '.npmrc'), path.join(envDir, '.npmrc'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
      // No workspace `.npmrc` — ambient npm configuration applies.
    }

    // `--install-links` turns npm's `file:` *link* into a copy-and-install; see
    // {@link SetupOptions.installLinks} for why linking stays the default.
    const args = options.installLinks ? ['install', '--install-links'] : ['install'];
    const command = `npm ${args.join(' ')}`;

    try {
      // Asynchronous so `setupWorkspace`'s bounded concurrency really runs
      // installs side by side. stderr is captured rather than discarded:
      // npm's own message is the only thing that explains *why* an install
      // failed, and swallowing it left the caller with a bare "Command
      // failed: npm install" naming no cause.
      await execFileAsync('npm', args, {
        cwd: envDir,
        encoding: 'utf-8',
        maxBuffer: NPM_INSTALL_MAX_BUFFER,
        shell: process.platform === 'win32',
      });
    } catch (e) {
      const npmOutput = (e as { stderr?: string }).stderr?.trim();
      return err(
        `Failed to install dependencies into "${envDir}" with \`${command}\`.` +
          (npmOutput ? `\n\nnpm reported:\n${npmOutput}` : '') +
          (options.installLinks ? `\n\n${INSTALL_LINKS_HINT}` : ''),
      );
    }

    const marker: DependencyEnvReadyMarker = {
      hash,
      dependencies: normalizedDependencies,
      installLinks: options.installLinks === true,
      installedAt: new Date().toISOString(),
    };
    await fs.writeFile(readyMarkerPath, `${JSON.stringify(marker, null, 2)}\n`);

    return ok(envDir);
  } catch (e) {
    return err(`Failed to set up dependency env "${envDir}": ${getErrorMessage(e)}`);
  }
}

/** What {@link setupWorkspace} set up. */
export interface SetupWorkspaceResult {
  /** The absolute target folder the envs live under. */
  readonly targetFolder: string;
  /** Every env the workspace's workflows need, in first-declared order. */
  readonly envs: DependencyEnvGroup[];
  /** Absolute paths of unreferenced envs that were deleted. */
  readonly prunedEnvs: string[];
}

/**
 * Runs `task` over `items` with at most `limit` in flight, collecting every
 * result in input order. Never rejects for a task's sake: tasks report
 * failure through their own `Result`.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  };

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

async function pathExists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false,
  );
}

/**
 * Deletes every `<targetFolder>/envs/<16-hex>/` directory whose hash is not in
 * `keepHashes` and that holds no setup lock. Entries that do not look like an
 * env are left alone: the folder is rawbox's, but nothing proves a stray file
 * in it is.
 */
async function pruneStaleDependencyEnvs(
  targetFolder: string,
  keepHashes: ReadonlySet<string>,
): Promise<string[]> {
  const envsDir = path.join(targetFolder, DEPENDENCY_ENVS_DIRNAME);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(envsDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }

  const pruned: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !DEPENDENCY_ENV_HASH_PATTERN.test(entry.name)) continue;
    if (keepHashes.has(entry.name)) continue;

    const envDir = path.join(envsDir, entry.name);
    if (await pathExists(path.join(envDir, DEPENDENCY_ENV_SETUP_LOCK_FILENAME))) continue;

    await fs.rm(envDir, { recursive: true, force: true });
    pruned.push(envDir);
  }
  return pruned;
}

/**
 * Loads and validates a workspace, groups its workflows by dependency set via
 * {@link groupDependencyEnvs}, and installs each distinct set into its own env
 * under the workspace's target folder.
 *
 * Workflows may declare different specifiers for the same package: they hash
 * to different envs and never share a `node_modules`. Workflows with identical
 * sets share one env and one install.
 *
 * Every env is attempted even when one fails, and the failures are reported
 * together, each naming its env hash and the workflows that use it — the
 * author is fixing declarations, and one pass should surface the whole list.
 * Pruning ({@link SetupOptions.pruneStaleEnvs}) runs only when every install
 * succeeded, so a half-set-up workspace never also loses its old envs.
 *
 * `targetFolder` is optional. When it is omitted the folder comes from
 * `targetFolder:` in the workspace document, and failing that from
 * `<workspace directory>/.rawbox` — see {@link resolveTargetFolder}. That
 * default is what makes `workspace setup` and `workflow run` agree without any
 * further configuration: the runner resolves plugins from the same envs.
 */
export async function setupWorkspace(
  workspacePath: string,
  targetFolder?: string | undefined,
  options: SetupOptions = {},
): Promise<Result<SetupWorkspaceResult, string>> {
  const workspaceResult = await loadAndValidateWorkspace(workspacePath);
  if (workspaceResult.isErr()) {
    return err(workspaceResult.error);
  }
  const workspace = workspaceResult.value;

  const workflowsResult = await loadAndValidateWorkflows(workspacePath, workspace);
  if (workflowsResult.isErr()) {
    return err(workflowsResult.error);
  }

  const workspaceDir = path.dirname(path.resolve(workspacePath));
  const resolvedTargetFolder = resolveTargetFolder(workspaceDir, workspace, targetFolder);

  const envs = groupDependencyEnvs(
    resolvedTargetFolder,
    workflowsResult.value.map((loaded) => ({
      path: loaded.path,
      dependencies: loaded.workflow.dependencies,
    })),
    workspaceDir,
  );

  const withEnvLock =
    options.withEnvLock ?? (<T>(_envDir: string, fn: () => Promise<T>): Promise<T> => fn());

  const results = await mapWithConcurrency(
    envs,
    options.concurrency ?? DEFAULT_SETUP_CONCURRENCY,
    (group) =>
      withEnvLock(group.envDir, () =>
        setupDependencyEnv(resolvedTargetFolder, group.dependencies, workspaceDir, options),
      ).catch((e: unknown) => err<string | undefined, string>(getErrorMessage(e))),
  );

  const failureList: string[] = [];
  results.forEach((result, index) => {
    if (result.isOk()) return;
    // Guarded: `results` is index-aligned with `envs`.
    const group = envs[index] as DependencyEnvGroup;
    failureList.push(
      `Env ${group.hash} (used by ${group.workflowPathList.join(', ')}) failed to install:\n` +
        result.error,
    );
  });

  if (failureList.length > 0) {
    return err(failureList.join('\n\n'));
  }

  let prunedEnvs: string[] = [];
  if (options.pruneStaleEnvs !== false) {
    try {
      prunedEnvs = await pruneStaleDependencyEnvs(
        resolvedTargetFolder,
        new Set(envs.map((group) => group.hash)),
      );
    } catch (e) {
      return err(
        `Every env installed, but pruning unused envs under "${resolvedTargetFolder}" failed: ` +
          getErrorMessage(e),
      );
    }
  }

  return ok({ targetFolder: resolvedTargetFolder, envs, prunedEnvs });
}
