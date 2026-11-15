import { describe, it, expect } from 'vitest';
import { Compile } from 'typebox/compile';

import { BoxStrategy, type BoxStorage } from '../../src/index.js';
import {
  STRATEGY_NAME_LIST,
  descriptorFor,
  keyBudgetOf,
  seedCapacityOf,
  storeIdentityOf,
} from '../../src/strategy/descriptor.js';
import { budgetForKey, budgetForStorage } from '../../src/strategy/budget.js';

// ---------------------------------------------------------------------------
// The strategy registry and authoring schemas for the shipped LMDB strategies
//
// No database is opened here. The whole registry is pure by construction — see
// the module header in `src/strategy/descriptor.ts` for why that is a
// requirement rather than a coincidence.
// ---------------------------------------------------------------------------

const LMDB_KV = { name: 'lmdb-kv', valueSizeMax: 1900 } as const;

const LMDB_FIFO = {
  name: 'lmdb-fifo',
  queueSizeMax: 8,
  valueSizeMax: 1900,
} as const;

const PG_KV = {
  name: 'pg-kv',
  backend: 'primary',
  valueSizeMax: 4096,
} as const;

const PG_FIFO = {
  name: 'pg-fifo',
  backend: 'primary',
  queueSizeMax: 8,
  valueSizeMax: 4096,
} as const;

describe('BoxStrategy schema', () => {
  const validator = Compile(BoxStrategy);

  it('accepts well-formed lmdb and pg strategy declarations', () => {
    expect(validator.Check(LMDB_KV)).toBe(true);
    expect(validator.Check(LMDB_FIFO)).toBe(true);
    expect(validator.Check({ ...LMDB_FIFO, queueSizeMax: 2 })).toBe(true);
    expect(validator.Check(PG_KV)).toBe(true);
    expect(validator.Check(PG_FIFO)).toBe(true);
    expect(validator.Check({ ...PG_FIFO, queueSizeMax: 1 })).toBe(true);
  });

  it('enforces queueSizeMax >= 2 on lmdb-fifo', () => {
    // One slot is reserved to disambiguate empty from full, so a declared
    // ceiling of 1 would have zero usable capacity.
    expect(validator.Check({ ...LMDB_FIFO, queueSizeMax: 1 })).toBe(false);
    expect(validator.Check({ ...LMDB_FIFO, queueSizeMax: 0 })).toBe(false);
    expect(
      validator.Check({ name: 'lmdb-fifo', valueSizeMax: 1900 }),
    ).toBe(false);
  });

  it('enforces valueSizeMax >= 1', () => {
    expect(validator.Check({ name: 'lmdb-kv', valueSizeMax: 0 })).toBe(false);
    expect(
      validator.Check({ name: 'lmdb-fifo', queueSizeMax: 8, valueSizeMax: 0 }),
    ).toBe(false);
  });

  it('is closed: stray fields are rejected rather than silently dropped', () => {
    // `StrictObject` is load-bearing on every union member (`src/box.ts`).
    expect(validator.Check({ ...LMDB_KV, queueSizeMax: 8 })).toBe(false);
    expect(validator.Check({ ...LMDB_KV, backend: 'main' })).toBe(false);
    expect(validator.Check({ ...LMDB_FIFO, backend: 'main' })).toBe(false);
    expect(validator.Check({ ...LMDB_FIFO, ringSizeMax: 8 })).toBe(false);
  });

  it('rejects unknown or removed strategy names', () => {
    expect(validator.Check({ name: 'unknown-kv', valueSizeMax: 1900 })).toBe(
      false,
    );
    expect(
      validator.Check({
        name: 'unknown-fifo',
        queueSizeMax: 8,
        valueSizeMax: 1900,
      }),
    ).toBe(false);
  });
});

