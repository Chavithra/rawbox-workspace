import pc from 'picocolors';
import { LMDB_INPAGE_KEY_PLUS_VALUE_MAX } from '@rawbox/store';
import type { KeyBudget, StorageBudget, UnbudgetableKey } from '@rawbox/store';
import { collectStorageBindingList } from '@rawbox/runner';
import type { Workflow } from '@rawbox/runner';

// ---------------------------------------------------------------------------
// `verify` budget reporting
//
// Because every key's strategy is declared up front, the maximum bytes a
// workflow's `storage:` block can consume is computable *before* it runs, from
// the document alone — for every strategy that models its bytes at all.
//
// Shared between `workflow verify` and `workspace verify` so the two commands
// render one key's budget, or a whole storage block's, in exactly the same
// words. A single figure presented as an exact file size would be wrong, and
// wrong in the unsafe direction. `dataBytesMax` (an upper bound on *data*) and
// `recommendedVolumeBytes` (the pages those entries occupy plus LMDB's
// structural cost, the figure to size a volume or container with) are two
// separate computations over the same entries, not one figure multiplied by
// the other, so conflating them is not merely misleading but arithmetically
// wrong. They must always appear as two distinctly labelled numbers.
//
// Both are reported, neither is enforced. Nothing in the store refuses a write
// for exceeding them; the ceiling belongs to whatever runs the container.
// ---------------------------------------------------------------------------

/**
 * One line for a single storage key. Crossing
 * `LMDB_INPAGE_KEY_PLUS_VALUE_MAX` is a real performance cliff, not just a
 * bigger number (rawbox-store/README.md, "Key and Value Sizes"),
 * so the line also reports whether the key's values have been pushed onto
 * dedicated overflow pages.
 *
 * **The source is printed because the budget covers more keys than the document
 * declares.** A key named only in a step binding resolves through
 * `keys[key].strategy ?? defaultStrategy` and is written at run time, so it is
 * counted; `example.workflow.yaml` declares five keys and budgets ten. A reader
 * shown ten lines against five declarations, with nothing saying why, will
 * reasonably conclude the figure is wrong.
 *
 * The overflow note names the *sum* of key and value bytes, because that is the
 * test LMDB applies and because naming `valueSizeMax` alone sent readers looking
 * for a value-only ceiling that does not exist. `keySizeMax` is the widest key
 * the declaration produces, so for `lmdb-fifo` it is the derived
 * `fifo:<key>:data:<n>`, not the key as written — which is exactly why a queue
 * can overflow at a `valueSizeMax` a plain `lmdb-kv` key would keep in-page.
 */
export function formatKeyBudgetLine(keyBudget: KeyBudget): string {
  const entryWord = keyBudget.entryCount === 1 ? 'entry' : 'entries';
  const sourceLabel =
    keyBudget.source === 'bound' ? 'bound by a step' : 'declared';
  const overflowNote = keyBudget.usesOverflowPages
    ? pc.yellow(
        ` [uses overflow pages: keySizeMax ${keyBudget.keySizeMax} + valueSizeMax > ` +
          `${LMDB_INPAGE_KEY_PLUS_VALUE_MAX} — rawbox-store/README.md, ` +
          `"Key and Value Sizes"]`,
      )
    : '';

  return (
    `Key "${pc.cyan(keyBudget.key)}" (${keyBudget.strategyName}, ${sourceLabel}): ` +
    `${keyBudget.entryCount} ${entryWord}, ` +
    `dataBytesMax ≤ ${pc.bold(String(keyBudget.dataBytesMax))} bytes` +
    overflowNote
  );
}

// ---------------------------------------------------------------------------
// Keys with no budget
//
// `StrategyDescriptor.budget` is optional (`@rawbox/store`,
// `strategy/descriptor.ts`): a strategy whose storage this document does not
// size — somebody else's server, an operator's quota — declares none, and
// `budgetForStorage` puts its keys in `unbudgetableKeyList` instead of charging
// them. This section is how they reach a reader.
//
// **The one rendering that is forbidden here is `0`.** A zero would sit in a
// column of byte counts and read as "this key costs nothing", which is the only
// statement about it that is certainly false — the bytes exist, they are just
// bounded somewhere this document cannot see. So the line says *not applicable*
// and says why, and the totals below it say plainly that they cover fewer keys
// than the document declares. That is the same posture the budget already takes
// for cross-workflow reads: a reader must be able to SEE what was excluded
// rather than infer that anything was.
// ---------------------------------------------------------------------------

