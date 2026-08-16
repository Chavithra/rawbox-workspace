import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { BoxStoreLmdb } from '../src/box-store/box-store-lmdb.js';
import {
  depthStatic,
  inspectStatic,
  fifoDataKey,
  fifoHeadKey,
  fifoTailKey,
  parseDerivedFifoKey,
  peekAllStatic,
  peekStatic,
  ringCapacity,
  ringIndexList,
  ringUsed,
  type BoxInspection,
  type BoxReadDbi,
} from '../src/box-store/box-peek.js';
import { measureValueSize } from '../src/box-size.js';
import { type Box, type BoxLocation, type BoxStrategy } from '../src/box.js';

// ---------------------------------------------------------------------------
// The premise of this file
//
// `getSync` on an `lmdb-fifo` box is a destructive dequeue. Peek must be the
// opposite, and "must" here is `@rawbox/runner`'s OBSERVABILITY.md, "Peek is
// not get" — every observation surface must leave the store byte-identical,
// and it is the one place a bug is dangerous rather than merely wrong: an
// inspection
// path that accidentally dequeues corrupts a running trading system's state,
// silently, with no error anywhere.
//
// So these tests are written against the implementation rather than with it.
// Where a normal test would assert "peek returned 'a'", these assert that the
// *entire physical contents* of the database — every key, every raw value
// byte, both cursors — are identical before and after, and that a real `get`
// afterwards still dequeues what peek claimed. A peek that mutated but
// returned the right answer would pass the former assertion and fail these.
// ---------------------------------------------------------------------------

const WORKSPACE = 'peek-workspace';
const WORKFLOW = 'peek-workflow';

const KV: BoxStrategy = { name: 'lmdb-kv', valueSizeMax: 4096 };

function fifoStrategy(queueSizeMax: number): BoxStrategy {
  return { name: 'lmdb-fifo', queueSizeMax, valueSizeMax: 4096 };
}

function kvLocation(key: string): BoxLocation {
  return { workspace: WORKSPACE, workflow: WORKFLOW, key, strategy: KV };
}

function fifoLocation(key: string, queueSizeMax: number): BoxLocation {
  return {
    workspace: WORKSPACE,
    workflow: WORKFLOW,
    key,
    strategy: fifoStrategy(queueSizeMax),
  };
}

function boxOf(location: BoxLocation, content: unknown): Box<unknown> {
  return { content, location };
}

interface PhysicalEntry {
  readonly key: string;
  /** Raw stored value bytes, hex — the byte-identity the assertions turn on. */
  readonly bytes: string;
}

/**
 * The complete physical contents of a workflow database: every key that
 * actually exists, with its stored bytes.
 *
 * `getBinary` rather than `get`: comparing decoded JavaScript values would let
 * a re-encoding slip past, and "byte-identical" is the claim being tested.
 */
function physicalSnapshot(
  store: BoxStoreLmdb,
  workflow: string,
): PhysicalEntry[] {
  const dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
  const entryList: PhysicalEntry[] = [];

  for (const key of dbi.getKeys()) {
    const bytes = dbi.getBinary(key);

    entryList.push({
      key: String(key),
      bytes: bytes === undefined ? '<absent>' : bytes.toString('hex'),
    });
  }

  return entryList;
}

let dataDirUrl: URL;
let store: BoxStoreLmdb;

beforeAll(async () => {
  dataDirUrl = new URL(
    `../data/test-peek-${Date.now()}-${Math.floor(Math.random() * 1e6)}/`,
    import.meta.url,
  );
  await fs.mkdir(fileURLToPath(dataDirUrl), { recursive: true });
  store = BoxStoreLmdb.create(WORKSPACE, dataDirUrl);
});

afterAll(async () => {
  try {
    void store.dbiCache.env.close();
  } catch {
    void 0;
  }

  try {
    await fs.rm(fileURLToPath(dataDirUrl), { recursive: true, force: true });
  } catch {
    void 0;
  }
});

// ---------------------------------------------------------------------------

