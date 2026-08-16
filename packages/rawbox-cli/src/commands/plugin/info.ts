import fs from 'node:fs/promises';
import path from 'node:path';

import * as p from '@clack/prompts';
import pc from 'picocolors';

import {
  DOCUMENT_KIND,
  RAWBOX_LOCK_FILENAME,
  discoverWorkspace,
  parseConfig,
  rawboxLockPath,
  readRawboxLock,
  resolvePluginLockEntries,
  resolveWorkspaceTargetFolder,
  validateWorkflowType,
  verifyRawboxLock,
  type RawboxLock,
  type ResolvedPluginLockEntry,
  type Workflow,
} from '@rawbox/runner';

import {
  ContractRegistryCache,
  type Contract,
  type ContractRegistry,
} from '@rawbox/plugin/core';

import { getErrorMessage } from '../../utils/error.js';

// ---------------------------------------------------------------------------
// `plugin info`
//
// This command exists so an agent authoring a workflow can find out *why* a
// plugin will not resolve, without running the workflow. It answers, for every
// package the document declares in `plugins:`:
//
//   - what the workflow asked for (the specifier) and what npm actually gave
//     it (the resolved version);
//   - whether that package is installed and its contract registry compiles;
//   - the contract-registry hash, and whether `rawbox.lock` agrees with it;
//   - which operations the workflow actually references from it.
//
// The last one is the reason the command is worth having and the easiest to
// fake: "the plugin resolves" and "the plugin provides the operation this
// workflow names" are different questions, and only the second one predicts
// whether the run will start.
//
// Nothing here is mutated. `plugin info` reads the workflow, the workspace's
// `node_modules`, and the lock; it writes none of them.
// ---------------------------------------------------------------------------

export interface PluginInfoOptions {
  /** Path to the workspace config, used to locate `rawbox.lock`. */
  workspace?: string;
}

// ---------------------------------------------------------------------------
// Package resolution — delegated to the shared loader
// ---------------------------------------------------------------------------

/** What this command knows about one declared package. */
type PackageResolution =
  | { name: string; status: 'available'; entry: ResolvedPluginLockEntry }
  | { name: string; status: 'unavailable'; reason: string };

/**
 * Resolves each declared package against the workspace directory.
 *
 * `resolvePluginLockEntries` is asked about **one package per call**. It
 * collects every failure and returns a single `err` for the batch — the right
 * shape for locking, where one unresolvable package means there is no lock to
 * write, but the wrong shape here: a batch `err` discards the entries it *did*
 * resolve, and this command's whole job is the per-package breakdown. Calling
 * it once per name recovers that without adding another private registry
 * loader, and keeps the shared loader's diagnostics verbatim.
 */
async function resolveDeclaredPackages(
  packageNameList: readonly string[],
  resolveFromDirectory: string,
  registryCache: ContractRegistryCache,
): Promise<PackageResolution[]> {
  const resolutionList: PackageResolution[] = [];

  for (const name of packageNameList) {
    const result = await resolvePluginLockEntries(
      [name],
      resolveFromDirectory,
      registryCache,
    );

    if (result.isErr()) {
      resolutionList.push({ name, status: 'unavailable', reason: result.error });
      continue;
    }

    const [entry] = result.value;
    if (!entry) {
      // Unreachable: a successful single-name call yields exactly one entry.
      resolutionList.push({
        name,
        status: 'unavailable',
        reason: `Plugin "${name}" resolved without producing a registry entry.`,
      });
      continue;
    }

    resolutionList.push({ name, status: 'available', entry });
  }

  return resolutionList;
}

// ---------------------------------------------------------------------------
// Operation references — what the workflow actually uses
// ---------------------------------------------------------------------------

/** Which operations of one package the workflow's steps name, in file order. */
interface OperationUsage {
  /** Distinct `operation:` values, first-reference order. */
  operationList: string[];
  /** How many steps reference this package at all. */
  stepCount: number;
}

/**
 * Groups the workflow's steps by the package their `plugin:` field names.
 *
 * Keyed by the *referenced* name rather than by the declared one, so a step
 * naming a package the document never declared shows up as its own group and
 * can be reported instead of silently vanishing.
 */
