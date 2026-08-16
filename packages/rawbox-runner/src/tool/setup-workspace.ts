import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Compile } from 'typebox/compile';
import { ok, err, type Result } from 'neverthrow';

import { Workspace, resolveTargetFolder, workspaceKindError } from '../workspace/workspace-types.js';
import { resolveWorkspaceWorkflowPath } from '../workspace/workflow-path.js';
import { type Workflow, type PluginSpecifierRecord } from '../workflow/workflow-types.js';
import { formatValidationErrors, validateWorkflowType } from '../workflow/validation.js';
import { parseConfig } from '../utils/config.js';
import { getErrorMessage } from '../utils/error.js';


const workspaceValidator = Compile(Workspace);

/** Prefix identifying an npm `file:` dependency specifier. */
const FILE_SPEC_PREFIX = 'file:';

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

/**
 * Rewrites a relative `file:` specifier to an absolute one, resolved against
 * `workspaceDir` — the directory containing the workspace file.
 *
 * npm resolves a relative `file:` specifier against the *generated* target
 * `package.json`, not the workflow file that declared it, so splicing
 * `plugins:` verbatim would silently break relative local paths. Absolute
 * `file:` specs and every other specifier form (registry ranges, `git+...`,
 * etc.) pass through untouched.
 */
function normalizePluginSpecifier(specifier: string, workspaceDir: string): string {
  if (!specifier.startsWith(FILE_SPEC_PREFIX)) {
    return specifier;
  }

  const target = specifier.slice(FILE_SPEC_PREFIX.length);
  if (path.isAbsolute(target)) {
    return specifier;
  }

  return `${FILE_SPEC_PREFIX}${path.resolve(workspaceDir, target)}`;
}

/** Applies {@link normalizePluginSpecifier} to every entry of a `plugins:` map. */
function normalizePlugins(plugins: PluginSpecifierRecord, workspaceDir: string): PluginSpecifierRecord {
  const normalized: PluginSpecifierRecord = {};
  for (const [name, specifier] of Object.entries(plugins)) {
    normalized[name] = normalizePluginSpecifier(specifier, workspaceDir);
  }
  return normalized;
}

export async function loadAndValidateWorkspace(workspacePath: string): Promise<Result<Workspace, string>> {
  const absoluteWorkspacePath = path.resolve(workspacePath);
  
  try {
    const content = await fs.readFile(absoluteWorkspacePath, 'utf-8');
    const workspaceData = parseConfig(content, absoluteWorkspacePath);

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
 */
export async function resolveWorkspaceTargetFolder(
  workspacePath: string,
): Promise<string> {
  const workspaceDir = path.dirname(path.resolve(workspacePath));
  const workspaceResult = await loadAndValidateWorkspace(workspacePath);
  return workspaceResult.isOk()
    ? resolveTargetFolder(workspaceDir, workspaceResult.value)
    : workspaceDir;
}

/**
 * A validated workflow paired with the relative path — as written in the
 * workspace's `workflowPathList` — it was loaded from.
 *
 * The path travels with the workflow (rather than being re-derived later)
 * because {@link mergeWorkflowPlugins} needs it to name *which* workflow
 * declared a conflicting specifier, and by the time it runs the workflow
 * object alone no longer carries that information.
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
      const workflowData: unknown = parseConfig(content, absoluteWorkflowPath);

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

/**
 * Merges every workflow's `plugins:` map into one, the way `setupNpmPackage`
 * needs it — but fails closed when two workflows declare the *same* package
 * name with *different* specifier strings.
 *
 * The comparison is plain string inequality, not semver-range intersection:
 * `"^1.0.0"` and `"^1.2.0"` are flagged as conflicting even though a real
 * resolver could satisfy both, because deciding that correctly means
 * re-implementing npm's own resolution logic. The cost of a false positive
 * (two workflows told to align specifiers that could technically coexist) is
 * a rewrite of one line in a workflow document; the cost of a false negative
 * is exactly the silent-merge bug this function exists to prevent — a later
 * workflow winning over an earlier one with nothing said about it.
 *
 * All conflicting packages are collected and reported together in a single
 * error, so a workspace with several disagreeing workflows doesn't have to be
 * fixed and re-run one package at a time.
 */
export function mergeWorkflowPlugins(loadedWorkflows: LoadedWorkflow[]): Result<PluginSpecifierRecord, string> {
  // package name -> specifier -> path of the first workflow that declared it
  const specifiersByPackage = new Map<string, Map<string, string>>();

  for (const { path: workflowPath, workflow } of loadedWorkflows) {
    for (const [name, specifier] of Object.entries(workflow.plugins)) {
      let specifiers = specifiersByPackage.get(name);
      if (specifiers === undefined) {
        specifiers = new Map();
        specifiersByPackage.set(name, specifiers);
      }
      // Distinct specifier strings only: a package re-declared with the exact
      // same specifier by a second workflow is the common, harmless case and
      // must merge silently, not be recorded as a second candidate.
      if (!specifiers.has(specifier)) {
        specifiers.set(specifier, workflowPath);
      }
    }
  }

  const merged: PluginSpecifierRecord = {};
  const conflictLines: string[] = [];

  for (const [name, specifiers] of specifiersByPackage) {
    const [firstSpecifier] = specifiers.keys();
    if (specifiers.size === 1) {
      merged[name] = firstSpecifier!;
      continue;
    }

    const rendered = [...specifiers.entries()]
      .map(([specifier, workflowPath]) => `"${specifier}" (${workflowPath})`)
      .join(' vs ');
    conflictLines.push(`Conflicting specifiers for "${name}": ${rendered}.`);
  }

  if (conflictLines.length > 0) {
    return err(
      `${conflictLines.join('\n')}\n\n` +
        `Workflows in one workspace share one install; align the specifiers or split the workspaces.`,
    );
  }

  return ok(merged);
}

/** Shape of the parts of a target `package.json` this module preserves. */
interface TargetPackageJson extends Record<string, unknown> {
  dependencies?: Record<string, string>;
}

/**
 * Reads the target folder's existing `package.json`, or `{}` when there is
 * none.
 *
 * An unparseable manifest is also treated as absent rather than as an error:
 * the alternative is refusing to set up a workspace because of a stray file,
 * and npm would have rejected it on the next line anyway with a better message.
 */
async function readExistingPackageJson(
  packageJsonPath: string,
): Promise<TargetPackageJson> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as TargetPackageJson)
      : {};
  } catch {
    return {};
  }
}

