// `import type`, not `import { type RedisClientType }` — see `box-store-redis.ts:1-4`'s
// note on why the inline-modifier form is not elided under `verbatimModuleSyntax`
// for a value import from the same specifier as a value.
import type { RedisClientType } from 'redis';
import { RESP_TYPES } from 'redis';
import { Packr } from 'msgpackr';
import { ok, err, type Result } from 'neverthrow';

import { type BoxLocation } from '../box.js';
import { type BoxObserverAsync } from './box-observer.js';
import { type BoxInspection, type BoxQueueDepth } from './box-peek.js';
import { descriptorFor, seedCapacityOf } from '../strategy/descriptor.js';
import {
  RedisClientCache,
  describeRedisCommandFailure,
  redisKeyFor,
} from './box-store-redis.js';

// ---------------------------------------------------------------------------
// `BoxObserverRedis` — the `BoxObserverAsync` counterpart of
// `BoxObserverLmdb`, for `redis-kv` and `redis-fifo` boxes held by a Redis
// server. Read `box-observer.ts`'s doc comment on `BoxObserverAsync` first —
// this class is the "on its own side" it defers to, and this comment does
// not repeat why an async observer needs a separate interface at all.
//
// ## What this class guarantees, and what it deliberately does not
//
// **1. It never writes.** Every command issued from this file is one of
// `SCAN`, `TYPE`, `GET`, `LRANGE` or `LLEN` — read commands, full stop. There
// is no `SET`, `DEL`, `LPUSH`/`RPUSH`, `EXPIRE` or `EVAL` anywhere below, and
// nothing here opens a `MULTI`. `box-observer-redis.test.ts` asserts this
// directly: it snapshots the exact key set under a namespace via `SCAN`
// before running every observation method this class exposes, and asserts
// the snapshot is byte-identical afterwards — not merely that the values it
// wrote are unchanged, but that no key was added, removed or had its TTL
// touched.
//
// **2. `SCAN`, never `KEYS`.** `KEYS` walks the entire keyspace inside one
// server-side call and blocks every other client for the duration — on a
// server with millions of keys shared by other workspaces, that is a stall
// this file has no business causing just to answer "what is in this one
// workspace". `SCAN` is the incremental cursor form: bounded batches
// (`COUNT`), no blocking, at the cost of the weaker iteration guarantee the
// next point states.
//
// **3. There is NO point-in-time snapshot, and nothing here pretends
// otherwise.** `BoxObserverLmdb` reads one MVCC snapshot per call
// (`box-observer-lmdb.ts`'s class doc comment), so a multi-key read from that
// class is internally consistent — every key it touches in one call reflects
// the store at one instant. Redis offers no equivalent for a `SCAN` sweep
// followed by per-key reads: each command here is its own round trip against
// whatever the server holds *at that moment*, and a live workspace can be
// written to between any two of them. Concretely, for a caller of this
// class:
//
//   - **`listKeys` can show a torn view.** A key enumerated by an early `SCAN`
//     batch may have changed — or been deleted — by the time this class
//     issues the `TYPE`/`GET`/`LRANGE` that inspects it. `inspectKey` treats a
//     key that has vanished between the two as "not observed this sweep"
//     (dropped from the result) rather than fabricating a zero-byte row for
//     it — see that method.
//   - **`SCAN` may return the same key twice within one cursor walk**, and a
//     key added *during* the sweep may be returned zero or one times
//     depending on exactly when it was added relative to the cursor's
//     position — both are `SCAN`'s own documented cursor contract, not a bug
//     in this file. `listKeys` de-duplicates by key before returning, which
//     removes the first symptom; it cannot detect or correct the second.
//   - **`SCAN` may also fail to return a key added during the sweep at
//     all.** A workspace under concurrent write while `store list`/`store
//     watch` is running should therefore be read as "what this poll
//     happened to see", never as an atomic transcript the way an LMDB
//     observer's output can be.
//
// Nothing above is a defect to fix later: it is the honest cost of observing
// a server with no read-transaction primitive exposed to a plain client, and
// `@rawbox/runner`'s OBSERVABILITY.md, "Snapshot hygiene", states it as the
// rule rather than hiding it: a backend that cannot offer a point-in-time
// snapshot MUST say so rather than imply parity with one that can.
//
// ## Distinguishing a cell from a queue — `TYPE`, not a key-name convention
//
// `redis-kv` and `redis-fifo` occupy the identical physical key shape,
// `rawbox:<workspace>:<workflow>:<key>` (`box-store-redis.ts`'s module
// comment, and `strategy/descriptor.ts`'s `redis-fifo` row, "the SAME
// physical key a `redis-kv` box... would") — deliberately, because unlike
// LMDB's flat untyped keyspace a Redis key already carries its type. `TYPE`
// is therefore the one honest way to tell them apart: `string` is a cell,
// `list` is a queue, and this class never infers a strategy from the key's
// *name*, the way `lmdb-fifo`'s `fifo:` convention would. `inspectKey` below
// is the one place that dispatch happens.
//
// **`peek`/`peekAll`/`depth` trust the CALLER's declared strategy, not
// `TYPE`.** They take a `BoxLocation`, whose `strategy` a caller chose, and
// issue the command that strategy implies (`GET`/`LINDEX`/`LRANGE`/`LLEN`)
// without probing `TYPE` first the way `inspectKey` does — a deliberate
// difference, not an inconsistency: `inspectKey` is asked "what IS this
// key", so it must derive the answer from the server; these three are asked
// "what does this *declared* box hold", so a mismatch between the caller's
// declaration and the server is the interesting case, not something to
// paper over by silently re-deriving the strategy from `TYPE`. When the
// declaration is stale — the same "strategy changed between runs" scenario
// `box-store-redis.ts`'s module comment names — Redis answers `WRONGTYPE` on
// the command these methods issue, and `describeRedisCommandFailure`
// (imported from that file, so the write-time and read-time paths report
// the identical diagnostic for the identical cause) turns it into the same
// named diagnostic `BoxStoreRedis` produces.
//
// ## Capacity — `seedCapacityOf`, never a hand-written `- 1`
//
// A Redis list reserves no slot to disambiguate full from empty the way
// `lmdb-fifo`'s ring does — `LLEN` reports depth outright, and an empty list
// is a key that does not exist (`strategy/descriptor.ts`'s `redis-fifo` row,
// "capacity IS the declared ceiling"). `depth` below therefore reports
// `capacity` as `seedCapacityOf(strategy)` — the registry's per-strategy
// answer, `queueSizeMax` unreduced for `redis-fifo` — rather than repeating
// `lmdb-fifo`'s `queueSizeMax - 1` or branching on the strategy's name by
// hand. An earlier spec draft stated the `- 1` as if it held for every
// FIFO-shaped strategy; `@rawbox/runner`'s OBSERVABILITY.md, "Enumeration",
// now names `lmdb-fifo` specifically, because a second queue strategy answers
// differently and a diagnostic must not assert a property the author's
// strategy does not have.
// ---------------------------------------------------------------------------

