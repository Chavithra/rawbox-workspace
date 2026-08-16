import { type TObject } from 'typebox';

import {
  budgetForFifoKey,
  budgetForKvKey,
  measureKeySize,
  type KeyBudget,
  type KeyBudgetSource,
} from '../box-size.js';
// From `fifo-ring.js`, not `box-peek.js` where these used to live: `box-peek`
// reads this module for `emptyReadMessage`/`hasDepth`, so importing it back
// here would close a cycle. `fifo-ring.js` imports neither side.
import { fifoDataKey, ringCapacity } from '../box-store/fifo-ring.js';
import {
  LmdbFIFO,
  LmdbKV,
  RedisFIFO,
  RedisKV,
  type BoxStrategy,
} from '../box.js';

// ---------------------------------------------------------------------------
// The strategy registry — one record per member of the `BoxStrategy` union
//
// A storage key's *strategy* decides more than how bytes are laid out. It
// decides whether a seed is one write or N, how many entries a seed may carry,
// which sentence a read of an empty box fails with, whether "depth" means
// anything, and how many bytes a declaration can occupy. Today each of those
// questions is answered by its own `strategy.name === 'lmdb-fifo'` branch,
// scattered across three packages, and each branch is free to disagree with the
// others about what a strategy *is*. This module is where a strategy states all
// of it once.
//
// It is deliberately the **pure** half. Nothing here opens, reads or writes a
// database, and nothing here imports `lmdb` for a value — the modules it does
// import take it type-only, which is erased (`box-size.ts:1`,
// `box-store/box-peek.ts:1`). That is a requirement, not a coincidence: this
// module lives in the package's main entry, and that entry must stay importable
// for its types without dragging in an environment opener — see the comment
// above the observation-surface exports in `src/index.ts`. Store
// factories, `peekStatic`, `depthStatic` and everything else needing a live
// `Database` therefore stay where they are; `BoxStoreLmdb` keeps routing its own
// two strategies. What lives here is schema, authoring semantics, diagnostics
// and budget.
//
// ## Why capability fields rather than a kind × backend taxonomy
//
// The obvious factorisation of `lmdb-kv` / `lmdb-fifo` is a `kind` ('kv' |
// 'fifo') crossed with a `backend` ('lmdb' | 'redis'), and it was considered and
// **rejected**. Two reasons, in order of weight:
//
//   - **The 2×2 is a coincidence of today's set, not a structure.** It survives
//     `redis-kv` and `redis-fifo` and breaks on the fifth strategy: a
//     `redis-stream` is not a FIFO with a different backend, a `sqlite-kv`'s
//     budget has no page model to share with `lmdb-kv`, and a sorted set is
//     neither cell nor queue. A taxonomy that has to be re-cut on the next
//     addition is a worse hand-kept list than no taxonomy at all.
//   - **No branch site actually asks the taxonomy's question.** Re-reading the
//     real call sites, none of them asks "is this a queue": `resolver.ts` asks
//     *does a seed expand into one write per element*; `validation.ts` asks
//     *how many entries may a seed carry* and *which sentence does an empty read
//     fail with*; `box-peek.ts` asks *does this box have a depth*;
//     `box-store-lmdb.ts` asks *how wide is the widest key this declaration
//     derives*. Those are the fields below. A strategy that answers them
//     differently from every existing one still fits, and the answer is written
//     next to the strategy rather than inferred from a category it was sorted
//     into.
//
// So there is no `BoxStrategyKind` and no `BoxBackend` type in this codebase,
// and adding one would re-open both problems.
//
// ## Derived, never hand-kept
//
// The same principle as `STRATEGY_SHAPE_LIST` in
// `@rawbox/runner`'s `workflow/validation.ts` (see its comment: the strategy
// *field* tables are read off `BoxStrategy.anyOf` rather than written out, so a
// third strategy is described the day it joins the union). That derives
// diagnostics from the schema; this extends the same rule to semantics, as far
// as a type system can: {@link StrategyDescriptorTable} is keyed by
// `BoxStrategy['name']`, so a new union member is a *compile error* here until
// it says what it does about seeds, empty reads, depth and bytes. It cannot be
// silently omitted, and it cannot be answered by a default that happens to
// describe some other strategy.
// ---------------------------------------------------------------------------

