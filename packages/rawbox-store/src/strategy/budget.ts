import {
  LMDB_BUDGET_RESIDUAL_FACTOR,
  recommendedVolumeBytesFor,
  type BoxStorage,
  type KeyBudget,
  type KeyBudgetSource,
  type VolumeRecommendationOptions,
} from '../box-size.js';
import { type BoxStrategy } from '../box.js';
import { keyBudgetOf } from './descriptor.js';

// ---------------------------------------------------------------------------
// Choosing a budget, and summing the ones that exist
//
// This module is the *dispatch* half of the budget. The arithmetic is all in
// `box-size.ts` — the LMDB page model and the two concrete functions
// `budgetForKvKey` / `budgetForFifoKey` — and the choice between them, plus the
// sum over a `storage:` block, are here.
//
// ## Why the split is where it is
//
// `budgetForKey` used to make that choice with a ternary in `box-size.ts`:
//
// ```ts
// strategy.name === 'lmdb-fifo' ? budgetForFifoKey(...) : budgetForKvKey(...)
// ```
//
// The `else` was a catch-all. **Every strategy that was not `lmdb-fifo` was
// charged LMDB page arithmetic** — leaf pages, overflow pages, `entryOverhead`
// — whatever its backend. A strategy stored on a server this process does not
// provision would have been handed a confident, entirely invented number, and
// nothing in the shape of the result would have said so.
//
// The honest answer is that some strategies have no budget, which
// `StrategyDescriptor.budget` already says by being optional. Reading it means
// calling `descriptorFor`, and **`box-size.ts` must not import
// `strategy/descriptor.ts`**: the descriptor imports the two budget functions
// *from* `box-size.ts`, so the reverse import closes a cycle (the same one-way
// rule `descriptor -> fifo-ring` follows, with `box-peek` re-exporting). So the
// dispatch moved to this side of the boundary — and `budgetForStorage` had to
// move with it, because it calls the dispatcher once per key and would have
// re-created the cycle on its own.
//
// The direction is worth restating because it is load-bearing:
//
//     descriptor -> box-size          (never box-size -> descriptor)
//     budget     -> descriptor, box-size
//
// which keeps the page model private to `box-size.ts` while letting the
// strategy registry hold LMDB budget behaviour.
//
// ## Why a discriminated union rather than `KeyBudget | undefined`
//
// A key with no budget must stay **nameable**. `KeyBudget | undefined` invites
// `.filter(Boolean)`, after which the surviving keys sum to a number that is
// then printed as a total — a partial total presented as a total, wrong in the
// unsafe direction. It is the same failure that keeps `dataBytesMax` and
// `recommendedVolumeBytes` two distinctly labelled numbers rather than one:
// collapsing them would state "this workflow costs N bytes" when `dataBytesMax`
// bounds *declared data* and not file size, and the gap between them is
// page-packing overhead — real, but a sawtooth rather than a fixed fraction of
// the byte total, so no multiplier can stand in for the page count.
// {@link UnbudgetableKey} carries the key, its source and its strategy so a
// report can say *which* keys are missing from the figure, and
// {@link budgetForStorage} surfaces them as their own list rather than dropping
// them.
//
// It is also deliberately **not** a `neverthrow` `Result`. Nothing failed: the
// document is valid, the strategy is legal, and the answer "this is not
// provisionable from a document" is a fact about the backend. An `Err` would
// invite a caller to treat a correct workflow as a broken one.
// ---------------------------------------------------------------------------

/**
 * A declared or bound storage key whose bytes **cannot be modelled from the
 * document** — the strategy's descriptor carries no `budget`.
 *
 * Not an error and not a zero. `0` bytes would read as "this key costs
 * nothing", which is the one reading that is certainly false; the bytes exist,
 * they are simply bounded somewhere this document cannot see (a server's own
 * configuration, an operator's quota) rather than by a `valueSizeMax` and a
 * `queueSizeMax` written here.
 *
 * It carries exactly the three fields needed to *name* the key in a report and
 * nothing else. There is deliberately no `dataBytesMax: 0`, no
 * `entryCount: 0` and no `estimated` flag: a field that could be summed would
 * eventually be summed.
 */