/** `e instanceof Error ? e.message : String(e)` — the one-liner every catch here needs. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A **second** `Packr({ copyBuffers: true })` instance, constructed
 * identically to `box-store-redis.ts`'s `redisPackr` and to
 * `box-size.ts`'s fallback encoder. That file's module comment states the
 * fact this relies on: `new Packr({ copyBuffers: true })` with no
 * `sharedStructuresKey` is a pure function of its input, so any two instances
 * built this way decode the same bytes to the same value. A third instance
 * here (rather than importing the store's private one) keeps this file's read
 * path independent of `box-store-redis.ts`'s internals — it needs the same
 * *codec*, not the same object.
 */
const observerPackr = new Packr({ copyBuffers: true });

function decodeValue(raw: Buffer): Result<unknown, string> {
  try {
    return ok(observerPackr.unpack(raw));
  } catch (e: unknown) {
    return err(`Failed to decode value: ${errorMessage(e)}`);
  }
}

/**
 * The `default:` arm for a strategy this class does not observe — the
 * `BoxObserverRedis` counterpart of `box-store-redis.ts`'s
 * `unsupportedStrategyError`, for the identical reason: `BoxStrategy` is open
 * to strategies this class does not route, and a `BoxLocation` can be built
 * by hand with any string in `strategy.name`.
 */
