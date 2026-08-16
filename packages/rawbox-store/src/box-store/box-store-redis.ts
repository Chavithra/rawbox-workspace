// `import type`, not `import { type RedisClientType }`. With `verbatimModuleSyntax`
// on, the inline-modifier form is *not* elided for a value import from the same
// specifier as a value — see `box-size.ts:1`'s note on the equivalent `lmdb` case.
// `RESP_TYPES` and `createClient` are values and are imported the normal way below.
import type { RedisClientType } from 'redis';
import { createClient, RESP_TYPES } from 'redis';
import { Packr } from 'msgpackr';
import { ok, err, type Result } from 'neverthrow';

import { type Box, type BoxLocation, type BoxStrategy } from '../box.js';
import { type BoxStore } from './box-store.js';
import { measureValueSize } from '../box-size.js';
import { descriptorFor } from '../strategy/descriptor.js';

// ---------------------------------------------------------------------------
// `redis-kv` — a value cell held by a Redis server, not this process's LMDB
// environment. Read `box-store-lmdb.ts` first: every contract this file
// repeats — msgpack measurement, the oversized-value message shape, "nothing
// throws across the API boundary" — is stated at length there and is not
// restated in full here.
//
// ## Key namespacing — the scheme, and why it is safe
//
// Redis is one flat keyspace shared by however many workspaces point their
// `backends:` entries at the same server. LMDB gets isolation for free: one
// **environment** (a directory) per workspace, one **DBI** (a named database)
// per workflow inside it — two workflows in one workspace cannot collide
// because they are not in the same table. Redis has no such structure to
// lean on, so this store builds the equivalent by hand, as a key prefix:
//
//     rawbox:<workspace>:<workflow>:<key>
//
// `:` is the separator because it is the one character
// `@rawbox/runner`'s FORMAT.md, "Storage keys", guarantees a storage **key**
// cannot contain —
// the author-key character class is `[A-Za-z0-9_.-]+`. That is the same fact
// `fifo-ring.ts` relies on for `fifo:<key>:head` (see its module comment):
// a key built from `:`-joined fields can never be mistaken for, or collide
// with, a value the *last* field could have produced on its own, because the
// last field — the author's key — is the one guaranteed not to carry the
// separator itself.
//
// **A gap recorded rather than closed.** The guarantee above covers the
// `key` field only. `workspace` and `workflow` are names (`Type.String()` in
// `workspace-types.ts` / `workflow-types.ts`), with no character-class
// restriction at this layer, so a workspace or workflow whose *name* itself
// contained `:` could in principle build an ambiguous prefix — `workspace
// "a", workflow "b:c"` and `workspace "a:b", workflow "c"` both stringify to
// `rawbox:a:b:c:`. This is not a new hole this store opens: `BoxStoreLmdb`
// already trusts `workspace` verbatim as a filesystem directory name
// (`resolveEnvFolderUrl`) and `workflow` verbatim as an LMDB DBI name
// (`LmdbDbiCache.getOrCreateDbi`), so a name that broke either of those
// assumptions was already a problem before this file existed. Closing it
// here — e.g. length-prefixing each segment — would be inventing a stronger
// contract for `redis-kv` alone, for two fields no strategy's schema
// constrains, which is not what this task asked for. Left open, by design,
// the same way the key character set's own case-sensitivity gap is: the set
// admits both cases, so `Foo` and `foo` are two distinct Rawbox keys that
// would collide on a case-insensitive filesystem if a backend ever mapped keys
// onto file names. Neither LMDB nor Redis does — both compare keys as byte
// strings — so nothing collides in practice, and a further restriction on what
// an author may write has not been asked for.
// ---------------------------------------------------------------------------

const REDIS_KEY_NAMESPACE = 'rawbox';

/**
 * The full `:`-joined Redis key for one `BoxLocation` — see the module
 * comment.
 *
 * Exported (not just used internally) so {@link BoxObserverRedis}
 * (`box-observer-redis.ts`) builds the identical string rather than a second,
 * independently-typed copy of this one line: the write side and the read
 * side agreeing on the key scheme is the entire reason `redis-kv`/`redis-fifo`
 * observation can find what this store wrote, and a duplicated function is
 * exactly the kind of thing that drifts unnoticed.
 */
export function redisKeyFor(location: {
  readonly workspace: string;
  readonly workflow: string;
  readonly key: string;
}): string {
  return `${REDIS_KEY_NAMESPACE}:${location.workspace}:${location.workflow}:${location.key}`;
}

