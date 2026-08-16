import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { BoxStoreLmdb, LmdbEnvCache } from '../src/box-store/box-store-lmdb.js';
import { type Box, type BoxLocation } from '../src/box.js';
import {
  readMaxKeySize,
  RAWBOX_KEY_DERIVATION_OVERHEAD_MAX,
  RAWBOX_KEY_SIZE_MAX,
  type BoxStorage,
} from '../src/box-size.js';
import { budgetForStorage } from '../src/strategy/budget.js';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ok, err } from 'neverthrow';

const workspace = 'test-workspace';
const workflow = 'test-workflow';

describe('BoxStoreLmdb', () => {
  let dbDirUrl: URL;
  let store: BoxStoreLmdb;

  beforeAll(async () => {
    const rand = Math.floor(Math.random() * 1000000);
    dbDirUrl = new URL(
      `../data/test-db-${Date.now()}-${rand}/`,
      import.meta.url,
    );
    await fs.mkdir(fileURLToPath(dbDirUrl), { recursive: true });
    store = BoxStoreLmdb.create(workspace, dbDirUrl);
  });

  afterAll(async () => {
    try {
      store.dbiCache.env.close();
    } catch {
      void 0;
    }
    try {
      await fs.rm(fileURLToPath(dbDirUrl), { recursive: true, force: true });
    } catch {
      void 0;
    }
  });

  describe('lmdb-kv strategy', () => {
    it('should put and get a value successfully', async () => {
      const box: Box<unknown> = {
        content: { foo: 'bar', count: 42 },
        location: { workspace, workflow, key: 'key1', strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };

      const putResult = await store.put(box);
      expect(putResult.isOk()).toBe(true);

      const getResult = await store.get(box.location);
      expect(getResult.isOk()).toBe(true);
      expect(getResult._unsafeUnwrap()).toEqual({ foo: 'bar', count: 42 });
    });

    it('should overwrite a value successfully', async () => {
      const box1: Box<unknown> = {
        content: 'initial-value',
        location: { workspace, workflow, key: 'key2', strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };
      const box2: Box<unknown> = {
        content: 'updated-value',
        location: { workspace, workflow, key: 'key2', strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };

      await store.put(box1);
      const putResult = await store.put(box2);
      expect(putResult.isOk()).toBe(true);

      const getResult = await store.get(box1.location);
      expect(getResult.isOk()).toBe(true);
      expect(getResult._unsafeUnwrap()).toBe('updated-value');
    });

    it('should return error if value not found', async () => {
      const boxLocation: BoxLocation = {
        workspace,
        workflow,
        key: 'not-found-key',
        strategy: { name: 'lmdb-kv', valueSizeMax: 1024 },
      };

      const getResult = await store.get(boxLocation);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toBe('Value not found');
    });

    it('should reject a put that exceeds valueSizeMax, naming the key and both sizes', async () => {
      const valueSizeMax = 16;
      const key = 'ticker';
      const box: Box<unknown> = {
        content: 'x'.repeat(64),
        location: { workspace, workflow, key, strategy: { name: 'lmdb-kv', valueSizeMax } },
      };

      const putResult = await store.put(box);
      expect(putResult.isErr()).toBe(true);

      const errorMessage = putResult._unsafeUnwrapErr();
      expect(errorMessage).toContain(`Value for key '${key}' exceeds valueSizeMax`);
      expect(errorMessage).toMatch(/\d+ bytes encoded/);
      expect(errorMessage).toContain(`limit ${valueSizeMax}`);

      // The rejected put must not have been stored.
      const getResult = await store.get(box.location);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toBe('Value not found');
    });

    it('get should still return a value that exceeds the current valueSizeMax, since the cap is write-side only', async () => {
      const key = 'kv-key-shrunk-limit';
      const content = 'y'.repeat(64);

      const putBox: Box<unknown> = {
        content,
        location: { workspace, workflow, key, strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };
      const putResult = await store.put(putBox);
      expect(putResult.isOk()).toBe(true);

      // The value was written under a generous valueSizeMax. Reading it back
      // through a location whose declared valueSizeMax has since shrunk
      // below the stored value's size must still succeed.
      const shrunkLocation: BoxLocation = {
        workspace,
        workflow,
        key,
        strategy: { name: 'lmdb-kv', valueSizeMax: 8 },
      };

      const getResult = await store.get(shrunkLocation);
      expect(getResult.isOk()).toBe(true);
      expect(getResult._unsafeUnwrap()).toBe(content);
    });
  });

  describe('lmdb-fifo strategy', () => {
    it('should put and get items in FIFO order', async () => {
      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 4,
        valueSizeMax: 1024,
      };
      const key = 'fifo-key-1';

      const box1: Box<string> = {
        content: 'item1',
        location: { workspace, workflow, key, strategy },
      };
      const box2: Box<string> = {
        content: 'item2',
        location: { workspace, workflow, key, strategy },
      };

      const putResult1 = await store.put(box1);
      expect(putResult1.isOk()).toBe(true);
      const putResult2 = await store.put(box2);
      expect(putResult2.isOk()).toBe(true);

      const boxLocation: BoxLocation = {
        workspace,
        workflow,
        key,
        strategy,
      };

      const getResult1 = await store.get(boxLocation);
      expect(getResult1.isOk()).toBe(true);
      expect(getResult1._unsafeUnwrap()).toBe('item1');

      const getResult2 = await store.get(boxLocation);
      expect(getResult2.isOk()).toBe(true);
      expect(getResult2._unsafeUnwrap()).toBe('item2');

      const getResult3 = await store.get(boxLocation);
      expect(getResult3.isErr()).toBe(true);
      expect(getResult3._unsafeUnwrapErr()).toBe('Queue empty');
    });

    it('should return error when queue is empty', async () => {
      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 4,
        valueSizeMax: 1024,
      };
      const key = 'fifo-key-2';
      const boxLocation: BoxLocation = {
        workspace,
        workflow,
        key,
        strategy,
      };

      const getResult = await store.get(boxLocation);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toBe('Queue empty');
    });

    it('should return error when queue is full', async () => {
      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 4,
        valueSizeMax: 1024,
      };
      const key = 'fifo-key-3';

      const putItem = async (val: string) => {
        return store.put({
          content: val,
          location: { workspace, workflow, key, strategy },
        });
      };

      // queueSizeMax = 4 allows at most 3 items because 1 slot is kept empty
      expect((await putItem('a')).isOk()).toBe(true);
      expect((await putItem('b')).isOk()).toBe(true);
      expect((await putItem('c')).isOk()).toBe(true);

      const fullPutResult = await putItem('d');
      expect(fullPutResult.isErr()).toBe(true);
      expect(fullPutResult._unsafeUnwrapErr()).toBe(
        "Queue is full 'lmdb-fifo'",
      );
    });

    it('should free a dequeued slot\'s data key so a drained queue does not hold stale bytes', async () => {
      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 4,
        valueSizeMax: 1024,
      };
      const key = 'fifo-key-free-slot';
      const boxLocation: BoxLocation = { workspace, workflow, key, strategy };

      const putResult = await store.put({
        content: 'to-be-dequeued',
        location: boxLocation,
      });
      expect(putResult.isOk()).toBe(true);

      const dataDbiKey = `fifo:${key}:data:0`;
      const dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();

      // The value is present before the dequeue.
      expect(dbi.get(dataDbiKey)).toBe('to-be-dequeued');

      const getResult = await store.get(boxLocation);
      expect(getResult.isOk()).toBe(true);
      expect(getResult._unsafeUnwrap()).toBe('to-be-dequeued');

      // getStatic must remove the slot it just consumed, not just advance
      // `tail` past it, so a drained queue's footprint tracks its depth
      // rather than holding queueSizeMax - 1 values' worth of bytes
      // indefinitely.
      expect(dbi.get(dataDbiKey)).toBeUndefined();
    });

    it('should wrap correctly with a non-power-of-2 queueSizeMax across fill/drain/refill', async () => {
      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 100,
        valueSizeMax: 1024,
      };
      const key = 'fifo-key-wrap-100';

      const boxLocation: BoxLocation = {
        workspace,
        workflow,
        key,
        strategy,
      };

      const putItem = async (val: string) => {
        return store.put({
          content: val,
          location: { workspace, workflow, key, strategy },
        });
      };

      // queueSizeMax = 100 allows at most 99 items because 1 slot is kept empty.
      const round1 = Array.from({ length: 99 }, (_, i) => `round1-item${i}`);
      for (const item of round1) {
        expect((await putItem(item)).isOk()).toBe(true);
      }

      // Queue should now be full.
      const fullResult = await putItem('round1-overflow');
      expect(fullResult.isErr()).toBe(true);
      expect(fullResult._unsafeUnwrapErr()).toBe("Queue is full 'lmdb-fifo'");

      // Drain all 99 items, verifying strict FIFO order.
      for (const expected of round1) {
        const getResult = await store.get(boxLocation);
        expect(getResult.isOk()).toBe(true);
        expect(getResult._unsafeUnwrap()).toBe(expected);
      }

      // Queue should now be empty.
      const emptyResult = await store.get(boxLocation);
      expect(emptyResult.isErr()).toBe(true);
      expect(emptyResult._unsafeUnwrapErr()).toBe('Queue empty');

      // Refill 99 more items: head/tail indices have now crossed the wrap
      // boundary (queueSizeMax) at least once. Verify strict FIFO order holds.
      const round2 = Array.from({ length: 99 }, (_, i) => `round2-item${i}`);
      for (const item of round2) {
        expect((await putItem(item)).isOk()).toBe(true);
      }

      for (const expected of round2) {
        const getResult = await store.get(boxLocation);
        expect(getResult.isOk()).toBe(true);
        expect(getResult._unsafeUnwrap()).toBe(expected);
      }

      const finalEmptyResult = await store.get(boxLocation);
      expect(finalEmptyResult.isErr()).toBe(true);
      expect(finalEmptyResult._unsafeUnwrapErr()).toBe('Queue empty');
    });

    it('should reject a put that exceeds valueSizeMax, leaving head/tail unchanged', async () => {
      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 4,
        valueSizeMax: 16,
      };
      const key = 'fifo-key-oversized';
      const boxLocation: BoxLocation = { workspace, workflow, key, strategy };

      // Put one accepted item first so head/tail are non-default, which
      // makes "unchanged" a meaningful assertion rather than "still zero".
      const seedResult = await store.put({
        content: 'ok',
        location: boxLocation,
      });
      expect(seedResult.isOk()).toBe(true);

      const dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
      const headDbiKey = `fifo:${key}:head`;
      const tailDbiKey = `fifo:${key}:tail`;

      const headBefore = dbi.get(headDbiKey);
      const tailBefore = dbi.get(tailDbiKey);

      const putResult = await store.put({
        content: 'x'.repeat(64),
        location: boxLocation,
      });

      expect(putResult.isErr()).toBe(true);
      expect(putResult._unsafeUnwrapErr()).toContain(
        `Value for key '${key}' exceeds valueSizeMax`,
      );

      // The rejection must not have mutated the queue's bookkeeping.
      expect(dbi.get(headDbiKey)).toBe(headBefore);
      expect(dbi.get(tailDbiKey)).toBe(tailBefore);
    });

    it('should not open a write transaction for an oversized FIFO put', async () => {
      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 4,
        valueSizeMax: 16,
      };
      const key = 'fifo-key-no-txn';
      const boxLocation: BoxLocation = { workspace, workflow, key, strategy };

      const transactionSyncSpy = vi.spyOn(store.dbiCache.env, 'transactionSync');

      try {
        const putResult = await store.put({
          content: 'x'.repeat(64),
          location: boxLocation,
        });

        expect(putResult.isErr()).toBe(true);
        expect(transactionSyncSpy).not.toHaveBeenCalled();
      } finally {
        transactionSyncSpy.mockRestore();
      }
    });

    it('should return a named error, not "Transaction failed", when the derived FIFO key exceeds the LIVE maximum key size', async () => {
      const dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
      const maxKeySize = readMaxKeySize(dbi)._unsafeUnwrap();

      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 4,
        valueSizeMax: 1024,
      };
      // 'fifo:' + key + ':data:' + digits(queueSizeMax - 1) must exceed the
      // limit LMDB itself reports; a key this long guarantees it regardless of
      // the digit count.
      const key = 'k'.repeat(maxKeySize);
      const boxLocation: BoxLocation = { workspace, workflow, key, strategy };

      const putResult = await store.put({
        content: 'small',
        location: boxLocation,
      });

      expect(putResult.isErr()).toBe(true);
      const errorMessage = putResult._unsafeUnwrapErr();
      expect(errorMessage).not.toContain('Transaction failed');
      expect(errorMessage).toContain("LMDB's maximum key size");
      expect(errorMessage).toContain(String(maxKeySize));
    });

    // -----------------------------------------------------------------------
    // The limit is the LIVE one, not upstream LMDB's compile-time default
    //
    // 511 is upstream LMDB's compile-time limit and is not this build's —
    // `db.maxKeySize` reports 1978 — so a guard hard-coded to 511 refuses keys
    // LMDB accepts, a static check contradicting the runtime. These two cases
    // pin the live figure from both sides.
    //
    // These write through `@rawbox/store` directly, with no workflow and no
    // runner verification, which is exactly the path on which this guard is
    // still reachable. A key arriving from a verified workflow is bounded by
    // `RAWBOX_KEY_SIZE_MAX` and cannot come near the figures here — see the
    // `is a backstop` case below.
    // -----------------------------------------------------------------------

    it('accepts a 600-byte FIFO author key — over the old 511 constant, well under the real limit', async () => {
      const dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
      const maxKeySize = readMaxKeySize(dbi)._unsafeUnwrap();

      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 4,
        valueSizeMax: 1024,
      };
      const key = 'k'.repeat(600);

      // The derived key is what LMDB weighs: 'fifo:' (5) + 600 + ':data:' (6)
      // + digits(3) (1) = 612. Past the old 511 constant, so this write used to
      // be refused outright; comfortably inside the 1978 this build reports.
      expect(600).toBeGreaterThan(511);
      expect(612).toBeLessThanOrEqual(maxKeySize);

      const putResult = await store.put({
        content: 'small',
        location: { workspace, workflow, key, strategy },
      });

      expect(putResult.isOk()).toBe(true);

      const getResult = await store.get({ workspace, workflow, key, strategy });
      expect(getResult._unsafeUnwrap()).toBe('small');
    });

    it('accepts a 1000-byte lmdb-kv key, and refuses one past the live limit with a named error', async () => {
      const dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
      const maxKeySize = readMaxKeySize(dbi)._unsafeUnwrap();

      const strategy = { name: 'lmdb-kv' as const, valueSizeMax: 1024 };

      const accepted = await store.put({
        content: 'small',
        location: { workspace, workflow, key: 'k'.repeat(1000), strategy },
      });
      expect(accepted.isOk()).toBe(true);

      // One byte past what LMDB reports. Without a key guard an over-long key
      // throws out of `dbi.putSync` and crosses the package's API boundary as
      // an exception, which nothing in this package may do.
      const refused = await store.put({
        content: 'small',
        location: {
          workspace,
          workflow,
          key: 'k'.repeat(maxKeySize + 1),
          strategy,
        },
      });

      expect(refused.isErr()).toBe(true);
      const errorMessage = refused._unsafeUnwrapErr();
      expect(errorMessage).toContain("LMDB's maximum key size");
      expect(errorMessage).toContain(String(maxKeySize + 1));
      expect(errorMessage).toContain(String(maxKeySize));
      // Not the FIFO wording: an `lmdb-kv` key is not derived.
      expect(errorMessage).not.toContain('derived');
    });

    it('is a backstop: a key inside the Rawbox contract cannot trip it, under either strategy', async () => {
      // The guard reads the linked build's real limit and keeps doing so, but
      // since `RAWBOX_KEY_SIZE_MAX` a key arriving from a verified workflow is
      // at most 79 bytes, and its worst derivation at most 32 more. Both write
      // happily here, which is what "expected never to fire" means in practice.
      const dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
      const maxKeySize = readMaxKeySize(dbi)._unsafeUnwrap();

      expect(
        RAWBOX_KEY_SIZE_MAX + RAWBOX_KEY_DERIVATION_OVERHEAD_MAX,
      ).toBeLessThanOrEqual(maxKeySize);

      const key = 'k'.repeat(RAWBOX_KEY_SIZE_MAX);

      const kvPut = await store.put({
        content: 'small',
        location: {
          workspace,
          workflow,
          key,
          strategy: { name: 'lmdb-kv', valueSizeMax: 1024 },
        },
      });
      expect(kvPut.isOk()).toBe(true);

      const fifoStrategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 2 ** 30,
        valueSizeMax: 1024,
      };
      const fifoPut = await store.put({
        content: 'small',
        location: { workspace, workflow, key: `${key.slice(1)}q`, strategy: fifoStrategy },
      });
      expect(fifoPut.isOk()).toBe(true);
    });

    it('fails closed when the build does not report db.maxKeySize', async () => {
      // `db.maxKeySize` is undocumented in lmdb-js's typings, exactly like
      // `db.encoder`, so a future release could move it. `measureValueSize`
      // has a faithful stand-in for its encoder and falls back; there is no
      // stand-in for a compile-time constant, so this refuses the write rather
      // than guessing and letting the opaque LMDB throw through.
      const dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
      const original = (dbi as unknown as { maxKeySize: number }).maxKeySize;
      Object.defineProperty(dbi, 'maxKeySize', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      try {
        const result = await store.put({
          content: 'small',
          location: {
            workspace,
            workflow,
            key: 'short',
            strategy: { name: 'lmdb-kv' as const, valueSizeMax: 1024 },
          },
        });

        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr()).toContain('db.maxKeySize');
      } finally {
        Object.defineProperty(dbi, 'maxKeySize', {
          value: original,
          configurable: true,
          writable: true,
        });
      }
    });
  });

  describe('unsupported strategy', () => {
    it('should return error for unsupported strategy', async () => {
      const box: Box<unknown> = {
        content: 'test',
        location: {
          workspace,
          workflow,
          key: 'kv-key-invalid',
          strategy: {
            name: 'invalid-strategy' as unknown as 'lmdb-kv',
            valueSizeMax: 1024,
          },
        },
      };

      const putResult = await store.put(box);
      expect(putResult.isErr()).toBe(true);
      expect(putResult._unsafeUnwrapErr()).toContain(
        "Unsupported strategy: 'invalid-strategy'",
      );

      const getResult = await store.get(box.location);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toContain(
        "Unsupported strategy: 'invalid-strategy'",
      );

      // The guarantee, not just the refusal. `BoxStrategy` is now an open set
      // — `redis-kv` is a legal strategy this class does not route — so the one
      // reading a caller must never be left with is that the write quietly
      // landed in LMDB under some default. It did not, and the message says so.
      expect(putResult._unsafeUnwrapErr()).toContain('nothing fell back to LMDB');
    });
  });

  describe('transaction', () => {
    it('should execute multiple operations and commit successfully', async () => {
      const box1: Box<unknown> = {
        content: 'tx-val-1',
        location: { workspace, workflow, key: 'tx-key-1', strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };
      const box2: Box<unknown> = {
        content: 'tx-val-2',
        location: { workspace, workflow, key: 'tx-key-2', strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };

      const txResult = await store.transaction((txStore) => {
        txStore.putSync(box1);
        txStore.putSync(box2);
        return ok('success');
      });

      expect(txResult.isOk()).toBe(true);
      expect(txResult._unsafeUnwrap()).toBe('success');

      // Verify data is committed
      const getResult1 = await store.get(box1.location);
      expect(getResult1.isOk()).toBe(true);
      expect(getResult1._unsafeUnwrap()).toBe('tx-val-1');

      const getResult2 = await store.get(box2.location);
      expect(getResult2.isOk()).toBe(true);
      expect(getResult2._unsafeUnwrap()).toBe('tx-val-2');
    });

    it('should rollback changes if callback throws an error', async () => {
      const box: Box<unknown> = {
        content: 'should-not-exist-throw',
        location: { workspace, workflow, key: 'tx-key-3', strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };

      const txResult = await store.transaction<never>((txStore) => {
        txStore.putSync(box);
        throw new Error('Test abort error');
      });

      expect(txResult.isErr()).toBe(true);
      expect(txResult._unsafeUnwrapErr()).toContain('Test abort error');

      // Verify data is NOT committed
      const getResult = await store.get(box.location);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toBe('Value not found');
    });

    it('should rollback changes if callback returns a Result.err', async () => {
      const box: Box<unknown> = {
        content: 'should-not-exist-result-err',
        location: { workspace, workflow, key: 'tx-key-4', strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };

      const txResult = await store.transaction((txStore) => {
        txStore.putSync(box);
        return err('Custom rollback error');
      });

      expect(txResult.isErr()).toBe(true);
      expect(txResult._unsafeUnwrapErr()).toBe('Custom rollback error');

      // Verify data is NOT committed
      const getResult = await store.get(box.location);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toBe('Value not found');
    });

    it('should work when internal operations call transactionSync (lmdb-fifo uses nested transactions)', async () => {
      const strategy = {
        name: 'lmdb-fifo' as const,
        queueSizeMax: 4,
        valueSizeMax: 1024,
      };
      const key = 'fifo-tx-key';

      const box1: Box<string> = {
        content: 'fifo-tx-1',
        location: { workspace, workflow, key, strategy },
      };
      const box2: Box<string> = {
        content: 'fifo-tx-2',
        location: { workspace, workflow, key, strategy },
      };

      const txResult = await store.transaction((txStore) => {
        // The lmdb-fifo putStatic internally calls dbiCache.env.transactionSync().
        // By calling it inside this store.transaction() block, we test lmdb's nested transaction behavior.
        const p1 = txStore.putSync(box1);
        if (p1.isErr()) return err(p1.error);
        const p2 = txStore.putSync(box2);
        if (p2.isErr()) return err(p2.error);
        return ok('fifo-success');
      });

      expect(txResult.isOk()).toBe(true);
      expect(txResult._unsafeUnwrap()).toBe('fifo-success');

      // Verify queue items are present in FIFO order
      const boxLocation: BoxLocation = {
        workspace,
        workflow,
        key,
        strategy,
      };
      const getResult1 = await store.get(boxLocation);
      expect(getResult1.isOk()).toBe(true);
      expect(getResult1._unsafeUnwrap()).toBe('fifo-tx-1');

      const getResult2 = await store.get(boxLocation);
      expect(getResult2.isOk()).toBe(true);
      expect(getResult2._unsafeUnwrap()).toBe('fifo-tx-2');
    });
  });

  // -------------------------------------------------------------------------
  // The storage budget is reported, never enforced
  //
  // The budget exists so an operator can size a container before a workflow
  // runs. It is deliberately NOT a runtime gate, and the tests here are the
  // guard against that decision being quietly reversed: a store knows nothing
  // about `budgetForStorage`, takes no budget argument, and refuses no write
  // for having grown.
  // -------------------------------------------------------------------------
  describe('storage budget is not enforced', () => {
    /** Values large enough to move the high-water mark, random so LZ4 cannot help. */
    const VALUE_BYTES = 4000;
    /** Enough writes to blow well past the declared budget computed below. */
    const WRITE_ATTEMPTS = 600;

    const kvStrategy = { name: 'lmdb-kv' as const, valueSizeMax: 8192 };

    const createdStoreList: BoxStoreLmdb[] = [];

    function createTracked(targetWorkspace: string): BoxStoreLmdb {
      const created = BoxStoreLmdb.create(targetWorkspace, dbDirUrl);
      createdStoreList.push(created);

      return created;
    }

    /** Bytes `data.mdb` actually occupies for a workspace under `dbDirUrl`. */
    async function dataFileBytes(targetWorkspace: string): Promise<number> {
      const dataFileUrl = new URL(`./${targetWorkspace}/data.mdb`, dbDirUrl);

      return (await fs.stat(fileURLToPath(dataFileUrl))).size;
    }

    afterAll(async () => {
      for (const createdStore of createdStoreList) {
        try {
          await createdStore.dbiCache.env.close();
        } catch {
          void 0;
        }
      }
    });

    it('writes far past the declared budget without the store objecting', async () => {
      // A storage block declaring a single small key: its whole workspace
      // budget is a few hundred KiB. The workload below writes ~2.4 MB into it.
      const storage: BoxStorage = {
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
        seed: { only_key: 'seeded-value' },
      };
      const budget = budgetForStorage(storage);

      const overrunWorkspace = 'budget-overrun-workspace';
      const overrunStore = createTracked(overrunWorkspace);

      for (let index = 0; index < WRITE_ATTEMPTS; index += 1) {
        const putResult = await overrunStore.put({
          content: randomBytes(VALUE_BYTES),
          location: {
            workspace: overrunWorkspace,
            workflow,
            key: `overrun-key-${index}`,
            strategy: kvStrategy,
          },
        });

        // Not `isOk()` alone: naming the error is what makes a regression here
        // readable rather than a bare `false !== true`.
        expect(
          putResult.isErr() ? putResult._unsafeUnwrapErr() : undefined,
        ).toBeUndefined();
      }

      // And it really did overshoot, so the assertion above was not vacuous.
      const fileBytes = await dataFileBytes(overrunWorkspace);
      expect(fileBytes).toBeGreaterThan(budget.recommendedVolumeBytes);
    });

    it('takes no budget argument: create(workspace, rootDirectoryUrl) is the whole API', () => {
      // A tripwire on the signature itself. `create.length` is 2, so a third
      // parameter — however innocuous — fails here, and `BoxStoreLmdb` carries
      // no budget field for a write path to consult.
      expect(BoxStoreLmdb.create.length).toBe(2);

      const plainStore = createTracked('budget-absent-workspace');
      expect(Object.keys(plainStore)).toEqual(
        expect.not.arrayContaining(['mapSizeMax']),
      );
    });

    it('opens a cached environment once, with no budget to collide over', () => {
      const envCache = new LmdbEnvCache<unknown, string>(dbDirUrl);
      const envIdentifier = 'budget-none-workspace';

      const first = envCache.getOrCreateEnv(envIdentifier);
      expect(first.isOk()).toBe(true);

      const second = envCache.getOrCreateEnv(envIdentifier);
      expect(second.isOk()).toBe(true);
      expect(second._unsafeUnwrap()).toBe(first._unsafeUnwrap());

      void first._unsafeUnwrap().close();
    });
  });
});
