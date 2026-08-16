import type { BoxStorage, BoxStrategy } from '@rawbox/store';

import type { Storage } from './workflow-types.js';

// ---------------------------------------------------------------------------
// The key table — one canonical view of what `storage:` says about a key
//
// A `storage:` block states three kinds of fact about a key: which box it is
// (`strategy`), what is in the box to begin with (`seed`), and whose box it is
// (`workflow`). All three are written in one place, one entry per key:
//
//     storage:
//       keys:
//         queue_items:
//           strategy: { name: lmdb-fifo, queueSizeMax: 8, valueSizeMax: 1900 }
//           seed: [a, b, c]
//         sleep_ms:
//           seed: 500
//         shared_state:
//           workflow: other-flow      # this box belongs to another workflow
//
// Two earlier top-level maps, `storage.strategies` and `storage.seed`, stated
// the first two facts one map per fact; they were removed, and this module used
// to exist largely to merge them. What remains is still worth having as one
// module: every per-key rule — the size checks, the resolver's `strategyFor`,
// the budget, the CLI's key report — is expressed against `ResolvedStorageKey`
// and against nothing else, so that `storage.defaultStrategy`'s fallback, the
// `hasSeed`-versus-`seed` distinction and the `declaredAt` paths are each
// decided once rather than in each of them.
//
// Two things this table deliberately does **not** contain:
//
//   - **Keys named only by a step binding.** They are real keys and they are
//     swept — `collectBoundStorageKeyList` in `validation.ts` does it, because
//     that is the package layer that owns the step schema — but they are not
//     facts a `storage:` block states, and `resolveKeyTable` is handed a
//     `storage:` block. A key absent from the table resolves to
//     `storage.defaultStrategy` by the format's one rule.
//   - **Any judgement about whether the document is acceptable.** With one
//     block there is nothing for a key to conflict with, but a `keys:` entry
//     can still contradict itself (`workflow:` beside `seed:`, or a `workflow:`
//     naming the document's own workflow). Those rules, their diagnostics and
//     their verify-time refusal live with the other diagnostics in
//     `validation.ts` (`validateStorageKeyTable`).
// ---------------------------------------------------------------------------

/** A storage key that needs no quoting to appear in a dotted document path. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * A document path down to one storage key — `storage.keys.queue_items`, or
 * `storage.keys["odd key"]` when the key would not survive dot notation. The
 * point is that the author can copy the path straight out of the diagnostic
 * and find the field.
 *
 * It lives here rather than beside the diagnostics that print it because every
 * path this module builds for {@link StorageKeyDeclaration} goes through it, and
 * the two must quote a key identically: a diagnostic naming
 * `storage.keys["odd key"]` and a `declaredAt` naming `storage.keys.odd key`
 * would be two spellings of one field. `validation.ts` re-exports it, so the
 * name every other module and `@rawbox/runner`'s public surface already import
 * is unchanged.
 */
export function keyPath(prefix: string, key: string): string {
  return PLAIN_KEY.test(key)
    ? `${prefix}.${key}`
    : `${prefix}[${JSON.stringify(key)}]`;
}

/**
 * Where each of a key's facts was declared, as document paths.
 *
 * This is the field that makes the whole table usable by a diagnostic, and it is
 * why the table is not simply `{ strategy, seed }`: every storage diagnostic in
 * this codebase ends on a field the author can go and edit — "raise
 * `storage.keys.queue_items.strategy.valueSizeMax`", "set
 * `storage.keys.queue_items.seed`" — and a message naming a path the document
 * does not contain is worse than one naming no path at all, because it sends the
 * author looking for a block they never wrote.
 *
 * With one declaration block there is one path per fact rather than one per
 * idiom, so these are computed rather than chosen. They are still built here
 * rather than interpolated at each diagnostic, because `storage.defaultStrategy`
 * is a genuine alternative for `strategy` (below) and because `keyPath`'s
 * quoting must be identical everywhere.
 *
 * All four fields are always present, `seed` and `workflow` carrying `undefined`
 * when the key states neither, so that a reader reaches the paths uniformly and
 * the "is there a seed" question has exactly one answer
 * ({@link ResolvedStorageKey.hasSeed}).
 */
export interface StorageKeyDeclaration {
  /** Where the key itself is named — `storage.keys.x`. */
  readonly key: string;
  /**
   * Where the strategy that this key resolves to comes from —
   * `storage.keys.x.strategy`, or `storage.defaultStrategy` for a key that
   * declares none.
   *
   * The second case is the one to keep in mind when interpolating: the path
   * names a block shared by every key without an override, so a remedy that says
   * "raise it" is telling the author to change a default.
   */
  readonly strategy: string;
  /**
   * Where the seed value is written — `storage.keys.x.seed` — and `undefined`
   * exactly when the key has no seed.
   */
  readonly seed: string | undefined;
  /**
   * Where the key's owning workflow is declared — `storage.keys.x.workflow`,
   * and `undefined` exactly when the key declares none (i.e. it belongs to the
   * workflow that declares it).
   *
   * Reached often, because the write boundary (`validateStorageOwnership`,
   * `validation.ts`) has to name the site an author must edit to make a rejected
   * write legal.
   */
  readonly workflow: string | undefined;
}

