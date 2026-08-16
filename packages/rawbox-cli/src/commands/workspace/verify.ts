import fs from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { Compile } from 'typebox/compile';
import {
  DOCUMENT_KIND,
  RAWBOX_LOCK_FILENAME,
  Workspace,
  boxStorageFor,
  collectBackendEnvProblems,
  collectBoundStorageKeys,
  collectLogRotationProblems,
  collectUnknownBackendProblems,
  collectSeedOverridePathProblems,
  formatValidationErrors,
  resolveWorkspaceWorkflowPath,
  parseConfig,
  validateWorkflowType,
  workspaceKindError,
  type Workflow,
} from '@rawbox/runner';
import {
  LMDB_BUDGET_RESIDUAL_FACTOR,
  budgetForStorage,
  recommendedVolumeBytesFor,
} from '@rawbox/store';
import { getErrorMessage } from '../../utils/error.js';
import {
  collectCrossWorkflowReads,
  formatBoundKeyNoteLine,
  formatCrossWorkflowReadLines,
  formatKeyBudgetLine,
  formatStorageBudgetSummaryLines,
  formatUnbudgetableKeyLine,
  formatUnbudgetableKeyNoteLine,
  formatWorkspaceUnbudgetableKeyLines,
  type WorkspaceUnbudgetableKey,
} from '../../utils/budget-report.js';

const workspaceValidator = Compile(Workspace);

/** Prefix of a specifier pointing at a directory rather than a registry. */
const FILE_SPECIFIER_PREFIX = 'file:';


// ---------------------------------------------------------------------------
// Conflicting plugin specifiers
//
// Plugins are declared per *workflow*, but `rawbox.lock` is keyed by package
// name at the *workspace* level: one package, one resolved version, one
// registry hash for the whole workspace. Two workflows in the same workspace
// declaring different specifiers for the same package therefore cannot both be
// honoured — one of them is silently going to run against the other's version.
//
// The install pipeline merges every workflow's `plugins:` map into a single
// generated `package.json` with last-wins semantics, which makes the outcome
// depend on `workflowPathList` ordering. That is unspecified behaviour, so it
// is reported here as a workspace verification error rather than resolved by
// coin flip.
// ---------------------------------------------------------------------------

/** Which workflows declared a given specifier for a given package. */
interface SpecifierDeclaration {
  specifier: string;
  workflowPathList: string[];
}

/** Package name → the distinct specifiers declared for it, in first-seen order. */
type SpecifierIndex = Map<string, SpecifierDeclaration[]>;

function recordSpecifier(
  index: SpecifierIndex,
  packageName: string,
  specifier: string,
  workflowPath: string,
): void {
  const declarationList = index.get(packageName) ?? [];
  const existing = declarationList.find(
    (declaration) => declaration.specifier === specifier,
  );

  if (existing) {
    if (!existing.workflowPathList.includes(workflowPath)) {
      existing.workflowPathList.push(workflowPath);
    }
  } else {
    declarationList.push({ specifier, workflowPathList: [workflowPath] });
  }

  index.set(packageName, declarationList);
}

/**
 * Builds the error text for one package declared with several specifiers.
 *
 * These files are authored by agents iterating against this command, so the
 * message names every conflicting specifier *and* the workflow that declared
 * it — the fix is always "make these agree", and the author needs to know which
 * files to edit.
 */
function describeSpecifierConflict(
  packageName: string,
  declarationList: readonly SpecifierDeclaration[],
): string {
  const detail = declarationList
    .map(
      (declaration) =>
        `  - "${declaration.specifier}" declared by:\n` +
        declaration.workflowPathList
          .map((workflowPath) => `      ${workflowPath}`)
          .join('\n'),
    )
    .join('\n');

  return (
    `Plugin "${packageName}" is declared with ${declarationList.length} different ` +
    `specifiers in this workspace:\n${detail}\n` +
    `A workspace resolves each package once: ${RAWBOX_LOCK_FILENAME} is keyed by ` +
    `package name at the workspace level, and \`workspace setup\` splices every ` +
    `workflow's \`plugins:\` map into one generated package.json. Two specifiers for ` +
    `one package cannot both be installed, and which one wins would depend on the ` +
    `order of \`workflowPathList\`.\n` +
    `Make every workflow in this workspace declare the same specifier for ` +
    `"${packageName}".`
  );
}