/** `e instanceof Error ? e.message : String(e)`, the one-liner every catch here needs. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Value encoding — msgpack, measured exactly like LMDB, stored uncompressed
//
// `checkValueSize` below calls `measureValueSize(content)` with **no** `db`
// argument, which is the whole of the parity contract: `box-size.ts` falls
// back to a standalone `Packr({ copyBuffers: true })` whenever it has no live
// database to consult (`measureValueSize`'s doc comment), so the bytes this
// guard charges against `valueSizeMax` are byte-identical to the bytes
// `BoxStoreLmdb`'s `checkValueSize` charges when it, too, has no `db` in hand
// — the same measurement, on both backends, from the same fallback path.
//
// `redisPackr` below is a **second** instance of that same construction, used
// to produce the bytes this store actually writes to Redis. It is not the
// literal object `measureValueSize` falls back to — that one lives private to
// `box-size.ts` — but `new Packr({ copyBuffers: true })` with no
// `sharedStructuresKey` is a pure function of its input, so two instances
// constructed identically pack any given value to the same bytes. Measuring
// and storing through two instances rather than one mirrors what
// `BoxStoreLmdb` already does across its own two steps: `checkValueSize`
// measures through `db.encoder`, and `dbi.putSync` then re-encodes the value
// itself through that same encoder as part of the write. One measurement, one
// write, never sharing a single pack() call between them, is the existing
// shape; this file just names both of its own steps instead of leaving the
// second implicit inside a native call.
//
// **No compression.** `LMDB_DBI_OPTIONS_DEFAULT` turns on lmdb-js's LZ4, so a
// value's bytes *on disk* are smaller than the bytes `valueSizeMax` bounds.
// Nothing here compresses, so a value's bytes *in Redis* are exactly the
// bytes `valueSizeMax` bounds — a stricter, not a looser, guarantee than
// LMDB's, and not a contract this task asked for, so it is simply not added.
// ---------------------------------------------------------------------------

const redisPackr = new Packr({ copyBuffers: true });

/**
 * Shared write-side guard, message-for-message identical to
 * `box-store-lmdb.ts`'s `checkValueSize` when that function's own `db`
 * argument is omitted — which for `redis-kv` it always would be, since there
 * is no LMDB `Database` to pass. Kept as its own small function rather than
 * exported and shared from the LMDB file because the two differ in exactly
 * that one parameter, and duplicating one `if` is cheaper than widening that
 * file's signature for a caller with no `db` to give it.
 */
function checkValueSize(
  content: unknown,
  strategy: BoxStrategy,
  key: string,
): Result<void, string> {
  const valueSizeMax = strategy.valueSizeMax;
  const sizeResult = measureValueSize(content);

  if (sizeResult.isErr()) {
    return err(sizeResult.error);
  }

  const size = sizeResult.value;

  if (size > valueSizeMax) {
    return err(
      `Value for key '${key}' exceeds valueSizeMax: ${size} bytes encoded, limit ${valueSizeMax}`,
    );
  }

  return ok();
}

/**
 * Packs `content` and copies the result out of msgpackr's shared arena
 * immediately, before returning to the caller.
 *
 * **Why the copy cannot be skipped.** `Packr#pack` reuses one internal
 * buffer across calls — `box-size.ts`'s note on `measureValueSize` documents
 * the same arena for the measuring instance — so the `Buffer` `pack()`
 * returns is a *view*, valid only until the next `pack()` call on this same
 * `redisPackr`. Two `put()`s racing on this store (this method is `async`,
 * so a second call can start before the first has awaited its `SET`) would
 * otherwise overwrite each other's payload before either reached the socket.
 * `Buffer.from(view)` copies — it is not the zero-copy `Buffer.from(arrayBuffer)`
 * form — so the copy happens synchronously, before any `await` in this
 * function's caller can yield the event loop to a concurrent `put()`.
 */
function encodeValue(content: unknown): Result<Buffer, string> {
  try {
    const packed = redisPackr.pack(content);
    return ok(Buffer.from(packed));
  } catch (e: unknown) {
    return err(`Failed to encode value: ${errorMessage(e)}`);
  }
}

/**
 * The `default:` arm of this store's strategy switch — the `redis-kv`/`redis-fifo`
 * counterpart of `box-store-lmdb.ts`'s `unsupportedStrategyError`, and for
 * the identical reason: `BoxStrategy` is open to strategies this class does
 * not route, and `BoxLocation` can be built by hand with any string in
 * `strategy.name`. An `Err`, never a throw or a silent fallback — see that
 * function's doc comment for the full argument, which applies here unchanged
 * with `redis-kv`/`redis-fifo` and `BoxStoreRedis` written in place of
 * `lmdb-kv`/`lmdb-fifo` and `BoxStoreLmdb`.
 */
function unsupportedStrategyError(strategyName: string): string {
  return (
    `Unsupported strategy: '${strategyName}' — BoxStoreRedis routes 'redis-kv' and ` +
    `'redis-fifo' only. Nothing was written and nothing fell back to Redis: a strategy ` +
    `this store does not route is either stored by a different backend or is not a ` +
    `strategy at all, and neither one's data may land in this file. Open a store for ` +
    `that backend, or declare a Redis strategy for this key.`
  );
}