describe('derived FIFO key grammar', () => {
  it('spells derived keys exactly as the writer always has', () => {
    // A regression guard with teeth: these three literals are the contract
    // between `BoxStoreLmdbFifo` and every observer. Changing one without the
    // other would make peek read a key nobody writes — and report "Queue
    // empty" for a full queue, with no error.
    expect(fifoHeadKey('tick_queue')).toBe('fifo:tick_queue:head');
    expect(fifoTailKey('tick_queue')).toBe('fifo:tick_queue:tail');
    expect(fifoDataKey('tick_queue', 17)).toBe('fifo:tick_queue:data:17');
  });

  it('classifies the three derived shapes', () => {
    expect(parseDerivedFifoKey('fifo:q:head')).toEqual({
      kind: 'head',
      key: 'q',
    });
    expect(parseDerivedFifoKey('fifo:q:tail')).toEqual({
      kind: 'tail',
      key: 'q',
    });
    expect(parseDerivedFifoKey('fifo:q:data:0')).toEqual({
      kind: 'data',
      key: 'q',
      index: 0,
    });
    expect(parseDerivedFifoKey('fifo:a.b-c_d:data:1023')).toEqual({
      kind: 'data',
      key: 'a.b-c_d',
      index: 1023,
    });
  });

  it('does not mistake a user key for a derived one', () => {
    for (const key of [
      'plain',
      'fifo',
      'fifo:',
      'fifo:q',
      'fifo:q:',
      'fifo:q:heads',
      'fifo:q:data',
      'fifo:q:data:',
      'fifo:q:data:007', // not a canonical `${n}`; the writer cannot emit it
      'fifo:q:data:-1',
      'fifo:q:data:1.5',
      'fifo:q:data:1:2',
      'fifo:q:x:data:1', // ':' is outside the author key charset
      'xfifo:q:head',
      'fifo:q:head ',
    ]) {
      expect(parseDerivedFifoKey(key), key).toBeUndefined();
    }
  });
});