/**
 * **Which store** a strategy's boxes live in — the quantity two keys must agree
 * on before one step's write and the next step's read can share a transaction.
 *
 * `id` is an **opaque identity**, compared only for equality and never parsed,
 * split or matched on a prefix. That is the whole discipline of this type:
 * "same store" is a fact about the concrete store a strategy names, not about
 * the *kind* of storage it uses. A `backend: 'redis'` category would report two
 * `redis-kv` keys pointed at two different servers as compatible, and they are
 * not co-transactional — nothing spans two Redis servers. See the "no kind ×
 * backend taxonomy" section above; this field is that decision applied to the
 * one question a category could have plausibly answered.
 *
 * `description` is what a diagnostic prints. It has to be actionable prose
 * rather than the id, because an author told that `lmdb:workspace` and
 * `redis:cache` differ has learnt nothing they can act on, whereas "the
 * workspace's LMDB environment" and `the Redis server named by backend:
 * "cache"` name the two things and point at the field that chose each.
 */
export interface StoreIdentity {
  /**
   * Equality here means **co-transactional**. Two strategies with the same id
   * address one store; two with different ids address two, whatever their
   * names or backends look like.
   */
  readonly id: string;
  /** The store as a diagnostic names it, e.g. `the workspace's LMDB environment`. */
  readonly description: string;
}

/**
 * The single LMDB environment a workspace opens, shared by **both** LMDB
 * strategies.
 *
 * One identity rather than one per strategy, because `lmdb-kv` and `lmdb-fifo`
 * are two key layouts inside one environment: `BoxStoreLmdb.transaction` runs a
 * callback that touches both over one `transactionSync`, so a cell and a queue
 * in the same workspace genuinely are co-transactional
 * (`box-store/box-store-lmdb.ts`).
 *
 * A module-level constant so the two rows below cannot drift into two ids that
 * would report a `lmdb-kv` key and a `lmdb-fifo` key as different stores — the
 * exact false positive this whole capability exists to avoid on the other side.
 */
const LMDB_WORKSPACE_STORE: StoreIdentity = {
  id: 'lmdb:workspace',
  description: "the workspace's LMDB environment",
};

/**
 * The Redis server one `backend:` id names, shared by **every** Redis strategy
 * pointed at that id.
 *
 * The Redis counterpart of {@link LMDB_WORKSPACE_STORE}, and a function rather
 * than a constant for the reason stated on
 * {@link StrategyDescriptor.storeIdentity}: which store a Redis strategy
 * addresses is chosen by its own `backend:` field, so two blocks with the same
 * `name` are two stores whenever those ids differ.
 *
 * **Why the two Redis rows call this instead of each building the object.**
 * `redis-kv` on backend `X` and `redis-fifo` on backend `X` are the SAME store —
 * one server, one `MULTI`, one Lua scope — exactly as `lmdb-kv` and `lmdb-fifo`
 * are one environment. A document holding a Redis cell beside a Redis queue on
 * one server is legal and co-transactional, and the check in `@rawbox/runner`'s
 * `workflow/validation.ts` compares ids for equality and nothing else. Two rows
 * writing the id out separately could drift into `redis:X` and
 * `redis-fifo:X` — spellings that look deliberate, compare unequal, and would
 * reject that legal document at verify time with a message insisting two keys on
 * one server are two stores. One function is what makes that unrepresentable,
 * the same discipline and the same failure mode as the LMDB constant above.
 *
 * The id remains derived from the *id*, never from a resolved connection string:
 * see the `redis-kv` row for why two ids that happen to point at one server are
 * still reported as two stores.
 */
function redisBackendStore(backend: string): StoreIdentity {
  return {
    id: `redis:${backend}`,
    description: `the Redis server named by backend: ${JSON.stringify(backend)}`,
  };
}

/**
 * Everything a storage strategy decides that does not need an open database.
 *
 * Generic in the union member so each field can speak about *its own* strategy's
 * fields — {@link seedCapacity} reads `queueSizeMax`, which only `lmdb-fifo`
 * has, and no cast or re-narrowing is needed to reach it.
 *
 * **Optional fields mean "this strategy has no such thing", never "unknown".**
 * `exactOptionalPropertyTypes` is on, so an absent {@link seedCapacity} is a
 * genuinely unbounded seed and an absent {@link budget} is a strategy whose
 * bytes cannot be modelled, both distinguishable from a present-but-`undefined`
 * field that nothing here writes.
 */