// ---------------------------------------------------------------------------
// WRONGTYPE — one physical key, two possible strategies
//
// `redis-kv` and `redis-fifo` occupy the identical physical key,
// `rawbox:<workspace>:<workflow>:<key>` — deliberately, per `redisKeyFor`'s
// doc comment and `strategy/descriptor.ts`'s `redis-fifo` row ("the SAME
// physical key a `redis-kv` box... would"). A `TYPE` marker prefix was
// rejected there on purpose: it would let a changed strategy silently start
// an empty queue or cell beside the author's abandoned data instead of
// surfacing the change. The cost of that decision lands here — a key
// declared one way this run may hold the other strategy's data from an
// earlier run, and Redis's own type check is what catches it.
//
// **Most commands catch this for free.** `GET`, `LPOP`, and `LLEN` (called
// from inside the enqueue script below) all refuse to run against a key of
// the wrong native type and reply `WRONGTYPE Operation against a key holding
// the wrong kind of value` — confirmed directly against the live server this
// package tests against. `describeRedisCommandFailure` below turns that
// generic client-library sentence into a diagnostic naming the key, what
// Redis actually holds, what this box's declared strategy expected, and the
// most likely cause (a strategy that changed between runs) — never the raw
// `SimpleError` text, which names none of that.
//
// **`SET` does not catch this — measured, not assumed.** Unlike every other
// command this file issues, `SET` is Redis's generic "make this key hold
// this string" command: it overwrites a key of *any* existing type with no
// type check at all. Run directly against the live server: `RPUSH k a b`
// followed by `SET k oops` replies `OK`, and `TYPE k` afterward reports
// `string` — the queue's two elements are gone, silently, with no error
// anywhere. That is precisely the failure mode this module's own key scheme
// exists to surface rather than hide (see the paragraph above), so `put`'s
// `redis-kv` arm below runs an explicit `TYPE` probe before its `SET` and
// refuses via the same diagnostic instead of allowing the clobber. This is
// the one place in this file that pays an extra round trip for a check Redis
// will not do on its own.
// ---------------------------------------------------------------------------

/** The Redis native type a strategy's key must hold, keyed by strategy name. */
const REDIS_EXPECTED_TYPE: { readonly 'redis-kv': string; readonly 'redis-fifo': string } = {
  'redis-kv': 'string',
  'redis-fifo': 'list',
};

/**
 * Builds the WRONGTYPE diagnostic from an already-known `foundType` — the
 * synchronous half, shared by the two ways this file discovers a type
 * mismatch: a caught `WRONGTYPE` reply (after probing `TYPE` to learn what
 * Redis actually holds) and `put`'s pre-`SET` `TYPE` probe, which learns
 * `foundType` without ever provoking the error Redis wouldn't raise on its
 * own (see the module comment above).
 */
function wrongTypeMessage(
  key: string,
  redisKey: string,
  strategyName: 'redis-kv' | 'redis-fifo',
  foundType: string,
): string {
  const expectedType = REDIS_EXPECTED_TYPE[strategyName];
  return (
    `Key '${key}' declares strategy '${strategyName}', which requires the Redis key ` +
    `'${redisKey}' to hold a '${expectedType}' — but Redis reports it currently holds ` +
    `${foundType}. 'redis-kv' and 'redis-fifo' store their boxes at the SAME physical key ` +
    `(this module's 'redisKeyFor'; 'strategy/descriptor.ts''s 'redis-fifo' row), so this ` +
    `almost always means the strategy declared for '${key}' changed between runs: an ` +
    `earlier run wrote this key under the other strategy, and this run's declaration no ` +
    `longer matches what is on the server. Redis refused the operation rather than let the ` +
    `two silently mix. Either restore this key's strategy to whichever one wrote it, or ` +
    `delete '${redisKey}' to discard the old data and let this run start fresh.`
  );
}

/**
 * The general per-command failure message every `catch` in this file used
 * before `redis-fifo` existed — kept as the fallback for every failure that
 * is not a type mismatch, so an ordinary network or protocol error still
 * reads exactly as it always has.
 */
function commandFailureMessage(command: string, key: string, e: unknown): string {
  return `Redis ${command} failed for key '${key}': ${errorMessage(e)}`;
}

/**
 * Turns a caught Redis command error into an `Err` message: the WRONGTYPE
 * diagnostic above when the failure is a type mismatch, the plain
 * command-failure sentence otherwise.
 *
 * Async because naming *what Redis actually holds* — the fact that makes the
 * WRONGTYPE diagnostic actionable rather than a restatement of the error —
 * costs a second round trip (`TYPE`) that the original failed command's own
 * error reply does not carry. That probe is itself best-effort: a `TYPE`
 * failing, or reporting `none` because the key was deleted between the two
 * commands, falls back to a sentence that still states everything except the
 * found type, rather than losing the WRONGTYPE diagnosis entirely over a
 * second, unrelated failure.
 */
export async function describeRedisCommandFailure(
  client: RedisClientType,
  e: unknown,
  redisKey: string,
  key: string,
  strategyName: 'redis-kv' | 'redis-fifo',
  command: string,
): Promise<string> {
  const message = errorMessage(e);

  if (!message.includes('WRONGTYPE')) {
    return commandFailureMessage(command, key, e);
  }

  let foundType = "a type this diagnostic could not determine (the key changed again before it could be inspected)";

  try {
    const redisType = await client.sendCommand<string>(['TYPE', redisKey]);
    if (redisType !== 'none') {
      foundType = `a '${redisType}'`;
    }
  } catch {
    // Best-effort — see the doc comment above. `foundType` keeps its
    // fallback wording.
  }

  return wrongTypeMessage(key, redisKey, strategyName, foundType);
}

