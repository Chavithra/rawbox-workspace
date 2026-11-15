import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

import { type BoxLocation, type BoxStrategy } from '../../src/index.js';
import { BoxStorePg, PgPoolCache } from '../../src/box-store/box-store-pg.js';
import { BoxObserverPg } from '../../src/box-store/box-observer-pg.js';
import { createPgTestEnvironment, type PgTestHandle } from '../pg-test-support.js';

const KV_STRATEGY: BoxStrategy = {
  name: 'pg-kv',
  backend: 'primary',
  valueSizeMax: 1024,
};

const FIFO_STRATEGY: BoxStrategy = {
  name: 'pg-fifo',
  backend: 'primary',
  queueSizeMax: 5,
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

describe('BoxObserverPg', () => {
  const WORKSPACE_PREFIX = 'pg_obs_test_';
  const WORKSPACE = `${WORKSPACE_PREFIX}${Date.now()}`;

  let pgEnv: PgTestHandle;
  let poolCache: PgPoolCache;
  let store: BoxStorePg;
  let observer: BoxObserverPg;

  beforeAll(async () => {
    pgEnv = await createPgTestEnvironment();
    poolCache = new PgPoolCache();
    store = (
      await BoxStorePg.create(WORKSPACE, pgEnv.connection, poolCache)
    )._unsafeUnwrap();
    observer = (
      await BoxObserverPg.create(WORKSPACE, pgEnv.connection, poolCache)
    )._unsafeUnwrap();
  });

  beforeEach(async () => {
    await pgEnv.cleanupWorkspace(WORKSPACE_PREFIX);
  });

  afterAll(async () => {
    await observer.close();
    await pgEnv.cleanupWorkspace(WORKSPACE_PREFIX);
    await poolCache.closeAll();
    await pgEnv.dispose();
  });

  it('enumerates workflows and keys accurately without consuming FIFO entries', async () => {
    const kvLoc = loc(WORKSPACE, 'wf_a', 'cell_key', KV_STRATEGY);
    const fifoLoc = loc(WORKSPACE, 'wf_b', 'queue_key', FIFO_STRATEGY);

    await store.transact({
      puts: [
        { location: kvLoc, content: { ok: true } },
        { location: fifoLoc, content: 'first' },
        { location: fifoLoc, content: 'second' },
      ],
    });

    const workflows = (await observer.listWorkflows())._unsafeUnwrap();
    expect(workflows).toEqual(['wf_a', 'wf_b']);

    const keysA = (await observer.listKeys('wf_a'))._unsafeUnwrap();
    expect(keysA).toEqual([
      {
        key: 'cell_key',
        strategy: 'pg-kv',
        entryCount: 1,
        valueSizeBytes: expect.any(Number),
        valueSizeMaxBytes: expect.any(Number),
      },
    ]);

    const keysB = (await observer.listKeys('wf_b'))._unsafeUnwrap();
    expect(keysB).toEqual([
      {
        key: 'queue_key',
        strategy: 'pg-fifo',
        entryCount: 2,
        valueSizeBytes: expect.any(Number),
        valueSizeMaxBytes: expect.any(Number),
        queueDepth: 2,
      },
    ]);

    // Non-destructive peek and peekAll preserve FIFO ordering and items.
    expect((await observer.peek(kvLoc))._unsafeUnwrap()).toEqual({ ok: true });
    expect((await observer.peek(fifoLoc))._unsafeUnwrap()).toBe('first');
    expect((await observer.peekAll(fifoLoc))._unsafeUnwrap()).toEqual([
      'first',
      'second',
    ]);
    expect((await observer.depth(fifoLoc))._unsafeUnwrap()).toEqual({
      used: 2,
      capacity: 5,
    });

    // Consumer still pops both items in FIFO order afterwards.
    expect((await store.get(fifoLoc))._unsafeUnwrap()).toBe('first');
    expect((await store.get(fifoLoc))._unsafeUnwrap()).toBe('second');
  });

  it('reports depth errors for pg-kv and strategy mismatches cleanly', async () => {
    const kvLoc = loc(WORKSPACE, 'wf_a', 'cell_key', KV_STRATEGY);
    const fifoWrongLoc = loc(WORKSPACE, 'wf_a', 'cell_key', FIFO_STRATEGY);

    await store.put({ location: kvLoc, content: 42 });

    const depthOnCell = await observer.depth(kvLoc);
    expect(depthOnCell.isErr()).toBe(true);
    expect(depthOnCell._unsafeUnwrapErr()).toContain('Depth is not a property');

    const peekMismatch = await observer.peek(fifoWrongLoc);
    expect(peekMismatch.isErr()).toBe(true);
    expect(peekMismatch._unsafeUnwrapErr()).toContain('pg-kv');

    const peekAllCell = await observer.peekAll(kvLoc);
    expect(peekAllCell._unsafeUnwrap()).toEqual([42]);
  });

  it('refuses calls cleanly after close()', async () => {
    const obs2 = (
      await BoxObserverPg.create(WORKSPACE, pgEnv.connection, poolCache)
    )._unsafeUnwrap();

    await obs2.close();
    await obs2.close();

    expect((await obs2.listWorkflows())._unsafeUnwrapErr()).toContain('closed');
    expect((await obs2.listKeys('wf_a'))._unsafeUnwrapErr()).toContain('closed');
    expect(
      (await obs2.peek(loc(WORKSPACE, 'wf_a', 'k', KV_STRATEGY)))._unsafeUnwrapErr(),
    ).toContain('closed');
  });
});