/**
 * Everything a `storage:` block says about one key, with
 * `keys[key].strategy ?? defaultStrategy` already applied.
 *
 * ## `hasSeed` is not `seed !== undefined`
 *
 * A seed is **arbitrary data** — that is the whole reason `seed` has no long
 * form, since no wrapper could be distinguished from an intended literal
 * object — so "the author seeded this
 * key with a value that happens to read as absent" and "the author seeded
 * nothing" are two different documents, and only one of them supplies the key.
 * `exactOptionalPropertyTypes` is on, so `seed` is present on this object
 * exactly when `hasSeed` is `true` and the two cannot drift; a reader that
 * branches on `entry.seed !== undefined` instead of on `hasSeed` is asking the
 * wrong question and will read an explicit seed as no seed.
 *
 * The case is not hypothetical in either direction: `sleep_ms:` written bare in
 * YAML parses as `null`, which is a *seeded* key holding `null` — a value the
 * store will write and a step will read — and it must not be confused with a key
 * the document merely declares.
 */
export interface ResolvedStorageKey {
  readonly key: string;
  /** `keys[key].strategy ?? defaultStrategy`. */
  readonly strategy: BoxStrategy;
  /** Whether the document supplies an initial value for this key at all. */
  readonly hasSeed: boolean;
  /** The initial value. Present exactly when {@link hasSeed}; see above. */
  readonly seed?: unknown;
  /**
   * The workflow whose store holds this key's box, when `keys.<key>.workflow`
   * names one — i.e. **present exactly when the box is another workflow's**.
   *
   * There is no `hasWorkflow` companion, and the asymmetry with `seed` above is
   * deliberate rather than an oversight: a seed is arbitrary data, so `undefined`
   * is a value an author can mean, whereas a workflow name is a non-empty string
   * (`StorageKeyEntry`, `workflow-types.ts`) and absence has exactly one reading.
   * `entry.workflow !== undefined` is therefore the whole of "is this key
   * foreign", and every rule that used to walk step bindings looking for
   * `{ key, workflow }` asks it as a field read instead.
   *
   * A key naming *this* workflow never reaches here: `validateStorageKeyTable`
   * rejects it, so that "declares `workflow:`" and "is foreign" stay the same
   * question and no reader has to compare the name against the running
   * workflow's. That is also why this module needs no `Workflow` — it is handed
   * a `storage:` block and nothing else.
   */
  readonly workflow?: string;
  readonly declaredAt: StorageKeyDeclaration;
}

/**
 * The canonical per-key view of a `storage:` block.
 *
 * `entryList` and `byKey` hold the same objects: the list is for the sweeps that
 * report every key in a stable order, the map is for the per-binding lookups
 * (`strategyFor`) that would otherwise scan.
 *
 * There is no conflict list. One key is one `keys:` entry, so a key cannot be
 * declared twice — a duplicate mapping key is a parse-level matter for YAML and
 * JSON, not something a reader of this table can see or has to arbitrate.
 */