export interface StrategyDescriptor<S extends BoxStrategy> {
  /** The `name:` an author writes, and the key of this record in the table. */
  readonly name: S['name'];
  /**
   * This strategy's member of the `BoxStrategy` union, as declared in
   * `box.ts` — the same object the union is built from, not a copy. Held here
   * so a consumer wanting the field list of one strategy (rather than of all of
   * them) reaches the schema through the descriptor instead of re-deriving it
   * from `anyOf`.
   */
  readonly schema: TObject;
  /**
   * Whether one key's `seed:` is **N writes rather than one**.
   *
   * `true` for a strategy whose seed MUST be a list, each element becoming one
   * stored entry — the expansion `resolveWorkflow` performs so that a `Seed`
   * means exactly one write under every strategy, and so that each element is
   * checked against the consuming step's `inputSchema` (`resolver.ts:511-556`).
   * `false` for a cell, where the authored value is the value.
   */
  readonly seedExpandsList: boolean;
  /**
   * How many entries a seed may carry, or **absent when nothing bounds it**.
   *
   * Only meaningful with {@link seedExpandsList}: a cell's seed is one value,
   * so there is no count to bound.
   *
   * **A function per strategy, not `queueSizeMax - 1` written into the
   * verifier**, and the two queue strategies are why. For `lmdb-fifo` this is
   * the ring's usable capacity, `queueSizeMax - 1`: one slot is permanently
   * reserved so `head === tail` can mean *empty* rather than *full*. For
   * `redis-fifo` it is `queueSizeMax` exactly, because a native list has no
   * cursors to disambiguate and so reserves nothing. A subtraction hardcoded at
   * the one call site would have been right for the first queue strategy and
   * silently wrong for the second — it would refuse a legal full-capacity seed
   * and tell the author to raise a ceiling that was already high enough.
   *
   * Absent means unbounded, not unknown. A queue with no declared ceiling would
   * omit this rather than return `Infinity`, and the diagnostic that consumes it
   * simply has nothing to report.
   */
  readonly seedCapacity?: (strategy: S) => number;
  /**
   * Why this strategy's {@link seedCapacity} is **below** the ceiling the author
   * declared — one clause, mid-sentence, no leading conjunction and no trailing
   * stop. **Absent when capacity IS the ceiling**, which is the whole point of
   * the field.
   *
   * `checkFifoSeedLength` in `@rawbox/runner`'s `workflow/validation.ts` builds
   * the seed-length diagnostic from three quantities: the capacity, the declared
   * `queueSizeMax`, and the gap between them. The first two are numbers and the
   * third is arithmetic — but *why* there is a gap is not derivable from any of
   * them, and that sentence is what makes the message actionable rather than
   * baffling ("holds 3 entries — its queueSizeMax is 4" reads like a bug unless
   * the reader is told a slot is spoken for).
   *
   * Before `redis-fifo` existed the explanation was a literal in that function,
   * reached through a parameter narrowed to `lmdb-fifo`. That was true then and
   * became **false** the moment a second queue strategy joined: a Redis list
   * reserves nothing, and printing "one slot is permanently reserved to
   * distinguish a full queue from an empty one" over a `redis-fifo` seed would
   * be the verifier stating, in the author's own diagnostic, a fact about their
   * queue that is not true — and sending them to raise `queueSizeMax` by one
   * more than they need. So the explanation moved next to the strategy it
   * explains, and a strategy with nothing to explain declares nothing.
   *
   * The gap and the note must agree: a strategy whose capacity equals its
   * ceiling and yet declares a note would print a reason for a shortfall that
   * does not exist. That pairing is asserted per row in
   * `tests/strategy-descriptor.test.ts` rather than assumed, because it is an
   * invariant between a number and a sentence and no type can hold it.
   */
  readonly seedCapacityNote?: string;
  /**
   * The **exact** sentence a read of an empty box fails with, verbatim.
   *
   * Load-bearing as a string, not as a label: `describeEmptyRead` in
   * `@rawbox/runner`'s `workflow/validation.ts` quotes it back to the author at
   * verify time — "the read fails with \"Queue empty\"" — and
   * the rule that a key read by a binding must be written by something prints
   * the same two words. That rule is only
   * worth having if the quoted sentence is the one the store really produces
   * (`box-peek.ts:359, 372` and `box-store-lmdb.ts:326, 439`), so this field
   * exists to make that a single definition rather than four agreeing copies.
   */
  readonly emptyReadMessage: string;
  /**
   * Whether `{used, capacity}` means anything for a box of this strategy.
   *
   * `false` is not "depth is zero": `depthStatic` returns an `Err` for a cell on
   * purpose, because answering `{used: 1}` invites a caller to treat the two
   * strategies as one (`box-peek.ts:450-468`).
   */
  readonly hasDepth: boolean;
  /**
   * Upper bound on the bytes one declared key can occupy, or **absent for a
   * strategy whose footprint this package cannot model**.
   *
   * Present for both LMDB strategies, where the bound is the page model in
   * `box-size.ts`. A future backend that does not expose a page model — or
   * whose storage is somebody else's server to provision — omits this rather
   * than inventing a figure, and a budget report then says the key is not
   * provisionable instead of printing a number nobody measured. Budgets are
   * informational throughout: nothing in this package refuses a write for
   * exceeding one (`box-size.ts:74-79`).
   */
  readonly budget?: (
    key: string,
    strategy: S,
    source?: KeyBudgetSource,
  ) => KeyBudget;
  /**
   * Which concrete store this strategy's boxes live in — see
   * {@link StoreIdentity}.
   *
   * **Required, not optional.** Every strategy stores its boxes *somewhere*, so
   * unlike {@link budget} there is no honest "this strategy has no such thing"
   * answer, and an absent identity would have to be read as "assume it shares
   * with everything" or "assume it shares with nothing" — the first silently
   * admits a document that cannot run, the second rejects one that can. The
   * table is keyed by `BoxStrategy['name']`, so a strategy joining the union is
   * a compile error here until it says which store it addresses.
   *
   * A function of the strategy rather than a constant field, because the store
   * is frequently *chosen by the strategy's own fields*: `redis-kv`'s store is
   * whichever server its `backend:` id names, so two blocks with the same
   * `name` are two stores whenever those ids differ.
   *
   * Consumed by the co-transactional check in `@rawbox/runner`'s
   * `workflow/validation.ts`: one step's outputs are written and the next
   * step's inputs are read inside a single transaction (`syncData`,
   * `machine/actors/sync-db-actor.ts`), and a transaction cannot span two
   * stores, so a document whose keys resolve to more than one store is rejected
   * at verify time (`@rawbox/runner`'s FORMAT.md, "Strategies").
   */
  readonly storeIdentity: (strategy: S) => StoreIdentity;
  /**
   * The **widest** backend key this declaration derives from the author's key —
   * the quantity the store's write-time guard compares against what LMDB
   * reports (`box-store-lmdb.ts:158`).
   *
   * Not the quantity `RAWBOX_KEY_SIZE_MAX` bounds. That limit is on the author's
   * key and is fixed; this one moves with the strategy and, for `lmdb-fifo`,
   * with `queueSizeMax`. Absent for a strategy that derives no keys at all and
   * so has nothing wider than the author's.
   */
  readonly keySizeMax?: (key: string, strategy: S) => number;
}

