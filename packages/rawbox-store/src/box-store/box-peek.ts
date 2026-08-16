import type { Database } from 'lmdb';
import { ok, err, type Result } from 'neverthrow';

import { type BoxLocation, type BoxStrategy } from '../box.js';
import { measureValueSize } from '../box-size.js';
import { descriptorFor, STRATEGY_NAME_LIST } from '../strategy/descriptor.js';
import {
  fifoDataKey,
  fifoHeadKey,
  fifoTailKey,
  parseDerivedFifoKey,
  ringCapacity,
  ringIndexList,
  ringUsed,
} from './fifo-ring.js';

// This module reads the descriptor (`emptyReadMessage`, `hasDepth`) and the
// descriptor reads the FIFO ring's names and arithmetic — so those two halves
// live in `fifo-ring.ts`, which imports neither. The graph stays one-way:
// `descriptor -> fifo-ring` and `box-peek -> {descriptor, fifo-ring}`, the
// same direction `descriptor -> box-size` runs in for the budget — which is why
// `budgetForKey` had to move to `strategy/budget.ts` to consult the descriptor
// at all. Everything `fifo-ring.ts` defines is re-exported
// below, so importers of this module saw no change.

// ---------------------------------------------------------------------------
// The observation path: reads that are not dequeues
// ---------------------------------------------------------------------------

/**
 * **`getSync` on an `lmdb-fifo` box is a *consumer* API. Everything in this
 * module is the *observer* API.**
 *
 * `BoxStoreLmdbFifo.getStatic` reads the entry at `tail`, **deletes it**, and
 * advances the tail cursor — correct for the workflow that owns the queue,
 * catastrophic for anything looking on. A `store get` wired to it would
 * silently eat a running system's data — the one place in observability where
 * a bug is dangerous rather than merely wrong (`@rawbox/runner`'s
 * OBSERVABILITY.md, "Peek is not get").
 *
 * Every function here reads and only reads. Nothing in this file calls `put`,
 * `remove`, `putSync`, `removeSync`, `drop` or `transactionSync`, and the
 * FIFO readers take {@link BoxReadDbi} — a `Pick` of `Database` carrying `get`
 * and `getRange` and nothing else — so a write is not merely absent, it does
 * not type-check. (`Database` itself is accepted only by
 * {@link inspectStatic}, which has to reach the live encoder to measure
 * values.) The runtime half of the same guarantee is
 * `BoxObserverLmdb`, whose environment is opened `readOnly: true`: lmdb-js
 * does not even install the write methods on such a store — `putSync`,
 * `transactionSync`, `remove` and `drop` are `undefined` (`lmdb/open.js:541`,
 * `if (!options.readOnly) addWriteMethods(...)`).
 *
 * ## Consistency of a multi-`get` read
 *
 * A FIFO peek reads three entries — `head`, `tail`, and the data slot at
 * `tail` — and they must come from one snapshot or a concurrent dequeue could
 * be observed half-applied. They do, and no explicit transaction is needed to
 * arrange it: lmdb-js keeps **one shared read transaction per environment**,
 * created lazily on the first read of an event-loop turn and reset on a
 * `setTimeout(…, 0)` scheduled at the same moment (`lmdb/read.js:1027-1059`).
 * Every subsequent read in that turn sees `readTxnRenewed` still truthy and
 * reuses the same `readTxn` (`lmdb/read.js:62, 86, 140, 384, 577`). Because
 * every function here is **synchronous**, no macrotask boundary can fall
 * between its reads, so all of them share one MVCC snapshot by construction.
 */

/**
 * The read surface these functions need. Deliberately not `Database`: a
 * `Pick` of the two read methods makes a write inside this module a
 * compile error rather than a code-review question.
 */
export type BoxReadDbi = Pick<Database<unknown, string>, 'get' | 'getRange'>;

/** `{used, capacity}` for one `lmdb-fifo` box. */
export interface BoxQueueDepth {
  /** Entries currently queued: `(head - tail) mod queueSizeMax`. */
  readonly used: number;
  /**
   * Entries the ring can hold, which is `queueSizeMax - 1` and not
   * `queueSizeMax`: `putStatic` refuses when `(head + 1) % queueSizeMax ===
   * tail`, keeping one slot free so `head === tail` can mean *empty* rather
   * than *full*. A `queueSizeMax` of 1024 therefore has a capacity of 1023.
   */
  readonly capacity: number;
}

