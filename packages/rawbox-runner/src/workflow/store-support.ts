import { STRATEGY_NAME_LIST, type BoxStrategy } from '@rawbox/store';

import { resolveKeyTable } from './key-table.js';
import { type Workflow } from './workflow-types.js';

// ---------------------------------------------------------------------------
// A strategy this build can express but cannot run
//
// The `BoxStrategy` union is the set of strategies a *document* may declare.
// The set of strategies a *run* can execute is a different set, because a
// strategy needs a store implementation wired into the run, and the two sets
// are allowed to diverge for exactly one release at a time: a strategy's shape,
// its authoring diagnostics and its budget semantics land before the store that
// backs it does. `redis-kv` is the first to sit in that gap
// (FORMAT.md, "Strategies").
//
// A document declaring one is **valid**, and `workflow verify` says so — the
// shape is right, the seeds check out, the budget reports what it can. What
// cannot happen is the *run* reaching a `put` and discovering the gap there. So
// this module states the runner's own composition, and the run refuses up
// front with a sentence naming the strategy and saying what is missing.
//
// ## Why the check lives here and not in `@rawbox/store`
//
// `@rawbox/store` cannot answer this question. It ships `BoxStoreLmdb` and
// would ship a Redis store beside it; which of them a *run* constructs is the
// runner's decision, made in `tool/run-workflow.ts` where `BoxStoreLmdb.create`
// is called and nothing else is. A list in the store package would be a guess
// about its caller.
//
// The store's own backstop stays where it is and is deliberately not removed:
// `BoxStoreLmdb.putSync`/`getSync` answer an unrouted strategy with
// `err("Unsupported strategy: 'redis-kv' — …")` rather than a throw, because
// nothing may throw across that package's API boundary
// (`packages/rawbox-store/README.md`, "API Reference"). That covers a caller
// using `@rawbox/store` directly, with no workflow and no runner. It is a
// backstop, not the diagnostic: it fires per `put`, from inside a seed
// transaction, after the LMDB environment has already been opened.
//
// ## Why bootstrap and not verify
//
// Verification must still pass. The document is correct, and a task that made
// `verify` reject it would be rejecting a document that becomes runnable the
// moment the store ships — with no change to the file. The failure belongs to
// the attempt to execute, so it is raised on the run path only.
//
// ## Why before the store is created and not at the first write
//
// `runWorkflowInstance` opens the LMDB environment and then writes the seeds.
// A run that discovered the gap at the first `put` would already have created
// the environment and, for a mixed document, possibly written some of the seeds
// — leaving a partially seeded store behind for a run that was never going to
// work. This check is a pure function of the authored document, so it runs
// before any of that, in the same preflight sequence as seed validation.
// ---------------------------------------------------------------------------

/**
 * The strategies this build actually wires a store for.
 *
 * **A hand-kept list, and one of the few in this codebase that has to be.**
 * Everywhere else a strategy fact is derived from the schema or the registry
 * (`STRATEGY_SHAPE_LIST` in `workflow/validation.ts`,
 * `STRATEGY_DESCRIPTOR_TABLE` in `@rawbox/store`'s `strategy/descriptor.ts`),
 * because a derived answer cannot drift. This one cannot be derived: the fact
 * it states is *which store objects `runWorkflowInstance` constructs*, and that
 * lives in a call expression, not in a type.
 *
 * The mitigation is {@link UNWIRED_STRATEGY_NAME_LIST} below, which is derived
 * and is what the diagnostics read — so the hand-kept half is the short,
 * additive one, and forgetting to update it fails **closed**: a newly wired
 * store that is missing from this list refuses runs loudly, rather than a
 * missing store passing silently.
 */
export const WIRED_STRATEGY_NAME_LIST: readonly BoxStrategy['name'][] = [
  // `BoxStoreLmdb` — constructed in `tool/run-workflow.ts`, routes both of
  // these itself (`box-store-lmdb.ts`, `putSync`/`getSync`).
  'lmdb-kv',
  'lmdb-fifo',
];

/**
 * Every strategy the union admits that {@link WIRED_STRATEGY_NAME_LIST} does
 * not cover — empty in a release where the two sets agree.
 *
 * Derived from `STRATEGY_NAME_LIST`, which is itself read off the strategy
 * registry's keys, so a strategy added to the union appears here the day it
 * joins and disappears the day a store for it is wired.
 */
export const UNWIRED_STRATEGY_NAME_LIST: readonly BoxStrategy['name'][] =
  STRATEGY_NAME_LIST.filter((name) => !WIRED_STRATEGY_NAME_LIST.includes(name));

/**
 * One declared strategy block, and the document path that declared it.
 *
 * Reported per *declaration* rather than per key: a `defaultStrategy` covers
 * every key that has no override, so listing keys would print the same fix many
 * times, and the fix is always to the one block.
 */