/**
 * One descriptor per union member, keyed by `name`.
 *
 * The mapped key is `BoxStrategy['name']` rather than a hand-written list of
 * two, which is the whole enforcement mechanism of this module: adding a third
 * variant to the union in `box.ts` makes the literal below fail to typecheck
 * until the variant has a descriptor.
 */
type StrategyDescriptorTable = {
  readonly [Name in BoxStrategy['name']]: StrategyDescriptor<
    Extract<BoxStrategy, { name: Name }>
  >;
};

const STRATEGY_DESCRIPTOR_TABLE: StrategyDescriptorTable = {
  'lmdb-kv': {
    name: 'lmdb-kv',
    schema: LmdbKV,
    // A cell's seed is the value, stored as written. One authored entry, one
    // write.
    seedExpandsList: false,
    // No `seedCapacity`: one value has no count to bound.
    emptyReadMessage: 'Value not found',
    hasDepth: false,
    budget: budgetForKvKey,
    // The workspace's one LMDB environment, and the *same* identity
    // `lmdb-fifo` returns: a cell and a queue in one workspace share a
    // transaction, so the check built on this must not separate them.
    storeIdentity: () => LMDB_WORKSPACE_STORE,
    // `lmdb-kv` stores the author's key verbatim and derives nothing, so the
    // widest key it produces is the key itself — the 0 of
    // `RAWBOX_KEY_DERIVATION_OVERHEAD_MAX`.
    keySizeMax: (key) => measureKeySize(key),
  },
  'lmdb-fifo': {
    name: 'lmdb-fifo',
    schema: LmdbFIFO,
    // A FIFO seed MUST be a list and each element becomes one queue entry.
    // Two arguments carried that. **A seed is a write, and a write to a queue
    // enqueues**: under the lenient reading, seeding was the single operation
    // where `lmdb-kv` and `lmdb-fifo` behaved identically, so a key's declared
    // strategy changed the meaning of every write in the workflow except the
    // first one. **And the mandatory list is checkable where accepting either
    // shape is not**: if any value were valid, an author who believed they were
    // seeding three entries would get one, silently, with no diagnostic at any
    // point. `queue_items: 5` is instead a loud error naming the key and the
    // strategy that makes it wrong, at the cost of one pair of brackets in the
    // single-entry case.
    seedExpandsList: true,
    // `ringCapacity`, not a second `- 1` written out here: the reserved slot is
    // one rule, and `box-peek.ts` is where it is stated.
    seedCapacity: (strategy) => ringCapacity(strategy.queueSizeMax),
    // The sentence that explains the `- 1` above, in the author's diagnostic.
    // It lives here rather than in the verifier because it is true of THIS
    // ring and of no other queue strategy — `redis-fifo` declares no note at
    // all. Byte-identical to the clause `checkFifoSeedLength` used to hold as a
    // literal, because `@rawbox/runner`'s `validation.test.ts` asserts this
    // wording and moving the string must not reword it.
    seedCapacityNote:
      'one slot is permanently reserved to distinguish a full queue from an empty one',
    emptyReadMessage: 'Queue empty',
    hasDepth: true,
    budget: budgetForFifoKey,
    // The same environment `lmdb-kv` names, deliberately by the same constant:
    // the ring's three derived keys are written by the same `transactionSync`
    // that writes a cell, so the two strategies are one store.
    storeIdentity: () => LMDB_WORKSPACE_STORE,
    // Of the three derived forms — `fifo:<key>:data:<n>`, `:head`, `:tail` —
    // the data key is always the widest, and it is widest at the highest ring
    // index. Indices run `0 … queueSizeMax - 1`, so the widest index is
    // `queueSizeMax - 1`; that it equals the ring's capacity is a coincidence
    // of the same reserved slot, which is why it is spelled out rather than
    // reusing `ringCapacity` above. Built through `fifoDataKey` so this cannot
    // drift from what the writer actually stores.
    keySizeMax: (key, strategy) =>
      measureKeySize(fifoDataKey(key, strategy.queueSizeMax - 1)),
  },
  'redis-kv': {
    name: 'redis-kv',
    schema: RedisKV,
    // A cell's seed is the value, stored as written — the same answer
    // `lmdb-kv` gives, and for the same reason: writes overwrite rather than
    // append, so one authored entry is one write
    // (`@rawbox/runner`'s FORMAT.md, "`seed`", which states the rule over the
    // *behaviour* — "for a strategy whose writes append" — rather than over the
    // name, so a strategy added later is bound by whichever half of that
    // sentence describes it).
    seedExpandsList: false,
    // No `seedCapacity`: one value has no count to bound.
    //
    // **Verbatim the same sentence as `lmdb-kv`, and deliberately so.**
    // Every strategy must declare the exact sentence its empty read fails with,
    // and the verifier quotes it back to the author. A cell that was never
    // written is a cell that is missing, whatever holds it — the author's
    // mistake and the author's fix are identical on both backends, so giving
    // the two cells different wording would be inventing a distinction the
    // reader has no use for. A strategy may reuse another's sentence, and doing
    // so binds it to producing that string exactly: the
    // Redis store, when it lands, MUST fail an unset key with this text and not
    // with whatever its client library says.
    emptyReadMessage: 'Value not found',
    hasDepth: false,
    // **No `budget`, and that absence is the declaration.** A Redis key's bytes
    // are bounded by the server's `maxmemory`, its eviction policy and whoever
    // operates it — none of which is written in, or derivable from, a
    // `storage:` block. There is no page model here to reuse and no honest
    // figure to invent, so this strategy states that it has none — a strategy
    // need not be provisionable from the document, and saying so is the honest
    // answer. `budgetForKey` turns the absence into an
    // `UnbudgetableKey` that still names the key, so a report says "not
    // applicable" and says the totals cover fewer keys than the document
    // declares — never `0`, which would be summed and would read as "this key
    // costs nothing".
    //
    // This is the first strategy to exercise that path through a real document.
    // The path is not new; the reachability is.
    //
    // **The store is the server, so the identity is the `backend:` id.** Two
    // `redis-kv` blocks are one store only when they name the same entry of the
    // workspace's `backends:` map; naming two entries is two servers, and
    // nothing spans two servers — no `MULTI`, no Lua script, no transaction.
    // This is exactly where a `backend: 'redis'` *category* would have given the
    // wrong answer, calling two servers one store, and it is why the
    // discriminator is identity rather than kind (see the header above). A
    // `kind` × `backend` taxonomy was rejected for the same reason: the 2×2 is
    // a coincidence of today's strategy set rather than a structure, and it
    // breaks on the fifth member — a `redis-stream` is not a FIFO with a
    // different backend, a sorted set is neither cell nor queue, and a
    // `sqlite-kv` budget shares no page model with `lmdb-kv`.
    //
    // The id is *not* the connection string: a `backends:` entry is resolved
    // against the workspace document, which a workflow can be shape-verified
    // without (`box.ts`, `RedisKV`). Two ids that happen to point at one server
    // are therefore reported as two stores. That is the conservative direction —
    // it asks the author to say which one they meant, rather than accepting a
    // document whose transactions depend on two `backends:` entries staying in
    // agreement forever.
    //
    // Built through {@link redisBackendStore} rather than inline, so this row
    // and `redis-fifo`'s cannot drift into two ids for one server — see that
    // function for why a Redis cell beside a Redis queue on one backend MUST
    // compare equal.
    storeIdentity: (strategy) => redisBackendStore(strategy.backend),
    //
    // `valueSizeMax` is still declared and still enforced per write: it bounds
    // ONE value, measured as the msgpack encoding, which is the format's
    // measurement rather than a backend's — the packed length of the value,
    // computable with no database open at all, so any strategy on any backend
    // can state and enforce exactly this bound. Bounding one value and
    // bounding the store are separate questions, and this strategy answers the
    // first and declines the second.
    //
    // Redis stores the author's key with no derivation at all — no `fifo:` shape,
    // no index suffix — so the widest key this declaration produces is the key
    // itself, exactly as for `lmdb-kv`. Declared rather than omitted because
    // omission means "there is no such quantity", and here there is one and it is
    // known; the unknown quantity is the byte footprint, and that is what the
    // absent `budget` above says. Keeping the two answers distinct is what stops
    // `budget: absent` from degrading into "this strategy is a stranger, assume
    // nothing".
    keySizeMax: (key) => measureKeySize(key),
  },
  'redis-fifo': {
    name: 'redis-fifo',
    schema: RedisFIFO,
    // A queue's seed is its initial contents, one entry per element — the same
    // answer `lmdb-fifo` gives, and again for the *behaviour* rather than the
    // name: a write to this key appends (`RPUSH`) rather than overwrites, and
    // the seed rule is written over exactly that (`@rawbox/runner`'s FORMAT.md,
    // "`seed`").
    seedExpandsList: true,
    // **The identity, not `ringCapacity`** — this is the one row that exists to
    // say so. A Redis list has no head/tail cursors to disambiguate: `LLEN`
    // reports the depth outright and an empty list is a key that does not
    // exist, so nothing has to be kept free to tell a full queue from an empty
    // one. `queueSizeMax: 8` therefore holds 8, where `lmdb-fifo`'s holds 7
    // (`box-store/fifo-ring.ts`, `ringCapacity`).
    //
    // Routing this through `ringCapacity` would have cost the author a usable
    // entry per queue and, worse, produced a diagnostic telling them to raise a
    // ceiling that already fit. This divergence is why `seedCapacity` is a
    // function on the descriptor at all.
    seedCapacity: (strategy) => strategy.queueSizeMax,
    // **No `seedCapacityNote`, and the absence is the declaration.** Capacity
    // IS the declared ceiling here, so there is no shortfall to explain, and
    // the seed-length diagnostic prints "its queueSizeMax is 8." with no
    // reserved-slot clause — see that field's doc comment for why the
    // explanation had to move out of the verifier when this row landed.
    //
    // **Verbatim the sentence `lmdb-fifo` declares, deliberately.** Every
    // strategy must declare the exact sentence its empty read fails with, and
    // declaring it binds the store to producing that string; a queue with
    // nothing in it is a queue with nothing in it, whichever server holds it,
    // and the author's mistake and fix are identical on both. The same
    // reasoning that gives the two *cells* one sentence, applied to the two
    // queues. The Redis store, when it lands (task #15), MUST fail an
    // `LPOP` that returns nil with this text and not with a client-library
    // message.
    emptyReadMessage: 'Queue empty',
    // A queue has a depth, and here it is `LLEN` — one command, no cursor
    // arithmetic. `{used, capacity}` means exactly what it means for
    // `lmdb-fifo`, except that `capacity` is `queueSizeMax` unreduced.
    hasDepth: true,
    // **No `budget`, the same absence and the same reason as `redis-kv`.** A
    // Redis list's bytes are bounded by the server's `maxmemory`, its eviction
    // policy and whoever operates it — none of it written in, or derivable
    // from, a `storage:` block. `queueSizeMax ×
    // valueSizeMax` would look like an honest figure and is not one: it models
    // no encoding overhead this package can see, no per-element list overhead,
    // and no server-side allocator, and once summed into a total it would read
    // as a provisioning number somebody measured. `budgetForKey` turns the
    // absence into an `UnbudgetableKey` that still NAMES the key, so a report
    // says the totals cover fewer keys than the document declares.
    //
    // The same server `redis-kv` addresses when the `backend:` ids match, and
    // built through the same function so it cannot be otherwise. This is the
    // pairing most likely to be got wrong: a Redis cell and a Redis queue on
    // one server are ONE store — one connection, one `MULTI`, one Lua scope —
    // exactly as `lmdb-kv` and `lmdb-fifo` are one environment, and a document
    // mixing them is legal. An id spelled per strategy would reject it at
    // verify time (`redisBackendStore`, and `tests/strategy-descriptor.test.ts`
    // which asserts the pairing directly).
    storeIdentity: (strategy) => redisBackendStore(strategy.backend),
    // **The author's key, unwidened — a native list derives nothing.**
    //
    // The contrast with `lmdb-fifo` is the whole answer. That strategy's ring
    // needs `fifo:<key>:data:<n>`, `:head` and `:tail` because LMDB gives it
    // one flat, *untyped* keyspace per workflow: several physical entries per
    // logical queue, and a naming convention is the only thing that can tell a
    // queue's bytes from a cell's. Redis needs neither half. One list is one
    // key, and a Redis key carries its type intrinsically — `TYPE` distinguishes
    // a list from a string with no help from the name — so the two reasons the
    // `fifo:` prefix exists both vanish here.
    //
    // The consequence for task #15, stated so it is inherited rather than
    // rediscovered: a `redis-fifo` box occupies the SAME physical key a
    // `redis-kv` box of that name would, `rawbox:<workspace>:<workflow>:<key>`
    // (`box-store/box-store-redis.ts`, `redisKeyFor`). Within one workflow that
    // cannot collide — a key resolves to exactly one strategy — but a key whose
    // strategy is *changed* from `redis-kv` to `redis-fifo` between runs will
    // meet a string where it expects a list, and Redis will answer `WRONGTYPE`.
    // That is the wanted behaviour and must be translated into a named
    // diagnostic, not designed away: a `fifo:` marker would instead start a
    // silent empty queue beside the author's abandoned data, which is the
    // failure mode this codebase refuses everywhere else.
    //
    // Declared rather than omitted for the same reason as `redis-kv`: omission
    // means "there is no such quantity", and here it is known and equals the
    // author's key. The unknown quantity is the byte footprint, and that is
    // what the absent `budget` above says.
    keySizeMax: (key) => measureKeySize(key),
  },
};