/** How a logical key's entries are laid out in the workflow database. */
export interface BoxFifoInspection {
  /** The `fifo:<key>:head` cursor, or 0 when the entry is absent. */
  readonly head: number;
  /** The `fifo:<key>:tail` cursor, or 0 when the entry is absent. */
  readonly tail: number;
  /**
   * Entries actually present, counted from the `fifo:<key>:data:<n>` keys
   * rather than derived from the cursors.
   *
   * This is the depth figure to trust. `get` removes the data key it
   * dequeues, so the count of surviving data entries *is* the depth — and
   * unlike `(head - tail) mod queueSizeMax` it needs no `queueSizeMax`, which
   * lives in the workflow document and is not recorded in LMDB. Enumeration
   * has no document in hand; {@link depthStatic} does, and reports both a
   * `used` and a `capacity` from it.
   */
  readonly depth: number;
  /**
   * Highest ring index seen among the data entries, or `-1` when the queue is
   * empty. Ring indices run `0 … queueSizeMax - 1`, so this is a witness that
   * `queueSizeMax > ringIndexMax` — the only bound on the declared size that
   * the stored bytes can supply.
   */
  readonly ringIndexMax: number;
}

/** One logical key as enumeration sees it. */
export interface BoxInspection {
  /** The key as its author wrote it — never a derived `fifo:…` key. */
  readonly key: string;
  /** Inferred from the layout, not from any declaration. */
  readonly strategy: BoxStrategy['name'];
  /**
   * Physical LMDB entries backing this logical key: 1 for `lmdb-kv`, and for
   * `lmdb-fifo` the head and tail cursors plus one per queued element.
   */
  readonly entryCount: number;
  /**
   * **Uncompressed** bytes of the logical value — for a FIFO, summed over its
   * elements. Measured through {@link measureValueSize} with the database's
   * own encoder, so this is the same quantity `checkValueSize` compares
   * against `valueSizeMax`, and never the on-disk size (`compression: true`
   * makes those differ; disk sizing is `recommendedVolumeBytesFor`'s job).
   */
  readonly valueSizeBytes: number;
  /**
   * Largest single value, which is the quantity `valueSizeMax` actually
   * governs — `valueSizeMax` bounds one element, not a queue's total. Equal
   * to {@link valueSizeBytes} for `lmdb-kv`, and 0 for an empty FIFO.
   */
  readonly valueSizeMaxBytes: number;
  /** Present only when `strategy === 'lmdb-fifo'`. */
  readonly fifo?: BoxFifoInspection;
  /**
   * Entries currently queued, independent of backend — present whenever
   * `descriptorFor(strategy).hasDepth` is true (`strategy/descriptor.ts`),
   * `lmdb-fifo` and `redis-fifo` alike.
   *
   * For `lmdb-fifo` this always equals `fifo.depth`; it is populated here too
   * so a caller that wants "how many are queued" without caring which backend
   * answered has one field to read regardless. `fifo` itself is never
   * populated for `redis-fifo` — `BoxFifoInspection.head`/`tail`/
   * `ringIndexMax` name LMDB's ring cursors specifically
   * (`box-store/fifo-ring.ts`), and a Redis list has no such cursors to
   * report; fabricating values for them would claim a mechanism that is not
   * there (`box-observer-redis.ts`'s class doc comment).
   */
  readonly queueDepth?: number;
}

// ---------------------------------------------------------------------------
// Derived key names and ring arithmetic — re-exported, not defined here
//
// They moved to `fifo-ring.ts` so `strategy/descriptor.ts` can read
// `fifoDataKey` and `ringCapacity` without importing this module, which reads
// the descriptor back for `emptyReadMessage`. See that file's header for why
// the cycle was removed rather than documented.
//
// Re-exported here so every existing importer — `box-store-lmdb.ts`, the CLI's
// `fifo-reconstruct.ts`, and the package's public surface via `index.ts` — is
// unchanged by the move.
// ---------------------------------------------------------------------------

export {
  fifoDataKey,
  fifoHeadKey,
  fifoTailKey,
  parseDerivedFifoKey,
  ringCapacity,
  ringIndexList,
  ringUsed,
} from './fifo-ring.js';
export type { DerivedFifoKey } from './fifo-ring.js';

// ---------------------------------------------------------------------------
// Reading cursors
// ---------------------------------------------------------------------------

/**
 * A cursor entry, or 0 when absent.
 *
 * Absent is normal and not an error: `putStatic` writes `head` on the first
 * enqueue and `tail` only on the first dequeue, so a queue that has been
 * filled but never drained legitimately has no `tail` entry. The writer
 * spells this `(dbi.get(k) as number) || 0`; this is stricter, because a
 * cursor that is present but not a non-negative integer is corruption and
 * `|| 0` would silently rebase the whole ring on it.
 */