/** Knobs shared by `setupNpmPackage` and `setupWorkspace`. */
export interface SetupOptions {
  /**
   * Pass `--install-links` to `npm install`.
   *
   * npm treats a `file:` dependency as a **link**: it symlinks the package and
   * does not install that package's own dependencies into the target, so the
   * target holds the symlink and nothing else. That is the default here on
   * purpose — a symlinked plugin keeps the local development loop live, since
   * editing and rebuilding the plugin is picked up by the next run with no
   * second `workspace setup`.
   *
   * `--install-links` makes npm *copy* the package and install its transitive
   * dependencies, producing a target that is self-contained and portable at the
   * cost of being a snapshot: further edits to the plugin are invisible until
   * setup is run again. Opt in when the target folder is going to be moved to a
   * machine that has not installed the plugin independently.
   */
  installLinks?: boolean | undefined;
}

/**
 * Initializes a new npm package in the target directory and installs the declared plugins.
 *
 * `plugins` is spliced directly into the generated `package.json`'s
 * `dependencies` — the same shape npm already understands — and a single
 * `npm install` resolves registry, `file:`, and `git+...` specifiers alike.
 * There is no per-plugin loop or local-directory probe: npm performs
 * resolution instead of us.
 */
export async function setupNpmPackage(
  targetFolder: string,
  plugins: PluginSpecifierRecord,
  workspaceDir: string,
  options: SetupOptions = {},
): Promise<Result<void, string>> {
  const absoluteTargetFolder = path.resolve(targetFolder);

  try {
    await fs.mkdir(absoluteTargetFolder, { recursive: true });

    const normalizedPlugins = normalizePlugins(plugins, workspaceDir);

    // Write a local package.json to prevent npm from climbing up the monorepo
    // directory tree.
    //
    // An existing manifest is *merged into*, not replaced: a declared
    // `targetFolder:` can point anywhere, including a directory an author
    // already made an npm package of, and overwriting their `scripts` or
    // `devDependencies` because they ran `workspace setup` would be
    // indefensible. Only `dependencies` is authoritative here.
    const packageJsonPath = path.join(absoluteTargetFolder, 'package.json');
    const existing = await readExistingPackageJson(packageJsonPath);
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify(
        {
          name: path.basename(absoluteTargetFolder).toLowerCase().replace(/[^a-z0-9-_]/g, ''),
          version: '1.0.0',
          type: 'module',
          ...existing,
          dependencies: { ...existing.dependencies, ...normalizedPlugins },
        },
        null,
        2,
      ),
    );

    // Propagate the workspace's `.npmrc` into the target folder before npm
    // runs. The generated package.json above makes the target folder its own
    // npm project root, so npm will not walk up to the workspace's `.npmrc`;
    // this copy is what makes a scaffolded registry (`project create` /
    // `workspace create --registry`) govern every install rawbox performs —
    // it is the one piece of real plumbing the flag needs. The workspace's
    // file is authoritative: it is copied byte-for-byte on every setup,
    // overwriting any earlier copy.
    const workspaceNpmrcPath = path.join(path.resolve(workspaceDir), '.npmrc');
    const targetNpmrcPath = path.join(absoluteTargetFolder, '.npmrc');
    if (workspaceNpmrcPath !== targetNpmrcPath) {
      try {
        await fs.copyFile(workspaceNpmrcPath, targetNpmrcPath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw e;
        }
        // No workspace `.npmrc` — ambient npm configuration applies, as before.
      }
    }

    if (Object.keys(normalizedPlugins).length === 0) {
      return ok(undefined);
    }

    // `--install-links` turns npm's `file:` *link* into a copy-and-install; see
    // {@link SetupOptions.installLinks} for why linking stays the default.
    const command = options.installLinks
      ? 'npm install --install-links'
      : 'npm install';

    try {
      // stderr is captured rather than discarded: npm's own message is the only
      // thing that explains *why* an install failed, and swallowing it left the
      // caller with a bare "Command failed: npm install" naming no cause.
      execSync(command, {
        cwd: absoluteTargetFolder,
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf-8',
      });
    } catch (e) {
      const npmOutput = (e as { stderr?: string }).stderr?.trim();
      return err(
        `Failed to install the workspace's plugins into "${absoluteTargetFolder}" ` +
          `with \`${command}\`.` +
          (npmOutput ? `\n\nnpm reported:\n${npmOutput}` : '') +
          (options.installLinks ? `\n\n${INSTALL_LINKS_HINT}` : ''),
      );
    }

    return ok(undefined);
  } catch (e) {
    return err(`Failed to setup target npm package directory: ${getErrorMessage(e)}`);
  }
}