/**
 * The descriptor for a strategy, by value.
 *
 * Total and infallible — `BoxStrategy` is a closed union and every member has a
 * row — so it returns the descriptor directly rather than a `Result`. Callers
 * holding an unvalidated `name: string` from a document have not got a
 * `BoxStrategy` yet; the schema is what turns one into the other, and it reports
 * an unknown name with the field diagnostics in `@rawbox/runner`'s
 * `workflow/validation.ts`.
 *
 * Generic so a caller that has already narrowed keeps its narrowing: passing an
 * `lmdb-fifo` strategy yields `StrategyDescriptor<lmdb-fifo>`, whose
 * `seedCapacity` takes exactly that strategy. A caller holding the bare union
 * gets the union of descriptors and must narrow before invoking a field that
 * takes a strategy, which is the correct amount of friction — those fields read
 * per-strategy declarations.
 */
export function descriptorFor<S extends BoxStrategy>(
  strategy: S,
): StrategyDescriptorTable[S['name']] {
  // The cast is the one place this module is not checked, and it is narrow:
  // TypeScript resolves `TABLE[strategy.name]` to the *union* of both rows
  // rather than to the indexed access `StrategyDescriptorTable[S['name']]`,
  // then refuses the assignment because the two rows' `name` fields conflict.
  // The lookup is nonetheless exact — `strategy.name` is `S['name']` and the
  // table is keyed by name — and the table literal above is fully checked, so
  // nothing here can return a row for the wrong strategy.
  return STRATEGY_DESCRIPTOR_TABLE[
    strategy.name
  ] as StrategyDescriptorTable[S['name']];
}