function readCursor(
  dbi: BoxReadDbi,
  dbiKey: string,
  cursorName: string,
  key: string,
): Result<number, string> {
  const raw = dbi.get(dbiKey);

  if (raw === undefined) {
    return ok(0);
  }

  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return err(
      `FIFO '${key}' has a corrupt ${cursorName} cursor: expected a non-negative integer, found ${typeof raw} ${String(raw)}`,
    );
  }

  return ok(raw);
}

interface FifoCursorPair {
  readonly head: number;
  readonly tail: number;
}

/**
 * Both cursors, validated against the declared ring size.
 *
 * The out-of-range check is the interesting one. `queueSizeMax` lives in the
 * workflow document, not in LMDB, so shrinking it in a document leaves
 * entries on disk whose indices no longer exist in the ring the caller is
 * describing. Every piece of arithmetic below would then be quietly wrong.
 * A named `Err` beats a plausible wrong answer.
 */
function readFifoCursors(
  dbi: BoxReadDbi,
  key: string,
  queueSizeMax: number,
): Result<FifoCursorPair, string> {
  if (!Number.isInteger(queueSizeMax) || queueSizeMax < 2) {
    return err(
      `FIFO '${key}' was given an invalid queueSizeMax: ${String(queueSizeMax)} (must be an integer >= 2)`,
    );
  }

  const headResult = readCursor(dbi, fifoHeadKey(key), 'head', key);

  if (headResult.isErr()) {
    return err(headResult.error);
  }

  const tailResult = readCursor(dbi, fifoTailKey(key), 'tail', key);

  if (tailResult.isErr()) {
    return err(tailResult.error);
  }

  const head = headResult.value;
  const tail = tailResult.value;

  if (head >= queueSizeMax || tail >= queueSizeMax) {
    return err(
      `FIFO '${key}' has cursors outside its ring (head ${head}, tail ${tail}, queueSizeMax ${queueSizeMax}): queueSizeMax may have been reduced since these entries were written`,
    );
  }

  return ok({ head, tail });
}

// ---------------------------------------------------------------------------
// The peek surface
// ---------------------------------------------------------------------------

/**
 * The value a `get` **would** return, without returning it.
 *
 * - `lmdb-kv`: a plain `get`, identical to `BoxStoreLmdbKv.getStatic`.
 * - `lmdb-fifo`: reads `fifo:<key>:data:<tail>` directly. `head` and `tail`
 *   are read and **not written**; the data entry is read and **not removed**.
 *   The queue is byte-identical afterwards, and a subsequent real `get`
 *   dequeues exactly the element this returned.
 *
 * Error strings match the consumer path — each is `descriptorFor(strategy)
 * .emptyReadMessage` (`'Value not found'` for `lmdb-kv`, `'Queue empty'` for
 * `lmdb-fifo`; see `strategy/descriptor.ts`) — so a caller can swap `getSync`
 * for `peekSync` without re-reading its error handling.
 */
export function peekStatic(
  dbi: BoxReadDbi,
  boxLocation: BoxLocation,
): Result<unknown, string> {
  const key = boxLocation.key;
  const strategy = boxLocation.strategy;

  if (strategy.name === 'lmdb-kv') {
    const value = dbi.get(key);

    return value !== undefined
      ? ok(value)
      : err(descriptorFor(strategy).emptyReadMessage);
  }

  if (strategy.name === 'lmdb-fifo') {
    const cursorsResult = readFifoCursors(dbi, key, strategy.queueSizeMax);

    if (cursorsResult.isErr()) {
      return err(cursorsResult.error);
    }

    const { head, tail } = cursorsResult.value;

    if (head === tail) {
      return err(descriptorFor(strategy).emptyReadMessage);
    }

    const content = dbi.get(fifoDataKey(key, tail));

    if (content === undefined) {
      return err(
        `FIFO '${key}' is missing the entry at its tail (ring index ${tail})`,
      );
    }

    return ok(content);
  }

  return err(
    `Invalid strategyName '${String((strategy as { name: unknown }).name)}'`,
  );
}