function unsupportedStrategyError(strategyName: string): string {
  return (
    `Unsupported strategy: '${strategyName}' — BoxObserverRedis observes 'redis-kv' and ` +
    `'redis-fifo' only. Open an observer for that backend instead, or declare a Redis ` +
    `strategy for this key.`
  );
}

/** node-redis reply typing that forces a `GET`/`LRANGE` blob reply to arrive as raw bytes, never decoded as UTF-8 text — see `box-store-redis.ts`'s `get()` for why. */
const BLOB_TYPE_MAPPING = { typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } } as const;

const REDIS_KEY_NAMESPACE = 'rawbox';

export class BoxObserverRedis implements BoxObserverAsync {
  private closed = false;

  private constructor(
    public readonly workspace: string,
    private readonly client: RedisClientType,
  ) {}

  /**
   * Resolves `connection` through `clientCache` and returns an observer bound
   * to the resulting client — mirroring `BoxStoreRedis.create`'s own
   * contract, including why `clientCache` is a required parameter rather than
   * a hidden default (`box-store-redis.ts`'s doc comment on
   * `RedisClientCache`).
   *
   * **Unlike `BoxObserverLmdb.openSync`, this never fails because "nothing
   * has been written to this workspace yet".** LMDB's observer refuses to
   * open an environment whose directory does not exist, because `open()`
   * would otherwise `mkdir` one into being (`box-observer-lmdb.ts:44-47`) —
   * there is a real filesystem side effect to avoid. Connecting to a Redis
   * server has no such hazard: a workspace prefix with zero keys under it is
   * simply an empty `SCAN`, not a directory this class would have to create
   * to look. So `create` fails only on a genuine connection problem (bad
   * URL, unreachable host, auth failure), and `listWorkflows`/`listKeys`
   * against an unwritten workspace answer `ok([])`, not an `Err`.
   */
  public static async create(
    workspace: string,
    connection: string,
    clientCache: RedisClientCache,
  ): Promise<Result<BoxObserverRedis, string>> {
    const clientResult = await clientCache.getOrCreateClient(connection);

    if (clientResult.isErr()) {
      return err(clientResult.error);
    }

    return ok(new BoxObserverRedis(workspace, clientResult.value));
  }

  private prefix(): string {
    return `${REDIS_KEY_NAMESPACE}:${this.workspace}:`;
  }

  /** Every key matching `pattern`, walked via `SCAN` — never `KEYS`. See the class doc comment. */
  private async scanAll(pattern: string): Promise<Result<string[], string>> {
    if (this.closed) {
      return err(`Observer for workspace '${this.workspace}' is closed`);
    }

    const keyList: string[] = [];
    let cursor = '0';

    try {
      do {
        const scanResult = await this.client.scan(cursor, {
          MATCH: pattern,
          COUNT: 200,
        });
        cursor = scanResult.cursor;
        keyList.push(...scanResult.keys);
      } while (cursor !== '0');
    } catch (e: unknown) {
      return err(`Redis SCAN failed for pattern '${pattern}': ${errorMessage(e)}`);
    }

    return ok(keyList);
  }