/**
 * Every strategy name, in union order.
 *
 * Read off the table's keys rather than written out, so it cannot list a
 * strategy that has no descriptor or omit one that has. Intended for
 * diagnostics that enumerate what an author may write — "expected one of …" —
 * and for tests sweeping every strategy.
 */
export const STRATEGY_NAME_LIST: readonly BoxStrategy['name'][] = Object.keys(
  STRATEGY_DESCRIPTOR_TABLE,
) as readonly BoxStrategy['name'][];

/**
 * How many entries a seed may enqueue for `strategy`, or `undefined` when the
 * strategy bounds no count.
 *
 * **Why this exists as a function rather than a field read.** {@link
 * descriptorFor} is generic so a narrowed caller keeps its narrowing, which
 * means a caller holding the bare `BoxStrategy` union gets the union of rows
 * and cannot invoke {@link StrategyDescriptor.seedCapacity} without narrowing
 * first. That is the right default for fields that read per-strategy
 * declarations — but it collides with the one thing this refactor is for.
 * `validateStorageSizes` decides *whether* a seed has a bounded count by
 * reading {@link StrategyDescriptor.seedExpandsList}, a boolean, which does not
 * narrow the strategy's type; it then needs the count. Without this helper that
 * one site has to re-narrow on `strategy.name`, reintroducing precisely the
 * per-strategy branch the descriptor replaced.
 *
 * So the narrowing happens once, here, inside the module that owns the table
 * and can therefore do it safely, and every caller gets a bare-union API.
 *
 * Returning `undefined` rather than `Infinity` keeps "bounds no count"
 * distinguishable from "bounds a very large count" — `exactOptionalPropertyTypes`
 * is on and an absent `seedCapacity` is a real statement about the strategy.
 */
