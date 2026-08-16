import fs from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Compile } from 'typebox/compile';
import {
  DOCUMENT_KIND,
  RAWBOX_LOCK_FILENAME,
  RawboxLock,
  applySeedOverrides,
  summarizeAppliedSeedOverrides,
  discoverWorkspace,
  loadPluginContractRegistry,
  parseConfig,
  resolveTargetFolder,
  resolveWorkflow,
  resolveWorkspaceTargetFolder,
  collectBackendEnvProblems,
  collectBackendReferenceList,
  boxStorageFor,
  collectBoundStorageKeys,
  collectLogRotationProblems,
  collectTimeoutWarnings,
  collectUnknownBackendProblems,
  formatSeedOverridePathProblems,
  resolveWorkspaceWorkflowPath,
  seedOverrideLayerFor,
  validateSeedData,
  validateStorageBoundaries,
  validateWorkflowType,
  type BackendMap,
  type PluginRegistryLoadFailure,
  type SeedOverrideLayer,
  type Workflow,
} from '@rawbox/runner';
import { ContractRegistryCache } from '@rawbox/plugin/core';
import { budgetForStorage } from '@rawbox/store';
import { getErrorMessage } from '../../utils/error.js';
import { parseSeedFlagList, seedOverrideLayerFromFlags } from '../../utils/seed-flag.js';
import {
  collectCrossWorkflowReads,
  formatBoundKeyNoteLine,
  formatCrossWorkflowReadLines,
  formatKeyBudgetLine,
  formatStorageBudgetSummaryLines,
  formatUnbudgetableKeyLine,
  formatUnbudgetableKeyNoteLine,
} from '../../utils/budget-report.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Plugin registries
//
// `resolveWorkflow` needs `registryHashByPlugin` because `ContractRegistryCache`
// is keyed by content hash and a registry's only back-reference is a file path
// that loses the package name under a symlink — the normal case for `file:`
// specifiers and npm workspaces.
//
// The map and the cache are built in a **single pass** here: `addContractRegistry`
// returns the hash of the registry it just stored, so the pairing is captured at
// the moment it exists. Deriving them separately is what makes the resolver's
// "hash map and registry cache disagree" error reachable.
// ---------------------------------------------------------------------------

interface PluginLoadFailure {
  packageName: string;
  reason: string;
}

interface PluginLoadResult {
  registryCache: ContractRegistryCache;
  registryHashByPlugin: Record<string, string>;
  failureList: PluginLoadFailure[];
}

/**
 * Renders a shared-loader failure as the clause `verify` appends to
 * `Plugin "<name>" could not be loaded: …`.
 *
 * Verification's audience is someone whose workflow declares a package that is
 * not where the command looked, so the "not installed" case names *every*
 * directory searched — the one thing neither locking (single directory) nor the
 * runner (silent fallback) has to say.
 */
function describeLoadFailure(failure: PluginRegistryLoadFailure): string {
  switch (failure.kind) {
    case 'unresolved':
      return (
        `not installed — no "${failure.specifier}" resolvable from ` +
        failure.searchedList.map((directory) => `"${directory}"`).join(' or ')
      );
    case 'import-failed':
      return `its contract registry failed to import: ${failure.cause}`;
    case 'not-a-registry':
      return `"${failure.registryPath}" has no default-exported ContractRegistry`;
  }
}

/**
 * Loads the contract registry of every declared package, producing the cache and
 * the package → hash map together.
 *
 * Resolution, import and hashing are `loadPluginContractRegistry` from
 * `@rawbox/runner`, shared with `PluginDiscoverer.loadPlugins` and
 * `resolvePluginLockEntries`. What stays here is verification's own policy:
 *
 *   - a **list** of search directories, tried in order, because a workflow can
 *     be verified from a target folder, its workspace, its own directory or the
 *     cwd, and any of them may be where the packages landed;
 *   - the **bare-specifier fallback stays off**. `verify` reports on a specific
 *     workspace's install, so resolving out of the CLI's own dependency tree
 *     would turn "not installed here" into a false pass;
 *   - a package that cannot be loaded is reported rather than thrown: the
 *     resolver turns a missing entry into an error that also lists what *was*
 *     loaded, which is the more useful diagnostic, and a workflow declaring no
 *     plugins at all must still verify.
 */