  /** Databases (workflows) that exist in this workspace, sorted — the segment of the key immediately after `rawbox:<workspace>:`. */
  public async listWorkflows(): Promise<Result<string[], string>> {
    const scanResult = await this.scanAll(`${this.prefix()}*`);

    if (scanResult.isErr()) {
      return err(scanResult.error);
    }

    const prefixLength = this.prefix().length;
    const workflowSet = new Set<string>();

    for (const redisKey of scanResult.value) {
      const rest = redisKey.slice(prefixLength);
      const separatorIndex = rest.indexOf(':');
      if (separatorIndex > 0) {
        workflowSet.add(rest.slice(0, separatorIndex));
      }
    }

    return ok([...workflowSet].sort());
  }

  /**
   * Every logical key in one workflow, classified by `TYPE` — see the class
   * doc comment's "Distinguishing a cell from a queue" section.
   *
   * A key that vanishes between this method's `SCAN` and its per-key `TYPE`
   * (concurrent expiry or, once #15 lands, a concurrent write) is dropped
   * from the result rather than reported as an empty entry — see
   * `inspectKey`. That is this class's honest answer to "was this key here",
   * not a bug: there is no snapshot to fall back on, per the class doc
   * comment.
   */
  public async listKeys(workflow: string): Promise<Result<BoxInspection[], string>> {
    const workflowPrefix = `${this.prefix()}${workflow}:`;
    const scanResult = await this.scanAll(`${workflowPrefix}*`);

    if (scanResult.isErr()) {
      return err(scanResult.error);
    }

    // De-duplicated, per the class doc comment's note on `SCAN`'s cursor
    // contract allowing a repeat within one walk.
    const redisKeySet = new Set(scanResult.value);
    const inspectionList: BoxInspection[] = [];

    for (const redisKey of redisKeySet) {
      const key = redisKey.slice(workflowPrefix.length);
      const inspectedResult = await this.inspectKey(redisKey, key);

      if (inspectedResult.isErr()) {
        return err(inspectedResult.error);
      }

      if (inspectedResult.value !== undefined) {
        inspectionList.push(inspectedResult.value);
      }
    }

    inspectionList.sort((left, right) => left.key.localeCompare(right.key));

    return ok(inspectionList);
  }

  /**
   * `TYPE` then the matching read — `GET` for `string`, `LRANGE 0 -1` for
   * `list`. Returns `ok(undefined)` for a key `TYPE` reports as `none`
   * (deleted between the enumerating `SCAN` and this call) so `listKeys` can
   * drop it rather than fabricate a row, and `Err` for any other reported
   * type — this class observes cells and native lists, nothing else a
   * `rawbox:` key could be.
   */
  private async inspectKey(
    redisKey: string,
    key: string,
  ): Promise<Result<BoxInspection | undefined, string>> {
    let redisType: string;

    try {
      redisType = await this.client.sendCommand<string>(['TYPE', redisKey]);
    } catch (e: unknown) {
      return err(`Redis TYPE failed for key '${key}': ${errorMessage(e)}`);
    }

    if (redisType === 'none') {
      return ok(undefined);
    }

    if (redisType === 'string') {
      let raw: Buffer | null;

      try {
        raw = await this.client.sendCommand<Buffer | null>(
          ['GET', redisKey],
          BLOB_TYPE_MAPPING,
        );
      } catch (e: unknown) {
        return err(`Redis GET failed for key '${key}': ${errorMessage(e)}`);
      }

      if (raw === null) {
        // Vanished between `TYPE` and `GET` — same torn-view case as `TYPE`
        // reporting `none` above, just observed one command later.
        return ok(undefined);
      }

      return ok({
        key,
        strategy: 'redis-kv',
        entryCount: 1,
        valueSizeBytes: raw.byteLength,
        valueSizeMaxBytes: raw.byteLength,
      });
    }

    if (redisType === 'list') {
      let elementList: Buffer[];

      try {
        elementList = await this.client.sendCommand<Buffer[]>(
          ['LRANGE', redisKey, '0', '-1'],
          BLOB_TYPE_MAPPING,
        );
      } catch (e: unknown) {
        return err(`Redis LRANGE failed for key '${key}': ${errorMessage(e)}`);
      }

      let valueSizeBytes = 0;
      let valueSizeMaxBytes = 0;
      for (const element of elementList) {
        valueSizeBytes += element.byteLength;
        valueSizeMaxBytes = Math.max(valueSizeMaxBytes, element.byteLength);
      }

      return ok({
        key,
        strategy: 'redis-fifo',
        entryCount: elementList.length,
        valueSizeBytes,
        valueSizeMaxBytes,
        queueDepth: elementList.length,
      });
    }

    return err(
      `Key '${key}' has Redis type '${redisType}', which no strategy this class observes ` +
        `produces — rawbox writes only 'string' (redis-kv) and 'list' (redis-fifo) keys under ` +
        `its own namespace, so a key of any other type was written by something else.`,
    );
  }