/**
 * Every queued element, **oldest first**, across the ring wrap — the order a
 * consumer would dequeue them in. Non-destructive by the same argument as
 * {@link peekStatic}: cursors are read, elements are read, nothing is
 * written.
 *
 * On `lmdb-kv` this is the one-element list `[value]`, or `Err('Value not
 * found')`. A caller enumerating a mixed workflow can therefore treat every
 * key uniformly instead of branching on strategy.
 *
 * A hole in the ring — a data key missing inside `[tail, head)` — is an
 * `Err` naming the index, not a `null` in the middle of the list. There is no
 * legitimate way for one to appear, so returning a plausible-looking list is
 * the wrong answer.
 */
export function peekAllStatic(
  dbi: BoxReadDbi,
  boxLocation: BoxLocation,
): Result<unknown[], string> {
  const key = boxLocation.key;
  const strategy = boxLocation.strategy;

  if (strategy.name === 'lmdb-kv') {
    const value = dbi.get(key);

    return value !== undefined
      ? ok([value])
      : err(descriptorFor(strategy).emptyReadMessage);
  }

  if (strategy.name === 'lmdb-fifo') {
    const cursorsResult = readFifoCursors(dbi, key, strategy.queueSizeMax);

    if (cursorsResult.isErr()) {
      return err(cursorsResult.error);
    }

    const { head, tail } = cursorsResult.value;
    const indexList = ringIndexList(head, tail, strategy.queueSizeMax);
    const contentList: unknown[] = [];

    for (const index of indexList) {
      const content = dbi.get(fifoDataKey(key, index));

      if (content === undefined) {
        return err(
          `FIFO '${key}' is missing the entry at ring index ${index} (head ${head}, tail ${tail})`,
        );
      }

      contentList.push(content);
    }

    return ok(contentList);
  }

  return err(
    `Invalid strategyName '${String((strategy as { name: unknown }).name)}'`,
  );
}

/**
 * `{used, capacity}` for a box whose strategy declares
 * `StrategyDescriptor.hasDepth` (`strategy/descriptor.ts`) — `lmdb-fifo`
 * today, and whichever other queue-shaped strategy joins it.
 *
 * `lmdb-kv` is an `Err`: a cell has no depth, and answering `{used: 1}` would
 * invite a caller to treat the two strategies as one.
 */