export function seedCapacityOf(strategy: BoxStrategy): number | undefined {
  const descriptor = STRATEGY_DESCRIPTOR_TABLE[strategy.name];

  // Narrow once, in the module that owns the pairing. The table is keyed by
  // name and fully checked at its literal, so the row and the strategy are the
  // same strategy by construction — which is what makes this cast safe here and
  // unsafe at a call site that cannot see the table.
  return (
    descriptor as StrategyDescriptor<BoxStrategy> & {
      seedCapacity?: (strategy: BoxStrategy) => number;
    }
  ).seedCapacity?.(strategy);
}

/**
 * Which store `strategy`'s boxes live in — see {@link StoreIdentity}.
 *
 * Total: every strategy answers, so this returns a `StoreIdentity` rather than
 * `StoreIdentity | undefined`. Unlike {@link keyBudgetOf} there is no absence to
 * model — a strategy that stored its boxes nowhere would not be a strategy — and
 * an optional return here would push every caller into inventing a policy for
 * "unknown store", which is the one thing a co-transactional check must not
 * guess at.
 *
 * **Compare the `id`s for equality and nothing else.** Two strategies are
 * co-transactional exactly when their ids match; they are not "nearly" one store
 * when the ids share a prefix, and the prefix carries no meaning a caller may
 * read. Print the `description` — never the id — when telling an author which
 * store a key landed in.
 *
 * **Why a function rather than a field read**, for the same reason as
 * {@link seedCapacityOf} and {@link keyBudgetOf}: {@link descriptorFor} is
 * generic, so a caller holding the bare `BoxStrategy` union gets the *union* of
 * rows and cannot invoke a field that takes a strategy without re-narrowing on
 * `strategy.name` — precisely the per-strategy branch the descriptor exists to
 * delete, and precisely the branch a store check must not grow one of per
 * strategy. The narrowing happens once, here, inside the module that owns the
 * table.
 */