  /** Guards a location against a workspace mismatch and an unrouted strategy — shared by `peek`/`peekAll`/`depth`. */
  private checkLocation(
    boxLocation: BoxLocation,
    allowedNameList: readonly string[],
  ): Result<void, string> {
    if (this.closed) {
      return err(`Observer for workspace '${this.workspace}' is closed`);
    }

    if (boxLocation.workspace !== this.workspace) {
      return err(
        `Location addresses workspace '${boxLocation.workspace}' but this observer is open on '${this.workspace}'`,
      );
    }

    if (!allowedNameList.includes(boxLocation.strategy.name)) {
      return err(unsupportedStrategyError(boxLocation.strategy.name));
    }

    return ok(undefined);
  }

  /**
   * The value a `get` would return, without consuming it.
   *
   * `redis-kv`: a plain `GET`. `redis-fifo`: `LINDEX 0` — the head of the
   * list, i.e. the oldest element and the one a native `LPOP` would take
   * (`strategy/descriptor.ts`'s `redis-fifo` row: the store this observes
   * pushes with `RPUSH` and would pop with `LPOP`, so index 0 is the front of
   * the queue). Neither command removes anything.
   */
  public async peek(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    const checkResult = this.checkLocation(boxLocation, ['redis-kv', 'redis-fifo']);
    if (checkResult.isErr()) {
      return err(checkResult.error);
    }

    const strategy = boxLocation.strategy;
    const redisKey = redisKeyFor(boxLocation);

    if (strategy.name === 'redis-kv') {
      let raw: Buffer | null;
      try {
        raw = await this.client.sendCommand<Buffer | null>(
          ['GET', redisKey],
          BLOB_TYPE_MAPPING,
        );
      } catch (e: unknown) {
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
        return err(descriptorFor(strategy).emptyReadMessage);
      }
      return decodeValue(raw);
    }

    let raw: Buffer | null;
    try {
      raw = await this.client.sendCommand<Buffer | null>(
        ['LINDEX', redisKey, '0'],
        BLOB_TYPE_MAPPING,
      );
    } catch (e: unknown) {
      return err(
        await describeRedisCommandFailure(
          this.client,
          e,
          redisKey,
          boxLocation.key,
          'redis-fifo',
          'LINDEX',
        ),
      );
    }
    if (raw === null) {
      return err(descriptorFor(strategy).emptyReadMessage);
    }
    return decodeValue(raw);
  }