// ---------------------------------------------------------------------------
// `redis-fifo` — a queue held as a native Redis list, RPUSH-appended and
// LPOP-dequeued. See `box.ts`'s `RedisFIFO` doc comment for why a native list
// rather than `lmdb-fifo`'s emulated ring, and `strategy/descriptor.ts`'s
// `redis-fifo` row for why capacity is `queueSizeMax` unreduced.
//
// ## The atomicity requirement
//
// Enforcing `queueSizeMax` is check-then-act: reading `LLEN` and then
// issuing `RPUSH` only if it was under the limit is TWO round trips with a
// race between them — two concurrent `put`s can both observe
// `LLEN < queueSizeMax`, both `RPUSH`, and both succeed, overflowing the
// declared ceiling. That race is not hypothetical for this store
// specifically: `client.sendCommand` returns a `Promise`, so two `put()`
// calls on one `BoxStoreRedis` (or two callers sharing a cached client,
// `RedisClientCache`'s whole reason for existing) can both have issued their
// `LLEN` before either's response comes back.
//
// `REDIS_FIFO_ENQUEUE_SCRIPT` below closes the race the only way a
// stateless client can: it moves the read-then-write into ONE `EVAL`, which
// Redis executes as a single atomic step — the documented guarantee behind
// Redis scripting is that no other command, from any client, runs while a
// script is executing. `LLEN` and the conditional `RPUSH` therefore happen
// with nothing able to interleave, which is the same guarantee
// `dbiCache.env.transactionSync` gives `BoxStoreLmdbFifo.putStatic`
// (`box-store-lmdb.ts`) for the ring's own head/tail read-modify-write, over
// a different mechanism because Redis offers no synchronous callback to
// bracket a JS-side network round trip inside.
//
// This was measured, not assumed correct by inspection: driving 50
// concurrent `put()`s at a `queueSizeMax: 10` queue and asserting the
// server-side `LLEN` never exceeds 10 is `box-store-redis.test.ts`'s
// "enqueue never overflows queueSizeMax under concurrent writers" case.
//
// The script returns an integer rather than raising a Lua error for the
// full case: `0` means "did not push, already at capacity", `1` means
// "pushed". A script-level Lua error is reserved for what Redis itself
// raises — `WRONGTYPE`, when `KEYS[1]` already holds a `redis-kv` string —
// which aborts the whole script (including a `RPUSH` that hadn't run yet)
// and surfaces to the client as a normal command failure, translated by
// `describeRedisCommandFailure` like every other command in this file.
// ---------------------------------------------------------------------------

const REDIS_FIFO_ENQUEUE_SCRIPT = `
local len = redis.call('LLEN', KEYS[1])
if len >= tonumber(ARGV[1]) then
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[2])
return 1
`;