interface StrategyDeclaration {
  readonly path: string;
  readonly name: BoxStrategy['name'];
}

/**
 * Every strategy the document declares, as `(path, name)` pairs — the complete
 * set a run can reach.
 *
 * **Read through {@link resolveKeyTable}, never off the `storage:` block by
 * hand.** A key resolves its strategy from `keys[key].strategy`, then
 * `defaultStrategy` (FORMAT.md, "`storage`"). Sweeping the then-existing
 * `storage.strategies` alone was complete while it was the only per-key source
 * and silently stopped being so when `keys:` landed: a `redis-kv` declared
 * there escaped this check entirely and reached a `put` — which is the one
 * thing this module exists to prevent, and it would have failed *after* the
 * environment was opened and the seeds written rather than before the run
 * started. The table is what keeps that from recurring.
 *
 * `declaredAt.strategy` is what makes this exact rather than merely broader. It
 * names the path the author actually wrote, and it is `storage.defaultStrategy`
 * for a key that declares no strategy of its own — so filtering those out leaves
 * one entry per *declaration site*, and the default is reported once no matter
 * how many keys inherit it. The consumer emits one diagnostic per entry, so a
 * duplicate here is a duplicate sentence in front of the author.
 */
function collectStrategyDeclarationList(
  workflow: Workflow,
): StrategyDeclaration[] {
  const storage = workflow.storage;
  const declarationList: StrategyDeclaration[] = [
    { path: 'storage.defaultStrategy', name: storage.defaultStrategy.name },
  ];

  for (const entry of resolveKeyTable(storage).entryList) {
    if (entry.declaredAt.strategy === 'storage.defaultStrategy') {
      continue;
    }

    declarationList.push({
      path: entry.declaredAt.strategy,
      name: entry.strategy.name,
    });
  }

  return declarationList;
}

/**
 * The sentence a run fails with when the document declares a strategy this
 * build has no store for.
 *
 * The house rules for a diagnostic, on the run path: name the thing (the
 * strategy), name where
 * it was declared (the document path), say what to do. The last part is the
 * awkward one and is said plainly rather than dressed up — there is nothing the
 * author can write to fix it, so the message says the strategy is declared but
 * unimplemented **in this version**, and names the strategies that do run, so a
 * reader can convert the key if they need it working today.
 *
 * It explicitly rules out the reading a terse message would invite: that the
 * name is a typo, or that the run quietly fell back to LMDB. It did not, and it
 * must not — a silent fallback would put a workflow's data in a file when its
 * author asked for a server, and nothing downstream would say so.
 */
function describeUnwiredStrategy(declaration: StrategyDeclaration): string {
  const wired = WIRED_STRATEGY_NAME_LIST.join(', ');

  return (
    `Strategy "${declaration.name}" is declared at ${declaration.path}, but this ` +
    `version of Rawbox has no store implementation wired for it, so the run cannot ` +
    `start.\n` +
    `  This is not a typo and not a schema error: "${declaration.name}" is a valid ` +
    `strategy and the document verifies. The gap is in the runner, which constructs ` +
    `a store for ${wired} and for nothing else.\n` +
    `  Nothing was written and nothing fell back to another strategy. A run that ` +
    `silently stored these keys in LMDB would put a workflow's data somewhere its ` +
    `author did not ask for, so it refuses instead.\n` +
    `  To run this workflow today, declare a strategy this version implements ` +
    `(${wired}); otherwise wait for a release that ships one for ` +
    `"${declaration.name}".`
  );
}

/**
 * Every strategy declaration in `workflow` whose strategy has no store wired in
 * this build, as run-facing diagnostics.
 *
 * Returns `[]` — the whole-run answer for every document that uses only wired
 * strategies, which is every LMDB-only document — so the caller adds no branch
 * beyond an emptiness test.
 *
 * Takes the **authored** `Workflow` rather than the resolved model because the
 * `storage:` block is authored: a resolved workflow carries seeds and steps,
 * and the strategy table it resolves them against is this one. It is a pure
 * function of the document, so it can run before anything is opened.
 *
 * Every offending declaration is reported rather than the first: an
 * author converting a document should get the whole list in one pass.
 *
 * @param workflow - The authored workflow document, already schema-valid.
 * @returns One diagnostic per declaration, in document order.
 */
export function collectUnwiredStrategyProblems(workflow: Workflow): string[] {
  // Cheap and exact: when every strategy the union admits is wired, there is
  // nothing any document can declare that this function could report.
  if (UNWIRED_STRATEGY_NAME_LIST.length === 0) {
    return [];
  }

  return collectStrategyDeclarationList(workflow)
    .filter((declaration) =>
      UNWIRED_STRATEGY_NAME_LIST.includes(declaration.name),
    )
    .map(describeUnwiredStrategy);
}