describe('STRATEGY_NAME_LIST', () => {
  it('lists all shipped LMDB and PostgreSQL strategies in union order', () => {
    // Read off `STRATEGY_DESCRIPTOR_TABLE` keys so union and table stay in
    // lockstep at runtime as well as compile time.
    expect(STRATEGY_NAME_LIST).toEqual([
      'lmdb-kv',
      'lmdb-fifo',
      'pg-kv',
      'pg-fifo',
    ]);
  });
});

describe('the lmdb-kv descriptor row', () => {
  it('declares a cell: a seed is one write, and there is no depth', () => {
    const descriptor = descriptorFor(LMDB_KV);

    expect(descriptor.seedExpandsList).toBe(false);
    expect(descriptor.seedCapacity).toBeUndefined();
    expect(seedCapacityOf(LMDB_KV)).toBeUndefined();
    expect(descriptor.seedCapacityNote).toBeUndefined();
    expect(descriptor.hasDepth).toBe(false);
  });

  it('declares its empty-read sentence verbatim', () => {
    expect(descriptorFor(LMDB_KV).emptyReadMessage).toBe('Value not found');
  });

  it('declares keySizeMax equal to the author key UTF-8 length', () => {
    expect(descriptorFor(LMDB_KV).keySizeMax?.('cache_entry', LMDB_KV)).toBe(
      11,
    );
  });

  it('declares a budget function and computes a budget via keyBudgetOf', () => {
    const descriptor = descriptorFor(LMDB_KV);
    const keyBudget = keyBudgetOf(LMDB_KV, 'cache_entry', 'declared');

    expect(descriptor.budget).toBeTypeOf('function');
    expect(keyBudget).toBeDefined();
    expect(keyBudget?.budgetable).toBe(true);
    expect(keyBudget?.key).toBe('cache_entry');
    expect(keyBudget?.source).toBe('declared');
  });

  it('addresses the shared LMDB workspace store', () => {
    expect(storeIdentityOf(LMDB_KV)).toEqual({
      id: 'lmdb:workspace',
      description: "the workspace's LMDB environment",
    });
  });
});

describe('the lmdb-fifo descriptor row', () => {
  it('declares a queue: a seed expands, and the box has a depth', () => {
    const descriptor = descriptorFor(LMDB_FIFO);

    expect(descriptor.seedExpandsList).toBe(true);
    expect(descriptor.hasDepth).toBe(true);
  });

  it('declares seedCapacity as queueSizeMax - 1 and enforces the seedCapacityNote invariant', () => {
    expect(seedCapacityOf(LMDB_FIFO)).toBe(7);
    expect(seedCapacityOf({ ...LMDB_FIFO, queueSizeMax: 2 })).toBe(1);

    // Invariant: `seedCapacityNote` is present exactly when capacity falls
    // short of the declared `queueSizeMax`.
    for (const strategy of [
      LMDB_FIFO,
      { ...LMDB_FIFO, queueSizeMax: 2 },
    ] as const) {
      const capacity = seedCapacityOf(strategy);
      const note = descriptorFor(strategy).seedCapacityNote;

      expect(capacity).toBeDefined();
      expect(note !== undefined).toBe(strategy.queueSizeMax - capacity! > 0);
    }

    expect(descriptorFor(LMDB_FIFO).seedCapacityNote).toBe(
      'one slot is permanently reserved to distinguish a full queue from an empty one',
    );
  });

  it('declares its empty-read sentence verbatim', () => {
    expect(descriptorFor(LMDB_FIFO).emptyReadMessage).toBe('Queue empty');
  });

  it('declares keySizeMax accounting for the widest derived data key', () => {
    const kvWidth = descriptorFor(LMDB_KV).keySizeMax?.('job_queue', LMDB_KV);
    const fifoWidth = descriptorFor(LMDB_FIFO).keySizeMax?.(
      'job_queue',
      LMDB_FIFO,
    );

    // `fifo:job_queue:data:7` is 21 bytes vs 9 bytes for bare `job_queue`.
    expect(fifoWidth).toBe(21);
    expect(fifoWidth).toBeGreaterThan(kvWidth!);
  });

  it('declares a budget function and computes a budget via keyBudgetOf', () => {
    const descriptor = descriptorFor(LMDB_FIFO);
    const keyBudget = keyBudgetOf(LMDB_FIFO, 'job_queue', 'bound');

    expect(descriptor.budget).toBeTypeOf('function');
    expect(keyBudget).toBeDefined();
    expect(keyBudget?.budgetable).toBe(true);
    expect(keyBudget?.key).toBe('job_queue');
    expect(keyBudget?.source).toBe('bound');
  });

  it('shares the LMDB workspace store identity with lmdb-kv', () => {
    expect(storeIdentityOf(LMDB_FIFO)).toEqual(storeIdentityOf(LMDB_KV));
    expect(storeIdentityOf(LMDB_FIFO).id).toBe('lmdb:workspace');
  });
});