export function storeIdentityOf(strategy: BoxStrategy): StoreIdentity {
  const descriptor = STRATEGY_DESCRIPTOR_TABLE[strategy.name];

  // The same narrow, checked cast as `seedCapacityOf` and `keyBudgetOf`, and
  // safe for the same reason: the table is keyed by name, so the row and the
  // strategy are the same strategy by construction.
  return (
    descriptor as StrategyDescriptor<BoxStrategy> & {
      storeIdentity: (strategy: BoxStrategy) => StoreIdentity;
    }
  ).storeIdentity(strategy);
}

/**
 * The byte budget for one key under `strategy`, or `undefined` when **the
 * strategy has no budget this package can compute** — see
 * {@link StrategyDescriptor.budget}.
 *
 * `undefined` is a statement about the strategy, not a failure and not a zero.
 * A backend whose storage is somebody else's server to provision has no honest
 * byte figure to derive from a `storage:` block, and the only two answers worse
 * than "no figure" are a fabricated one and a `0` that reads as "this costs
 * nothing". Callers must not collapse it into either; `budgetForKey` in
 * `budget.ts` turns it into an explicit `budgetable: false` record that still
 * names the key, so a report can say which key it could not charge.
 *
 * **Why a function rather than a field read**, for the same reason as
 * {@link seedCapacityOf}: {@link descriptorFor} is generic, so a caller holding
 * the bare `BoxStrategy` union gets the *union* of rows and cannot invoke a
 * field that takes a strategy without re-narrowing on `strategy.name` — which
 * is precisely the per-strategy branch the descriptor exists to delete. The
 * narrowing happens once, here, inside the module that owns the table and can
 * therefore do it safely.
 *
 * `source` is passed through rather than defaulted here so the one default
 * (`'declared'`) lives with the two concrete budget functions in `box-size.ts`.
 */
export function keyBudgetOf(
  strategy: BoxStrategy,
  key: string,
  source?: KeyBudgetSource,
): KeyBudget | undefined {
  const descriptor = STRATEGY_DESCRIPTOR_TABLE[strategy.name];

  // The same narrow, checked cast as `seedCapacityOf` above, and safe for the
  // same reason: the table is keyed by name, so the row and the strategy are
  // the same strategy by construction.
  return (
    descriptor as StrategyDescriptor<BoxStrategy> & {
      budget?: (
        key: string,
        strategy: BoxStrategy,
        source?: KeyBudgetSource,
      ) => KeyBudget;
    }
  ).budget?.(key, strategy, source);
}
