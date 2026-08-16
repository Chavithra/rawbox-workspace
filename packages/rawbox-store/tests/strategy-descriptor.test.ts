import { describe, it, expect } from 'vitest';
import { Compile } from 'typebox/compile';

import { BoxStrategy, type BoxStorage } from '../src/index.js';
import {
  STRATEGY_NAME_LIST,
  descriptorFor,
  keyBudgetOf,
  seedCapacityOf,
  storeIdentityOf,
} from '../src/strategy/descriptor.js';
import { budgetForKey, budgetForStorage } from '../src/strategy/budget.js';

// ---------------------------------------------------------------------------
// The strategy registry, and the `budgetable: false` half of the budget
//
// `StrategyDescriptor.budget` has always been optional and `budgetForKey` has
// always had an `UnbudgetableKey` branch, but until `redis-kv` joined the union
// nothing a *document* could express reached it. These tests pin the row that
// makes it reachable, and the arithmetic consequence: an unbudgetable key is
// excluded from every total and NAMED, never charged zero.
//
// No database is opened here. The whole registry is pure by construction — see
// the module header in `src/strategy/descriptor.ts` for why that is a
// requirement rather than a coincidence.
// ---------------------------------------------------------------------------

const REDIS_KV = {
  name: 'redis-kv',
  valueSizeMax: 1900,
  backend: 'main',
} as const;

const LMDB_KV = { name: 'lmdb-kv', valueSizeMax: 1900 } as const;

const LMDB_FIFO = {
  name: 'lmdb-fifo',
  queueSizeMax: 8,
  valueSizeMax: 1900,
} as const;

const REDIS_FIFO = {
  name: 'redis-fifo',
  queueSizeMax: 8,
  valueSizeMax: 1900,
  backend: 'main',
} as const;

describe('the redis-kv schema', () => {
  const validator = Compile(BoxStrategy);

  it('accepts a well-formed declaration', () => {
    expect(validator.Check(REDIS_KV)).toBe(true);
  });

  it('requires a backend id, and refuses an empty one', () => {
    // An empty id names nothing and would otherwise reach the resolver as a
    // lookup miss with no name to report.
    expect(validator.Check({ name: 'redis-kv', valueSizeMax: 1900 })).toBe(false);
    expect(validator.Check({ ...REDIS_KV, backend: '' })).toBe(false);
  });

  it('is closed: `queueSizeMax` under redis-kv is rejected', () => {
    // A cell, not a queue. `StrictObject` is what turns a stray field into an
    // error rather than a silently dropped setting — the diagnostic naming the
    // field lives in `@rawbox/runner`'s `collectStrategyFieldProblems`.
    expect(validator.Check({ ...REDIS_KV, queueSizeMax: 8 })).toBe(false);
  });

  it('is closed the other way too: `backend` under lmdb-kv is rejected', () => {
    expect(validator.Check({ ...LMDB_KV, backend: 'main' })).toBe(false);
  });
});

describe('the redis-kv descriptor row', () => {
  it('is in the registry, so the union and the table agree', () => {
    // The table is keyed by `BoxStrategy['name']`, so a member with no row is a
    // compile error. This asserts the runtime half of the same statement.
    expect(STRATEGY_NAME_LIST).toContain('redis-kv');
  });

  it('declares a cell: a seed is one write, and there is no depth', () => {
    const descriptor = descriptorFor(REDIS_KV);

    expect(descriptor.seedExpandsList).toBe(false);
    expect(descriptor.seedCapacity).toBeUndefined();
    expect(descriptor.hasDepth).toBe(false);
  });

  it("declares lmdb-kv's empty-read sentence VERBATIM", () => {
    // Every strategy must declare the exact sentence its empty read fails
    // with, because the verifier quotes it back to the author when it rejects
    // a key that is read but never written — so the quoted sentence has to be
    // the one the store really produces. A
    // cell that was never written is a cell that is missing, whatever holds it,
    // so the two cells share one sentence — which the rule explicitly allows
    // and which binds a Redis store to producing this string exactly.
    expect(descriptorFor(REDIS_KV).emptyReadMessage).toBe('Value not found');
    expect(descriptorFor(REDIS_KV).emptyReadMessage).toBe(
      descriptorFor(LMDB_KV).emptyReadMessage,
    );
  });

  it('declares NO budget — the point of the row', () => {
    // A Redis key's bytes are bounded by a server's `maxmemory`, its eviction
    // policy and whoever operates it. None of that is written in, or derivable
    // from, a `storage:` block, so the strategy states that it has no figure
    // rather than inventing one.
    expect(descriptorFor(REDIS_KV).budget).toBeUndefined();
    expect(keyBudgetOf(REDIS_KV, 'cache_entry')).toBeUndefined();
  });

  it('still declares a key width, because that one IS known', () => {
    // Redis stores the author's key with no derivation, so the widest key this
    // declaration produces is the key itself. Declared rather than omitted:
    // omission would mean "there is no such quantity", and the unknown quantity
    // here is the byte footprint, which is what the absent `budget` says.
    expect(descriptorFor(REDIS_KV).keySizeMax?.('cache_entry', REDIS_KV)).toBe(11);
    expect(descriptorFor(REDIS_KV).keySizeMax?.('cache_entry', REDIS_KV)).toBe(
      descriptorFor(LMDB_KV).keySizeMax?.('cache_entry', LMDB_KV),
    );
  });
});