// ---------------------------------------------------------------------------
// Cross-workflow read ownership
//
// `workspace verify` can say something `workflow verify` cannot: whether a
// cross-workflow read's declared owner is one of *this* workspace's own
// workflows — the case where a reader can actually go look at the other
// figure, versus one naming a workflow this run knows nothing about.
//
// That needs every workflow's `name:`, gathered ahead of the main loop below
// so a read is checked against the *whole* workspace regardless of where in
// `workflowPathList` the reader and the owner each fall. Failures here are
// silent on purpose: this is read-ahead for one piece of context, not a
// validation pass — the main loop is the authoritative one and reports
// parse/schema failures properly.
// ---------------------------------------------------------------------------

async function collectWorkspaceWorkflowNames(
  workspaceDirectory: string,
  workflowPathList: readonly string[],
): Promise<Set<string>> {
  const nameSet = new Set<string>();

  for (const workflowPath of workflowPathList) {
    try {
      const fullPath = resolveWorkspaceWorkflowPath(workspaceDirectory, workflowPath);
      const document = parseConfig(await fs.readFile(fullPath, 'utf-8'), fullPath);
      const typeResult = validateWorkflowType(document, workflowPath);
      if (typeResult.isOk()) {
        nameSet.add((document as Workflow).name);
      }
    } catch {
      // Reported properly by the main verification loop below.
    }
  }

  return nameSet;
}

// ---------------------------------------------------------------------------
// workspace verify
// ---------------------------------------------------------------------------

/**
 * Verifies a workspace document and every workflow it lists.
 *
 * 1. the document carries `kind: Workspace`, which is required, and matches
 *    the `Workspace` schema;
 * 2. every path in `workflowPathList` exists and is a valid workflow document —
 *    a file that is not one is rejected here with the same diagnostic
 *    `workflow verify` gives, rather than being silently skipped;
 * 3. the union of every workflow's `plugins:` map is free of conflicting
 *    specifiers;
 * 4. every `file:` specifier points at a directory that exists.
 *
 * Plugin *installation* is not required to pass: `workspace setup` is what
 * installs, and a workspace must be verifiable before it has been set up.
 */