describe('budgetForKey and budgetForStorage on LMDB strategies', () => {
  it('budgetForKey returns budgetable: true for both LMDB strategies', () => {
    const kvBudget = budgetForKey('cache_entry', LMDB_KV, 'declared');
    const fifoBudget = budgetForKey('job_queue', LMDB_FIFO, 'bound');

    expect(kvBudget.budgetable).toBe(true);
    expect(fifoBudget.budgetable).toBe(true);
  });

  it('budgetForStorage budgets all keys with an empty unbudgetableKeyList', () => {
    const storage: BoxStorage = {
      defaultStrategy: LMDB_KV,
      strategies: { job_queue: LMDB_FIFO },
      seed: { sleep_ms: 500, job_queue: ['a'] },
      boundKeyList: ['slept_at'],
    };

    const budget = budgetForStorage(storage);

    expect(budget.unbudgetableKeyList).toEqual([]);
    expect(budget.keyBudgetList.every((entry) => entry.budgetable)).toBe(true);
    expect(budget.keyBudgetList.map((entry) => entry.key)).toEqual([
      'job_queue',
      'sleep_ms',
      'slept_at',
    ]);
  });
});

describe('PostgreSQL strategy descriptors and unbudgetable keys', () => {
  it('declares pg-kv metadata and store identity by backend id', () => {
    const descriptor = descriptorFor(PG_KV);

    expect(descriptor.seedExpandsList).toBe(false);
    expect(descriptor.hasDepth).toBe(false);
    expect(descriptor.emptyReadMessage).toBe('Value not found');
    expect(descriptor.budget).toBeUndefined();
    expect(storeIdentityOf(PG_KV).id).toBe('pg:primary');
    expect(storeIdentityOf({ ...PG_KV, backend: 'analytics' }).id).toBe('pg:analytics');
  });

  it('declares pg-fifo with exact queueSizeMax capacity and no reserved slot note', () => {
    const descriptor = descriptorFor(PG_FIFO);

    expect(descriptor.seedExpandsList).toBe(true);
    expect(descriptor.hasDepth).toBe(true);
    expect(seedCapacityOf(PG_FIFO)).toBe(8);
    expect(seedCapacityOf({ ...PG_FIFO, queueSizeMax: 1 })).toBe(1);
    expect(descriptor.seedCapacityNote).toBeUndefined();
    expect(descriptor.emptyReadMessage).toBe('Queue empty');
    expect(storeIdentityOf(PG_FIFO)).toEqual(storeIdentityOf(PG_KV));
  });

  it('partitions pg-* keys into unbudgetableKeyList', () => {
    const budget = budgetForStorage({
      defaultStrategy: PG_KV,
      strategies: { tasks: PG_FIFO },
      seed: { state: 'ok', tasks: ['a'] },
      boundKeyList: [],
    });

    expect(budget.keyBudgetList).toEqual([]);
    expect(budget.unbudgetableKeyList.map((entry) => entry.key)).toEqual([
      'tasks',
      'state',
    ]);
  });
});