async function loadPluginRegistries(
  packageNameList: readonly string[],
  searchDirectoryList: readonly string[],
): Promise<PluginLoadResult> {
  const registryCache = new ContractRegistryCache();
  const registryHashByPlugin: Record<string, string> = {};
  const failureList: PluginLoadFailure[] = [];

  for (const packageName of packageNameList) {
    const result = await loadPluginContractRegistry(packageName, {
      resolveFrom: searchDirectoryList,
      registryCache,
    });

    if (result.isErr()) {
      failureList.push({
        packageName,
        reason: describeLoadFailure(result.error),
      });
      continue;
    }

    registryHashByPlugin[packageName] = result.value.registryHash;
  }

  return { registryCache, registryHashByPlugin, failureList };
}

// ---------------------------------------------------------------------------
// rawbox.lock
// ---------------------------------------------------------------------------

const lockValidator = Compile(RawboxLock);

type LockRead =
  | { status: 'absent' }
  | { status: 'ok'; lock: RawboxLock }
  | { status: 'invalid'; message: string };

/** Reads `<workspaceDir>/rawbox.lock`. Absent means "resolve what is installed". */
async function readLock(workspaceDirectory: string): Promise<LockRead> {
  const lockPath = path.join(workspaceDirectory, RAWBOX_LOCK_FILENAME);

  let content: string;
  try {
    content = await fs.readFile(lockPath, 'utf-8');
  } catch {
    return { status: 'absent' };
  }

  // `rawbox.lock` has no extension, and is documented in YAML while the data
  // model is plain JSON-compatible. `parseConfig` accepts both, so reading it
  // here does not pin the writer to one encoding.
  let data: unknown;
  try {
    data = parseConfig(content, lockPath);
  } catch (error) {
    return {
      status: 'invalid',
      message:
        `"${lockPath}" is not valid JSON or YAML: ${getErrorMessage(error)}\n` +
        `The lock is generated — do not hand-edit it. Regenerate with: ` +
        `npx rawbox-cli workflow lock <workflow file>`,
    };
  }

  if (!lockValidator.Check(data)) {
    const details = Array.from(lockValidator.Errors(data))
      .map((error) => `  - Path: "${error.instancePath}" : ${error.message}`)
      .join('\n');
    return {
      status: 'invalid',
      message:
        `"${lockPath}" does not match the rawbox.lock schema:\n${details}\n` +
        `Regenerate with: npx rawbox-cli workflow lock <workflow file>`,
    };
  }

  return { status: 'ok', lock: data };
}

// ---------------------------------------------------------------------------
// Storage-boundary diagnostics on the *authored* document
//
// `validateStorageBoundaries` runs on resolver output (below), which is where
// the format requires it. But a boundary mistake in an authored file is caught
// one layer earlier, by `additionalProperties: false` on the binding schemas
// — and there it surfaces as an opaque union-mismatch error that never says
// the word "workspace". These files are authored by agents iterating against
// this exact command, so the message has to name the rule that was broken.
// ---------------------------------------------------------------------------

function describeBinding(
  stepIndex: number,
  label: unknown,
  section: string,
  field: string,
): string {
  const step =
    typeof label === 'string' && label.length > 0
      ? `step "${label}" (steps[${stepIndex}])`
      : `steps[${stepIndex}]`;
  return `${step}: ${section} "${field}"`;
}

/**
 * Scans a raw parsed document for the two storage-boundary mistakes the schema
 * rejects structurally, and explains each in the vocabulary of
 * FORMAT.md, "Bindings".
 */
function describeBoundaryViolations(document: unknown): string[] {
  if (!isPlainObject(document) || !Array.isArray(document.steps)) {
    return [];
  }

  const problemList: string[] = [];

  document.steps.forEach((step: unknown, stepIndex: number) => {
    if (!isPlainObject(step)) {
      return;
    }

    const sectionList: Array<{ name: string; isWrite: boolean }> = [
      { name: 'inputs', isWrite: false },
      { name: 'outputs', isWrite: true },
      { name: 'errors', isWrite: true },
    ];

    for (const { name, isWrite } of sectionList) {
      const record = step[name];
      if (!isPlainObject(record)) {
        continue;
      }

      for (const [field, binding] of Object.entries(record)) {
        if (!isPlainObject(binding)) {
          continue;
        }
        const where = describeBinding(stepIndex, step.label, name, field);

        if ('workspace' in binding) {
          problemList.push(
            `${where} declares a "workspace" property. Storage is always scoped to the ` +
              `workspace the workflow runs in, so no binding may name another workspace — ` +
              `remove it.`,
          );
        }

        if (isWrite && 'workflow' in binding) {
          problemList.push(
            `${where} declares a "workflow" property. A step may only write into its own ` +
              `workflow; only \`inputs:\` may name another workflow (a cross-workflow read). ` +
              `Remove "workflow" from this ${name === 'outputs' ? 'output' : 'error'} binding.`,
          );
        }
      }
    }
  });

  return problemList;
}