export async function verifyWorkspace(workspacePath: string): Promise<void> {
  const absolutePath = path.resolve(process.cwd(), workspacePath);
  const workspaceDirectory = path.dirname(absolutePath);
  const s = p.spinner();
  s.start(`Loading workspace config from ${pc.green(workspacePath)}...`);

  try {
    const content = await fs.readFile(absolutePath, 'utf-8');
    const document = parseConfig(content, absolutePath);

    // -- 1. Document identity ----------------------------------------------
    // `kind` is required: a workspace without it is undiscoverable, so this is
    // an error rather than a warning — reporting it as a pass would let
    // `workspace verify` and `workflow verify` disagree about the same tree.
    const kindError = workspaceKindError(document, workspacePath);
    if (kindError !== undefined) {
      s.error('Validation failed.');
      p.log.error(
        pc.red(
          `${kindError}\n` +
            `Valid kinds are: ${Object.values(DOCUMENT_KIND).map((kind) => `"${kind}"`).join(', ')}.`,
        ),
      );
      process.exit(1);
      return;
    }

    if (!workspaceValidator.Check(document)) {
      const errors = formatValidationErrors(
        workspaceValidator.Errors(document),
        document,
      );
      s.error('Validation failed.');
      p.log.error(pc.red(`Workspace config schema is invalid:\n${errors}`));
      process.exit(1);
      return;
    }

    const workspace = document;
    s.stop(`Workspace config for "${pc.cyan(workspace.name)}" loaded successfully.`);

    // -- 1b. Backends ------------------------------------------------------
    //
    // **Every declared backend is checked, referenced or not.** The workspace
    // document is what this command verifies, and a backend whose connection
    // string names a variable nobody set is broken whether or not a workflow
    // reaches for it today. (`workflow verify` takes the other half of that
    // rule and checks only the ids the workflow it is verifying references —
    // see `collectBackendEnvProblems` for why each command checks the document
    // it is verifying.)
    //
    // An unset variable is an **error**, not a warning. The failure being
    // designed out is a run that connects to `localhost` — or to a URL with an
    // empty password — because `${REDIS_URL}` expanded to nothing: a store that
    // answers the wrong questions is worse than one that will not open, and a
    // warning is a thing a script ignores.
    let hasError = false;

    const backendIdList = Object.keys(workspace.backends ?? {});

    if (backendIdList.length > 0) {
      const backendEnvProblemList = collectBackendEnvProblems({
        backends: workspace.backends,
        source: workspacePath,
        env: process.env,
      });

      for (const problem of backendEnvProblemList) {
        p.log.error(pc.red(problem));
        hasError = true;
      }

      if (backendEnvProblemList.length === 0) {
        p.log.step(
          `${backendIdList.length} storage ` +
            `${backendIdList.length === 1 ? 'backend' : 'backends'} declared ` +
            `(${backendIdList.map((id) => `"${pc.cyan(id)}"`).join(', ')}), every ` +
            `environment variable set.`,
        );
      }
    }

    // -- 2. Workflows ------------------------------------------------------
    p.log.info(pc.cyan('Verifying workflows...'));
    const specifierIndex: SpecifierIndex = new Map();

    // Names of every workflow this workspace declares that parses and
    // validates, gathered ahead of the loop below so a cross-workflow read's
    // owner can be checked against the whole workspace, not just the
    // workflows processed so far.
    const workspaceWorkflowNameSet = await collectWorkspaceWorkflowNames(
      workspaceDirectory,
      workspace.workflowPathList,
    );

    // -- 2a. Seed overrides name a workflow that is here --------------------
    //
    // A `seedOverrides:` block is keyed by workflow **path** — the same entry
    // `workflowPathList` holds — so this check needs nothing but the document
    // in hand, and it therefore also runs in `runWorkflowInstance` and
    // `workflow verify`. It stays here as well because each command checks the
    // document it is verifying, and this one is verifying the document the
    // block lives in: `workspace verify` reports a typo for a workflow nobody
    // is running today, which the other two cannot.
    //
    // It used to be keyed by *name*, which made this the ONLY command that
    // could check it — a name lives inside a different file — and a run with a
    // misspelt block silently used the workflow's own seed. See
    // `@rawbox/runner`'s `workspace/seed-overrides.ts` module note.
    //
    // Reported one `p.log.error` per problem rather than through
    // `formatSeedOverridePathProblems`, so these sit alongside the other
    // per-field errors this command collects for the same document.
    for (const problem of collectSeedOverridePathProblems({
      seedOverrides: workspace.seedOverrides,
      workflowPathList: workspace.workflowPathList,
      workspaceDir: workspaceDirectory,
      source: workspacePath,
    })) {
      p.log.error(pc.red(problem));
      hasError = true;
    }

    // -- 1c. `logs.rotate` is not half-configured ---------------------------
    //
    // The one cross-field rule a schema cannot express on its own — see
    // `@rawbox/runner`'s `workspace/logs.ts`, `collectLogRotationProblems`.
    // Runs here for the same reason 1b runs here: this is the document the
    // block lives in, so this is where a half-configured bound is reported
    // even for a workspace nobody has run yet.
    for (const problem of collectLogRotationProblems({
      logs: workspace.logs,
      source: workspacePath,
    })) {
      p.log.error(pc.red(problem));
      hasError = true;
    }

    // Storage budget, summed across every workflow that parsed and validated
    // — a workflow that failed to load has
    // no `storage:` block to trust, so it contributes nothing to the total
    // rather than being estimated.
    let budgetedWorkflowCount = 0;
    let totalDataBytesMax = 0;
    let totalEntryCount = 0;
    let totalPageCountMax = 0;
    // Keys no workflow's budget could charge, each tagged with the workflow it
    // came from. Accumulated rather than counted so the total below can NAME
    // what it leaves out — see `formatWorkspaceUnbudgetableKeyLines` for why
    // that is the reporting posture rather than a silent omission or an
    // invented figure.
    const workspaceUnbudgetableKeyList: WorkspaceUnbudgetableKey[] = [];

    for (const workflowPath of workspace.workflowPathList) {
      const workflowFullPath = resolveWorkspaceWorkflowPath(
        workspaceDirectory,
        workflowPath,
      );

      let workflowContent: string;
      try {
        workflowContent = await fs.readFile(workflowFullPath, 'utf-8');
      } catch {
        p.log.error(pc.red(`Workflow file not found: ${workflowPath}`));
        hasError = true;
        continue;
      }

      let workflowDocument: unknown;
      try {
        workflowDocument = parseConfig(workflowContent, workflowFullPath);
      } catch (error) {
        p.log.error(
          pc.red(`Workflow file ${workflowPath} could not be parsed: ${getErrorMessage(error)}`),
        );
        hasError = true;
        continue;
      }

      const typeResult = validateWorkflowType(workflowDocument, workflowPath);
      if (typeResult.isErr()) {
        p.log.error(
          pc.red(`Workflow ${workflowPath} is invalid:\n${typeResult.error.message}`),
        );
        hasError = true;
        continue;
      }

      const workflow = workflowDocument as Workflow;
      p.log.step(
        `Workflow ${pc.green(workflowPath)} is valid: "${pc.cyan(workflow.name)}".`,
      );

      for (const [packageName, specifier] of Object.entries(workflow.plugins)) {
        recordSpecifier(specifierIndex, packageName, specifier, workflowPath);
      }

      // A strategy's `backend:` id, against the map declared above. This is the
      // half of backend verification that needs both documents, and a workspace
      // run is the one place both are always in hand — which is why a workflow
      // declaring a backend can be shape-verified on its own but
      // connection-verified only here or under `workflow verify --workspace`.
      for (const problem of collectUnknownBackendProblems({
        document: workflow,
        backends: workspace.backends,
        workflowLabel: `workflow "${workflowPath}"`,
        workspaceSource: workspacePath,
      })) {
        p.log.error(pc.red(problem));
        hasError = true;
      }

      // Bound keys included, for the same reason `workflow verify` includes
      // them: a key named only in a step binding is written at run time, so a
      // total that omitted it would under-state what the workspace consumes.
      //
      // `boxStorageFor`, never `workflow.storage` spread directly — see the
      // matching note in `workflow verify`: `budgetForStorage` cannot read
      // `storage.keys` itself (`key-table.ts`'s note on `boxStorageFor`
      // explains why), and the spread type-checks while charging nothing, so
      // every workflow would report zero and the workspace total with it.
      const workflowBudget = budgetForStorage({
        ...boxStorageFor(workflow.storage),
        boundKeyList: collectBoundStorageKeys(workflow),
      });
      for (const keyBudget of workflowBudget.keyBudgetList) {
        p.log.step(`  ${formatKeyBudgetLine(keyBudget)}`);
      }
      // Keys whose strategy declares no byte budget — reported per workflow
      // here, and again against the workspace total below, because a reader
      // scrolling to the total must not have to remember these lines.
      for (const unbudgetableKey of workflowBudget.unbudgetableKeyList) {
        p.log.step(`  ${formatUnbudgetableKeyLine(unbudgetableKey)}`);
        workspaceUnbudgetableKeyList.push({
          workflowName: workflow.name,
          unbudgetableKey,
        });
      }
      const boundKeyNote = formatBoundKeyNoteLine(workflowBudget);
      if (boundKeyNote) {
        p.log.step(`  ${boundKeyNote}`);
      }
      const unbudgetableNote = formatUnbudgetableKeyNoteLine(workflowBudget);
      if (unbudgetableNote) {
        p.log.step(`  ${unbudgetableNote}`);
      }
      // Cross-workflow reads. Unlike `workflow verify`, this command has the
      // whole workspace in hand, so it can say
      // whether the owner is one of these workflows — the case where a
      // reader can actually go look at the other figure — or a name this run
      // never saw.
      for (const line of formatCrossWorkflowReadLines(
        collectCrossWorkflowReads(workflow),
        (owningWorkflow) => workspaceWorkflowNameSet.has(owningWorkflow),
      )) {
        p.log.step(`  ${line}`);
      }
      for (const line of formatStorageBudgetSummaryLines(
        workflowBudget,
        `Workflow "${workflow.name}"`,
      )) {
        p.log.step(`  ${line}`);
      }

      budgetedWorkflowCount += 1;
      totalDataBytesMax += workflowBudget.dataBytesMax;
      totalEntryCount += workflowBudget.entryCount;
      totalPageCountMax += workflowBudget.pageCountMax;
    }

    // -- Storage budget, workspace total -----------------------------------
    // A plain sum over every budgeted workflow's `dataBytesMax`, `entryCount`
    // and **page counts**, then re-derived into one `recommendedVolumeBytes`
    // rather than summing each workflow's own. Summing the per-workflow
    // recommendations would charge LMDB's environment overhead once per
    // workflow, where one environment holds them all.
    //
    // **This is the one call site that knows `workflowCount`**, and it is why
    // the page model takes it as a parameter here rather than as a field on
    // `BoxStorage`: one dbi is one workflow, a `storage:` block is always
    // exactly one workflow's (so `budgetForStorage` fixes the count at 1), and
    // the only place a different number exists is this loop, which has already
    // counted the workflows that contributed.
    //
    // Per-workflow page counts are already rounded up, so summing them
    // over-counts by under one page per workflow. That errs high, which is the
    // correct direction for a provisioning figure.
    if (budgetedWorkflowCount > 0) {
      p.log.info(pc.cyan('Workspace storage budget total:'));
      for (const line of formatStorageBudgetSummaryLines(
        {
          dataBytesMax: totalDataBytesMax,
          entryCount: totalEntryCount,
          pageCountMax: totalPageCountMax,
          recommendedVolumeBytes: recommendedVolumeBytesFor(totalPageCountMax, {
            workflowCount: budgetedWorkflowCount,
          }),
          workflowCount: budgetedWorkflowCount,
          residualFactor: LMDB_BUDGET_RESIDUAL_FACTOR,
        },
        `Workspace "${workspace.name}"`,
      )) {
        p.log.step(line);
      }
      // What the total does NOT cover, by name. A mixed-backend workspace has
      // no single true figure; this reports the modelled one and lists the
      // rest rather than inventing a number for them or dropping them.
      for (const line of formatWorkspaceUnbudgetableKeyLines(
        workspaceUnbudgetableKeyList,
      )) {
        p.log.step(line);
      }
      if (budgetedWorkflowCount < workspace.workflowPathList.length) {
        p.log.warn(
          `Only ${budgetedWorkflowCount} of ${workspace.workflowPathList.length} declared ` +
            `workflow(s) contributed to this total — the rest failed to load or validate ` +
            `(see errors above) and are excluded rather than estimated.`,
        );
      }
    }

    // -- 3. Conflicting specifiers -----------------------------------------
    for (const [packageName, declarationList] of specifierIndex) {
      if (declarationList.length > 1) {
        p.log.error(pc.red(describeSpecifierConflict(packageName, declarationList)));
        hasError = true;
      }
    }

    // -- 4. Plugins --------------------------------------------------------
    // A specifier carries its own source, so there is nothing to probe for a
    // registry range — but a `file:` specifier names a directory, and a
    // missing one is a definite error rather than a "not installed yet".
    p.log.info(pc.cyan('Verifying plugins...'));
    if (specifierIndex.size === 0) {
      p.log.step('No plugins are declared by this workspace\'s workflows.');
    }

    for (const [packageName, declarationList] of specifierIndex) {
      for (const { specifier } of declarationList) {
        if (!specifier.startsWith(FILE_SPECIFIER_PREFIX)) {
          p.log.step(`Plugin ${pc.green(packageName)} → ${specifier}`);
          continue;
        }

        const target = specifier.slice(FILE_SPECIFIER_PREFIX.length);
        const targetPath = path.resolve(workspaceDirectory, target);
        try {
          const stats = await fs.stat(targetPath);
          if (!stats.isDirectory()) {
            throw new Error('not a directory');
          }
          await fs.stat(path.join(targetPath, 'package.json'));
          p.log.step(`Plugin ${pc.green(packageName)} → ${specifier} (${targetPath})`);
        } catch {
          p.log.error(
            pc.red(
              `Plugin "${packageName}" declares "${specifier}", but ` +
                `"${targetPath}" is not a directory containing a package.json.\n` +
                `A relative \`file:\` specifier resolves against the workspace directory ` +
                `("${workspaceDirectory}").`,
            ),
          );
          hasError = true;
        }
      }
    }

    if (hasError) {
      p.outro(pc.red('❌ Workspace verification failed with errors.'));
      process.exit(1);
      return;
    }

    p.outro(pc.green('✅ Workspace structure is valid and verified!'));
  } catch (error) {
    s.error('Failed.');
    p.log.error(pc.red(`Error verifying workspace: ${getErrorMessage(error)}`));
    process.exit(1);
  }
}
