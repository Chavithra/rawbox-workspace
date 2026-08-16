import { Type, type Static, type TSchema } from 'typebox';

import { StrictObject } from './schema.js';

const SizeMax = Type.Integer({ minimum: 1, maximum: 0x7fffffff });

// ---------------------------------------------------------------------------
// Strategies — authoring model
//
// These are what `storage.defaultStrategy` and every `storage.keys` entry's
// `strategy:` in a *user's document* parse into, so a stray field here
// is a silent misread of something a person or an assistant wrote: today's
// `queueSizeMax` on an `lmdb-kv` key is dropped, and the author gets a
// key-value cell where they asked for a queue. `StrictObject` is load-bearing
// on every one of them, and a new strategy MUST use it too.
//
// Because `BoxStrategy` is a union, the schema alone would report a stray field
// as a branch dump listing every variant, which `@rawbox/runner`'s FORMAT.md,
// "Validation", forbids: an unrecognised field is reported as that field, never
// as a list of the shapes the value failed to be. The runner's
// `collectStrategyFieldProblems` runs *before* the schema and names the field
// and the strategy it belongs to; these schemas close the hole, that one
// explains it. That diagnostic derives its field tables from
// `BoxStrategy.anyOf` (`@rawbox/runner`, `workflow/validation.ts`
// `STRATEGY_SHAPE_LIST`), so adding a member below is all that is needed for it
// to describe the new strategy — there is no second list to update.
// ---------------------------------------------------------------------------

export const LmdbKV = StrictObject({
  name: Type.Readonly(Type.Literal('lmdb-kv')),
  valueSizeMax: Type.Readonly(SizeMax),
});

export const LmdbFIFO = StrictObject({
  name: Type.Readonly(Type.Literal('lmdb-fifo')),
  queueSizeMax: Type.Readonly(Type.Integer({ minimum: 2 })),
  valueSizeMax: Type.Readonly(SizeMax),
});

/**
 * A single value cell held by a Redis server rather than by this process's
 * LMDB environment.
 *
 * **`backend` is an id, not a connection string.** It names an entry of the
 * *workspace* document's `backends:` map (`@rawbox/runner`,
 * `workspace/workspace-types.ts`), and that indirection is the point:
 *
 *   - a strategy block is declared **per key**, so putting the connection here
 *     would repeat one server's address once per key, with nothing keeping the
 *     copies in agreement;
 *   - a workflow document is **committed**, and a Redis URL routinely carries a
 *     password. Credentials belong in the environment, which is what the
 *     workspace's `backends:` entry interpolates from;
 *   - a workspace is defined as ONE storage environment (root README, "How It
 *     Works"), so
 *     the environment's connection details are the workspace's to state.
 *
 * The consequence, stated so it is not discovered: a workflow declaring
 * `redis-kv` can be **shape**-verified on its own — this schema, the field
 * diagnostics and the seed rules need no workspace — but cannot be
 * **connection**-verified without one, because the id it names is resolved
 * there. That is already true of `plugin:` resolution, which also needs the
 * workspace to say where packages were installed, so it is one rule an author
 * already knows rather than a new exception (`@rawbox/runner`'s FORMAT.md,
 * "`backends`").
 *
 * There is deliberately **no `queueSizeMax`**: this is a cell. The Redis list
 * strategy is {@link RedisFIFO}, a separate union member with its own capacity
 * semantics, since a native list reserves no slot the way `lmdb-fifo`'s ring
 * does.
 */
export const RedisKV = StrictObject({
  name: Type.Readonly(Type.Literal('redis-kv')),
  valueSizeMax: Type.Readonly(SizeMax),
  /**
   * Id of the entry in the workspace document's `backends:` map that says how
   * to reach the server. `minLength: 1` because an empty id names nothing and
   * would otherwise reach the resolver as a lookup miss with no name to report.
   */
  backend: Type.Readonly(Type.String({ minLength: 1 })),
});