  /**
   * Every queued element, oldest first. `redis-kv`: the one-element list
   * `[value]`, matching `peekAllStatic`'s treatment of `lmdb-kv`. `redis-fifo`:
   * `LRANGE 0 -1`, which is already head-to-tail — oldest to newest — with no
   * ring wrap to reconstruct (`strategy/descriptor.ts`'s `redis-fifo` row).
   */
  public async peekAll(boxLocation: BoxLocation): Promise<Result<unknown[], string>> {
    const checkResult = this.checkLocation(boxLocation, ['redis-kv', 'redis-fifo']);
    if (checkResult.isErr()) {
      return err(checkResult.error);
    }

    const strategy = boxLocation.strategy;
    const redisKey = redisKeyFor(boxLocation);

    if (strategy.name === 'redis-kv') {
      let raw: Buffer | null;
      try {
        raw = await this.client.sendCommand<Buffer | null>(
          ['GET', redisKey],
          BLOB_TYPE_MAPPING,
        );
      } catch (e: unknown) {
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
        return err(descriptorFor(strategy).emptyReadMessage);
      }
      const decoded = decodeValue(raw);
      return decoded.isOk() ? ok([decoded.value]) : err(decoded.error);
    }

    let elementList: Buffer[];
    try {
      elementList = await this.client.sendCommand<Buffer[]>(
        ['LRANGE', redisKey, '0', '-1'],
        BLOB_TYPE_MAPPING,
      );
    } catch (e: unknown) {
      return err(
        await describeRedisCommandFailure(
          this.client,
          e,
          redisKey,
          boxLocation.key,
          'redis-fifo',
          'LRANGE',
        ),
      );
    }

    if (elementList.length === 0) {
      return err(descriptorFor(strategy).emptyReadMessage);
    }

    const decodedList: unknown[] = [];
    for (const element of elementList) {
      const decoded = decodeValue(element);
      if (decoded.isErr()) {
        return err(decoded.error);
      }
      decodedList.push(decoded.value);
    }

    return ok(decodedList);
  }

  /**
   * `{used, capacity}` for a `redis-fifo` box. `used` is `LLEN`, exactly —
   * no cursor arithmetic, because a Redis list's length already is its
   * depth. `capacity` is `seedCapacityOf(strategy)`, **not** `queueSizeMax -
   * 1` — see the class doc comment's "Capacity" section for why a Redis list
   * reserves nothing and what would go wrong with the LMDB subtraction here.
   */
  public async depth(boxLocation: BoxLocation): Promise<Result<BoxQueueDepth, string>> {
    const checkResult = this.checkLocation(boxLocation, ['redis-fifo']);
    if (checkResult.isErr()) {
      return err(checkResult.error);
    }

    const strategy = boxLocation.strategy;
    const redisKey = redisKeyFor(boxLocation);

    let used: number;
    try {
      used = await this.client.sendCommand<number>(['LLEN', redisKey]);
    } catch (e: unknown) {
      return err(
        await describeRedisCommandFailure(
          this.client,
          e,
          redisKey,
          boxLocation.key,
          'redis-fifo',
          'LLEN',
        ),
      );
    }

    const capacity = seedCapacityOf(strategy);

    if (capacity === undefined) {
      // Unreachable while `redis-fifo` is the only `hasDepth` strategy this
      // class routes — its descriptor always declares `seedCapacity`
      // (`strategy/descriptor.ts`). Named rather than silently defaulted, so
      // a future queue strategy with no seed cap surfaces here instead of
      // reporting a fabricated number.
      return err(
        `Strategy 'redis-fifo' declares no seed capacity to report depth against for key ` +
          `'${boxLocation.key}' — this is a gap in the strategy registry, not in the data.`,
      );
    }

    return ok({ used, capacity });
  }

  /**
   * Marks this observer closed; further calls refuse rather than reach the
   * network. Idempotent, and never throws — the same contract as
   * `BoxObserverLmdb.closeSync`.
   *
   * **Deliberately does not `quit()` the underlying client.** Unlike
   * `BoxObserverLmdb`, which owns its LMDB environment exclusively, this
   * class's `client` comes from a `RedisClientCache` that may be shared with
   * other observers or a `BoxStoreRedis` pointed at the same connection
   * string (`box-store-redis.ts`'s doc comment on why the cache exists).
   * Closing the shared client out from under a sibling that is still using
   * it would be exactly the kind of surprising cross-caller effect that cache
   * is built to prevent. Closing the connection itself is the cache owner's
   * job — `RedisClientCache.close`/`closeAll`, called once by whoever created
   * the cache.
   */
  public async close(): Promise<void> {
    this.closed = true;
  }
}