function collectOperationUsage(
  workflow: Workflow,
): Map<string, OperationUsage> {
  const usageByPlugin = new Map<string, OperationUsage>();

  for (const step of workflow.steps) {
    let usage = usageByPlugin.get(step.plugin);
    if (!usage) {
      usage = { operationList: [], stepCount: 0 };
      usageByPlugin.set(step.plugin, usage);
    }
    usage.stepCount += 1;
    if (!usage.operationList.includes(step.operation)) {
      usage.operationList.push(step.operation);
    }
  }

  return usageByPlugin;
}

/**
 * An `operation:` value addresses `./<operation>.definition.js` in the
 * package's `contractRecord`. Same mapping the resolver applies; if the
 * two ever disagree this report would claim an operation exists that resolution
 * cannot find.
 */
function operationDefinitionPath(operation: string): string {
  return `./${operation}.definition.js`;
}

/**
 * The `Operations:` line for one package.
 *
 * When the package resolved, each referenced operation is checked against the
 * registry that was actually loaded and marked. "The plugin resolves" and "the
 * plugin provides the operation this workflow names" are separate questions,
 * and only the second predicts whether the run will start — so the report must
 * not conflate them.
 */
function describeOperations(
  usage: OperationUsage | undefined,
  contractKeySet?: ReadonlySet<string>,
): string {
  if (!usage || usage.stepCount === 0) {
    return pc.yellow(
      'no steps reference this plugin — declared in plugins: but unused',
    );
  }

  const stepWord = usage.stepCount === 1 ? 'step' : 'steps';
  const rendered = usage.operationList
    .map((operation) => {
      if (!contractKeySet) return operation;
      return contractKeySet.has(operationDefinitionPath(operation))
        ? pc.green(`${operation} ✅`)
        : pc.red(`${operation} ❌ not in registry`);
    })
    .join(', ');

  return `${usage.stepCount} ${stepWord} referenced (${rendered})`;
}

/** Referenced operations the loaded registry does not provide. */
function missingOperations(
  usage: OperationUsage | undefined,
  contractKeySet: ReadonlySet<string>,
): string[] {
  if (!usage) return [];
  return usage.operationList.filter(
    (operation) => !contractKeySet.has(operationDefinitionPath(operation)),
  );
}

// ---------------------------------------------------------------------------
// Lock agreement
//
// The three lock states this command must keep distinct:
//
//   - **absent** — "resolve whatever is installed". Reported, never an error.
//   - **present and matching** — the integrity guarantee holds.
//   - **present and mismatched** — a hard error naming the package, because
//     every step referencing it is bound to a registry that no longer exists.
//
// A **corrupt** lock is handled before any of this: `readRawboxLock` returns an
// error for it, and it is reported as one. Downgrading a corrupt lock to
// "unlocked" would turn an integrity failure into a clean report.
// ---------------------------------------------------------------------------

interface LockAgreement {
  /** The `(rawbox.lock: …)` annotation on the `Registry Hash:` line. */
  note: string;
  /** Full mismatch diagnostic from `verifyRawboxLock`, when it disagreed. */
  mismatch?: string;
  /** Version recorded in the lock, when there is an entry for this package. */
  lockedVersion?: string;
  /** Hash recorded in the lock, when there is an entry for this package. */
  lockedHash?: string;
}