/**
 * One line for a storage key whose strategy has no byte budget.
 *
 * Names the key and the strategy, then states the exclusion as a deliberate
 * answer rather than a missing number. The strategy name carries the *reason*:
 * `@rawbox/store` deliberately has no backend taxonomy to consult (see the
 * "capability fields rather than a kind × backend taxonomy" note in
 * `strategy/descriptor.ts`), so this says what is true of every such strategy —
 * its bytes are bounded by the backend, not by this document — and lets the
 * name identify which backend that is.
 */
export function formatUnbudgetableKeyLine(
  unbudgetableKey: UnbudgetableKey,
): string {
  const sourceLabel =
    unbudgetableKey.source === 'bound' ? 'bound by a step' : 'declared';

  return (
    `Key "${pc.cyan(unbudgetableKey.key)}" (${unbudgetableKey.strategyName}, ${sourceLabel}): ` +
    `${pc.bold('not applicable')} — this strategy declares no byte budget, so its ` +
    `storage is bounded by the backend that holds it, not by this document. ` +
    `NOT zero bytes: the key is excluded from the totals below rather than ` +
    `counted as free, and whoever provisions that backend sizes it there.`
  );
}

/**
 * One line saying that the figures below exclude the unbudgetable keys, naming
 * every one of them, or `undefined` when there are none.
 *
 * Separate from the per-key lines because the risk this closes is not "the key
 * was not shown" but "the total was read as covering it". A reader who saw
 * three key lines and one total will assume the total covers three keys unless
 * told otherwise, so it is told here, next to the total.
 */
export function formatUnbudgetableKeyNoteLine(
  budget: Pick<StorageBudget, 'keyBudgetList' | 'unbudgetableKeyList'>,
): string | undefined {
  const unbudgetableKeyList = budget.unbudgetableKeyList;

  if (unbudgetableKeyList.length === 0) {
    return undefined;
  }

  const budgetedCount = budget.keyBudgetList.length;

  return (
    `${unbudgetableKeyList.length} ` +
    `${unbudgetableKeyList.length === 1 ? 'key is' : 'keys are'} NOT included in ` +
    `the figures below (${unbudgetableKeyList
      .map((unbudgetableKey) => `"${unbudgetableKey.key}" (${unbudgetableKey.strategyName})`)
      .join(', ')}): ${unbudgetableKeyList.length === 1 ? 'its' : 'their'} ` +
    `strategy declares no byte budget, so there is no honest figure to derive ` +
    `from this document. The totals below therefore cover ${budgetedCount} of ` +
    `${budgetedCount + unbudgetableKeyList.length} keys — they size THIS ` +
    `store's volume, not the other backend's.`
  );
}

/**
 * One line explaining the keys the budget covers that the `storage:` block does
 * not declare, or `undefined` when there are none.
 *
 * Separate from {@link formatStorageBudgetSummaryLines} because that function is
 * also called on a *workspace* total, which is assembled from summed figures
 * and has no `keyBudgetList` to explain.
 *
 * **Counts both lists.** "Bound by a step" and "has a budget" are independent
 * questions, and this line answers only the first — a bound key with no budget
 * is still a key the document never declared, and leaving it out of these
 * counts would make the sentence disagree with the lines printed above it.
 */
export function formatBoundKeyNoteLine(
  budget: Pick<StorageBudget, 'keyBudgetList' | 'unbudgetableKeyList'>,
): string | undefined {
  const keyList = [...budget.keyBudgetList, ...budget.unbudgetableKeyList];
  const boundKeyList = keyList.filter(
    (keyBudget) => keyBudget.source === 'bound',
  );

  if (boundKeyList.length === 0) {
    return undefined;
  }

  const declaredCount = keyList.length - boundKeyList.length;

  return (
    `${boundKeyList.length} of these ${keyList.length} keys ` +
    `${boundKeyList.length === 1 ? 'is' : 'are'} bound by a step and declared ` +
    `nowhere in storage: (${boundKeyList
      .map((keyBudget) => `"${keyBudget.key}"`)
      .join(', ')}). That is legal — an undeclared key resolves to ` +
    `storage.defaultStrategy — and the bytes are real, so they are counted ` +
    `here alongside the ${declaredCount} declared ` +
    `${declaredCount === 1 ? 'key' : 'keys'}. Cross-workflow reads ` +
    `({ key, workflow }) are NOT counted: those bytes belong to the workflow ` +
    `that declares them.`
  );
}

/**
 * Two lines summarising a budget over a whole `storage:` block, or several of
 * them combined: `dataBytesMax` and `recommendedVolumeBytes`, each with its own
 * label and its own caveat.
 *
 * Deliberately two lines, not one — collapsing them loses the distinction the
 * whole budget is built around.
 */