/**
 * A queue held by a Redis server as a **native list**, not as a ring emulated
 * over a cell store.
 *
 * `backend` means exactly what it means on {@link RedisKV} — an id naming an
 * entry of the *workspace* document's `backends:` map, never a connection
 * string — and every consequence stated there holds here unchanged: a workflow
 * declaring this strategy is shape-verifiable standing alone and
 * connection-verifiable only with its workspace.
 *
 * ## Why a native list rather than `lmdb-fifo`'s ring
 *
 * `lmdb-fifo` stores a queue as `fifo:<key>:data:<n>` plus a `head` and a
 * `tail` cursor, because LMDB offers one operation — put a byte string at a
 * byte key — and a queue has to be built out of it. Redis does not have that
 * problem: `RPUSH`/`LPOP` *are* the queue, `LLEN` *is* the depth, and each is
 * atomic on the server with no cursor to read, increment and write back.
 *
 * Emulating the ring here would give up all three to gain a shared key parser,
 * and would pay for it in the currency that actually matters over a network: a
 * single enqueue becomes read-tail, read-head, write-data, write-tail — four
 * round trips and a lost-update race between any two of them, where the native
 * form is one command that cannot interleave wrongly. It would also make this
 * store's correctness depend on arithmetic *this process* performs about state
 * *another process* may be changing concurrently, which is the class of bug the
 * ring only avoids under LMDB because `transactionSync` brackets the whole
 * sequence. Nothing brackets four Redis round trips by default.
 *
 * ## The consequence that reaches the author: capacity
 *
 * The ring keeps one slot permanently free so `head === tail` can mean *empty*
 * rather than *full*, which is why {@link LmdbFIFO}'s `queueSizeMax` is `≥ 2`
 * and a declared 1024 holds 1023 (`box-store/fifo-ring.ts`, `ringCapacity`). A Redis
 * list has no cursors to disambiguate: `LLEN` reports the depth directly, and
 * an empty list is a key that does not exist. **So `queueSizeMax` here is the
 * capacity, exactly** — a declared 1024 holds 1024 — and the minimum is `1`,
 * not `2`, because a one-entry queue is a real queue under this strategy where
 * under the ring it would be a queue that can never hold anything.
 *
 * That divergence is the reason `StrategyDescriptor.seedCapacity` is a
 * *function* per strategy rather than a `- 1` written into the verifier, and
 * the reason the seed-length diagnostic explains the reserved slot only for the
 * strategy that has one (`strategy/descriptor.ts`, `seedCapacityNote`).
 *
 * There is deliberately **no `queueSizeMax` upper bound** beyond the integer
 * one, matching `LmdbFIFO`: nothing here is a bitmask or a preallocation, so no
 * power of two is preferred and no ceiling is technical.
 */
export const RedisFIFO = StrictObject({
  name: Type.Readonly(Type.Literal('redis-fifo')),
  /**
   * Entries this queue may hold. **`minimum: 1`, where {@link LmdbFIFO}
   * declares 2** — see the capacity section above. A native list reserves no
   * slot, so 1 declares a usable one-entry queue, where under the ring it would
   * declare a queue with zero usable capacity.
   */
  queueSizeMax: Type.Readonly(Type.Integer({ minimum: 1 })),
  valueSizeMax: Type.Readonly(SizeMax),
  /**
   * Id of the entry in the workspace document's `backends:` map that says how
   * to reach the server — identical in meaning to {@link RedisKV}'s `backend`,
   * including why it is an id and not a URL. `minLength: 1` because an empty id
   * names nothing and would reach the resolver as a lookup miss with no name to
   * report.
   */
  backend: Type.Readonly(Type.String({ minLength: 1 })),
});

export const BoxStrategy = Type.Union([LmdbKV, LmdbFIFO, RedisKV, RedisFIFO]);
export type BoxStrategy = Static<typeof BoxStrategy>;

// ---------------------------------------------------------------------------
// Box locations — resolved runtime model
//
// Nothing parses a document into these: the resolver builds them from an
// authored binding plus the document's key table. Strictness is therefore an
// invariant on the resolver's own output rather than a guard on user input —
// useful, and not the live bug the strategies above are.
//
// It is not redundant with `validateStorageBoundaries`, which reads the same
// absent fields as a *boundary*: a write that carries `workflow` or `workspace`
// is a step reaching outside itself, and that gets a sentence saying so rather
// than an unknown-property error.
// ---------------------------------------------------------------------------

export const BoxLocation = StrictObject({
  key: Type.Readonly(Type.String()),
  workflow: Type.Readonly(Type.String()),
  workspace: Type.Readonly(Type.String()),
  strategy: Type.Readonly(BoxStrategy),
});
export type BoxLocation = Static<typeof BoxLocation>;

export const WriteBoxLocation = StrictObject({
  key: Type.Readonly(Type.String()),
  strategy: Type.Readonly(BoxStrategy),
});
export type WriteBoxLocation = Static<typeof WriteBoxLocation>;

export const ReadBoxLocation = StrictObject({
  key: Type.Readonly(Type.String()),
  strategy: Type.Readonly(BoxStrategy),
  workflow: Type.Optional(Type.Readonly(Type.String())),
});
export type ReadBoxLocation = Static<typeof ReadBoxLocation>;

export const Box = <T extends TSchema>(TValue: T) =>
  StrictObject({
    content: TValue,
    location: BoxLocation,
  });

export interface Box<TValue> {
  readonly content: TValue;
  readonly location: BoxLocation;
}

export const BoxLocationRecord = Type.Record(Type.String(), Type.Union([WriteBoxLocation, ReadBoxLocation]));
export type BoxLocationRecord = Static<typeof BoxLocationRecord>;