function describeLockAgreement(
  name: string,
  installedHash: string | undefined,
  lock: RawboxLock | undefined,
  lockLocated: boolean,
): LockAgreement {
  if (!lockLocated) {
    return { note: pc.dim(`${RAWBOX_LOCK_FILENAME}: not located`) };
  }

  if (!lock) {
    // Absent is the convenient development default, not a fault.
    return {
      note: pc.dim(`${RAWBOX_LOCK_FILENAME}: absent — unlocked, no integrity guarantee`),
    };
  }

  const entry = lock.plugins[name];
  if (!entry) {
    // A present lock missing one entry leaves a partially locked workspace
    // usable; that package is simply unlocked.
    return {
      note: pc.yellow(`${RAWBOX_LOCK_FILENAME}: ⚠️ no entry — this package is unlocked`),
      };
  }

  if (installedHash === undefined) {
    return {
      note: pc.yellow(
        `${RAWBOX_LOCK_FILENAME}: entry exists but nothing is installed to compare it with`,
      ),
      lockedVersion: entry.resolved,
      lockedHash: entry.registryHash,
    };
  }

  // Delegated so the mismatch wording is the one every other command emits.
  const verification = verifyRawboxLock(lock, { [name]: installedHash }, [name]);

  if (verification.isErr()) {
    return {
      note: pc.red(`${RAWBOX_LOCK_FILENAME}: ❌ MISMATCH`),
      mismatch: verification.error,
      lockedVersion: entry.resolved,
      lockedHash: entry.registryHash,
    };
  }

  return {
    note: pc.green(`${RAWBOX_LOCK_FILENAME}: ✅ matches`),
    lockedVersion: entry.resolved,
    lockedHash: entry.registryHash,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Width of the rules that bracket each package block. */
const RULE = '-'.repeat(70);

/** Label column width, so every field value starts at the same column. */
const LABEL_WIDTH = 15;

function field(label: string, value: string): string {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

/** Registry hashes are 64 hex characters; the report shows a prefix. */
function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/**
 * Renders the plugin report: package, specifier plus resolved version,
 * install/compile status, registry hash with
 * `rawbox.lock` agreement, and the operations the workflow references.
 *
 * Exits non-zero when the report contains something that would stop the
 * workflow from running — a package that will not resolve, a lock mismatch, or
 * a step naming a plugin the document never declared. An absent lock is none of
 * those and exits zero.
 */
export async function pluginInfo(
  workflowPath: string,
  options: PluginInfoOptions = {},
): Promise<void> {
  const absoluteWorkflowPath = path.resolve(process.cwd(), workflowPath);

  try {
    // -- 1. Load and schema-check the workflow -----------------------------
    // Reporting on a document that does not validate would describe a file
    // that can never run, so the schema gate comes first.
    const content = await fs.readFile(absoluteWorkflowPath, 'utf-8');
    const document = parseConfig(content, absoluteWorkflowPath);

    const typeResult = validateWorkflowType(document, workflowPath);
    if (typeResult.isErr()) {
      p.log.error(pc.red(`Workflow schema is invalid:\n${typeResult.error.message}`));
      process.exit(1);
      return;
    }

    const workflow = document as Workflow;

    // -- 2. Locate the workspace -------------------------------------------
    // The workspace directory is both where plugins are installed and where
    // `rawbox.lock` lives, so it determines almost every field below.
    let workspaceFile: string | undefined = options.workspace
      ? path.resolve(process.cwd(), options.workspace)
      : undefined;

    if (!workspaceFile) {
      const discovery = await discoverWorkspace(absoluteWorkflowPath);

      if (discovery.ambiguousList) {
        p.log.error(
          pc.red(
            `Several workspace documents were found in one directory:\n` +
              discovery.ambiguousList.map((file) => `  - ${file}`).join('\n') +
              `\nPass the one to report against explicitly: --workspace <file>`,
          ),
        );
        process.exit(1);
        return;
      }

      workspaceFile = discovery.file;

      if (workspaceFile) {
        p.log.info(
          `Auto-discovered workspace ${pc.green(workspaceFile)} (kind: ${DOCUMENT_KIND.WORKSPACE}).`,
        );
      } else {
        // Unlike `workflow lock`, this is not fatal. `plugin info` mutates
        // nothing, and the specifier and operation columns are still exactly
        // the diagnosis an author needs; refusing to print them because the
        // workspace could not be found withholds the answer to the question
        // being asked. Resolution falls back to the working directory, which
        // is what the upward walk would have reached anyway.
        p.log.warn(
          `No "kind: ${DOCUMENT_KIND.WORKSPACE}" document found in:\n` +
            discovery.searchedList.map((directory) => `  - ${directory}`).join('\n') +
            `\nReporting without a workspace context: packages resolve from the current ` +
            `directory and ${RAWBOX_LOCK_FILENAME} cannot be located, so integrity is not ` +
            `checked. Pass --workspace <file> to include it.`,
        );
      }
    }

    const resolveFromDirectory = workspaceFile
      ? path.dirname(workspaceFile)
      : process.cwd();

    // Where `rawbox.lock` lives and where the *packages* live are two different
    // questions once a workspace can declare a `targetFolder:`. The lock stays
    // beside `workspace.yaml`; resolution follows setup.
    const resolutionDirectory = workspaceFile
      ? await resolveWorkspaceTargetFolder(workspaceFile)
      : resolveFromDirectory;

    // -- 3. Read the lock --------------------------------------------------
    // Before resolution, so a corrupt lock fails fast rather than after a
    // report that implies everything is fine.
    let lock: RawboxLock | undefined;
    const lockLocated = workspaceFile !== undefined;

    if (lockLocated) {
      const lockResult = await readRawboxLock(resolveFromDirectory);
      if (lockResult.isErr()) {
        p.log.error(pc.red(lockResult.error));
        process.exit(1);
        return;
      }
      lock = lockResult.value;
    }

    // -- 4. Resolve every declared package ---------------------------------
    const declaredPackageList = Object.keys(workflow.plugins);
    const usageByPlugin = collectOperationUsage(workflow);

    if (declaredPackageList.length === 0) {
      p.log.warn(
        `Workflow "${workflow.name}" declares no plugins. Every step's plugin: must name ` +
          `a package listed under plugins: (there is no implicit default).`,
      );
    }

    // The cache is populated as a side effect of resolution, so each loaded
    // registry can be looked up by the very hash the report prints — that is
    // what lets the `Operations:` column say whether the operation exists.
    const registryCache = new ContractRegistryCache();

    const s = p.spinner();
    s.start(
      `Resolving ${declaredPackageList.length} plugin(s) from ${pc.green(resolutionDirectory)}...`,
    );
    const resolutionList = await resolveDeclaredPackages(
      declaredPackageList,
      resolutionDirectory,
      registryCache,
    );
    s.stop(`Inspected ${resolutionList.length} declared plugin(s).`);

    // -- 5. Render the report ----------------------------------------------
    p.log.message(
      `📦 Required Plugins for workflow "${pc.cyan(workflow.name)}":\n${RULE}`,
    );

    const unavailableList: string[] = [];
    const mismatchList: string[] = [];
    const missingOperationList: string[] = [];
    const typeboxNoteList: string[] = [];

    for (const resolution of resolutionList) {
      const { name } = resolution;
      // Guarded: `name` comes from `Object.keys(workflow.plugins)`.
      const specifier = workflow.plugins[name] as string;
      const usage = usageByPlugin.get(name);

      const installedHash =
        resolution.status === 'available' ? resolution.entry.registryHash : undefined;

      // Only a package that actually loaded has a registry to check operations
      // against; for the rest the column stays unannotated rather than
      // reporting every operation as missing, which would bury the real fault.
      const registry: ContractRegistry<Contract> | undefined =
        installedHash !== undefined
          ? registryCache.getContractRegistry(installedHash)
          : undefined;
      const contractKeySet = registry
        ? new Set(Object.keys(registry.contractRecord))
        : undefined;

      const agreement = describeLockAgreement(name, installedHash, lock, lockLocated);

      const lineList: string[] = [field('Package', pc.cyan(name))];

      if (resolution.status === 'available') {
        lineList.push(
          field(
            'Specifier',
            `${specifier}${' '.repeat(Math.max(1, 18 - specifier.length))}(resolved: ${resolution.entry.resolved})`,
          ),
          field('Status', pc.green('✅ Installed & Compiled')),
          field(
            'Registry Hash',
            `${shortHash(resolution.entry.registryHash)}${' '.repeat(Math.max(1, 18 - shortHash(resolution.entry.registryHash).length))}(${agreement.note})`,
          ),
        );
      } else {
        unavailableList.push(name);
        const lockedNote =
          agreement.lockedVersion !== undefined
            ? `; ${RAWBOX_LOCK_FILENAME} records ${agreement.lockedVersion}`
            : '';
        lineList.push(
          field('Specifier', `${specifier}  (resolved: not installed${lockedNote})`),
          // The shared loader returns one opaque string covering "not
          // resolvable", "failed to import", and "not a registry". Classifying
          // it here would mean string-matching another module's messages, so
          // the status stays coarse and the message itself — which is authored
          // to be actionable — is reproduced verbatim below.
          field('Status', pc.red('❌ Unavailable — see the diagnostic below')),
          field(
            'Registry Hash',
            `${pc.dim('unavailable')}${' '.repeat(8)}(${agreement.note})`,
          ),
        );
      }

      lineList.push(field('Operations', describeOperations(usage, contractKeySet)));

      const typeboxNote =
        resolution.status === 'available' ? resolution.entry.typeboxVersionNote : undefined;
      if (typeboxNote) {
        lineList.push(field('Typebox', pc.dim('ℹ️ version note — see below')));
      }

      lineList.push(RULE);

      p.log.message(lineList.join('\n'));

      if (resolution.status === 'unavailable') {
        p.log.error(pc.red(resolution.reason));
      }
      if (typeboxNote) {
        typeboxNoteList.push(name);
        p.log.message(pc.dim(typeboxNote));
      }
      if (agreement.mismatch) {
        mismatchList.push(name);
        p.log.error(pc.red(agreement.mismatch));
      }

      if (contractKeySet) {
        const missingList = missingOperations(usage, contractKeySet);
        for (const operation of missingList) {
          missingOperationList.push(`${name} → ${operation}`);
          // Listing the registry's contract keys is the actionable half: the
          // author picked a name and needs to see the ones that exist.
          p.log.error(
            pc.red(
              `Plugin "${name}" has no operation "${operation}".\n` +
                `  Looked for contract "${operationDefinitionPath(operation)}".\n` +
                `  This registry provides:\n` +
                [...contractKeySet]
                  .sort()
                  .map((key) => `    - ${key}`)
                  .join('\n'),
            ),
          );
        }
      }
    }

    // -- 6. Steps naming a package the document never declared -------------
    // The schema cannot catch this: `plugin:` is just a string, and the tie to
    // `plugins:` is semantic. `resolveWorkflow` rejects it later, but this
    // command is where an author looks first, so it says so here — and lists
    // what *was* declared, which is the actionable half.
    const undeclaredList = [...usageByPlugin.keys()].filter(
      (name) => !Object.prototype.hasOwnProperty.call(workflow.plugins, name),
    );

    for (const name of undeclaredList) {
      const usage = usageByPlugin.get(name);
      p.log.error(
        pc.red(
          `Step(s) reference plugin "${name}", which the workflow does not declare.\n` +
            `  Referenced by: ${describeOperations(usage)}\n` +
            `  Declared packages: ${
              declaredPackageList.length > 0
                ? declaredPackageList.map((entry) => `"${entry}"`).join(', ')
                : '(none)'
            }\n` +
            `  Add it under plugins: with an npm specifier, e.g. ${name}: "^1.0.0".`,
        ),
      );
    }

    // -- 7. Outcome ---------------------------------------------------------
    const problemList: string[] = [];
    if (unavailableList.length > 0) {
      problemList.push(`${unavailableList.length} plugin(s) unavailable`);
    }
    if (mismatchList.length > 0) {
      problemList.push(`${mismatchList.length} ${RAWBOX_LOCK_FILENAME} mismatch(es)`);
    }
    if (undeclaredList.length > 0) {
      problemList.push(`${undeclaredList.length} undeclared plugin reference(s)`);
    }
    if (missingOperationList.length > 0) {
      problemList.push(
        `${missingOperationList.length} operation(s) missing from their registry`,
      );
    }

    if (problemList.length > 0) {
      p.log.error(
        pc.red(
          `This workflow will not resolve: ${problemList.join(', ')}. ` +
            `Install with: npx rawbox-cli workspace setup <workspace file> [target folder]` +
            (mismatchList.length > 0
              ? `, then re-lock with: npx rawbox-cli workflow lock ${workflowPath}`
              : '.'),
        ),
      );
      p.outro(pc.red('❌ Plugin report complete — problems found.'));
      process.exit(1);
      return;
    }

    if (lockLocated && !lock) {
      p.log.warn(
        `No ${RAWBOX_LOCK_FILENAME} in "${path.dirname(rawboxLockPath(resolveFromDirectory))}" — ` +
          `resolving whatever is installed, with no integrity guarantee. ` +
          `Create one with: npx rawbox-cli workflow lock ${workflowPath}`,
      );
    }

    p.outro(pc.green('✅ All declared plugins resolve.'));
  } catch (error) {
    p.log.error(
      pc.red(
        `Failed to report plugins for workflow "${workflowPath}": ${getErrorMessage(error)}`,
      ),
    );
    process.exit(1);
  }
}