/** `Queue is full '<strategy name>'` — byte-identical to `BoxStoreLmdbFifo.putStatic`'s message (`box-store-lmdb.ts`), so a caller checking this text does not need a second branch per backend. */
function fullQueueMessage(strategyName: string): string {
  return `Queue is full '${strategyName}'`;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/**
 * Upper bound, in milliseconds, on **one** `connect()` attempt (node-redis's
 * `socket.connectTimeout`, itself defaulted to this same 5s upstream). Named
 * here anyway so {@link REDIS_CONNECT_RETRY_MAX}'s worst-case total below is
 * computed from a value this file states rather than one only node-redis's
 * source knows.
 */
const REDIS_CONNECT_TIMEOUT_MS = 5_000;

/**
 * How many times a **failed** connection attempt retries before `connect()`
 * gives up — see {@link openRedisClient}'s doc comment for why a bound is
 * required at all. `2` means 3 attempts total (the first, plus 2 retries),
 * each capped at {@link REDIS_CONNECT_TIMEOUT_MS}, so the worst case for a
 * target that is silently dropped rather than refused — nothing to bound the
 * per-attempt wait *except* the timeout — is a little over
 * `3 × REDIS_CONNECT_TIMEOUT_MS` ≈ 15s before `create()` resolves to an `Err`.
 * That is slow for a person watching a terminal and fast for a server that
 * is merely restarting, which is the trade this number encodes: a couple of
 * retries survives the ordinary "the container is still coming up" race
 * without asking a genuinely misconfigured connection string to hang the
 * caller indefinitely.
 */
const REDIS_CONNECT_RETRY_MAX = 2;

/**
 * Opens one `redis` client against `connection` and connects it.
 *
 * **Bounded retries are not optional — this is a promise about `create()`
 * itself, not a tuning knob.** node-redis's default `reconnectStrategy`
 * retries **forever**, with capped exponential backoff, and does not treat a
 * failed *initial* connection any differently from a drop after success —
 * both run through the same retry loop (`@redis/client`'s
 * `RedisSocket#connect`, the `do { … } while (isOpen && !isReady)`). Left at
 * that default, `client.connect()`'s returned Promise never settles for a
 * target that is unreachable rather than merely slow — measured directly
 * against a silently-dropping port in this package's own tests, which hung
 * past a 10s test timeout with the client still retrying in the background
 * until the process exited. "Connecting is async, so the factory is async
 * and returns a `Result`" (this task's own instruction) is a promise about
 * the *shape* of a connection failure; it only holds if the failure is
 * guaranteed to arrive, which is exactly what an unbounded retry loop does
 * not guarantee. The `reconnectStrategy` below is what turns "retries
 * forever" into "retries {@link REDIS_CONNECT_RETRY_MAX} times, then rejects".
 *
 * **The 'error' listener is not optional either.** `RedisClientType` extends
 * Node's `EventEmitter`, whose documented default behaviour for an `'error'`
 * event with no listener is to throw — as an *uncaught exception*, which
 * crashes the process. A dropped socket or a server restart *after* a
 * successful `connect()` emits exactly that event, on a timer the caller
 * does not control, so without a listener a store that had already returned
 * `ok(...)` to every prior caller could still bring the process down on a
 * later, unrelated network hiccup. Attaching a no-op listener does not hide
 * the failure: the command that was in flight when the socket dropped still
 * rejects its own promise, which every `get`/`put` below already turns into
 * an `Err` — the listener's only job is to stop that same failure from also
 * being reported a second time, as a crash, via a completely different
 * channel `neverthrow` cannot reach into.
 */
async function openRedisClient(
  connection: string,
): Promise<Result<RedisClientType, string>> {
  let client: RedisClientType;

  try {
    client = createClient({
      url: connection,
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        reconnectStrategy: (retries: number) =>
          retries >= REDIS_CONNECT_RETRY_MAX
            ? false
            : Math.min(retries * 200, 1_000),
      },
    });
  } catch (e: unknown) {
    return err(
      `Failed to construct a Redis client for "${connection}": ${errorMessage(e)}`,
    );
  }

  client.on('error', () => {
    // Intentionally empty — see the doc comment above.
  });

  try {
    await client.connect();
  } catch (e: unknown) {
    return err(`Failed to connect to Redis at "${connection}": ${errorMessage(e)}`);
  }

  return ok(client);
}

/**
 * One `redis` client per connection string, memoized — the `redis-kv`
 * counterpart of `LmdbEnvCache`'s memoization of one environment per
 * workspace (`box-store-lmdb.ts`).
 *
 * **Why this has to be a cache the caller can share, not a private field of
 * `BoxStoreRedis`.** `RedisKV.backend` is declared **per strategy block**
 * (`box.ts`), so two different `storage.keys` entries in the same
 * workflow — or the same `backend:` id referenced by two different
 * workflows in one workspace — can resolve to the *same* connection string.
 * `BoxStoreRedis.create` takes a resolved connection string, not a backend
 * id (see that method's doc comment for why), so nothing inside this file
 * ever sees two callers asking for "the same backend" as the same request —
 * it only ever sees the string. A cache keyed on that string is what turns
 * repeated `create()` calls for one server into one TCP connection rather
 * than N, without requiring every caller to have first agreed on how to
 * dedupe backend ids themselves.
 *
 * Concurrent calls for the same connection string share one in-flight
 * `connect()` rather than racing two: the map holds the `Promise` itself, not
 * only its resolved value, so a second caller arriving before the first
 * `connect()` has settled is handed that same pending promise.
 *
 * **A failed connection attempt is not cached.** Unlike `LmdbEnvCache`,
 * where `open()` on a local directory either succeeds or the environment is
 * unusable for the life of the process either way, a Redis connection failure
 * is routinely transient — the server has not started yet, a DNS entry has
 * not propagated, a restart is in progress. Caching the failed `Promise`
 * would condemn every later `getOrCreateClient` call for that connection
 * string to the same stale error for the rest of the process's life, with no
 * way to recover short of restarting it. Evicting the entry on failure means
 * the next call tries again.
 */
export class RedisClientCache {
  private readonly clientPromiseByConnection = new Map<
    string,
    Promise<Result<RedisClientType, string>>
  >();

  public async getOrCreateClient(
    connection: string,
  ): Promise<Result<RedisClientType, string>> {
    const cached = this.clientPromiseByConnection.get(connection);

    if (cached) {
      return cached;
    }

    const connectPromise = openRedisClient(connection);
    this.clientPromiseByConnection.set(connection, connectPromise);

    const result = await connectPromise;

    if (result.isErr()) {
      // Do not let one transient failure poison every later call — see the
      // class doc comment.
      this.clientPromiseByConnection.delete(connection);
    }

    return result;
  }

  /**
   * Closes and evicts the client cached for `connection`, if one exists and
   * connected successfully. A no-op for a connection string this cache never
   * saw, or whose only attempt failed — there is nothing open to close.
   */
  public async close(connection: string): Promise<void> {
    const cached = this.clientPromiseByConnection.get(connection);

    if (!cached) {
      return;
    }

    this.clientPromiseByConnection.delete(connection);

    const result = await cached;

    if (result.isOk()) {
      try {
        await result.value.quit();
      } catch {
        // Closing is best-effort: a client whose socket is already gone has
        // nothing left to flush, and the caller closing it is winding down
        // regardless of whether the server acknowledges QUIT.
      }
    }
  }