export function formatStorageBudgetSummaryLines(
  budget: Pick<
    StorageBudget,
    | 'dataBytesMax'
    | 'entryCount'
    | 'pageCountMax'
    | 'recommendedVolumeBytes'
    | 'residualFactor'
    | 'workflowCount'
  >,
  scopeLabel: string,
): string[] {
  const dbiWord = budget.workflowCount === 1 ? 'workflow' : 'workflows';

  return [
    `${scopeLabel}: ${pc.bold('dataBytesMax')} ≤ ${budget.dataBytesMax} bytes ` +
      `across ${budget.entryCount} entries — an upper bound on ` +
      `DATA only. It excludes B+tree branch pages, the freelist, and MVCC's ` +
      `live copies of touched pages, none of which are a function of the ` +
      `declared strategies.`,
    `${scopeLabel}: ${pc.bold('recommendedVolumeBytes')} = ${budget.recommendedVolumeBytes} bytes ` +
      `(${budget.pageCountMax} LMDB pages for those entries, plus the ` +
      `environment and ${budget.workflowCount} ${dbiWord}' dbis, ` +
      `× ${budget.residualFactor} residual, page-rounded) — this is a DIFFERENT ` +
      `number from dataBytesMax, and a different computation, not that one ` +
      `scaled; size the VOLUME or CONTAINER this workspace runs on with THIS ` +
      `one. Nothing in the store enforces either figure: the ceiling is the ` +
      `container's to apply.`,
  ];
}

/** One unbudgetable key, tagged with the workflow that declared or bound it. */
export interface WorkspaceUnbudgetableKey {
  /** `workflow.name` — the identifier a reader can go and look up. */
  readonly workflowName: string;
  readonly unbudgetableKey: UnbudgetableKey;
}

/**
 * The workspace total's exclusion note: one line per key no workflow's budget
 * could charge, each naming the workflow it belongs to.
 *
 * **The decision this encodes.** A workspace whose workflows sit on different
 * backends has no single true total, and there are three ways to report one:
 * omit the unbudgetable keys silently, invent a figure for them, or report the
 * modelled total and *list* what it leaves out. This takes the third. The
 * figure stays the one it has always been — the volume to provision for the
 * store this tool actually sizes — and every key outside it is named, with its
 * workflow, so a reader can see where the excluded storage lives rather than
 * having to infer that anything was excluded at all. That is the posture the
 * budget already fixed for cross-workflow reads, and there is no reason for a
 * second, quieter rule here.
 *
 * Returns `[]` when nothing was excluded, so a caller that loops adds no
 * section at all rather than an empty one.
 */