describe('ring arithmetic', () => {
  it('keeps one slot free, per the put-refusal rule', () => {
    expect(ringCapacity(2)).toBe(1);
    expect(ringCapacity(1024)).toBe(1023);
  });

  it('never reports a negative depth for a wrapped ring', () => {
    expect(ringUsed(3, 0, 4)).toBe(3);
    expect(ringUsed(0, 0, 4)).toBe(0);
    expect(ringUsed(0, 1, 4)).toBe(3); // head behind tail: wrapped
    expect(ringUsed(1, 3, 4)).toBe(2);
  });

  it('lists indices oldest-first across the wrap', () => {
    expect(ringIndexList(3, 0, 4)).toEqual([0, 1, 2]);
    expect(ringIndexList(0, 1, 4)).toEqual([1, 2, 3]);
    expect(ringIndexList(2, 3, 4)).toEqual([3, 0, 1]);
    expect(ringIndexList(0, 0, 4)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('peekSync on lmdb-kv', () => {
  it('returns the stored value and leaves the database untouched', () => {
    const location = kvLocation('kv_stable');
    expect(store.putSync(boxOf(location, { a: 1, b: 'two' })).isOk()).toBe(true);

    const before = physicalSnapshot(store, WORKFLOW);

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const peeked = store.peekSync(location);
      expect(peeked.isOk()).toBe(true);
      expect(peeked._unsafeUnwrap()).toEqual({ a: 1, b: 'two' });
    }

    expect(physicalSnapshot(store, WORKFLOW)).toEqual(before);
    expect(store.getSync(location)._unsafeUnwrap()).toEqual({ a: 1, b: 'two' });
  });

  it("reports a missing key with the consumer path's own error string", () => {
    const result = store.peekSync(kvLocation('kv_absent'));
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBe('Value not found');
  });

  it('does not create a key it failed to find', () => {
    store.peekSync(kvLocation('kv_never_written'));

    const keyList = physicalSnapshot(store, WORKFLOW).map((e) => e.key);
    expect(keyList).not.toContain('kv_never_written');
  });
});

// ---------------------------------------------------------------------------

describe('peekSync / peekAllSync on lmdb-fifo — non-destructiveness', () => {
  const KEY = 'fifo_hostile';
  const QUEUE_SIZE_MAX = 8;
  const location = fifoLocation(KEY, QUEUE_SIZE_MAX);
  const elementList = [
    { seq: 1, tag: 'alpha' },
    { seq: 2, tag: 'beta' },
    { seq: 3, tag: 'gamma' },
    { seq: 4, tag: 'delta' },
    { seq: 5, tag: 'epsilon' },
  ];

  beforeAll(() => {
    for (const element of elementList) {
      expect(store.putSync(boxOf(location, element)).isOk()).toBe(true);
    }
  });

  it('survives a hundred peeks with every byte, cursor and depth unchanged', () => {
    const before = physicalSnapshot(store, WORKFLOW);
    const dbi = store.dbiCache.getOrCreateDbi(WORKFLOW)._unsafeUnwrap();
    const headBefore = dbi.get(fifoHeadKey(KEY));
    const tailBefore = dbi.get(fifoTailKey(KEY));
    const depthBefore = store.depthSync(location)._unsafeUnwrap();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const peeked = store.peekSync(location);
      expect(peeked.isOk()).toBe(true);
      expect(peeked._unsafeUnwrap()).toEqual(elementList[0]);

      const peekedAll = store.peekAllSync(location);
      expect(peekedAll.isOk()).toBe(true);
      expect(peekedAll._unsafeUnwrap()).toEqual(elementList);

      expect(store.depthSync(location)._unsafeUnwrap()).toEqual(depthBefore);
    }

    // The whole point: not "the answers stayed the same", but "the store did".
    expect(physicalSnapshot(store, WORKFLOW)).toEqual(before);
    expect(dbi.get(fifoHeadKey(KEY))).toBe(headBefore);
    expect(dbi.get(fifoTailKey(KEY))).toBe(tailBefore);
    expect(depthBefore).toEqual({ used: 5, capacity: QUEUE_SIZE_MAX - 1 });
  });

  it('reports the element a real get then dequeues, and only that one', () => {
    const peeked = store.peekSync(location)._unsafeUnwrap();
    const dequeued = store.getSync(location)._unsafeUnwrap();

    expect(dequeued).toEqual(peeked);
    expect(dequeued).toEqual(elementList[0]);

    // One dequeue moved the queue by exactly one element, no more.
    expect(store.peekSync(location)._unsafeUnwrap()).toEqual(elementList[1]);
    expect(store.peekAllSync(location)._unsafeUnwrap()).toEqual(
      elementList.slice(1),
    );
    expect(store.depthSync(location)._unsafeUnwrap()).toEqual({
      used: 4,
      capacity: QUEUE_SIZE_MAX - 1,
    });
  });

  it('drains in exactly the order peekAll predicted', () => {
    const predicted = store.peekAllSync(location)._unsafeUnwrap();
    const drained: unknown[] = [];

    for (let attempt = 0; attempt < predicted.length; attempt += 1) {
      drained.push(store.getSync(location)._unsafeUnwrap());
    }

    expect(drained).toEqual(predicted);
    expect(store.peekSync(location)._unsafeUnwrapErr()).toBe('Queue empty');
    expect(store.peekAllSync(location)._unsafeUnwrap()).toEqual([]);
    expect(store.depthSync(location)._unsafeUnwrap().used).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('peekAllSync across the ring wrap', () => {
  it('orders elements by enqueue order through several full wraps', () => {
    const QUEUE_SIZE_MAX = 4; // capacity 3 — wraps every few operations
    const location = fifoLocation('fifo_wrap', QUEUE_SIZE_MAX);
    const dbi = store.dbiCache.getOrCreateDbi(WORKFLOW)._unsafeUnwrap();

    // A model of the queue kept alongside it. Every assertion below compares
    // peekAll against this list, so an off-by-one in the wrap arithmetic
    // shows up as a wrong *order*, not merely a wrong length.
    const expected: number[] = [];
    let sequence = 0;
    let wrapsObserved = 0;
    let lastHead = 0;

    for (let step = 0; step < 40; step += 1) {
      // Two enqueues then one dequeue: the ring advances and wraps repeatedly
      // while never being empty, which is the state a naive `tail..head`
      // slice gets wrong.
      for (let index = 0; index < 2; index += 1) {
        sequence += 1;

        if (store.putSync(boxOf(location, sequence)).isOk()) {
          expected.push(sequence);
        }
      }

      if (expected.length > 0) {
        const dequeued = store.getSync(location);

        if (dequeued.isOk()) {
          expect(dequeued._unsafeUnwrap()).toBe(expected.shift());
        }
      }

      const head = dbi.get(fifoHeadKey(location.key)) as number;

      if (head < lastHead) {
        wrapsObserved += 1;
      }

      lastHead = head;

      expect(store.peekAllSync(location)._unsafeUnwrap()).toEqual(expected);
      expect(store.depthSync(location)._unsafeUnwrap()).toEqual({
        used: expected.length,
        capacity: QUEUE_SIZE_MAX - 1,
      });

      if (expected.length > 0) {
        expect(store.peekSync(location)._unsafeUnwrap()).toBe(expected[0]);
      }
    }

    // Guards the guard: if the ring never wrapped, everything above passed
    // without exercising the case the test exists for.
    expect(wrapsObserved).toBeGreaterThanOrEqual(5);
  });

  it('reads a queue whose contents straddle index 0', () => {
    const QUEUE_SIZE_MAX = 4;
    const location = fifoLocation('fifo_straddle', QUEUE_SIZE_MAX);
    const dbi = store.dbiCache.getOrCreateDbi(WORKFLOW)._unsafeUnwrap();

    // a,b,c fill indices 0,1,2 (head 3). Dequeue a and b (tail 2), then
    // enqueue d,e into indices 3 and 0 — the live window is now 2,3,0.
    for (const value of ['a', 'b', 'c']) {
      expect(store.putSync(boxOf(location, value)).isOk()).toBe(true);
    }

    expect(store.getSync(location)._unsafeUnwrap()).toBe('a');
    expect(store.getSync(location)._unsafeUnwrap()).toBe('b');
    expect(store.putSync(boxOf(location, 'd')).isOk()).toBe(true);
    expect(store.putSync(boxOf(location, 'e')).isOk()).toBe(true);

    expect(dbi.get(fifoTailKey(location.key))).toBe(2);
    expect(dbi.get(fifoHeadKey(location.key))).toBe(1);
    expect(dbi.get(fifoDataKey(location.key, 0))).toBe('e');

    // Sorted-key order would say e, c, d. Ring order says c, d, e.
    expect(store.peekAllSync(location)._unsafeUnwrap()).toEqual([
      'c',
      'd',
      'e',
    ]);
    expect(store.peekSync(location)._unsafeUnwrap()).toBe('c');
    expect(store.getSync(location)._unsafeUnwrap()).toBe('c');
  });
});

// ---------------------------------------------------------------------------

describe('depthSync capacity semantics', () => {
  it('ties capacity to the point where put actually refuses', () => {
    const QUEUE_SIZE_MAX = 5;
    const location = fifoLocation('fifo_capacity', QUEUE_SIZE_MAX);

    expect(store.depthSync(location)._unsafeUnwrap()).toEqual({
      used: 0,
      capacity: 4,
    });

    let accepted = 0;

    while (store.putSync(boxOf(location, accepted)).isOk()) {
      accepted += 1;
      expect(accepted).toBeLessThanOrEqual(QUEUE_SIZE_MAX);
    }

    const depth = store.depthSync(location)._unsafeUnwrap();

    // `capacity` is not a declaration restated: it is the number of entries
    // the queue accepted before `put` returned 'Queue is full'.
    expect(accepted).toBe(depth.capacity);
    expect(depth).toEqual({ used: 4, capacity: 4 });
    expect(store.putSync(boxOf(location, 'overflow'))._unsafeUnwrapErr()).toBe(
      "Queue is full 'lmdb-fifo'",
    );
    expect(store.peekAllSync(location)._unsafeUnwrap()).toHaveLength(4);
  });

  it('refuses to report a depth for lmdb-kv', () => {
    const result = store.depthSync(kvLocation('kv_stable'));
    expect(result.isErr()).toBe(true);
    // The guard is capability-based (`StrategyDescriptor.hasDepth`), not a
    // name check against `lmdb-fifo`, so the message names the offending
    // strategy — `lmdb-kv` — rather than the one strategy that happens to
    // have a depth today.
    expect(result._unsafeUnwrapErr()).toContain("lmdb-kv");
  });
});

// ---------------------------------------------------------------------------

describe('peek error paths', () => {
  it('names an unsupported strategy instead of throwing', () => {
    const location = {
      ...kvLocation('kv_stable'),
      strategy: { name: 'nonesuch-queue', valueSizeMax: 10 } as unknown as BoxStrategy,
    };

    expect(store.peekSync(location)._unsafeUnwrapErr()).toContain('nonesuch-queue');
    expect(store.peekAllSync(location)._unsafeUnwrapErr()).toContain(
      'nonesuch-queue',
    );
    expect(store.depthSync(location)._unsafeUnwrapErr()).toContain('nonesuch-queue');
  });

  it('refuses cursors that fall outside a shrunken ring', () => {
    const location = fifoLocation('fifo_shrunk', 8);

    for (let index = 0; index < 6; index += 1) {
      expect(store.putSync(boxOf(location, index)).isOk()).toBe(true);
    }

    // The document shrank; the entries on disk did not.
    const shrunk = fifoLocation('fifo_shrunk', 3);

    for (const result of [
      store.peekSync(shrunk),
      store.peekAllSync(shrunk),
      store.depthSync(shrunk),
    ]) {
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toContain('queueSizeMax');
    }
  });

  it('refuses a queueSizeMax that is not a ring size', () => {
    const location = fifoLocation('fifo_bad_size', 1);
    expect(store.peekSync(location)._unsafeUnwrapErr()).toContain(
      'invalid queueSizeMax',
    );
  });

  it('reports a corrupt cursor rather than rebasing the ring on it', () => {
    const KEY = 'fifo_corrupt';
    const location = fifoLocation(KEY, 8);

    for (let index = 0; index < 3; index += 1) {
      expect(store.putSync(boxOf(location, index)).isOk()).toBe(true);
    }

    // Reaching around the FIFO API to write a string over the head cursor:
    // `(dbi.get(k) as number) || 0` on the consumer path would silently read
    // this as 0 and declare the queue empty.
    const dbi = store.dbiCache.getOrCreateDbi(WORKFLOW)._unsafeUnwrap();
    dbi.putSync(fifoHeadKey(KEY), 'not-a-number');

    const result = store.peekSync(location);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('corrupt head cursor');
  });

  it('reports a hole in the ring rather than a plausible-looking list', () => {
    const KEY = 'fifo_hole';
    const location = fifoLocation(KEY, 8);
    const dbi = store.dbiCache.getOrCreateDbi(WORKFLOW)._unsafeUnwrap();

    // Cursors say two entries are queued; only one exists.
    dbi.putSync(fifoTailKey(KEY), 0);
    dbi.putSync(fifoHeadKey(KEY), 2);
    dbi.putSync(fifoDataKey(KEY, 0), 'present');

    expect(store.peekSync(location)._unsafeUnwrap()).toBe('present');

    const all = store.peekAllSync(location);
    expect(all.isErr()).toBe(true);
    expect(all._unsafeUnwrapErr()).toContain('ring index 1');
  });

  it('reports a missing tail entry rather than returning undefined', () => {
    const KEY = 'fifo_no_tail_entry';
    const location = fifoLocation(KEY, 8);
    const dbi = store.dbiCache.getOrCreateDbi(WORKFLOW)._unsafeUnwrap();

    dbi.putSync(fifoTailKey(KEY), 0);
    dbi.putSync(fifoHeadKey(KEY), 1);

    const result = store.peekSync(location);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('missing the entry at its tail');
  });
});

// ---------------------------------------------------------------------------

describe('the peek functions cannot write', () => {
  it('touches only `get` on the database handle', () => {
    // A read surface that records every property reached for, and refuses
    // anything that is not `get`. If a future edit added a `putSync`,
    // `remove` or `transactionSync` to any peek path, this throws — the
    // assertion is on the *mechanism*, not on an observable side effect that
    // a subtle bug might not produce on this particular fixture.
    const touched = new Set<string>();
    const entries = new Map<string, unknown>([
      [fifoHeadKey('q'), 2],
      [fifoTailKey('q'), 0],
      [fifoDataKey('q', 0), 'first'],
      [fifoDataKey('q', 1), 'second'],
      ['cell', { v: 1 }],
    ]);

    const recorder = new Proxy({} as Record<string, unknown>, {
      get(_target, property) {
        const name = String(property);
        touched.add(name);

        if (name === 'get') {
          return (key: string) => entries.get(key);
        }

        throw new Error(`peek reached for a non-read method: ${name}`);
      },
    }) as unknown as BoxReadDbi;

    const queue = fifoLocation('q', 8);
    expect(peekStatic(recorder, queue)._unsafeUnwrap()).toBe('first');
    expect(peekAllStatic(recorder, queue)._unsafeUnwrap()).toEqual([
      'first',
      'second',
    ]);
    expect(depthStatic(recorder, queue)._unsafeUnwrap()).toEqual({
      used: 2,
      capacity: 7,
    });
    expect(peekStatic(recorder, kvLocation('cell'))._unsafeUnwrap()).toEqual({
      v: 1,
    });

    expect([...touched]).toEqual(['get']);
  });
});

describe('an enumeration that gives up mid-scan closes its cursor', () => {
  it('returns the iterator when it abandons a range', () => {
    // The hazard in miniature. lmdb-js's range iterator holds a cursor and a
    // reference on the shared read transaction, and releases both in its
    // `return()` (`lmdb/read.js:828`, `finishCursor`). A scan abandoned
    // without that — an early `return` out of a hand-rolled `while (true)`
    // loop, say — would leave the snapshot pinned, which is the failure that
    // makes the *writers'* store grow without bound.
    //
    // `for...of` calls `return()` on abrupt completion, so the guarantee
    // holds as long as enumeration keeps using it. This asserts that it does.
    let returned = 0;

    const unpackable = Symbol('cannot be msgpacked');
    const entryList = [
      { key: 'fine', value: { ok: true } },
      { key: 'poison', value: unpackable },
      { key: 'never-reached', value: 1 },
    ];

    const range = {
      [Symbol.iterator]() {
        let index = 0;

        return {
          next() {
            return index < entryList.length
              ? { value: entryList[index++], done: false }
              : { value: undefined, done: true };
          },
          return() {
            returned += 1;
            return { value: undefined, done: true };
          },
        };
      },
    };

    const fakeDbi = {
      get: () => undefined,
      getRange: () => range,
    } as unknown as Parameters<typeof inspectStatic>[0];

    const result = inspectStatic(fakeDbi);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('poison');
    expect(returned).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('inspectSync — enumeration and classification', () => {
  const ENUM_WORKFLOW = 'enum-workflow';

  function inspectionFor(
    list: BoxInspection[],
    key: string,
    strategy: string,
  ): BoxInspection | undefined {
    return list.find((e) => e.key === key && e.strategy === strategy);
  }

  let inspection: BoxInspection[];

  beforeAll(() => {
    const at = (location: BoxLocation): BoxLocation => ({
      ...location,
      workflow: ENUM_WORKFLOW,
    });

    const cell = at(kvLocation('config_cell'));
    const other = at(kvLocation('another.cell-1'));
    const queue = at(fifoLocation('tick_queue', 8));
    const empty = at(fifoLocation('empty_queue', 8));
    const wrapped = at(fifoLocation('wrapped_queue', 4));
    const collidingKv = at(kvLocation('both_ways'));
    const collidingFifo = at(fifoLocation('both_ways', 8));
    const impostor = at(kvLocation('fifo:not_real:data:007'));

    store.putSync(boxOf(cell, { mode: 'live', size: 12 }));
    store.putSync(boxOf(other, 'short'));

    for (const value of ['t1', 't2', 't3']) {
      store.putSync(boxOf(queue, value));
    }

    // Fill and wrap: 3 in, 2 out, 2 in — live window straddles index 0.
    for (const value of ['w1', 'w2', 'w3']) {
      store.putSync(boxOf(wrapped, value));
    }

    store.getSync(wrapped);
    store.getSync(wrapped);
    store.putSync(boxOf(wrapped, 'w4'));
    store.putSync(boxOf(wrapped, 'w5'));

    // An empty queue still exists: `put` then `get` leaves both cursors.
    store.putSync(boxOf(empty, 'gone'));
    store.getSync(empty);

    store.putSync(boxOf(collidingKv, 'as-a-cell'));
    store.putSync(boxOf(collidingFifo, 'as-a-queue'));

    // A key that *looks* derived but cannot have been written by the FIFO
    // path (`007` is not a canonical `${n}`). Reachable only by using
    // `@rawbox/store` directly, which the package supports.
    store.putSync(boxOf(impostor, 'impostor'));

    inspection = store.inspectSync(ENUM_WORKFLOW)._unsafeUnwrap();
  });

  it('never leaks a derived key as a user key', () => {
    for (const entry of inspection) {
      if (entry.strategy === 'lmdb-fifo') {
        expect(entry.key).not.toContain(':');
      }

      // Not a loose `fifo:.*` match: `fifo:not_real:data:007` is a legitimate
      // user key precisely because the writer cannot emit it. The claim is
      // that nothing the *writer* derives is reported as a user key.
      expect(parseDerivedFifoKey(entry.key)).toBeUndefined();
    }
  });

  it('infers each strategy from the layout', () => {
    const keyList = inspection.map((e) => `${e.key}/${e.strategy}`).sort();

    expect(keyList).toEqual(
      [
        'another.cell-1/lmdb-kv',
        'both_ways/lmdb-fifo',
        'both_ways/lmdb-kv',
        'config_cell/lmdb-kv',
        'empty_queue/lmdb-fifo',
        'fifo:not_real:data:007/lmdb-kv',
        'tick_queue/lmdb-fifo',
        'wrapped_queue/lmdb-fifo',
      ].sort(),
    );
  });

  it('reports the uncompressed value size valueSizeMax governs', () => {
    const cell = inspectionFor(inspection, 'config_cell', 'lmdb-kv');
    const expectedSize = measureValueSize({
      mode: 'live',
      size: 12,
    })._unsafeUnwrap();

    expect(cell?.valueSizeBytes).toBe(expectedSize);
    expect(cell?.valueSizeMaxBytes).toBe(expectedSize);
    expect(cell?.entryCount).toBe(1);
  });

  it('sums a FIFO across its elements and reports the largest', () => {
    const queue = inspectionFor(inspection, 'tick_queue', 'lmdb-fifo');
    const elementSize = measureValueSize('t1')._unsafeUnwrap();

    expect(queue?.fifo?.depth).toBe(3);
    expect(queue?.valueSizeBytes).toBe(elementSize * 3);
    // `valueSizeMax` bounds one element, never the queue's total.
    expect(queue?.valueSizeMaxBytes).toBe(elementSize);
    // head + three data entries, and no tail: `put` writes the head cursor,
    // `get` writes the tail cursor, and this queue has never been dequeued.
    // Enumeration reports the absent cursor as 0 without inventing an entry.
    expect(queue?.entryCount).toBe(4);
    expect(queue?.fifo?.tail).toBe(0);
    expect(queue?.fifo?.head).toBe(3);
  });

  it('classifies a FIFO that has wrapped past its ring boundary', () => {
    const wrapped = inspectionFor(inspection, 'wrapped_queue', 'lmdb-fifo');

    expect(wrapped?.fifo?.depth).toBe(3);
    // head behind tail is exactly what "wrapped" looks like on disk.
    expect(wrapped?.fifo?.head).toBeLessThan(wrapped?.fifo?.tail ?? 0);
    expect(wrapped?.fifo?.ringIndexMax).toBe(3);
    expect(wrapped?.entryCount).toBe(5);

    // And the ordering still holds through the observer's own read path.
    const location: BoxLocation = {
      ...fifoLocation('wrapped_queue', 4),
      workflow: ENUM_WORKFLOW,
    };
    expect(store.peekAllSync(location)._unsafeUnwrap()).toEqual([
      'w3',
      'w4',
      'w5',
    ]);
  });

  it('reports an empty queue as a queue, not as nothing', () => {
    const empty = inspectionFor(inspection, 'empty_queue', 'lmdb-fifo');

    expect(empty).toBeDefined();
    expect(empty?.fifo).toEqual({
      head: 1,
      tail: 1,
      depth: 0,
      ringIndexMax: -1,
    });
    expect(empty?.valueSizeBytes).toBe(0);
    expect(empty?.valueSizeMaxBytes).toBe(0);
  });

  it('reports both records when one key exists under both strategies', () => {
    expect(inspectionFor(inspection, 'both_ways', 'lmdb-kv')).toBeDefined();
    expect(inspectionFor(inspection, 'both_ways', 'lmdb-fifo')).toBeDefined();
  });

  it('surfaces a key the FIFO writer could not have produced', () => {
    const impostor = inspectionFor(
      inspection,
      'fifo:not_real:data:007',
      'lmdb-kv',
    );

    expect(impostor).toBeDefined();
    expect(inspectionFor(inspection, 'not_real', 'lmdb-fifo')).toBeUndefined();
  });

  it('leaves the database exactly as it found it', () => {
    const before = physicalSnapshot(store, ENUM_WORKFLOW);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(store.inspectSync(ENUM_WORKFLOW).isOk()).toBe(true);
    }

    expect(physicalSnapshot(store, ENUM_WORKFLOW)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------

describe('enumeration of an untouched workflow', () => {
  it('returns an empty listing rather than an error', () => {
    // `getOrCreateDbi` creates the database handle, as `getSync` also would;
    // the point is that no *key* appears and nothing throws.
    const result = store.inspectSync('never-written-workflow');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('peek does not disturb an interleaved consumer', () => {
  let location: BoxLocation;

  beforeEach(() => {
    location = fifoLocation(
      `fifo_interleaved_${Math.floor(Math.random() * 1e9)}`,
      16,
    );
  });

  it('produces the same drain sequence with and without peeks', () => {
    const enqueued: number[] = [];

    for (let index = 0; index < 10; index += 1) {
      expect(store.putSync(boxOf(location, index)).isOk()).toBe(true);
      enqueued.push(index);
    }

    const drained: unknown[] = [];

    while (true) {
      // Peek between every dequeue, twice, plus a full peekAll and a depth
      // read. If any of them consumed, the drain sequence would skip.
      const peeked = store.peekSync(location);

      if (peeked.isErr()) {
        expect(peeked._unsafeUnwrapErr()).toBe('Queue empty');
        break;
      }

      store.peekSync(location);
      store.peekAllSync(location);
      store.depthSync(location);

      const dequeued = store.getSync(location);
      expect(dequeued.isOk()).toBe(true);
      expect(dequeued._unsafeUnwrap()).toBe(peeked._unsafeUnwrap());
      drained.push(dequeued._unsafeUnwrap());
    }

    expect(drained).toEqual(enqueued);
  });
});