export interface StorageKeyTable {
  /**
   * Every key the block declares, in document order — which is a diagnostic's
   * determinism: the same document must produce the same problems in the same
   * sequence.
   */
  readonly entryList: readonly ResolvedStorageKey[];
  readonly byKey: ReadonlyMap<string, ResolvedStorageKey>;
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Who owns a key's box, and where the document says so. */
export interface StorageKeyOwner {
  /** The owning workflow's `name:`. */
  readonly workflow: string;
  /** `storage.keys.<key>.workflow`, the site an author edits. */
  readonly declaredAt: string;
}

/**
 * Which keys a `storage:` block declares to belong to **another** workflow.
 *
 * ## Why ownership is a key-table fact and not a per-binding one
 *
 * A box belongs to whoever owns it, not to whichever read happened to name it.
 * Written per binding — `inputs: { ms: { key: shared, workflow: other } }`,
 * which is still the format (`ReadStorageRef`, `step-types.ts`) — two steps of
 * one document can disagree about who owns `shared`, and every rule that cares
 * has to walk the step list to find out. Declared on the key table the
 * disagreement is structurally impossible and the question is this map.
 *
 * ## Why it takes `unknown` rather than `Storage`
 *
 * Unlike {@link resolveKeyTable}, this runs **ahead of the schema**. Its
 * callers are the step-binding sweeps in `validation.ts`, which are exported,
 * documented to tolerate a document that never reached the schema, and used by
 * the CLI on a document it is still deciding about. So a malformed `keys:`
 * block, a non-object entry and a `workflow:` that is not a non-empty string
 * are all simply *not ownership declarations* here; the schema reports each of
 * them by path, and nothing in this function has to guess.
 *
 * ## Why this cannot drift from `resolveKeyTable`
 *
 * Because it does not read the fact twice: {@link resolveKeyTable} calls this
 * function rather than repeating the property access, which is what makes the
 * two answers the same answer. The two exist separately only because of the
 * paragraph above — this one runs pre-schema on `unknown`, the table does not.
 */
export function resolveKeyOwnerMap(
  storage: unknown,
): ReadonlyMap<string, StorageKeyOwner> {
  const ownerMap = new Map<string, StorageKeyOwner>();

  const keyEntryRecord =
    isPlainObject(storage) && isPlainObject(storage.keys) ? storage.keys : {};

  for (const [key, entry] of Object.entries(keyEntryRecord)) {
    if (!isPlainObject(entry)) continue;

    const workflow = entry.workflow;
    if (typeof workflow !== 'string' || workflow.length === 0) continue;

    ownerMap.set(key, {
      workflow,
      declaredAt: `${keyPath('storage.keys', key)}.workflow`,
    });
  }

  return ownerMap;
}

/**
 * Normalise a `storage:` block into one entry per declared key.
 *
 * **This is the only place `keys:` is read.** Everything downstream is meant to
 * consume {@link StorageKeyTable}, so the fallback to `storage.defaultStrategy`,
 * the `hasSeed`-versus-`seed` distinction and the `declaredAt` paths are decided
 * once, here, and answered for good.
 *
 * @param storage - a **schema-valid** `storage:` block. This reads
 *   `defaultStrategy` and each `strategy:` as the `BoxStrategy` the schema
 *   guarantees, exactly as `validateCoTransactionalStore` does and for the same
 *   reason: a strategy whose shape the schema has not accepted has no meaning to
 *   resolve. Every production caller reaches it after
 *   `validateWorkflowType` (`validation.ts`).
 */
export function resolveKeyTable(storage: Storage): StorageKeyTable {
  const keyEntryRecord = storage.keys ?? {};

  // The ownership fact, read through the one function that reads it — see
  // `resolveKeyOwnerMap` for why it is a separate, schema-independent pass
  // rather than an inline `entry.workflow` here.
  const ownerMap = resolveKeyOwnerMap(storage);

  const entryList: ResolvedStorageKey[] = [];
  const byKey = new Map<string, ResolvedStorageKey>();

  for (const [key, entry] of Object.entries(keyEntryRecord)) {
    const entryPath = keyPath('storage.keys', key);

    // `strategy:` cannot be written as an absent-but-present field — the schema
    // rejects `strategy: null` against the `BoxStrategy` union, and neither YAML
    // nor JSON can produce `undefined` — so a presence test buys nothing here.
    // `seed:` is the opposite case, and is tested with `hasOwnProperty`.
    const entryStrategy = entry.strategy;

    const hasSeed = hasOwn(entry, 'seed');
    const owner = ownerMap.get(key);

    const declaredAt: StorageKeyDeclaration = {
      key: entryPath,
      strategy:
        entryStrategy === undefined
          ? 'storage.defaultStrategy'
          : `${entryPath}.strategy`,
      seed: hasSeed ? `${entryPath}.seed` : undefined,
      workflow: owner?.declaredAt,
    };

    const resolved: ResolvedStorageKey = {
      key,
      strategy: entryStrategy ?? storage.defaultStrategy,
      hasSeed,
      // Spread rather than assigned, because `exactOptionalPropertyTypes` makes
      // "no `seed` property" and "`seed` property holding undefined" two
      // different objects — and that difference is the whole of `hasSeed`.
      ...(hasSeed ? { seed: entry.seed } : {}),
      // Spread for the `exactOptionalPropertyTypes` reason above, though here it
      // is presence alone that carries the meaning: a key with this property is
      // another workflow's, and one without it is this workflow's.
      ...(owner === undefined ? {} : { workflow: owner.workflow }),
      declaredAt,
    };

    entryList.push(resolved);
    byKey.set(key, resolved);
  }

  return { entryList, byKey };
}

// ---------------------------------------------------------------------------
// Feeding the budget across the runner -> store boundary
//
// `@rawbox/store`'s `budgetForStorage` (`strategy/budget.ts`) sums a
// `storage:` block, and it takes `BoxStorage` **structurally** —
// `defaultStrategy`, `strategies?`, `seed?`, `boundKeyList?`. That is
// `@rawbox/store`'s own input type and not the authoring schema, so removing
// `storage.strategies` and `storage.seed` from the *format* does not touch it:
// `box-size.ts`'s header explains that the authoring schema (`Storage`, this
// package) cannot be imported into `@rawbox/store`, because the dependency runs
// `@rawbox/runner` -> `@rawbox/store` and never the other way, so a `Storage`
// parameter there would close an import cycle. `resolveKeyTable` needs that
// authoring schema — `keys:` is its field — so it cannot move into
// `@rawbox/store` either. Neither package can hold both halves of "what did
// `keys:` declare, summed the way the budget already sums keys", so this
// function holds the seam on the side that is allowed to import both.
//
// ## Why the flattener is MORE necessary now, not less
//
// It is tempting to read `boxStorageFor` as scaffolding that existed to
// flatten two idioms into one and can go with them. The opposite is true. When
// `storage.strategies`/`storage.seed` were the format, an authoring block
// *happened* to be structurally assignable to `BoxStorage`, so a caller that
// spread `workflow.storage` straight into `budgetForStorage` got a correct
// answer by accident. It cannot any more: a `Storage` is `{ defaultStrategy,
// keys }`, `BoxStorage` reads neither `keys` nor anything derived from it, and
// the spread now type-checks (every field of `BoxStorage` past
// `defaultStrategy` is optional) while charging **zero** declared keys. This
// function is the only thing standing between the two shapes, so every budget
// call site must route through it — `workflow verify` and `workspace verify`
// both do, and each says so where it calls.
//
// The alternative was to widen `BoxStorage` — give it a pre-resolved per-key
// list of its own, so `budgetForStorage` could sum it directly. Rejected: it
// would add a second key-collection code path to a package whose one rule about
// this boundary is that it must never import the schema such a path would exist
// to read, for no gain. Fewer packages have to know about `keys:` this way.
// ---------------------------------------------------------------------------

/**
 * A `storage:` block's declared keys, in the shape `@rawbox/store`'s
 * `budgetForStorage` already sums — see the module note above for why this
 * exists and lives here rather than in `@rawbox/store`.
 *
 * Every key {@link resolveKeyTable} names comes back in `strategies`, keyed to
 * its **already-resolved** strategy (`entry.strategy`, which is
 * `keys[key].strategy ?? defaultStrategy`) — so `budgetForStorage`'s own
 * `strategies[key] ?? defaultStrategy` fallback, still applied on the far side
 * of this call, is a no-op for every key named here and reaches only a
 * `boundKeyList` key that `keys:` did not declare. `seed` carries exactly the
 * keys with `hasSeed: true`, each holding `entry.seed`, in `entryList`'s order —
 * which is `keys:`'s document order, so the budget's per-key report comes back
 * in the order the author wrote.
 *
 * `defaultStrategy` is passed straight through: it is not a keyed fact
 * `resolveKeyTable` normalises, so there is nothing for this function to do to
 * it.
 *
 * **Keys owned by another workflow are dropped.** A budget answers "how large
 * must this workflow's store be", and a foreign key's bytes are charged to the
 * workflow that owns and writes it — so a workspace total is a plain sum over
 * workflows, and counting a shared box in every reader would inflate that total
 * by one copy per reader. This is the same exclusion
 * `collectBoundStorageKeyList` has always applied to a `{ key, workflow }`
 * binding (`validation.ts`, the budget sweep); the only thing that changed is that the fact
 * is now read off the key table instead of found by walking step bindings, so
 * a foreign key *no step binds at all* — declared for its strategy, read
 * nowhere yet — is excluded too, where before it could not even be written down.
 *
 * **Deliberately omits `boundKeyList`.** The caller already has
 * `collectBoundStorageKeys(workflow)` for that (`validation.ts`), and which
 * keys a step binds is orthogonal to what `storage:` declares — mixing the two
 * concerns into one function would make this one need a `Workflow` rather than
 * a `storage:` block, for no reason.
 *
 * @param storage - a schema-valid `storage:` block, the same precondition
 *   {@link resolveKeyTable} carries.
 */
export function boxStorageFor(
  storage: Storage,
): Pick<BoxStorage, 'defaultStrategy' | 'strategies' | 'seed'> {
  const { entryList } = resolveKeyTable(storage);

  const strategies: Record<string, BoxStrategy> = {};
  const seed: Record<string, unknown> = {};

  for (const entry of entryList) {
    // Another workflow's box: its bytes are that workflow's budget, not this
    // one's. See the note above.
    if (entry.workflow !== undefined) continue;

    strategies[entry.key] = entry.strategy;
    if (entry.hasSeed) {
      seed[entry.key] = entry.seed;
    }
  }

  return { defaultStrategy: storage.defaultStrategy, strategies, seed };
}