export function formatWorkspaceUnbudgetableKeyLines(
  unbudgetableKeyList: readonly WorkspaceUnbudgetableKey[],
): string[] {
  if (unbudgetableKeyList.length === 0) {
    return [];
  }

  // Agreement matters here because this line is one sentence about a count the
  // reader can see: "1 key … their strategy … size them" reads as a bug in the
  // report, which is the last thing a figure an operator provisions from should
  // do. The list was empty for every document the previous release could
  // express, so the mismatch was unreachable until a strategy with no byte
  // model shipped.
  const isSingular = unbudgetableKeyList.length === 1;

  return [
    `${unbudgetableKeyList.length} ` +
      `${isSingular ? 'key is' : 'keys are'} NOT part of the ` +
      `workspace total above: ${isSingular ? 'its' : 'their'} strategy declares no ` +
      `byte budget, so this document cannot size ${isSingular ? 'it' : 'them'}. The ` +
      `total is the figure to provision THIS store's volume with; the ` +
      `${isSingular ? 'key' : 'keys'} below ${isSingular ? 'is' : 'are'} storage ` +
      `somebody provisions elsewhere, listed here so ${isSingular ? 'its' : 'their'} ` +
      `absence from the total is visible rather than inferred.`,
    ...unbudgetableKeyList.map(
      ({ workflowName, unbudgetableKey }) =>
        `  Workflow "${pc.cyan(workflowName)}", key "${pc.cyan(unbudgetableKey.key)}" ` +
        `(${unbudgetableKey.strategyName}, ` +
        `${unbudgetableKey.source === 'bound' ? 'bound by a step' : 'declared'}): ` +
        `not applicable — bounded by the backend that holds it, not by this workspace.`,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Cross-workflow reads
//
// An input reads another workflow's box when the binding says so
// (`{ key, workflow }`) or when the key table does
// (`storage.keys.<key>.workflow`). Those bytes are
// correctly excluded from THIS workflow's budget — a workspace total is a
// plain sum over workflows, and counting them here too
// would double-count them. But excluding them from the figure leaves the
// reader with no sign they exist at all: a budget that silently omits a
// cross-workflow read reads as though the workflow had no external
// dependency, when in fact it will fail at run time unless some *other*
// workflow populates the key. This section closes that gap by naming, for
// every such read, the key and the workflow that owns it — an absence in
// THIS budget is explained, not implied to be a missing number.
// ---------------------------------------------------------------------------

/** One cross-workflow input, resolved to the key and its declared owner. */
export interface CrossWorkflowRead {
  readonly key: string;
  readonly owningWorkflow: string;
  /** The step's `label:`, when it has one — mirrors `StorageBinding.stepLabel`. */
  readonly stepLabel: string | undefined;
  /** Document path of the binding, e.g. `steps[0].inputs.prev`. */
  readonly path: string;
}

/**
 * Every cross-workflow read in a schema-valid workflow document, in binding
 * order.
 *
 * Built entirely on top of `collectStorageBindingList` (`@rawbox/runner`) —
 * the same traversal `collectBoundStorageKeys` feeds the budget with — so
 * this can never disagree with the budget about which keys are excluded and
 * why. Nothing here is deduplicated by key: two bindings reading the same key
 * from two different declared owners is a document a reader should see in
 * full, however unlikely.
 *
 * `binding.owningWorkflow` is a **field read**. This used to be a targeted
 * re-lookup into `workflow.steps[n].inputs` for the `workflow:` value, because
 * a `StorageBinding` carried only the fact *that* a binding was
 * cross-workflow. Now that ownership can be declared on the key table the
 * traversal knows the owner either way — from the binding's own `workflow:`,
 * or from `storage.keys.<key>.workflow` — so the re-lookup is gone along with
 * the index-parsing it needed, and a shorthand `inputs: { ms: shared_state }`
 * on a foreign key is reported here as well, which the old lookup could not
 * have seen at all.
 *
 * Restricted to `inputs`, which is what "read" means and what the removed
 * lookup enforced by only ever searching that record. A *write* to a foreign
 * key is not a cross-workflow anything — it is rejected outright by
 * `validateStorageOwnership` (`@rawbox/runner`), long before a budget is
 * printed.
 */
export function collectCrossWorkflowReads(
  workflow: Workflow,
): CrossWorkflowRead[] {
  const readList: CrossWorkflowRead[] = [];

  for (const binding of collectStorageBindingList(workflow)) {
    if (binding.role !== 'inputs') continue;

    const owningWorkflow = binding.owningWorkflow;
    if (owningWorkflow === undefined) continue;

    readList.push({
      key: binding.key,
      owningWorkflow,
      stepLabel: binding.stepLabel,
      path: binding.path,
    });
  }

  return readList;
}

/**
 * One line per cross-workflow read: names the key and the workflow that owns
 * it, and says plainly that the bytes are counted in that workflow's budget
 * rather than here.
 *
 * `isKnownInWorkspace`, supplied by `workspace verify` only, tells a reader
 * whether the owner is one they can go check in the same run — the case
 * where a reader can actually go look at the other figure. `workflow verify`
 * has no such context: the budget prints before workspace discovery, on
 * purpose, so a single workflow's report cannot know what else is in its
 * workspace and omits the distinction rather than guessing.
 *
 * Returns `[]` for a workflow with no cross-workflow reads — deliberately,
 * so a caller that loops over the result adds no output at all rather than
 * an empty section.
 */
export function formatCrossWorkflowReadLines(
  crossWorkflowReadList: readonly CrossWorkflowRead[],
  isKnownInWorkspace?: (owningWorkflow: string) => boolean,
): string[] {
  return crossWorkflowReadList.map((read) => {
    const where = read.stepLabel ? `step "${read.stepLabel}"` : read.path;
    const membershipNote =
      isKnownInWorkspace === undefined
        ? ''
        : isKnownInWorkspace(read.owningWorkflow)
          ? ' — that workflow is verified in this run; see its budget above'
          : ' — that workflow is NOT part of this workspace, so its budget was not verified here';

    return (
      `Cross-workflow read (${where}): key "${pc.cyan(read.key)}" is read from ` +
      `workflow "${pc.cyan(read.owningWorkflow)}"${membershipNote}. Its bytes ` +
      `are counted in that workflow's budget, not this one.`
    );
  });
}