/**
 * Loads and validates a workspace, merges every workflow's `plugins:` map via
 * {@link mergeWorkflowPlugins}, and installs the result into the workspace's
 * target folder.
 *
 * The merge fails closed — before npm is ever invoked — when two workflows
 * declare the same package with different specifiers, naming the package,
 * both specifiers, and both workflow files; see {@link mergeWorkflowPlugins}
 * for why. Identical duplicate specifiers merge silently, as they always have.
 *
 * `targetFolder` is optional. When it is omitted the folder comes from
 * `targetFolder:` in the workspace document, and failing that from
 * `<workspace directory>/.rawbox` — see {@link resolveTargetFolder}. That
 * default is what makes `workspace setup` and `workflow run` agree without any
 * further configuration: the runner resolves plugins from the same resolved
 * folder.
 *
 * @returns The absolute target folder that was set up, so a caller can report
 *   where the install actually landed rather than echoing what it was given.
 */
export async function setupWorkspace(
  workspacePath: string,
  targetFolder?: string | undefined,
  options: SetupOptions = {},
): Promise<Result<string, string>> {
  const workspaceResult = await loadAndValidateWorkspace(workspacePath);
  if (workspaceResult.isErr()) {
    return err(workspaceResult.error);
  }
  const workspace = workspaceResult.value;

  const workflowsResult = await loadAndValidateWorkflows(workspacePath, workspace);
  if (workflowsResult.isErr()) {
    return err(workflowsResult.error);
  }

  const pluginsResult = mergeWorkflowPlugins(workflowsResult.value);
  if (pluginsResult.isErr()) {
    return err(pluginsResult.error);
  }
  const plugins = pluginsResult.value;

  const workspaceDir = path.dirname(path.resolve(workspacePath));
  const resolvedTargetFolder = resolveTargetFolder(workspaceDir, workspace, targetFolder);

  const setupResult = await setupNpmPackage(
    resolvedTargetFolder,
    plugins,
    workspaceDir,
    options,
  );
  return setupResult.map(() => resolvedTargetFolder);
}