describe('budgetForKey on a strategy with no budget', () => {
  it('names the key instead of charging it', () => {
    const outcome = budgetForKey('cache_entry', REDIS_KV, 'declared');

    expect(outcome.budgetable).toBe(false);
    // Exactly the three fields needed to NAME the key in a report, and nothing
    // that could be summed: no `dataBytesMax: 0`, no `entryCount: 0`.
    expect(outcome).toEqual({
      budgetable: false,
      key: 'cache_entry',
      source: 'declared',
      strategyName: 'redis-kv',
    });
  });

  it('is not an Err: nothing failed', () => {
    // The document is valid, the strategy is legal, and "this is not
    // provisionable from a document" is a fact about the backend.
    expect(budgetForKey('cache_entry', LMDB_KV).budgetable).toBe(true);
  });
});

describe('budgetForStorage over a mixed block', () => {
  const storage: BoxStorage = {
    defaultStrategy: LMDB_KV,
    strategies: { cache_entry: REDIS_KV },
    seed: { sleep_ms: 500, cache_entry: 'cached' },
    boundKeyList: ['slept_at'],
  };

  it('excludes the redis key from every total and lists it by name', () => {
    const budget = budgetForStorage(storage);

    expect(budget.unbudgetableKeyList).toEqual([
      {
        budgetable: false,
        key: 'cache_entry',
        source: 'declared',
        strategyName: 'redis-kv',
      },
    ]);
    expect(budget.keyBudgetList.map((entry) => entry.key)).toEqual([
      'sleep_ms',
      'slept_at',
    ]);
  });

  it('produces figures identical to the same block with the redis key removed', () => {
    // The arithmetic half of "excluded, not charged zero". A charged zero would
    // also leave the totals unchanged, which is why the reporting assertions in
    // `packages/rawbox-cli/tests/verify.test.ts` are the other half.
    const withRedis = budgetForStorage(storage);
    const withoutRedis = budgetForStorage({
      defaultStrategy: LMDB_KV,
      seed: { sleep_ms: 500 },
      boundKeyList: ['slept_at'],
    });

    expect(withRedis.dataBytesMax).toBe(withoutRedis.dataBytesMax);
    expect(withRedis.entryCount).toBe(withoutRedis.entryCount);
    expect(withRedis.pageCountMax).toBe(withoutRedis.pageCountMax);
    expect(withRedis.recommendedVolumeBytes).toBe(
      withoutRedis.recommendedVolumeBytes,
    );
    // Two 8-byte keys at valueSizeMax 1900, both in-page:
    // (2 + 8 + 8) + 1900 = 1918 each.
    expect(withRedis.dataBytesMax).toBe(3836);
    expect(withRedis.entryCount).toBe(2);
  });

  it('leaves the excluded list empty for an LMDB-only block', () => {
    expect(
      budgetForStorage({ defaultStrategy: LMDB_KV, seed: { sleep_ms: 500 } })
        .unbudgetableKeyList,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `redis-fifo` — a queue whose capacity is NOT `queueSizeMax - 1`
//
// The second queue strategy, and the first to disagree with the first one about
// what a declared ceiling means. `lmdb-fifo` emulates a ring over a key-value
// store and keeps one slot permanently free so `head === tail` can mean *empty*
// rather than *full*; `redis-fifo` is a native Redis list, where `LLEN` reports
// the depth outright and an empty list is a key that does not exist, so nothing
// has to be held back.
//
// These tests pin that divergence at its source — the registry row — because
// every consumer reads it from there: the seed-length check, the sentence that
// explains the shortfall, and (task #15) the store that will have to hold
// exactly as many entries as the verifier promised.
// ---------------------------------------------------------------------------

describe('the redis-fifo schema', () => {
  const validator = Compile(BoxStrategy);

  it('accepts a well-formed declaration', () => {
    expect(validator.Check(REDIS_FIFO)).toBe(true);
  });

  it('accepts queueSizeMax: 1, which lmdb-fifo rejects', () => {
    // The schema half of "no reserved slot". Under the ring, 1 would declare a
    // queue with zero usable capacity, so `LmdbFIFO` sets `minimum: 2`; under a
    // native list 1 is a perfectly usable one-entry queue, so `RedisFIFO` sets
    // `minimum: 1`. The pair below is the assertion that the two minimums are
    // deliberate and not copied.
    expect(validator.Check({ ...REDIS_FIFO, queueSizeMax: 1 })).toBe(true);
    expect(validator.Check({ ...LMDB_FIFO, queueSizeMax: 1 })).toBe(false);
    // Zero is a queue that can hold nothing under either, and is refused by
    // both.
    expect(validator.Check({ ...REDIS_FIFO, queueSizeMax: 0 })).toBe(false);
  });

  it('requires every field, including the backend id', () => {
    expect(
      validator.Check({ name: 'redis-fifo', queueSizeMax: 8, valueSizeMax: 1900 }),
    ).toBe(false);
    expect(validator.Check({ ...REDIS_FIFO, backend: '' })).toBe(false);
    expect(
      validator.Check({ name: 'redis-fifo', valueSizeMax: 1900, backend: 'main' }),
    ).toBe(false);
  });

  it('is closed: a stray field is rejected rather than silently dropped', () => {
    // `StrictObject`, as every strategy MUST use (`src/box.ts` header). A
    // dropped `queueSizeMax` once turned a queue into a cell silently; the
    // diagnostic naming the field lives in `@rawbox/runner`.
    expect(validator.Check({ ...REDIS_FIFO, ringSizeMax: 8 })).toBe(false);
    // And the other way: `backend` is not a field of `lmdb-fifo`.
    expect(validator.Check({ ...LMDB_FIFO, backend: 'main' })).toBe(false);
  });
});

describe('the redis-fifo descriptor row', () => {
  it('is in the registry, so the union and the table agree', () => {
    expect(STRATEGY_NAME_LIST).toContain('redis-fifo');
  });

  it('declares a queue: a seed expands, and the box has a depth', () => {
    const descriptor = descriptorFor(REDIS_FIFO);

    expect(descriptor.seedExpandsList).toBe(true);
    expect(descriptor.hasDepth).toBe(true);
  });

  it('declares capacity as the IDENTITY on queueSizeMax — the point of the row', () => {
    // `queueSizeMax: 8` holds 8 here and 7 under the ring. Asserted against
    // `seedCapacityOf`, the bare-union entry point the verifier actually calls,
    // rather than against the row's field, so this covers the path a document
    // takes.
    expect(seedCapacityOf(REDIS_FIFO)).toBe(8);
    expect(seedCapacityOf(LMDB_FIFO)).toBe(7);
    // Including at the minimum the schema allows: a one-entry queue really can
    // hold its one entry.
    expect(seedCapacityOf({ ...REDIS_FIFO, queueSizeMax: 1 })).toBe(1);
  });

  it('declares NO capacity note, because there is no shortfall to explain', () => {
    // The invariant no type can hold: a note is present exactly when capacity
    // falls short of the declared ceiling. `checkFifoSeedLength` derives both
    // the clause and the "raise it to at least N" figure from that same gap, so
    // a row breaking this pairing would print a reason for a shortfall that
    // does not exist — or leave a real one unexplained.
    for (const strategy of [LMDB_FIFO, REDIS_FIFO] as const) {
      const capacity = seedCapacityOf(strategy);
      const note = descriptorFor(strategy).seedCapacityNote;

      expect(capacity).toBeDefined();
      expect(note !== undefined).toBe(strategy.queueSizeMax - capacity! > 0);
    }

    expect(descriptorFor(REDIS_FIFO).seedCapacityNote).toBeUndefined();
    expect(descriptorFor(LMDB_FIFO).seedCapacityNote).toBe(
      'one slot is permanently reserved to distinguish a full queue from an empty one',
    );
  });

  it("declares lmdb-fifo's empty-read sentence VERBATIM", () => {
    // Every strategy declares the exact sentence its empty read fails with,
    // and the verifier quotes it back to the author. A queue with nothing in it is a
    // queue with nothing in it whichever server holds it, so the two queues
    // share one sentence — which binds task #15's store to producing this
    // string and not a client-library message.
    expect(descriptorFor(REDIS_FIFO).emptyReadMessage).toBe('Queue empty');
    expect(descriptorFor(REDIS_FIFO).emptyReadMessage).toBe(
      descriptorFor(LMDB_FIFO).emptyReadMessage,
    );
  });

  it('declares NO budget: a Redis list is bounded by a server, not by storage:', () => {
    // `queueSizeMax × valueSizeMax` would look like an honest figure and is not
    // one — it models no per-element overhead and no server allocator — so the
    // strategy states it has none rather than inventing it.
    expect(descriptorFor(REDIS_FIFO).budget).toBeUndefined();
    expect(keyBudgetOf(REDIS_FIFO, 'job_queue')).toBeUndefined();
    expect(budgetForKey('job_queue', REDIS_FIFO, 'declared')).toEqual({
      budgetable: false,
      key: 'job_queue',
      source: 'declared',
      strategyName: 'redis-fifo',
    });
  });

  it('derives NO key: one list is one key, unlike the ring', () => {
    // `lmdb-fifo` widens the author's key to `fifo:<key>:data:<n>` because LMDB
    // gives it one flat untyped keyspace and a ring needs several entries per
    // queue. Redis needs neither: one list is one key, and `TYPE` distinguishes
    // a list from a string with no help from the name.
    expect(descriptorFor(REDIS_FIFO).keySizeMax?.('job_queue', REDIS_FIFO)).toBe(9);
    expect(descriptorFor(REDIS_FIFO).keySizeMax?.('job_queue', REDIS_FIFO)).toBe(
      descriptorFor(REDIS_KV).keySizeMax?.('job_queue', REDIS_KV),
    );
    // The contrast, so the equality above is read as a decision and not as an
    // oversight: the ring's widest derived key is much wider than the key.
    expect(
      descriptorFor(LMDB_FIFO).keySizeMax?.('job_queue', LMDB_FIFO),
    ).toBeGreaterThan(9);
  });
});

describe('redis-fifo and redis-kv on one backend', () => {
  // The pairing most likely to be got wrong, and the one a `backend: 'redis'`
  // category and a per-strategy id would each get wrong in opposite directions.
  //
  // A Redis cell beside a Redis queue on ONE server is co-transactional: one
  // connection, one `MULTI`, one Lua scope — exactly as `lmdb-kv` and
  // `lmdb-fifo` are one LMDB environment. The co-transactional check in
  // `@rawbox/runner` compares `StoreIdentity.id` for equality and nothing else,
  // so two rows spelling the id differently would reject a legal document.

  it('are the SAME store — identical id, identical description', () => {
    expect(storeIdentityOf(REDIS_FIFO)).toEqual(storeIdentityOf(REDIS_KV));
    expect(storeIdentityOf(REDIS_FIFO).id).toBe('redis:main');
  });

  it('are TWO stores when their backend ids differ, under either name', () => {
    // The other half: identity is the concrete server, never the kind of
    // storage. Nothing spans two Redis servers, so a queue on `alpha` and a
    // cell on `beta` are not co-transactional however alike the names look.
    expect(storeIdentityOf({ ...REDIS_FIFO, backend: 'alpha' }).id).not.toBe(
      storeIdentityOf({ ...REDIS_KV, backend: 'beta' }).id,
    );
    expect(storeIdentityOf({ ...REDIS_FIFO, backend: 'alpha' }).id).not.toBe(
      storeIdentityOf({ ...REDIS_FIFO, backend: 'beta' }).id,
    );
  });

  it('name the server in prose a reader can act on, never the opaque id', () => {
    // `StoreIdentity.description` is what a diagnostic prints: an author told
    // that `redis:main` and `lmdb:workspace` differ has learnt nothing to edit.
    expect(storeIdentityOf(REDIS_FIFO).description).toBe(
      'the Redis server named by backend: "main"',
    );
  });

  it('share no store with LMDB', () => {
    expect(storeIdentityOf(REDIS_FIFO).id).not.toBe(storeIdentityOf(LMDB_FIFO).id);
    expect(storeIdentityOf(LMDB_FIFO).id).toBe(storeIdentityOf(LMDB_KV).id);
  });
});