export interface UnbudgetableKey {
  /** **The discriminant.** See {@link KeyBudget.budgetable} for the pair. */
  readonly budgetable: false;
  /**
   * The key, as written — in the `storage:` block for a `declared` key, in a
   * step's `inputs`/`outputs`/`errors` for a `bound` one.
   */
  readonly key: string;
  /** Whether the key was declared in `storage:` or only bound by a step. */
  readonly source: KeyBudgetSource;
  /**
   * The strategy the key resolved to. Reported because it is the *answer* to
   * why there is no figure — the report says which strategy declined to
   * provide one, rather than leaving a reader to guess that the key was
   * forgotten.
   */
  readonly strategyName: BoxStrategy['name'];
}

/**
 * What {@link budgetForKey} answers: a real {@link KeyBudget}, or an
 * {@link UnbudgetableKey} that still names the key.
 *
 * Narrow it on `.budgetable` — `true` is the budgeted half, `false` the other.
 */
export type KeyBudgetOutcome = KeyBudget | UnbudgetableKey;

/**
 * Upper bound on bytes for one storage key, or an explicit statement that its
 * strategy has none.
 *
 * The choice is `StrategyDescriptor.budget`'s, read through `keyBudgetOf`, and
 * the arithmetic is `budgetForKvKey` / `budgetForFifoKey` in `box-size.ts`.
 * There is no branch on `strategy.name` here and there must not be one: a
 * strategy states its own budget in the registry, and a strategy that states
 * none gets the `budgetable: false` record below rather than another
 * strategy's page model.
 */
export function budgetForKey(
  key: string,
  strategy: BoxStrategy,
  source: KeyBudgetSource = 'declared',
): KeyBudgetOutcome {
  return (
    keyBudgetOf(strategy, key, source) ?? {
      budgetable: false,
      key,
      source,
      strategyName: strategy.name,
    }
  );
}

/**
 * The two halves of a list of {@link KeyBudgetOutcome}s, kept apart so a sum
 * can be taken over one of them without losing the other.
 */
export interface KeyBudgetPartition {
  /** The keys that carry byte figures, in the order they were given. */
  readonly keyBudgetList: readonly KeyBudget[];
  /** The keys that do not, in the order they were given. */
  readonly unbudgetableKeyList: readonly UnbudgetableKey[];
}

/**
 * Split budget outcomes into the ones that can be summed and the ones that
 * must be named.
 *
 * **Why this is exported, and a pure function of a list.** It is the whole
 * safety property of the union in one place — every key that goes in comes out
 * on exactly one side, and neither side can be silently dropped — and both
 * strategies shipping today have budgets, so the `budgetable: false` side is
 * not reachable through {@link budgetForKey} yet. Taking a plain list makes it
 * testable against a hand-built mixture right now, rather than becoming
 * exercised for the first time by whichever backend lands first.
 *
 * Order is preserved within each side, so a report's lines stay in the
 * declaration order `budgetForStorage` establishes.
 */
export function partitionKeyBudgetOutcomeList(
  outcomeList: readonly KeyBudgetOutcome[],
): KeyBudgetPartition {
  const keyBudgetList: KeyBudget[] = [];
  const unbudgetableKeyList: UnbudgetableKey[] = [];

  for (const outcome of outcomeList) {
    if (outcome.budgetable) {
      keyBudgetList.push(outcome);
    } else {
      unbudgetableKeyList.push(outcome);
    }
  }

  return { keyBudgetList, unbudgetableKeyList };
}