  /** Closes and evicts every client this cache holds. See {@link close}. */
  public async closeAll(): Promise<void> {
    const connectionList = [...this.clientPromiseByConnection.keys()];

    for (const connection of connectionList) {
      await this.close(connection);
    }
  }
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * `BoxStore` for `redis-kv` — a value cell held by a Redis server.
 *
 * ## Transactions — what this store offers today, and what it does not
 *
 * `BoxStore` (`box-store.ts`) declares only `get`/`put`; it is
 * `BoxStoreLmdb.transaction` — not part of the interface — that gives the
 * runner an atomic `{write a set of boxes, optionally read a set of
 * locations}` primitive, over a **synchronous** callback (see that method's
 * long doc comment for why the callback must stay synchronous on LMDB). This
 * class deliberately implements **no such method**. Two reasons:
 *
 * 1. **Nothing in the current runner needs it from this backend yet.**
 *    `redis-kv` is a cell: `seedExpandsList: false`
 *    (`strategy/descriptor.ts`), so a `redis-kv` seed is one write, not a
 *    read-modify-write ring like `lmdb-fifo`'s. Every call site
 *    `BoxStoreLmdb.transaction` serves today — the seed loop in
 *    `tool/run-workflow.ts`, `sync-db-actor.ts`, `exit-actor.ts` — uses it to
 *    make a *set* of independent `put`s atomic, never to make one write
 *    depend on a read of Redis-side state the way the FIFO ring's
 *    head/tail check does. Nothing currently calls this class from the
 *    runner at all (see `store-support.ts`'s `WIRED_STRATEGY_NAME_LIST` and
 *    this task's report for why), so there is no live caller to build the
 *    primitive against.
 * 2. **A callback shaped like `BoxStoreLmdb.transaction`'s cannot be honoured
 *    on Redis.** That callback is synchronous by contract; a Redis command is
 *    a network round trip and cannot be issued from inside one. Offering a
 *    same-named method that silently ran its "atomic" writes as a sequence
 *    of independent commands — no `MULTI`/`EXEC`, no `EVAL` — would satisfy
 *    the type signature while breaking the one guarantee callers rely on: the
 *    module comment on `BoxStoreLmdb.transaction` explicitly rules that out
 *    ("not a sequence of independent commands pretending to be atomic").
 *
 * **What Redis *can* offer, for whenever a future task needs it.** A single
 * `SET`/`GET` is already atomic — Redis is single-threaded per command, so
 * `put`/`get` below need no transaction at all to be individually safe. For
 * a *set* of `redis-kv` writes — the seed-loop shape, and the only shape any
 * current call site needs — `MULTI`/`EXEC` is sufficient and is the right
 * tool: it is a blind pipeline (no read-your-writes and no server-side
 * branching, which a cell strategy never needs — unlike `lmdb-fifo`'s ring
 * arithmetic, nothing about a `redis-kv` write depends on a value read
 * moments earlier in the same transaction), and it queues on the existing
 * client rather than opening a second connection or shipping a Lua string.
 * `EVAL`/a Lua script is the tool for a Redis strategy whose writes are
 * conditional on server-side reads within the same round trip — `redis-fifo`
 * is exactly that, and `enqueue` below reaches for `REDIS_FIFO_ENQUEUE_SCRIPT`
 * for the identical reason `lmdb-fifo` needs `transactionSync` and `lmdb-kv`
 * does not: a queue's capacity check and its write must happen as one atomic
 * step, and unlike `lmdb-kv`'s and `redis-kv`'s single-command writes, a
 * queue's "is there room" and "add the element" are two operations that a
 * blind `MULTI` pipeline cannot make conditional on each other.
 *
 * **On the `{writes, reads}` data shape the LMDB file's doc comment
 * proposes**, as the primitive a later task could build once a real
 * multi-backend caller exists: it is the right shape for `redis-kv`,
 * specifically because a cell's writes never need to read anything back
 * mid-transaction — `{writes: Box[], reads: BoxLocation[]}` maps onto one
 * `MULTI` pipeline of `SET`s followed by `GET`s, executed with `EXEC`, with
 * no branch and no Lua required. It would very likely need a second,
 * incompatible implementation the day a strategy needs conditional
 * server-side logic (as `lmdb-fifo` does today on the LMDB side) — at which
 * point that strategy's backend would reach for `EVAL` instead, behind the
 * same data shape. Recording this rather than building it now, per this
 * task's own instruction not to.
 */
export class BoxStoreRedis implements BoxStore {
  private constructor(private readonly client: RedisClientType) {}

  /**
   * Resolves `connection` through `clientCache` and returns a store bound to
   * the resulting client.
   *
   * **Takes a connection string, not a `backend:` id.** Turning an id into a
   * connection string means reading the *workspace* document's `backends:`
   * map and substituting `${VARIABLE}` references from the process
   * environment — `@rawbox/runner`'s `resolveBackendConnection`
   * (`workspace/backends.ts`) already does exactly that. Duplicating it here
   * would mean this package depending on `@rawbox/runner`'s workspace schema,
   * which is backwards: `@rawbox/runner` depends on `@rawbox/store`, not the
   * other way around. So this factory receives the string
   * `resolveBackendConnection` would have produced, and the caller — the
   * runner, when it wires this in — is the one that calls it.
   *
   * `clientCache` is a required parameter rather than a hidden module-level
   * default so that two callers who want isolation — most concretely, two
   * test files running in the same Vitest worker against the same live
   * server — do not silently share a client neither of them asked to share,
   * and so a caller that does want sharing across many `create()` calls (the
   * runner, across a workflow's several `redis-kv` declarations) states that
   * choice by passing the same cache instance rather than getting it by
   * default.
   */
  public static async create(
    connection: string,
    clientCache: RedisClientCache,
  ): Promise<Result<BoxStoreRedis, string>> {
    const clientResult = await clientCache.getOrCreateClient(connection);

    if (clientResult.isErr()) {
      return err(clientResult.error);
    }

    return ok(new BoxStoreRedis(clientResult.value));
  }

  public async get(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    const strategy = boxLocation.strategy;

    if (strategy.name === 'redis-fifo') {
      return this.dequeue(boxLocation);
    }

    if (strategy.name !== 'redis-kv') {
      return err(unsupportedStrategyError(strategy.name));
    }

    const redisKey = redisKeyFor(boxLocation);

    let raw: Buffer | null;

    try {
      // `typeMapping` is passed **per call**, on `sendCommand` directly,
      // rather than baked into how the client was constructed in
      // `openRedisClient`: it is this method's own concern that a `redis-kv`
      // payload is arbitrary msgpack bytes, not UTF-8 text, and node-redis's
      // default `GET` decodes the reply as a `string` — which would corrupt
      // any payload that is not valid UTF-8. `RESP_TYPES.BLOB_STRING: Buffer`
      // is the one override that makes a `GET` reply come back as the bytes
      // it actually is.
      raw = await this.client.sendCommand<Buffer | null>(
        ['GET', redisKey],
        { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } },
      );
    } catch (e: unknown) {
      // A rejected promise, never a throw past this point — the network or
      // protocol failure this `try` exists to catch becomes a named `Err`
      // like every other failure in this package (rawbox-store/README.md,
      // "API Reference"). Routed through `describeRedisCommandFailure` so a
      // `GET` against a key `redis-fifo` turned into a list (the
      // queue-then-cell direction of the module comment's "WRONGTYPE"
      // section) reports the actionable diagnostic rather than the bare
      // client-library sentence.
      return err(
        await describeRedisCommandFailure(
          this.client,
          e,
          redisKey,
          boxLocation.key,
          'redis-kv',
          'GET',
        ),
      );
    }

    if (raw === null) {
      // Verbatim from the registry, never retyped here — see
      // `strategy/descriptor.ts`'s note on why `redis-kv` reuses `lmdb-kv`'s
      // exact sentence. The verifier rejects a key that is read but never
      // written by quoting the failure that key's own strategy would produce,
      // so that rule is only worth having if the store really produces the
      // string that was quoted — the message must be the runtime error it
      // prevents, not a paraphrase of it.
      return err(descriptorFor(strategy).emptyReadMessage);
    }

    try {
      return ok(redisPackr.unpack(raw));
    } catch (e: unknown) {
      // Reachable only for bytes this store did not write itself — a key a
      // human or another tool poked directly, or a payload written under a
      // different codec entirely. Named rather than left to throw out of
      // `unpack`, for the same API-boundary reason as every other catch here.
      return err(
        `Failed to decode value for key '${boxLocation.key}': ${errorMessage(e)}`,
      );
    }
  }

  public async put(box: Box<unknown>): Promise<Result<void, string>> {
    const strategy = box.location.strategy;

    if (strategy.name === 'redis-fifo') {
      return this.enqueue(box);
    }

    if (strategy.name !== 'redis-kv') {
      return err(unsupportedStrategyError(strategy.name));
    }

    const key = box.location.key;

    // Sized before anything is encoded for the wire, exactly as
    // `box-store-lmdb.ts` checks before its own `dbi.putSync` — a value that
    // is about to be rejected must not have reached the network first.
    const sizeCheckResult = checkValueSize(box.content, strategy, key);

    if (sizeCheckResult.isErr()) {
      return err(sizeCheckResult.error);
    }

    const encodeResult = encodeValue(box.content);

    if (encodeResult.isErr()) {
      return err(`Failed to encode value for key '${key}': ${encodeResult.error}`);
    }

    const redisKey = redisKeyFor(box.location);

    // A `TYPE` probe `SET` itself would not perform — see the module
    // comment's "WRONGTYPE" section, "`SET` does not catch this — measured,
    // not assumed". Without this, a `redis-kv` `put` against a key a
    // `redis-fifo` box currently owns would silently overwrite the queue
    // with a string and report `ok(undefined)`, the exact silent-mixing
    // failure `redisKeyFor`'s shared-key scheme exists to surface.
    let existingType: string;

    try {
      existingType = await this.client.sendCommand<string>(['TYPE', redisKey]);
    } catch (e: unknown) {
      return err(commandFailureMessage('TYPE', key, e));
    }

    if (existingType !== 'none' && existingType !== 'string') {
      return err(wrongTypeMessage(key, redisKey, 'redis-kv', `a '${existingType}'`));
    }

    try {
      await this.client.sendCommand(['SET', redisKey, encodeResult.value]);
      return ok(undefined);
    } catch (e: unknown) {
      // `SET` itself will not raise `WRONGTYPE` (the check above exists
      // because of that), but routing through the same helper keeps this
      // catch consistent with every other command in this file and costs
      // nothing extra on the common path, where `message.includes('WRONGTYPE')`
      // is simply false.
      return err(
        await describeRedisCommandFailure(this.client, e, redisKey, key, 'redis-kv', 'SET'),
      );
    }
  }

  /**
   * `redis-fifo` enqueue — `put`'s dispatch target when `box.location.strategy.name
   * === 'redis-fifo'`. See the module comment above `REDIS_FIFO_ENQUEUE_SCRIPT`
   * for why this must be one `EVAL` rather than an `LLEN` followed by a
   * conditional `RPUSH`.
   */
  private async enqueue(box: Box<unknown>): Promise<Result<void, string>> {
    const strategy = box.location.strategy;

    if (strategy.name !== 'redis-fifo') {
      return err(unsupportedStrategyError(strategy.name));
    }

    const key = box.location.key;

    // `valueSizeMax` bounds ONE element of the queue, measured exactly like
    // every other strategy in this file: `checkValueSize` calls
    // `measureValueSize(content)` with no `db`, the same quantity
    // `lmdb-fifo` bounds per entry (`box-store-lmdb.ts`'s `checkValueSize`),
    // never the list as a whole.
    const sizeCheckResult = checkValueSize(box.content, strategy, key);

    if (sizeCheckResult.isErr()) {
      return err(sizeCheckResult.error);
    }

    const encodeResult = encodeValue(box.content);

    if (encodeResult.isErr()) {
      return err(`Failed to encode value for key '${key}': ${encodeResult.error}`);
    }

    const redisKey = redisKeyFor(box.location);

    let pushed: number;

    try {
      pushed = await this.client.sendCommand<number>([
        'EVAL',
        REDIS_FIFO_ENQUEUE_SCRIPT,
        '1',
        redisKey,
        String(strategy.queueSizeMax),
        encodeResult.value,
      ]);
    } catch (e: unknown) {
      // Reachable for a genuine connection failure, and for `WRONGTYPE` —
      // `KEYS[1]` already a `redis-kv` string — raised from inside the
      // script by its own `LLEN` call and propagated by Redis as this
      // `EVAL`'s failure, the cell-then-queue direction of the module
      // comment's "WRONGTYPE" section.
      return err(
        await describeRedisCommandFailure(this.client, e, redisKey, key, 'redis-fifo', 'EVAL'),
      );
    }

    if (pushed === 0) {
      // Byte-identical to `BoxStoreLmdbFifo.putStatic`'s full-queue message
      // — see `fullQueueMessage`'s doc comment.
      return err(fullQueueMessage(strategy.name));
    }

    return ok(undefined);
  }

  /**
   * `redis-fifo` dequeue — `get`'s dispatch target when `boxLocation.strategy.name
   * === 'redis-fifo'`. `LPOP` alone is already atomic (Redis is
   * single-threaded per command), so unlike `enqueue` this needs no script:
   * there is no second operation to make conditional on the first.
   */
  private async dequeue(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    const strategy = boxLocation.strategy;

    if (strategy.name !== 'redis-fifo') {
      return err(unsupportedStrategyError(strategy.name));
    }

    const redisKey = redisKeyFor(boxLocation);

    let raw: Buffer | null;

    try {
      raw = await this.client.sendCommand<Buffer | null>(
        ['LPOP', redisKey],
        { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } },
      );
    } catch (e: unknown) {
      // `LPOP` against a key that already holds a `redis-kv` string also
      // raises `WRONGTYPE` — the cell-then-queue direction of the module
      // comment's "WRONGTYPE" section, caught here the same way `enqueue`'s
      // `EVAL` catches it for `put`.
      return err(
        await describeRedisCommandFailure(this.client, e, redisKey, boxLocation.key, 'redis-fifo', 'LPOP'),
      );
    }

    if (raw === null) {
      // Verbatim from the registry — see `strategy/descriptor.ts`'s
      // `redis-fifo` row: this MUST be the exact sentence the verifier quoted
      // to the author when it rejected a key that is read but never written,
      // never a retyped literal and never "nil" or any other client-library
      // word for "empty".
      return err(descriptorFor(strategy).emptyReadMessage);
    }

    try {
      return ok(redisPackr.unpack(raw));
    } catch (e: unknown) {
      return err(
        `Failed to decode value for key '${boxLocation.key}': ${errorMessage(e)}`,
      );
    }
  }
}
