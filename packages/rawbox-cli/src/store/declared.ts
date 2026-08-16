/**
 * Joining a workspace's declared storage keys against what
 * `BoxObserverLmdb` reports is actually on disk — the "runtime counterpart to
 * `verify`'s static budget report" OBSERVABILITY.md, "CLI surfaces" asks
 * `store list` for.
 *
 * Built to agree exactly with `@rawbox/store`'s own `budgetForStorage` about
 * which keys are "declared" versus "bound" (`strategy/budget.ts`: every key
 * `resolveKeyTable` names — every `storage.keys` entry — is `'declared'`;
 * every remaining key a step binds, resolved through
 * `keys[key].strategy ?? defaultStrategy`, is `'bound'`) — replicated here
 * rather than called through `budgetForStorage`,
 * because that function returns derived byte estimates
 * (`KeyBudget.dataBytesMax`), not the raw `valueSizeMax`/`queueSizeMax` this
 * join needs to print.
 *
 * **Through `resolveKeyTable`, never `workflow.storage` walked by hand.** This
 * index once read the then-existing `workflow.storage.strategies` and
 * `workflow.storage.seed` directly, so a key declared under `keys:` was
 * invisible here — `store list` silently omitted it from the declared side of
 * the join while `BoxObserverLmdb` still reported it as real, on-disk data.
 * Reading `resolveKeyTable(workflow.storage).entryList` is the same
 * normalisation `budgetForStorage`'s caller feeds it (`boxStorageFor`,
 * `key-table.ts`), so the two cannot disagree about which keys this workflow
 * declared.
 *
 * **The agreement is about the key set and its `source`, not about the byte
 * figures.** `budgetForStorage` now splits its keys in two — the ones whose
 * strategy models its own bytes, and the ones it can only name
 * (`StorageBudget.unbudgetableKeyList`) — because a strategy may legitimately
 * have no budget. That split is a property of the *budget*, and this index
 * deliberately does not inherit it: `store list` joins declarations against
 * what is on disk, and a key that cannot be sized is still a key that was
 * declared. Dropping it here would make the observability view disagree with
 * the document, which is the failure this whole module exists to prevent.
 */

import {
  collectBoundStorageKeys,
  loadAndValidateWorkflows,
  resolveKeyTable,
  type Workspace,
} from '@rawbox/runner';
import type { BoxStrategy } from '@rawbox/store';

export type DeclaredSource = 'declared' | 'bound';

export interface DeclaredKeyInfo {
  readonly key: string;
  readonly strategy: BoxStrategy;
  readonly source: DeclaredSource;
}

/** `workflow.name` (the LMDB dbi identifier — `run-workflow.ts` writes under it, not the file path) -> key -> declared info. */
export type DeclaredIndex = ReadonlyMap<string, ReadonlyMap<string, DeclaredKeyInfo>>;

/**
 * Builds the declared-key index for every workflow a workspace document
 * lists.
 *
 * Best-effort, matching `workspace verify`'s own posture: a workflow that
 * fails to load or validate contributes nothing to the index rather than
 * failing the whole command — `store list` still has real, actual data to
 * show even when one workflow's document has since rotted.
 */
export async function buildDeclaredIndex(
  workspaceDocPath: string,
  workspaceDoc: Workspace,
): Promise<DeclaredIndex> {
  const index = new Map<string, Map<string, DeclaredKeyInfo>>();

  const loaded = await loadAndValidateWorkflows(workspaceDocPath, workspaceDoc);
  if (loaded.isErr()) {
    return index;
  }

  for (const { workflow } of loaded.value) {
    const perKey = new Map<string, DeclaredKeyInfo>();
    const defaultStrategy = workflow.storage.defaultStrategy;

    // `resolveKeyTable` is the one place `keys:` is read — see `key-table.ts`
    // — so every declared key is a `'declared'` key here, rather than falling
    // through to the `'bound'` branch below (wrong, for a key no step binds)
    // or being omitted from the index altogether (wrong, and the failure this
    // had: `store list` would show real on-disk data next to no declaration at
    // all).
    const { entryList } = resolveKeyTable(workflow.storage);

    for (const entry of entryList) {
      // A key declaring `storage.keys.<key>.workflow` names a box in *another*
      // workflow's dbi. This index is keyed by `workflow.name`, which is the
      // dbi `BoxObserverLmdb` reports under, so listing a foreign key here
      // would assert a declaration against a dbi that does not hold it — and
      // would then show as "declared but absent" for as long as this workflow
      // merely reads it. The owning workflow contributes it to the index from
      // its own entry, which is where it actually lives.
      if (entry.workflow !== undefined) continue;

      perKey.set(entry.key, {
        key: entry.key,
        strategy: entry.strategy,
        source: 'declared',
      });
    }

    for (const key of collectBoundStorageKeys(workflow)) {
      if (perKey.has(key)) {
        continue;
      }
      perKey.set(key, { key, strategy: defaultStrategy, source: 'bound' });
    }

    index.set(workflow.name, perKey);
  }

  return index;
}