export function depthStatic(
  dbi: BoxReadDbi,
  boxLocation: BoxLocation,
): Result<BoxQueueDepth, string> {
  const key = boxLocation.key;
  const strategy = boxLocation.strategy;

  // Checked before the capability read below, not folded into it:
  // `descriptorFor` is total over `BoxStrategy`, but a `BoxLocation` built
  // from an unverified caller (as in the 'names an unsupported strategy'
  // test) can carry a `name` with no row in `STRATEGY_DESCRIPTOR_TABLE` at
  // all, and indexing the table with one returns `undefined` — reading
  // `.hasDepth` off that would throw, and the throw would be caught three
  // layers up by `BoxStoreLmdb.withDbi` as an opaque "Observation failed",
  // losing the strategy name this function exists to report.
  if (!STRATEGY_NAME_LIST.includes(strategy.name)) {
    return err(`Invalid strategyName '${String(strategy.name)}'`);
  }

  // Capability-based, not `strategy.name !== 'lmdb-fifo'`: this asks the
  // question `StrategyDescriptor.hasDepth` documents — does `{used,
  // capacity}` mean anything for this strategy — rather than restating which
  // one strategy currently answers yes. `lmdb-kv` fails this today for the
  // same reason it always did; a future non-fifo cell-shaped strategy would
  // fail it too, without this guard needing to name it.
  if (!descriptorFor(strategy).hasDepth) {
    return err(
      `Depth is not a property of strategy '${strategy.name}'; key '${key}' has no depth to report`,
    );
  }

  // `hasDepth` is true only for `lmdb-fifo` in today's descriptor table, but
  // that is a fact about the table, not something a boolean field lets
  // TypeScript narrow through. Everything below is `lmdb-fifo`'s own ring
  // arithmetic — `queueSizeMax`, head/tail cursors — not a generic
  // consequence of `hasDepth`, so it is narrowed explicitly here rather than
  // folded into the capability guard above: a second `hasDepth: true`
  // strategy must bring its own ring model and its own branch rather than
  // silently fall into this one.
  if (strategy.name !== 'lmdb-fifo') {
    return err(
      `Strategy '${strategy.name}' declares depth but 'depthStatic' has no ring model for it yet`,
    );
  }

  const queueSizeMax = strategy.queueSizeMax;
  const cursorsResult = readFifoCursors(dbi, key, queueSizeMax);

  if (cursorsResult.isErr()) {
    return err(cursorsResult.error);
  }

  const { head, tail } = cursorsResult.value;

  return ok({
    used: ringUsed(head, tail, queueSizeMax),
    capacity: ringCapacity(queueSizeMax),
  });
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

interface FifoAccumulator {
  head: number;
  tail: number;
  entryCount: number;
  depth: number;
  ringIndexMax: number;
  valueSizeBytes: number;
  valueSizeMaxBytes: number;
}

/** Mirrors the writer's `|| 0` coercion, for a cursor read during enumeration. */
function coerceCursor(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Every **logical** key in one workflow database, sorted, with its strategy
 * inferred from the layout.
 *
 * The `fifo:<key>:head|tail|data:<n>` family is folded into a single record
 * per logical key; those physical keys are never returned as user keys. A key
 * that is not derived is reported as `lmdb-kv`.
 *
 * **A key may appear twice, once per strategy.** Nothing removes the old
 * entries when a document changes a key from `lmdb-kv` to `lmdb-fifo`, so
 * `k` and `fifo:k:head` can coexist. Emitting one record for each is the only
 * honest report; collapsing them would hide bytes that are really there.
 *
 * Sizes are the uncompressed, encoder-measured figures described on
 * {@link BoxInspection.valueSizeBytes}. Measuring means re-packing the value
 * lmdb-js just unpacked; for msgpack-round-trippable data — everything the
 * store accepts — that reproduces the stored encoding exactly.
 *
 * Takes a full `Database` rather than {@link BoxReadDbi} for one reason: it
 * has to hand the live encoder to `measureValueSize` so measured bytes and
 * written bytes stay one computation. It still writes nothing.
 */
export function inspectStatic(
  dbi: Database<unknown, string>,
): Result<BoxInspection[], string> {
  const kvList: BoxInspection[] = [];
  const fifoMap = new Map<string, FifoAccumulator>();

  try {
    for (const entry of dbi.getRange()) {
      const dbiKey = entry.key;

      if (typeof dbiKey !== 'string') {
        continue;
      }

      const derived = parseDerivedFifoKey(dbiKey);

      if (derived === undefined) {
        const sizeResult = measureValueSize(entry.value, dbi);

        if (sizeResult.isErr()) {
          return err(
            `Failed to measure the value of key '${dbiKey}': ${sizeResult.error}`,
          );
        }

        kvList.push({
          key: dbiKey,
          strategy: 'lmdb-kv',
          entryCount: 1,
          valueSizeBytes: sizeResult.value,
          valueSizeMaxBytes: sizeResult.value,
        });

        continue;
      }

      let accumulator = fifoMap.get(derived.key);

      if (accumulator === undefined) {
        accumulator = {
          head: 0,
          tail: 0,
          entryCount: 0,
          depth: 0,
          ringIndexMax: -1,
          valueSizeBytes: 0,
          valueSizeMaxBytes: 0,
        };
        fifoMap.set(derived.key, accumulator);
      }

      accumulator.entryCount += 1;

      if (derived.kind === 'data') {
        const sizeResult = measureValueSize(entry.value, dbi);

        if (sizeResult.isErr()) {
          return err(
            `Failed to measure element ${derived.index} of FIFO '${derived.key}': ${sizeResult.error}`,
          );
        }

        accumulator.depth += 1;
        accumulator.valueSizeBytes += sizeResult.value;
        accumulator.valueSizeMaxBytes = Math.max(
          accumulator.valueSizeMaxBytes,
          sizeResult.value,
        );
        accumulator.ringIndexMax = Math.max(
          accumulator.ringIndexMax,
          derived.index,
        );
      } else if (derived.kind === 'head') {
        accumulator.head = coerceCursor(entry.value);
      } else {
        accumulator.tail = coerceCursor(entry.value);
      }
    }
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);

    return err(`Failed to scan the workflow database: ${error}`);
  }

  const inspectionList: BoxInspection[] = [...kvList];

  for (const [key, accumulator] of fifoMap) {
    inspectionList.push({
      key,
      strategy: 'lmdb-fifo',
      entryCount: accumulator.entryCount,
      valueSizeBytes: accumulator.valueSizeBytes,
      valueSizeMaxBytes: accumulator.valueSizeMaxBytes,
      fifo: {
        head: accumulator.head,
        tail: accumulator.tail,
        depth: accumulator.depth,
        ringIndexMax: accumulator.ringIndexMax,
      },
      queueDepth: accumulator.depth,
    });
  }

  inspectionList.sort((left, right) =>
    left.key === right.key
      ? left.strategy.localeCompare(right.strategy)
      : left.key.localeCompare(right.key),
  );

  return ok(inspectionList);
}
