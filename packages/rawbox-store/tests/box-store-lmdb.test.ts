import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BoxStoreLmdb } from '../src/box-store/box-store-lmdb.js';
import { type Box, type BoxLocation } from '../src/box.js';
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
        location: { workspace, workflow, key: 1, strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
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
        location: { workspace, workflow, key: 2, strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };
      const box2: Box<unknown> = {
        content: 'updated-value',
        location: { workspace, workflow, key: 2, strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
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
        key: 99999,
        strategy: { name: 'lmdb-kv', valueSizeMax: 1024 },
      };

      const getResult = await store.get(boxLocation);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toBe('Value not found');
    });

    it('should throw an error if key is out of bounds for buildDbiKey', async () => {
      const invalidBox: Box<unknown> = {
        content: 'test',
        location: { workspace, workflow, key: 1048576, strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } }, // limit is 1048575 (0xfffff)
      };

      await expect(store.put(invalidBox)).rejects.toThrow();

      const invalidBoxLocation: BoxLocation = {
        workspace,
        workflow,
        key: -1,
        strategy: { name: 'lmdb-kv', valueSizeMax: 1024 },
      };

      await expect(store.get(invalidBoxLocation)).rejects.toThrow();
    });
  });

  describe('lmdb-fifo strategy', () => {
    it('should put and get items in FIFO order', async () => {
      const strategy = { name: 'lmdb-fifo' as const, queueSizeMax: 4 };
      const key = 10;

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
      const strategy = { name: 'lmdb-fifo' as const, queueSizeMax: 4 };
      const key = 11;
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
      const strategy = { name: 'lmdb-fifo' as const, queueSizeMax: 4 };
      const key = 12;

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

    it('should return error if queueSizeMax is not a power of 2', async () => {
      const invalidStrategy = { name: 'lmdb-fifo' as const, queueSizeMax: 5 };
      const key = 13;

      const box: Box<string> = {
        content: 'test',
        location: { workspace, workflow, key, strategy: invalidStrategy },
      };

      const putResult = await store.put(box);
      expect(putResult.isErr()).toBe(true);
      expect(putResult._unsafeUnwrapErr()).toContain(
        'queueSizeMax must be a power of 2',
      );

      const getResult = await store.get({
        workspace,
        workflow,
        key,
        strategy: invalidStrategy,
      });
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toContain(
        'queueSizeMax must be a power of 2',
      );
    });

    it('should return error if FIFO key is invalid', async () => {
      const strategy = { name: 'lmdb-fifo' as const, queueSizeMax: 4 };

      // Key 0 is reserved for lmdb-kv
      const boxKey0: Box<string> = {
        content: 'test',
        location: { workspace, workflow, key: 0, strategy },
      };
      const putResult0 = await store.put(boxKey0);
      expect(putResult0.isErr()).toBe(true);
      expect(putResult0._unsafeUnwrapErr()).toBe(
        'Key 0 is reserved for lmdb-kv strategy',
      );

      const getResult0 = await store.get({
        workspace,
        workflow,
        key: 0,
        strategy,
      });
      expect(getResult0.isErr()).toBe(true);
      expect(getResult0._unsafeUnwrapErr()).toBe(
        'Key 0 is reserved for lmdb-kv strategy',
      );

      // Key >= 4096
      const boxKeyTooLarge: Box<string> = {
        content: 'test',
        location: { workspace, workflow, key: 4096, strategy },
      };
      const putResultTooLarge = await store.put(boxKeyTooLarge);
      expect(putResultTooLarge.isErr()).toBe(true);
      expect(putResultTooLarge._unsafeUnwrapErr()).toBe(
        'Key too large: must be < 4096 for lmdb-fifo strategy to avoid bitwise overflow',
      );

      const getResultTooLarge = await store.get({
        workspace,
        workflow,
        key: 4096,
        strategy,
      });
      expect(getResultTooLarge.isErr()).toBe(true);
      expect(getResultTooLarge._unsafeUnwrapErr()).toBe(
        'Key too large: must be < 4096 for lmdb-fifo strategy to avoid bitwise overflow',
      );
    });
  });

  describe('unsupported strategy', () => {
    it('should return error for unsupported strategy', async () => {
      const box: Box<unknown> = {
        content: 'test',
        location: {
          workspace,
          workflow,
          key: 1,
          strategy: {
            name: 'invalid-strategy' as unknown as 'lmdb-kv',
            valueSizeMax: 1024,
          },
        },
      };

      const putResult = await store.put(box);
      expect(putResult.isErr()).toBe(true);
      expect(putResult._unsafeUnwrapErr()).toBe(
        "Unsupported strategy: 'invalid-strategy'",
      );

      const getResult = await store.get(box.location);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toBe(
        "Unsupported strategy: 'invalid-strategy'",
      );
    });
  });

  describe('transaction', () => {
    it('should execute multiple operations and commit successfully', async () => {
      const box1: Box<unknown> = {
        content: 'tx-val-1',
        location: { workspace, workflow, key: 100, strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };
      const box2: Box<unknown> = {
        content: 'tx-val-2',
        location: { workspace, workflow, key: 101, strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };

      const txResult = store.transaction((txStore) => {
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
        location: { workspace, workflow, key: 102, strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };

      const txResult = store.transaction<never>((txStore) => {
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
        location: { workspace, workflow, key: 103, strategy: { name: 'lmdb-kv', valueSizeMax: 1024 } },
      };

      const txResult = store.transaction((txStore) => {
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
      const strategy = { name: 'lmdb-fifo' as const, queueSizeMax: 4 };
      const key = 20;

      const box1: Box<string> = {
        content: 'fifo-tx-1',
        location: { workspace, workflow, key, strategy },
      };
      const box2: Box<string> = {
        content: 'fifo-tx-2',
        location: { workspace, workflow, key, strategy },
      };

      const txResult = store.transaction((txStore) => {
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
});