/** Upper bound on bytes for a whole `storage:` block and the keys its steps bind. */
export interface StorageBudget {
  /**
   * Per-key detail **for the keys that have a budget**: declared keys first, in
   * declaration order (`strategies` then `seed`-only keys), then keys a step
   * binds and nothing declares, in binding order. `KeyBudget.source` says which
   * is which.
   *
   * Every figure below is a sum over exactly this list. Keys whose strategy has
   * no budget are in {@link unbudgetableKeyList} instead — they are *not*
   * counted here as zero, and a report that prints these lines must print those
   * too or it will read as though the excluded keys did not exist.
   */
  readonly keyBudgetList: readonly KeyBudget[];
  /**
   * The keys this budget could **not** charge, named rather than dropped, in
   * the same declaration-then-binding order.
   *
   * Empty for a document whose strategies all model their own bytes, which is
   * every document the two LMDB strategies can produce. It is non-empty exactly
   * when the totals below cover less than the document declares — which is why
   * it is a list of names and not a count: a reader must be able to *see* what
   * was excluded rather than infer that anything was, and a bare "3 keys
   * excluded" is an inference. "Not applicable — bounded by the backend that
   * holds it, not by this document" is a statement a reader can act on; a
   * missing line, or a zero in a column of byte counts, is not.
   */
  readonly unbudgetableKeyList: readonly UnbudgetableKey[];
  /** Total LMDB entries across every budgeted key. */
  readonly entryCount: number;
  /**
   * Upper bound on **data** bytes. Not a file size: branch pages, the freelist
   * and MVCC copies are excluded, because none of them is a function of the
   * declared strategies.
   *
   * A sum over {@link keyBudgetList} only. When
   * {@link unbudgetableKeyList} is non-empty this is a *partial* figure, and
   * must never be presented as covering the whole document.
   */
  readonly dataBytesMax: number;
  /**
   * Whole LMDB pages this storage block's entries occupy — the total leaf share
   * across every budgeted key, plus every budgeted key's overflow pages,
   * rounded up once.
   *
   * **This is what `recommendedVolumeBytes` is computed from**, and it is a
   * different accounting of the same entries rather than a rescaling of
   * `dataBytesMax`. Exposed so a workspace total can sum pages across workflows
   * and apply the environment terms once — summing per-workflow
   * `recommendedVolumeBytes` would charge the environment overhead once per
   * workflow.
   */
  readonly pageCountMax: number;
  /**
   * **How large a volume or container to provision for this storage block** —
   * see `recommendedVolumeBytesFor` in `box-size.ts`. Deliberately a
   * **different number** from `dataBytesMax`, and never to be presented as the
   * same one.
   *
   * A number to *read*, not a gate. Nothing in this package enforces it: no
   * write is refused for exceeding it and it is not passed to `open()`. It
   * exists so an operator can size the container this tool runs in, and the
   * container runtime is what actually holds the ceiling.
   *
   * It sizes **this** environment. Keys in {@link unbudgetableKeyList} are not
   * missing bytes from this figure — they are bytes that do not land in this
   * volume at all — but they are still storage somebody has to provision
   * somewhere, which is why they are listed rather than dropped.
   */
  readonly recommendedVolumeBytes: number;
  /**
   * How many workflows — and therefore how many dbis — the environment this
   * recommendation sizes was assumed to hold. Always `1` from
   * {@link budgetForStorage}, because a `storage:` block *is* one workflow's;
   * a workspace total passes its own count to `recommendedVolumeBytesFor`.
   */
  readonly workflowCount: number;
  /**
   * The residual factor applied on top of the counted pages
   * (`LMDB_BUDGET_RESIDUAL_FACTOR` unless overridden).
   *
   * It multiplies a page count that already includes page quantisation, and
   * covers only branch pages, the freelist and transaction-granularity
   * overshoot — so a change to it moves the figure by a few percent, not by a
   * factor.
   */
  readonly residualFactor: number;
}