// ---------------------------------------------------------------------------
// workflow verify
// ---------------------------------------------------------------------------

/**
 * Verifies a workflow document end to end:
 *
 * 1. the document declares `kind: Workflow` and matches the authoring schema;
 * 2. its workspace context is located — from `--workspace`, or by reading
 *    `kind: Workspace`. Without a workspace context, steps 3–5 below (the
 *    majority of what this command checks) cannot run, so failing to locate
 *    one is a failure of verification, not a pass with reduced coverage;
 * 3. every declared plugin's contract registry is loaded, producing the
 *    package → hash map the resolver needs;
 * 4. the document is **resolved** — this is what checks every `plugin:` and
 *    `operation:` reference and verifies `rawbox.lock` when present;
 * 5. storage boundaries and seed data are validated **on the resolver's output**,
 *    not on the raw document. An authored document has `steps`, not `stepList`,
 *    so checking the raw file passes vacuously.
 */
export async function verifyWorkflow(
  workflowPath: string,
  options: { workspace?: string; workspaceName?: string; seed?: string[] } = {},
): Promise<void> {
  const absoluteWorkflowPath = path.resolve(process.cwd(), workflowPath);
  const workflowDirectory = path.dirname(absoluteWorkflowPath);

  // -- 0. --seed key=<json> ---------------------------------------------------
  // Parsed before anything else, same reasoning as `run.ts`'s own step 0: it needs
  // no workspace and no workflow document, so a malformed value is refused
  // immediately, named, rather than surfacing as a failure attributed to
  // either document.
  const seedFlagResult = parseSeedFlagList(options.seed ?? []);
  if (seedFlagResult.isErr()) {
    p.log.error(pc.red(seedFlagResult.error));
    p.outro(pc.red('❌ Workflow verification failed with errors.'));
    process.exit(1);
    return;
  }
  const cliSeedOverrideLayer = seedOverrideLayerFromFlags(seedFlagResult.value);

  const s = p.spinner();
  s.start(`Loading workflow from ${pc.green(workflowPath)}...`);

  try {
    // -- 1. Document schema ------------------------------------------------
    const content = await fs.readFile(absoluteWorkflowPath, 'utf-8');
    const document = parseConfig(content, absoluteWorkflowPath);

    const typeResult = validateWorkflowType(document, workflowPath);
    if (typeResult.isErr()) {
      s.error('Validation failed.');
      p.log.error(pc.red(`Workflow schema is invalid:\n${typeResult.error.message}`));

      // The schema rejects a boundary violation structurally, but says so in
      // union-mismatch terms. Translate it while the raw document is in hand.
      for (const problem of describeBoundaryViolations(document)) {
        p.log.error(pc.red(`Storage boundary violation: ${problem}`));
      }

      p.outro(pc.red('❌ Workflow verification failed with errors.'));
      process.exit(1);
      return;
    }

    const workflow = document as Workflow;
    s.stop(`Workflow "${pc.cyan(workflow.name)}" loaded and schema validated.`);

    // -- 1b. Storage budget ------------------------------------------------
    // Computed from the *authored* `storage:` block alone and printed as soon
    // as the document is schema-valid — deliberately **before** workspace
    // discovery and plugin resolution, neither of which the budget depends
    // on. A workflow whose plugins are not yet installed, or that has no
    // workspace context at all, still gets an answer to "what will this
    // cost". (Not computed from `resolved.seedData`: that only carries
    // *seeded* keys, so a key declared with no `seed:` would silently be
    // dropped from the total if this read the resolved model.)
    //
    // `boundKeyList` is what makes the figure cover what the workflow can
    // actually write: a key named only in a step binding is legal, resolves to
    // `defaultStrategy`, and is written at run time. Without it, a workflow
    // declaring no `storage.keys` at all reports a budget of zero.
    //
    // `boxStorageFor` — **never** `workflow.storage` spread directly — because
    // `budgetForStorage` (`@rawbox/store`) cannot read `storage.keys`: the
    // authoring schema lives in `@rawbox/runner`, one side of a dependency
    // that never runs backward (`key-table.ts`'s note on `boxStorageFor`
    // explains why). The spread still type-checks — every `BoxStorage` field
    // past `defaultStrategy` is optional — and charges nothing at all, so the
    // mistake is silent in both directions. `boxStorageFor` runs
    // `resolveKeyTable` on this side of the boundary and hands back the shape
    // `budgetForStorage` already sums.
    const budget = budgetForStorage({
      ...boxStorageFor(workflow.storage),
      boundKeyList: collectBoundStorageKeys(workflow),
    });

    p.log.info(
      pc.cyan(
        'Storage budget (a figure to size a volume or container with, not a limit the store enforces):',
      ),
    );
    for (const keyBudget of budget.keyBudgetList) {
      p.log.step(formatKeyBudgetLine(keyBudget));
    }
    // Keys whose strategy declares no byte budget. Printed as their own lines,
    // never as `0` bytes among the figures above: a zero would be read as "this
    // key costs nothing", and the note below says the totals cover fewer keys
    // than the document declares rather than leaving that to be inferred.
    for (const unbudgetableKey of budget.unbudgetableKeyList) {
      p.log.step(formatUnbudgetableKeyLine(unbudgetableKey));
    }
    const boundKeyNote = formatBoundKeyNoteLine(budget);
    if (boundKeyNote) {
      p.log.step(boundKeyNote);
    }
    const unbudgetableNote = formatUnbudgetableKeyNoteLine(budget);
    if (unbudgetableNote) {
      p.log.step(unbudgetableNote);
    }
    // Cross-workflow reads: excluded from the figures above by design (their
    // bytes belong to the owning workflow's budget), but excluded should not
    // read as absent — name the key and the workflow that owns it. No
    // workspace context exists yet at this point (the budget prints before
    // workspace discovery, by design), so this cannot say whether the owner
    // is one of this workspace's workflows.
    for (const line of formatCrossWorkflowReadLines(
      collectCrossWorkflowReads(workflow),
    )) {
      p.log.step(line);
    }
    for (const line of formatStorageBudgetSummaryLines(
      budget,
      `Workflow "${workflow.name}"`,
    )) {
      p.log.step(line);
    }

    // -- 2. Workspace context ----------------------------------------------
    // `--workspace-name` (rawbox-runner README, "Implicit (workspace-less) workspaces") synthesizes
    // the workspace context in memory instead of reading or discovering a
    // document, so it skips both `--workspace` and discovery outright — the
    // CLI enforces the two flags are mutually exclusive before this runs.
    let workspaceFile = options.workspace;
    const scratchWorkspaceName = options.workspaceName;

    if (scratchWorkspaceName !== undefined) {
      p.log.info(
        `state persisted under workspace ${pc.green(`"${scratchWorkspaceName}"`)} — reruns ` +
          `with the same name share it.`,
      );
    } else if (!workspaceFile) {
      const discovery = await discoverWorkspace(absoluteWorkflowPath);

      if (discovery.ambiguousList) {
        p.log.error(
          pc.red(
            `Several workspace documents were found in one directory:\n` +
              discovery.ambiguousList.map((file) => `  - ${file}`).join('\n') +
              `\nPass the one to verify against explicitly: --workspace <file>`,
          ),
        );
        p.outro(pc.red('❌ Workflow verification failed with errors.'));
        process.exit(1);
        return;
      }

      if (discovery.file) {
        workspaceFile = discovery.file;
        p.log.info(
          `Auto-discovered workspace ${pc.green(workspaceFile)} (kind: ${DOCUMENT_KIND.WORKSPACE}).`,
        );
      } else {
        p.log.error(
          pc.red(
            `Verification could not be completed: no "kind: ${DOCUMENT_KIND.WORKSPACE}" ` +
              `document was found, so no workspace context is available. The workflow document ` +
              `itself is schema-valid, but without a workspace the following were NOT checked:\n` +
              `  - plugin resolution\n` +
              `  - operation existence against the contract registry\n` +
              `  - seed validation against contract input schemas\n` +
              `  - ${RAWBOX_LOCK_FILENAME} integrity\n` +
              `Directories searched:\n` +
              discovery.searchedList.map((directory) => `  - ${directory}`).join('\n') +
              `\nPass --workspace <file> to verify against a specific workspace.\n` +
              `Or run without a workspace document at all: --workspace-name <name>.`,
          ),
        );
        p.outro(pc.red('❌ Workflow verification failed with errors.'));
        process.exit(1);
        return;
      }
    }

    let workspaceName = '<no workspace>';
    let workspaceDirectory: string | undefined;
    // The workspace's `backends:` map and the path to quote for it. Hoisted out
    // of the branch below because step 2b needs both *after* the workspace context
    // is settled, and because a synthesized (`--workspace-name`) context has
    // neither — which is itself the answer step 2b reports.
    let workspaceBackends: BackendMap | undefined;
    let workspaceBackendSource: string | undefined;
    // The workspace's `seedOverrides:` block, hoisted for the same reason and
    // read as-is for the same reason: `workspace verify` validates that
    // document, and this command must not report a second document's schema
    // errors. `seedOverrideLayerFor` treats anything that is not a map as
    // supplying no overrides.
    let workspaceSeedOverrides: unknown;
    // …and its `workflowPathList`, which is what a `seedOverrides:` key is
    // checked against (step 2c). Hoisted beside the block because the two are read
    // together: keying by path is precisely what lets this command answer
    // "does that block name a workflow this workspace lists" from the one
    // document, without holding every sibling workflow.
    let workspaceWorkflowPathList: unknown;
    // The workspace's `logs:` block, read the same defensive way as
    // `seedOverrides:` above and for the same reason — `workspace verify`
    // validates this document's schema, not this command.
    let workspaceLogs: unknown;

    if (scratchWorkspaceName !== undefined) {
      // The workflow's own directory stands in for "the workspace
      // directory" — the same convention `runWorkflowCommand` uses for a
      // scratch run, so `verify --workspace-name` and `run --workspace-name`
      // agree about where a lock file or an installed plugin would live.
      workspaceName = scratchWorkspaceName;
      workspaceDirectory = workflowDirectory;
      p.log.info(`Verifying against synthesized (workspace-less) workspace: ${pc.green(workspaceName)}`);
    } else if (workspaceFile) {
      const workspaceAbsolutePath = path.resolve(process.cwd(), workspaceFile);
      workspaceDirectory = path.dirname(workspaceAbsolutePath);

      const workspaceDocument = parseConfig(
        await fs.readFile(workspaceAbsolutePath, 'utf-8'),
        workspaceAbsolutePath,
      );

      if (
        isPlainObject(workspaceDocument) &&
        workspaceDocument.kind !== undefined &&
        workspaceDocument.kind !== DOCUMENT_KIND.WORKSPACE
      ) {
        p.log.error(
          pc.red(
            `"${workspaceFile}" declares kind ${JSON.stringify(workspaceDocument.kind)}, ` +
              `but --workspace expects a document of kind "${DOCUMENT_KIND.WORKSPACE}".`,
          ),
        );
        p.outro(pc.red('❌ Workflow verification failed with errors.'));
        process.exit(1);
        return;
      }

      workspaceName = String(workspaceDocument?.name ?? '<unnamed workspace>');
      p.log.info(`Verifying against workspace: ${pc.green(workspaceFile)}`);

      // Read as-is rather than through the `Workspace` schema: `workspace
      // verify` is what validates that document, and this command must not
      // start reporting a second document's schema errors. A `backends:` that
      // is not a map simply yields no ids, and the unknown-id diagnostic below
      // then says so in the vocabulary of the *workflow* being verified.
      workspaceBackends = isPlainObject(workspaceDocument?.backends)
        ? (workspaceDocument.backends as BackendMap)
        : undefined;
      workspaceBackendSource = workspaceFile;
      workspaceSeedOverrides = isPlainObject(workspaceDocument)
        ? workspaceDocument.seedOverrides
        : undefined;
      workspaceLogs = isPlainObject(workspaceDocument) ? workspaceDocument.logs : undefined;

      // A workflow the workspace does not list will never be installed or run
      // as part of it — worth saying, but not a reason to fail the document.
      const workflowPathList: unknown = workspaceDocument?.workflowPathList;
      workspaceWorkflowPathList = workflowPathList;
      if (Array.isArray(workflowPathList)) {
        const isListed = workflowPathList.some(
          (entry) =>
            typeof entry === 'string' &&
            // The one resolution every reference in a workspace document goes
            // through, so this warning and step 2c's `seedOverrides:` check agree
            // about which entry names which file.
            resolveWorkspaceWorkflowPath(workspaceDirectory!, entry) ===
              absoluteWorkflowPath,
        );
        if (!isListed) {
          p.log.warn(
            `Workspace "${workspaceName}" does not list this workflow in workflowPathList. ` +
              `It will not be installed or run as part of that workspace.`,
          );
        }
      }
    }

    // -- 2a2. `logs.rotate` is not half-configured ---------------------------
    //
    // The one cross-field rule a schema cannot express — see
    // `@rawbox/runner`'s `workspace/logs.ts`, `collectLogRotationProblems`.
    // Runs here, right after the workspace context settles, for the same
    // reason step 2a checks `seedOverrides:` as soon as the document is in
    // hand: this command must catch a half-configured bound before a run
    // ever does, not only when `workspace verify` happens to be run against
    // the same document. A synthesized (`--workspace-name`) context has no
    // document and therefore no `logs:` block to be wrong about.
    for (const problem of collectLogRotationProblems({
      logs: workspaceLogs,
      source: workspaceFile ?? workspaceName,
    })) {
      p.log.error(pc.red(problem));
      p.outro(pc.red('❌ Workflow verification failed with errors.'));
      process.exit(1);
      return;
    }

    // -- 2b. Backend references, against the workspace -----------------------
    //
    // A strategy's `backend:` is an **id** into the workspace's `backends:` map,
    // not a connection string (`@rawbox/runner`, `workspace/backends.ts` says
    // why). Which means this is the first check in this command that needs
    // *both* documents — and it is placed here, immediately after the workspace
    // context is settled, for exactly that reason.
    //
    // **So a `redis-kv` workflow is shape-verifiable alone and
    // connection-verifiable only with its workspace.** Everything above this
    // point — the schema, the strategy-field diagnostics, the storage budget —
    // read the workflow document and nothing else, and they still pass for a
    // document naming a backend that does not exist. That split is not new: it
    // is the same one `plugin:` resolution has always had, which is why step 2
    // fails outright rather than passing with reduced coverage when no
    // workspace can be found. One rule, two things it governs.
    const backendReferenceList = collectBackendReferenceList(workflow);

    if (backendReferenceList.length > 0) {
      if (workspaceBackendSource === undefined) {
        // `--workspace-name` synthesizes a context in memory; there is no
        // document, so there is nowhere for `backends:` to be declared and
        // nothing to correct the id against. Reported as a failure rather than
        // a warning, because the run this verification is standing in for
        // cannot resolve the id either.
        p.log.error(
          pc.red(
            `This workflow names ${backendReferenceList.length} storage ` +
              `${backendReferenceList.length === 1 ? 'backend' : 'backends'} ` +
              `(${backendReferenceList.map((reference) => `"${reference.backendId}" at ${reference.path}`).join(', ')}), ` +
              `but it is being verified against a synthesized workspace ` +
              `(--workspace-name), which declares no "backends:" map.\n` +
              `  A "backend:" is an id into that map, and the map lives in the ` +
              `workspace document — so this workflow cannot be connection-verified, ` +
              `or run, without one.\n` +
              `  Verify against the real workspace instead: --workspace <file>.`,
          ),
        );
        p.outro(pc.red('❌ Workflow verification failed with errors.'));
        process.exit(1);
        return;
      }

      const backendProblemList = [
        ...collectUnknownBackendProblems({
          document: workflow,
          backends: workspaceBackends,
          workflowLabel: `"${workflowPath}"`,
          workspaceSource: workspaceBackendSource,
        }),
        // Only the backends THIS workflow references. A workflow touching no
        // Redis must not fail because the workspace also declares a `prod`
        // backend whose password this developer does not hold — see
        // `collectBackendEnvProblems` for why the scope is the caller's choice.
        ...collectBackendEnvProblems({
          backends: workspaceBackends,
          source: workspaceBackendSource,
          env: process.env,
          backendIdList: backendReferenceList.map(
            (reference) => reference.backendId,
          ),
        }),
      ];

      if (backendProblemList.length > 0) {
        for (const problem of backendProblemList) {
          p.log.error(pc.red(problem));
        }
        p.outro(pc.red('❌ Workflow verification failed with errors.'));
        process.exit(1);
        return;
      }

      p.log.step(
        `${backendReferenceList.length} storage backend ` +
          `${backendReferenceList.length === 1 ? 'reference' : 'references'} resolved ` +
          `against "${workspaceBackendSource}", with every environment variable set.`,
      );
    }

    // -- 2c. Seed overrides, merged in --------------------------------------
    //
    // The second check in this command that needs *both* documents, and placed
    // beside the first for that reason. A `seedOverrides:` block replaces the
    // value a key starts with and NOTHING else — not its strategy, not its
    // sizing, not its owner, not its backend — so everything above this line
    // (the schema, the strategy-field diagnostics, the storage budget) is
    // unaffected by it and still reads the authored document.
    //
    // Everything **below** it must read the merged one: step 5 resolves seeds into
    // the writes a run performs, and step 7 checks each of those against the
    // consuming step's `inputSchema`. Verifying the authored value would pass a
    // document whose run then writes a different one.
    //
    // A `--workspace-name` (scratch) context has no document, so there is
    // nowhere for a block to be declared and nothing to merge — the same
    // answer step 2b gives for `backends:`, minus the failure, because a workflow
    // that names no override is complete on its own.
    //
    // `--seed` becomes a second layer, appended after the workspace's — `CLI >
    // workspace > workflow`, the same precedence `run.ts` builds — kept as a
    // local so the per-key report below can read exactly what was applied
    // without re-deriving it.
    //
    // **The block's outer keys are checked here too, not only by `workspace
    // verify`.** A `seedOverrides:` key is a workflow *path*, so
    // `workflowPathList` in the document already read above answers "does this
    // block name a workflow this workspace lists" — no sibling workflow
    // document needed. That is the whole point of keying by path: this command
    // used to select a block by name and return nothing for a name it did not
    // recognise, so a misspelt block passed `workflow verify` and then seeded
    // the workflow's own value at run time.
    const overridePathProblem = formatSeedOverridePathProblems({
      seedOverrides: workspaceSeedOverrides,
      workflowPathList: workspaceWorkflowPathList,
      workspaceDir: workspaceFile === undefined ? undefined : workspaceDirectory,
      source: workspaceFile ?? workspaceName,
    });

    if (overridePathProblem !== undefined) {
      p.log.error(pc.red(overridePathProblem));
      p.outro(pc.red('❌ Workflow verification failed with errors.'));
      process.exit(1);
      return;
    }

    const seedOverrideLayerList: SeedOverrideLayer[] = [
      seedOverrideLayerFor({
        seedOverrides: workspaceSeedOverrides,
        workflowPath: absoluteWorkflowPath,
        // A synthesized (`--workspace-name`) context has no document, so there
        // is no path base and no block to select — the same answer step 2b gives
        // for `backends:`, minus the failure.
        workspaceDir: workspaceFile === undefined ? undefined : workspaceDirectory,
        source: workspaceFile ?? workspaceName,
      }),
    ]
      .filter((layer): layer is SeedOverrideLayer => layer !== undefined)
      .concat(cliSeedOverrideLayer ? [cliSeedOverrideLayer] : []);

    const overrideResult = applySeedOverrides({
      workflow,
      workflowSource: workflowPath,
      layerList: seedOverrideLayerList,
    });

    if (overrideResult.isErr()) {
      p.log.error(pc.red(overrideResult.error));
      p.outro(pc.red('❌ Workflow verification failed with errors.'));
      process.exit(1);
      return;
    }

    // The merged document from here on. Identical to `workflow` — the same
    // object — when no override applied, so a workspace that declares none
    // and no `--seed` flag changes nothing about this command.
    const mergedWorkflow = overrideResult.value;

    if (mergedWorkflow !== workflow) {
      p.log.step(
        `Seed overrides from ${pc.green(workspaceFile ?? workspaceName)} applied ` +
          `to workflow "${pc.cyan(workflow.name)}".`,
      );
      // Every key any layer applied, and which layer supplied it — safe to
      // read straight off `seedOverrideLayerList` now that `applySeedOverrides`
      // above returned `ok` for it (`summarizeAppliedSeedOverrides`'s own doc
      // says why). This is what makes a `--seed` override reviewable at all:
      // it has no file and no diff anywhere else, so this line — printed
      // before a run ever starts — and the run's own `seed.override.applied`
      // NDJSON event are the only two places it is visible.
      for (const application of summarizeAppliedSeedOverrides(seedOverrideLayerList)) {
        p.log.step(`  ${pc.cyan(application.key)} ← ${application.source}`);
      }
    }

    // -- 3. Plugin registries ----------------------------------------------
    // The workspace's target folder leads, for the same reason it leads in
    // `runWorkflowInstance`: it is where `workspace setup` installed the
    // packages this workflow declared. It defaults to the workspace directory,
    // so for a workspace that declares no `targetFolder:` this list is
    // unchanged apart from the duplicate the dedup below removes.
    const targetFolder =
      scratchWorkspaceName !== undefined
        ? resolveTargetFolder(workspaceDirectory!, {})
        : workspaceFile
          ? await resolveWorkspaceTargetFolder(path.resolve(process.cwd(), workspaceFile))
          : undefined;
    const searchDirectoryList = [
      ...new Set([
        ...(targetFolder ? [targetFolder] : []),
        ...(workspaceDirectory ? [workspaceDirectory] : []),
        workflowDirectory,
        process.cwd(),
      ]),
    ];

    const declaredPackageList = Object.keys(workflow.plugins);
    const { registryCache, registryHashByPlugin, failureList } =
      await loadPluginRegistries(declaredPackageList, searchDirectoryList);

    for (const failure of failureList) {
      p.log.warn(
        `Plugin "${failure.packageName}" could not be loaded: ${failure.reason}\n` +
          `Install the workspace's plugins first: npx rawbox-cli workspace setup ` +
          `<workspace file> [target folder]`,
      );
    }

    // -- 4. rawbox.lock ----------------------------------------------------
    let lock: RawboxLock | undefined;
    if (workspaceDirectory) {
      const lockRead = await readLock(workspaceDirectory);
      if (lockRead.status === 'invalid') {
        p.log.error(pc.red(lockRead.message));
        p.outro(pc.red('❌ Workflow verification failed with errors.'));
        process.exit(1);
        return;
      }
      if (lockRead.status === 'ok') {
        lock = lockRead.lock;
        p.log.info(
          `Checking plugin integrity against ${pc.green(RAWBOX_LOCK_FILENAME)}.`,
        );
      }
    }

    // -- 5. Resolution ------------------------------------------------------
    // Every step reference and lock entry is checked here, and the
    // result is the runtime model the remaining validators operate on.
    const resolveResult = resolveWorkflow(
      mergedWorkflow,
      registryCache,
      registryHashByPlugin,
      lock,
    );

    if (resolveResult.isErr()) {
      p.log.error(pc.red(resolveResult.error));
      p.outro(pc.red('❌ Workflow verification failed with errors.'));
      process.exit(1);
      return;
    }

    const resolved = resolveResult.value;

    // -- 6. Storage boundaries, on the resolved model ----------------------
    const boundaryResult = validateStorageBoundaries(resolved, workspaceName);
    if (boundaryResult.isErr()) {
      p.log.error(
        pc.red(`Storage boundary validation failed:\n  ${boundaryResult.error.message}`),
      );
      p.outro(pc.red('❌ Workflow verification failed with errors.'));
      process.exit(1);
      return;
    }

    // -- 7. Seed data, on the resolved model -------------------------------
    // This is where a value an author wrote meets the `inputSchema` of the
    // field that consumes it.
    const seedResult = validateSeedData(resolved, registryCache);
    if (seedResult.isErr()) {
      p.log.error(pc.red(seedResult.error.message));
      p.outro(pc.red('❌ Workflow verification failed with errors.'));
      process.exit(1);
      return;
    }

    // -- 7b. Bounds that are legal but probably not meant -------------------
    // Warnings, never failures: `collectTimeoutWarnings` reports bounds the
    // format accepts and the runner will enforce exactly as written — an author
    // is allowed to mean something surprising, and a command that refused the
    // document over one would be refusing a working workflow. So this neither
    // returns early nor touches the exit code; it prints and falls through to
    // the report below. It runs on the *resolved* model because the rule needs
    // the contract behind each step, which only resolution supplies.
    for (const warning of collectTimeoutWarnings(resolved, registryCache)) {
      p.log.warn(warning);
    }

    // -- 8. Report ----------------------------------------------------------
    for (const [packageName, hash] of Object.entries(registryHashByPlugin)) {
      p.log.step(
        `Plugin ${pc.cyan(packageName)} → registry ${pc.dim(hash.slice(0, 12))}…`,
      );
    }

    workflow.steps.forEach((step, index) => {
      const label = step.label ?? `#${index}`;
      p.log.step(
        `Step "${label}" verified: ${pc.cyan(step.plugin)} → ${pc.cyan(step.operation)}.`,
      );
    });

    if (resolved.seedData && resolved.seedData.length > 0) {
      p.log.step(
        `${resolved.seedData.length} seed value(s) validated against their contract input schemas.`,
      );
    }

    p.outro(pc.green('✅ Workflow verification complete and successful!'));
  } catch (error) {
    s.error('Failed.');
    p.log.error(pc.red(`Error: ${getErrorMessage(error)}`));
    process.exit(1);
  }
}
