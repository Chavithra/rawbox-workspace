import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { type BoxLocation, type BoxStrategy } from '../../src/index.js';
import { BoxStoreLmdb } from '../../src/box-store/box-store-lmdb.js';
import { BoxStorePg, PgPoolCache } from '../../src/box-store/box-store-pg.js';
import { createPgTestEnvironment, type PgTestHandle } from '../pg-test-support.js';

const KV_STRATEGY: BoxStrategy = {
  name: 'pg-kv',
  backend: 'primary',
  valueSizeMax: 1024,
};

const FIFO_STRATEGY: BoxStrategy = {
  name: 'pg-fifo',
  backend: 'primary',
  queueSizeMax: 3,
  valueSizeMax: 1024,
};

function loc(
  workspace: string,
  workflow: string,
  key: string,
  strategy: BoxStrategy,
): BoxLocation {
  return { workspace, workflow, key, strategy };
}

describe('BoxStorePg', () => {
  const WORKSPACE_PREFIX = 'pg_store_test_';
  const WORKSPACE = `${WORKSPACE_PREFIX}${Date.now()}`;
  const WORKFLOW = 'wf_main';

  let pgEnv: PgTestHandle;
  let poolCache: PgPoolCache;
  let store: BoxStorePg;

  beforeAll(async () => {
    pgEnv = await createPgTestEnvironment();
    poolCache = new PgPoolCache();
    store = (
      await BoxStorePg.create(WORKSPACE, pgEnv.connection, poolCache)
    )._unsafeUnwrap();
  });

  beforeEach(async () => {
    await pgEnv.cleanupWorkspace(WORKSPACE_PREFIX);
  });

  afterAll(async () => {
    await pgEnv.cleanupWorkspace(WORKSPACE_PREFIX);
    await poolCache.closeAll();
    await pgEnv.dispose();
  });

  it('rejects invalid connection URLs and workspace mismatches', async () => {
    const badCache = new PgPoolCache();
    const badRes = await BoxStorePg.create(WORKSPACE, 'http://localhost:5432/db', badCache);
    expect(badRes.isErr()).toBe(true);
    expect(badRes._unsafeUnwrapErr()).toContain('Invalid PostgreSQL connection string');
    await badCache.closeAll();

    const mismatchRes = await store.put({
      location: loc('other-ws', WORKFLOW, 'k', KV_STRATEGY),
      content: 123,
    });
    expect(mismatchRes.isErr()).toBe(true);
    expect(mismatchRes._unsafeUnwrapErr()).toContain('Workspace mismatch');
  });

  it('stores, overwrites, and reads pg-kv boxes cleanly', async () => {
    const location = loc(WORKSPACE, WORKFLOW, 'config', KV_STRATEGY);

    const missing = await store.get(location);
    expect(missing.isErr()).toBe(true);
    expect(missing._unsafeUnwrapErr()).toBe('Value not found');

    expect((await store.put({ location, content: { step: 1, ok: true } })).isOk()).toBe(true);
    expect((await store.get(location))._unsafeUnwrap()).toEqual({ step: 1, ok: true });

    // Overwrite in place; subsequent read retains updated value.
    expect((await store.put({ location, content: { step: 2 } })).isOk()).toBe(true);
    expect((await store.get(location))._unsafeUnwrap()).toEqual({ step: 2 });
    expect((await store.get(location))._unsafeUnwrap()).toEqual({ step: 2 });
  });

  it('enforces strict FIFO order, queueSizeMax capacity, and empty errors for pg-fifo', async () => {
    const qLoc = loc(WORKSPACE, WORKFLOW, 'jobs', FIFO_STRATEGY);

    expect((await store.get(qLoc))._unsafeUnwrapErr()).toBe('Queue empty');

    expect((await store.put({ location: qLoc, content: 'job-1' })).isOk()).toBe(true);
    expect((await store.put({ location: qLoc, content: 'job-2' })).isOk()).toBe(true);
    expect((await store.put({ location: qLoc, content: 'job-3' })).isOk()).toBe(true);

    // Full at queueSizeMax = 3
    const overflow = await store.put({ location: qLoc, content: 'job-4' });
    expect(overflow.isErr()).toBe(true);
    expect(overflow._unsafeUnwrapErr()).toContain('Queue is full');

    expect((await store.get(qLoc))._unsafeUnwrap()).toBe('job-1');
    expect((await store.get(qLoc))._unsafeUnwrap()).toBe('job-2');

    // Capacity freed after popping
    expect((await store.put({ location: qLoc, content: 'job-4' })).isOk()).toBe(true);
    expect((await store.get(qLoc))._unsafeUnwrap()).toBe('job-3');
    expect((await store.get(qLoc))._unsafeUnwrap()).toBe('job-4');
    expect((await store.get(qLoc))._unsafeUnwrapErr()).toBe('Queue empty');
  });

  it('enforces valueSizeMax before writing to PostgreSQL', async () => {
    const smallKv: BoxStrategy = { name: 'pg-kv', backend: 'primary', valueSizeMax: 16 };
    const location = loc(WORKSPACE, WORKFLOW, 'tiny', smallKv);

    const res = await store.put({
      location,
      content: 'this payload is certainly well above sixteen msgpack bytes',
    });
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr()).toContain('exceeds valueSizeMax');
    expect((await store.get(location))._unsafeUnwrapErr()).toBe('Value not found');
  });

  it('prevents strategy mismatch (WRONGTYPE) between pg-kv and pg-fifo on the same key', async () => {
    const kvLoc = loc(WORKSPACE, WORKFLOW, 'shared_name', KV_STRATEGY);
    const fifoLoc = loc(WORKSPACE, WORKFLOW, 'shared_name', FIFO_STRATEGY);

    expect((await store.put({ location: kvLoc, content: 'cell' })).isOk()).toBe(true);

    const mismatchPut = await store.put({ location: fifoLoc, content: 'elem' });
    expect(mismatchPut.isErr()).toBe(true);
    expect(mismatchPut._unsafeUnwrapErr()).toContain('pg-kv');

    const mismatchGet = await store.get(fifoLoc);
    expect(mismatchGet.isErr()).toBe(true);
    expect(mismatchGet._unsafeUnwrapErr()).toContain('pg-kv');

    // Original kv cell remains intact
    expect((await store.get(kvLoc))._unsafeUnwrap()).toBe('cell');
  });

  describe('transact() atomicity & rollback guarantees', () => {
    it('commits puts and pops atomically and supports read-your-own-writes', async () => {
      const kvOut = loc(WORKSPACE, WORKFLOW, 'state', KV_STRATEGY);
      const qOut = loc(WORKSPACE, WORKFLOW, 'q_out', FIFO_STRATEGY);

      const txRes = await store.transact({
        puts: [
          { location: kvOut, content: { phase: 'done' } },
          { location: qOut, content: 'item-a' },
          { location: qOut, content: 'item-b' },
        ],
        gets: {
          readKv: kvOut,
          popFirst: qOut,
        },
      });

      expect(txRes.isOk()).toBe(true);
      expect(txRes._unsafeUnwrap()).toEqual({
        readKv: { phase: 'done' },
        popFirst: 'item-a',
      });

      // item-b remains in queue
      expect((await store.get(qOut))._unsafeUnwrap()).toBe('item-b');
    });

    it('rolls back all puts when a subsequent put hits queueSizeMax', async () => {
      const kvLoc = loc(WORKSPACE, WORKFLOW, 'cell_before_full', KV_STRATEGY);
      const qLoc = loc(WORKSPACE, WORKFLOW, 'bounded_q', {
        ...FIFO_STRATEGY,
        queueSizeMax: 2,
      });

      // Pre-fill bounded_q to capacity 2
      expect((await store.put({ location: qLoc, content: 'e1' })).isOk()).toBe(true);
      expect((await store.put({ location: qLoc, content: 'e2' })).isOk()).toBe(true);

      const txRes = await store.transact({
        puts: [
          { location: kvLoc, content: 'should-not-persist' },
          { location: qLoc, content: 'overflow' },
        ],
      });

      expect(txRes.isErr()).toBe(true);
      expect(txRes._unsafeUnwrapErr()).toContain('Queue is full');
      // First put must have rolled back completely
      expect((await store.get(kvLoc))._unsafeUnwrapErr()).toBe('Value not found');
    });

    it('rolls back all puts and pops when a subsequent get fails (missing key or empty queue)', async () => {
      const kvWrite = loc(WORKSPACE, WORKFLOW, 'written_in_tx', KV_STRATEGY);
      const qPoppable = loc(WORKSPACE, WORKFLOW, 'poppable_q', FIFO_STRATEGY);
      const missingKv = loc(WORKSPACE, WORKFLOW, 'does_not_exist', KV_STRATEGY);

      expect((await store.put({ location: qPoppable, content: 'must-stay' })).isOk()).toBe(true);

      const txRes = await store.transact({
        puts: [{ location: kvWrite, content: 'rolled-back' }],
        gets: {
          qVal: qPoppable,
          missing: missingKv,
        },
      });

      expect(txRes.isErr()).toBe(true);
      expect(txRes._unsafeUnwrapErr()).toBe('Value not found');

      // Neither the put nor the earlier queue pop committed
      expect((await store.get(kvWrite))._unsafeUnwrapErr()).toBe('Value not found');
      expect((await store.get(qPoppable))._unsafeUnwrap()).toBe('must-stay');
    });

    it('rolls back when a batch mixes puts into a wrong-strategy key', async () => {
      const cleanKv = loc(WORKSPACE, WORKFLOW, 'clean_kv', KV_STRATEGY);
      const existingFifo = loc(WORKSPACE, WORKFLOW, 'existing_fifo', FIFO_STRATEGY);
      const conflictingKv = loc(WORKSPACE, WORKFLOW, 'existing_fifo', KV_STRATEGY);

      expect((await store.put({ location: existingFifo, content: 'keep' })).isOk()).toBe(true);

      const txRes = await store.transact({
        puts: [
          { location: cleanKv, content: 'rolled-back' },
          { location: conflictingKv, content: 'clobber' },
        ],
      });

      expect(txRes.isErr()).toBe(true);
      expect(txRes._unsafeUnwrapErr()).toContain('pg-fifo');
      expect((await store.get(cleanKv))._unsafeUnwrapErr()).toBe('Value not found');
      expect((await store.get(existingFifo))._unsafeUnwrap()).toBe('keep');
    });
  });

  describe('BoxStoreLmdb.transact', () => {
    it('executes puts and gets atomically and rolls back on failure', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rawbox-lmdb-tx-'));
      const storeLmdb = BoxStoreLmdb.create('lmdb-tx-ws', pathToFileURL(tempDir))._unsafeUnwrap();
      const lmdbKv: BoxStrategy = { name: 'lmdb-kv', valueSizeMax: 1024 };

      try {
        const kv1 = loc('lmdb-tx-ws', 'wf', 'k1', lmdbKv);
        const missing = loc('lmdb-tx-ws', 'wf', 'missing', lmdbKv);

        const failRes = await storeLmdb.transact({
          puts: [{ location: kv1, content: 'should-abort' }],
          gets: { m: missing },
        });
        expect(failRes.isErr()).toBe(true);
        expect((await storeLmdb.get(kv1))._unsafeUnwrapErr()).toBe('Value not found');

        const okRes = await storeLmdb.transact({
          puts: [{ location: kv1, content: 'committed' }],
          gets: { readBack: kv1 },
        });
        expect(okRes.isOk()).toBe(true);
        expect(okRes._unsafeUnwrap()).toEqual({ readBack: 'committed' });
      } finally {
        storeLmdb.dbiCache.env.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