/**
 * Sum over a `storage:` block and the keys its steps bind.
 *
 * Three sources, in this order, deduplicated: every key in `strategies`, then
 * every `seed` key without an override, then every key in `boundKeyList` that
 * neither of those already covers. All three resolve their strategy by this
 * package's `strategies[key] ?? defaultStrategy` — which is the format's own
 * rule, `keys[key].strategy ?? defaultStrategy`, already applied on the caller's
 * side by `boxStorageFor` (`@rawbox/runner`). A key named only by a step binding
 * is legal, resolves to `defaultStrategy`, and is written at run time, so it is
 * charged.
 *
 * What is deliberately *not* counted:
 *
 * - **Cross-workflow reads.** `{ key, workflow }` inputs are the owning
 *   workflow's bytes. The caller filters them out before building
 *   `boundKeyList`; see `BoxStorage.boundKeyList`.
 * - **Keys whose strategy declares no budget.** They are swept and resolved
 *   like every other key, then partitioned into
 *   {@link StorageBudget.unbudgetableKeyList} instead of being charged. They
 *   are *excluded from the totals and named*, never charged zero: a zero would
 *   be summed, and a summed zero says "this key costs nothing" in a figure an
 *   operator sizes a volume with.
 *
 * Those are the only exclusions. Every other key a workflow writes is named in
 * the document and swept here, because the format has no binding form that
 * carries a value and no key is generated during resolution.
 */
export function budgetForStorage(
  storage: BoxStorage,
  options?: Pick<VolumeRecommendationOptions, 'residualFactor'>,
): StorageBudget {
  const defaultStrategy = storage.defaultStrategy;
  const strategies = storage.strategies;
  const seed = storage.seed;

  const declaredKeyList: string[] = [];

  if (strategies) {
    declaredKeyList.push(...Object.keys(strategies));
  }

  if (seed) {
    for (const key of Object.keys(seed)) {
      if (!declaredKeyList.includes(key)) {
        declaredKeyList.push(key);
      }
    }
  }

  const boundKeyList: string[] = [];

  for (const key of storage.boundKeyList ?? []) {
    if (!declaredKeyList.includes(key) && !boundKeyList.includes(key)) {
      boundKeyList.push(key);
    }
  }

  // Every swept key produces an outcome, and the partition is what decides
  // which of them the sums below may see. Nothing is filtered out on the way.
  const { keyBudgetList, unbudgetableKeyList } = partitionKeyBudgetOutcomeList([
    ...declaredKeyList.map((key) =>
      budgetForKey(key, strategies?.[key] ?? defaultStrategy, 'declared'),
    ),
    ...boundKeyList.map((key) =>
      budgetForKey(key, strategies?.[key] ?? defaultStrategy, 'bound'),
    ),
  ]);

  const dataBytesMax = keyBudgetList.reduce(
    (total, keyBudget) => total + keyBudget.dataBytesMax,
    0,
  );
  const entryCount = keyBudgetList.reduce(
    (total, keyBudget) => total + keyBudget.entryCount,
    0,
  );

  // Leaf shares accumulate across keys and round **once**; overflow pages are
  // already whole and are simply added. Rounding per key would charge every
  // small `lmdb-kv` declaration a page of its own — see `KeyBudget.leafPageShare`.
  const pageCountMax = Math.ceil(
    keyBudgetList.reduce(
      (total, keyBudget) =>
        total + keyBudget.leafPageShare + keyBudget.overflowPageCount,
      0,
    ),
  );

  // A `storage:` block is one workflow's, so the environment it sizes holds one
  // dbi. A workspace total is the caller's to assemble, with its own count.
  const workflowCount = 1;
  const residualFactor =
    options?.residualFactor ?? LMDB_BUDGET_RESIDUAL_FACTOR;

  return {
    keyBudgetList,
    unbudgetableKeyList,
    entryCount,
    dataBytesMax,
    pageCountMax,
    recommendedVolumeBytes: recommendedVolumeBytesFor(pageCountMax, {
      workflowCount,
      residualFactor,
    }),
    workflowCount,
    residualFactor,
  };
}
