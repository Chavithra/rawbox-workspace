// ---------------------------------------------------------------------------
// `BoxObserverRedis` against a real server.
//
// Runs for real against whatever `resolveRedisTarget()` finds (typically
// `REDIS_URL` — see redis-test-support.ts's module comment). With no target
// available, every test below skips via `ctx.skip(message)`, printing the
// full diagnostic while keeping the suite green — the same posture as
// `box-store-redis.test.ts`.
//
// **`redis-fifo` has no store implementation yet (#15 builds it)**, so every
// test that needs a list-shaped key builds one with a raw `RPUSH` through the
// bare client — that is test setup standing in for a writer that does not
// exist yet, not this class writing anything (`BoxObserverRedis` never
// issues a write command; see its own class doc comment). Elements are
// packed with a `Packr({ copyBuffers: true })` instance built the same way
// `box-observer-redis.ts`'s own decoder is, so what this suite writes by hand
// decodes exactly as a real `redis-fifo` writer's bytes would.
//
// ## Isolation
//
// Same reasoning as `box-store-redis.test.ts`: `createRedisTestNamespace`
// prefixes at the front of the key, but this store's scheme is
// `rawbox:<workspace>:<workflow>:<key>` — the namespacing fields sit *after*
// a fixed `rawbox:` literal. So each test gets its own random `workspace` id
// and this file scans `rawbox:<workspace>:*` directly for cleanup.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, type TestContext } from 'vitest';
import type { RedisClientType } from 'redis';
import { Packr } from 'msgpackr';

import { BoxObserverRedis } from '../src/box-store/box-observer-redis.js';
import { RedisClientCache } from '../src/box-store/box-store-redis.js';
import { type BoxLocation } from '../src/box.js';
import { seedCapacityOf } from '../src/strategy/descriptor.js';
import {
  resolveRedisTarget,
  stopEphemeralRedisServer,
  createRedisTestClient,
  closeRedisTestClient,
} from './redis-test-support.js';

const testPackr = new Packr({ copyBuffers: true });

function packValue(value: unknown): Buffer {
  return Buffer.from(testPackr.pack(value));
}

function randomWorkspace(): string {
  return `redis-observer-test-${randomBytes(8).toString('hex')}`;
}

/** Every key under `rawbox:<workspace>:*`, via raw `SCAN` — used both for cleanup and for the "no writes" assertion. */
async function scanWorkspaceKeys(
  client: RedisClientType,
  workspace: string,
): Promise<string[]> {
  const pattern = `rawbox:${workspace}:*`;
  const keyList: string[] = [];
  let cursor = '0';

  do {
    const scanResult = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = scanResult.cursor;
    keyList.push(...scanResult.keys);
  } while (cursor !== '0');

  return keyList.sort();
}

async function cleanupWorkspace(client: RedisClientType, workspace: string): Promise<void> {
  const keyList = await scanWorkspaceKeys(client, workspace);
  if (keyList.length > 0) {
    await client.del(keyList);
  }
}

const REDIS_KV: { name: 'redis-kv'; valueSizeMax: number; backend: string } = {
  name: 'redis-kv',
  valueSizeMax: 1024,
  backend: 'main',
};

function redisFifoStrategy(queueSizeMax: number) {
  return { name: 'redis-fifo' as const, queueSizeMax, valueSizeMax: 1024, backend: 'main' };
}

describe('BoxObserverRedis', () => {
  let rawClient: RedisClientType | undefined;
  let clientCache: RedisClientCache | undefined;
  let connectionUrl: string | undefined;

  beforeAll(async () => {
    const target = await resolveRedisTarget();

    if (target.ok) {
      connectionUrl = target.url;
      rawClient = createRedisTestClient(target.url);
      await rawClient.connect();
      clientCache = new RedisClientCache();
    } else {
      process.stdout.write(`\n${target.message}\n\n`);
    }
  });

  afterAll(async () => {
    if (clientCache) {
      await clientCache.closeAll();
    }
    closeRedisTestClient(rawClient);
    await stopEphemeralRedisServer();
  });

  /** Skips the running test and returns `undefined` when no live server is available; otherwise returns the fixtures every test needs. */
  async function requireFixtures(
    ctx: TestContext,
  ): Promise<
    { client: RedisClientType; cache: RedisClientCache; connection: string } | undefined
  > {
    const target = await resolveRedisTarget();
    if (!target.ok) {
      ctx.skip(target.message);
      return undefined;
    }
    const client = rawClient;
    const cache = clientCache;
    const connection = connectionUrl;
    if (!client || !cache || !connection) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return undefined;
    }
    return { client, cache, connection };
  }

  it('an unwritten workspace has no workflows and no keys — ok([]), not an Err', async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { cache, connection } = fixtures;
    const workspace = randomWorkspace();

    const observerResult = await BoxObserverRedis.create(workspace, connection, cache);
    expect(observerResult.isOk()).toBe(true);
    const observer = observerResult._unsafeUnwrap();

    try {
      const workflowsResult = await observer.listWorkflows();
      expect(workflowsResult.isOk()).toBe(true);
      expect(workflowsResult._unsafeUnwrap()).toEqual([]);

      const keysResult = await observer.listKeys('wf');
      expect(keysResult.isOk()).toBe(true);
      expect(keysResult._unsafeUnwrap()).toEqual([]);
    } finally {
      await observer.close();
    }
  });

  it('classifies a string key as redis-kv and a list key as redis-fifo via TYPE, in one workflow', async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { client, cache, connection } = fixtures;
    const workspace = randomWorkspace();
    const workflow = 'wf';

    try {
      await client.set(`rawbox:${workspace}:${workflow}:cell`, packValue({ hello: 'world' }));
      await client.rPush(`rawbox:${workspace}:${workflow}:queue`, [
        packValue('first'),
        packValue('second'),
      ]);

      const observer = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();

      try {
        const keysResult = await observer.listKeys(workflow);
        expect(keysResult.isOk()).toBe(true);
        const keyList = keysResult._unsafeUnwrap();

        const cellEntry = keyList.find((entry) => entry.key === 'cell');
        const queueEntry = keyList.find((entry) => entry.key === 'queue');

        expect(cellEntry?.strategy).toBe('redis-kv');
        expect(cellEntry?.entryCount).toBe(1);
        expect(cellEntry?.fifo).toBeUndefined();
        expect(cellEntry?.queueDepth).toBeUndefined();

        expect(queueEntry?.strategy).toBe('redis-fifo');
        expect(queueEntry?.entryCount).toBe(2);
        expect(queueEntry?.queueDepth).toBe(2);
        // No LMDB ring fields fabricated for a Redis list — see box-observer-redis.ts's
        // class doc comment and box-peek.ts's doc comment on `BoxInspection.fifo`.
        expect(queueEntry?.fifo).toBeUndefined();

        const workflowsResult = await observer.listWorkflows();
        expect(workflowsResult._unsafeUnwrap()).toEqual([workflow]);
      } finally {
        await observer.close();
      }
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('peek/peekAll round-trip a redis-kv cell through msgpack, non-destructively', async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { client, cache, connection } = fixtures;
    const workspace = randomWorkspace();
    const workflow = 'wf';
    const content = { count: 7, nested: { unicode: 'café — 日本語' } };

    try {
      await client.set(`rawbox:${workspace}:${workflow}:cell`, packValue(content));

      const observer = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();
      const location: BoxLocation = { workspace, workflow, key: 'cell', strategy: REDIS_KV };

      try {
        const peekResult = await observer.peek(location);
        expect(peekResult.isOk()).toBe(true);
        expect(peekResult._unsafeUnwrap()).toEqual(content);

        const peekAllResult = await observer.peekAll(location);
        expect(peekAllResult._unsafeUnwrap()).toEqual([content]);

        // Non-destructive: the raw value is still there afterwards.
        const raw = await client.get(Buffer.from(`rawbox:${workspace}:${workflow}:cell`));
        expect(raw).not.toBeNull();
      } finally {
        await observer.close();
      }
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('peek/peekAll on a redis-fifo list return the elements oldest first, without popping', async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { client, cache, connection } = fixtures;
    const workspace = randomWorkspace();
    const workflow = 'wf';

    try {
      const redisKey = `rawbox:${workspace}:${workflow}:queue`;
      await client.rPush(redisKey, [packValue('oldest'), packValue('middle'), packValue('newest')]);

      const observer = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();
      const location: BoxLocation = {
        workspace,
        workflow,
        key: 'queue',
        strategy: redisFifoStrategy(10),
      };

      try {
        const peekResult = await observer.peek(location);
        expect(peekResult._unsafeUnwrap()).toBe('oldest');

        const peekAllResult = await observer.peekAll(location);
        expect(peekAllResult._unsafeUnwrap()).toEqual(['oldest', 'middle', 'newest']);

        // Non-destructive: LLEN is unchanged.
        expect(await client.lLen(redisKey)).toBe(3);
      } finally {
        await observer.close();
      }
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it("depth.capacity is queueSizeMax, UNREDUCED — not queueSizeMax - 1, and matches seedCapacityOf", async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { client, cache, connection } = fixtures;
    const workspace = randomWorkspace();
    const workflow = 'wf';
    const queueSizeMax = 8;

    try {
      const redisKey = `rawbox:${workspace}:${workflow}:queue`;
      await client.rPush(redisKey, [packValue('a'), packValue('b'), packValue('c')]);

      const observer = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();
      const strategy = redisFifoStrategy(queueSizeMax);
      const location: BoxLocation = { workspace, workflow, key: 'queue', strategy };

      try {
        const depthResult = await observer.depth(location);
        expect(depthResult.isOk()).toBe(true);
        const depth = depthResult._unsafeUnwrap();

        expect(depth.used).toBe(3);
        // The load-bearing assertion: NOT `queueSizeMax - 1` (7), which is
        // `lmdb-fifo`'s ring reservation and has no analogue on a native
        // Redis list (`strategy/descriptor.ts`'s `redis-fifo` row).
        expect(depth.capacity).toBe(queueSizeMax);
        expect(depth.capacity).toBe(seedCapacityOf(strategy));
        expect(depth.capacity).not.toBe(queueSizeMax - 1);
      } finally {
        await observer.close();
      }
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it("returns the descriptor's exact empty-read sentence for an unset redis-kv key and an empty/missing redis-fifo list", async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { client, cache, connection } = fixtures;
    const workspace = randomWorkspace();
    const workflow = 'wf';

    try {
      const observer = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();

      try {
        const cellLocation: BoxLocation = {
          workspace,
          workflow,
          key: 'never-written',
          strategy: REDIS_KV,
        };
        expect((await observer.peek(cellLocation))._unsafeUnwrapErr()).toBe('Value not found');
        expect((await observer.peekAll(cellLocation))._unsafeUnwrapErr()).toBe('Value not found');

        const queueLocation: BoxLocation = {
          workspace,
          workflow,
          key: 'never-pushed',
          strategy: redisFifoStrategy(4),
        };
        expect((await observer.peek(queueLocation))._unsafeUnwrapErr()).toBe('Queue empty');
        expect((await observer.peekAll(queueLocation))._unsafeUnwrapErr()).toBe('Queue empty');
      } finally {
        await observer.close();
      }
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('rejects an unrouted strategy on peek/peekAll/depth, naming redis-kv and redis-fifo, never a throw', async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { client, cache, connection } = fixtures;
    const workspace = randomWorkspace();

    try {
      const observer = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();

      try {
        const location: BoxLocation = {
          workspace,
          workflow: 'wf',
          key: 'foo',
          strategy: { name: 'lmdb-kv', valueSizeMax: 1024 },
        };

        const peekResult = await observer.peek(location);
        expect(peekResult.isErr()).toBe(true);
        expect(peekResult._unsafeUnwrapErr()).toContain(
          "BoxObserverRedis observes 'redis-kv' and 'redis-fifo' only",
        );

        const peekAllResult = await observer.peekAll(location);
        expect(peekAllResult._unsafeUnwrapErr()).toContain('BoxObserverRedis observes');

        const depthResult = await observer.depth(location);
        expect(depthResult._unsafeUnwrapErr()).toContain('BoxObserverRedis observes');
      } finally {
        await observer.close();
      }
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('refuses a location addressed at a different workspace', async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { client, cache, connection } = fixtures;
    const workspace = randomWorkspace();
    const otherWorkspace = randomWorkspace();

    try {
      const observer = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();

      try {
        const location: BoxLocation = {
          workspace: otherWorkspace,
          workflow: 'wf',
          key: 'foo',
          strategy: REDIS_KV,
        };
        const result = await observer.peek(location);
        expect(result.isErr()).toBe(true);
        expect(result._unsafeUnwrapErr()).toContain(otherWorkspace);
        expect(result._unsafeUnwrapErr()).toContain(workspace);
      } finally {
        await observer.close();
      }
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('close() is idempotent, refuses further reads, and does not disturb a sibling sharing the same cached client', async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { client, cache, connection } = fixtures;
    const workspace = randomWorkspace();

    try {
      const observerA = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();
      const observerB = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();

      await observerA.close();
      await observerA.close(); // idempotent — must not throw

      const afterCloseResult = await observerA.listWorkflows();
      expect(afterCloseResult.isErr()).toBe(true);
      expect(afterCloseResult._unsafeUnwrapErr()).toContain('closed');

      // The sibling, sharing the same cached client, must still work: closing
      // one observer must not have quit the connection out from under it.
      const stillWorksResult = await observerB.listWorkflows();
      expect(stillWorksResult.isOk()).toBe(true);

      await observerB.close();
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('writes nothing to Redis: the key set is byte-identical before and after a full observation sweep', async (ctx) => {
    const fixtures = await requireFixtures(ctx);
    if (!fixtures) return;
    const { client, cache, connection } = fixtures;
    const workspace = randomWorkspace();
    const workflow = 'wf';

    try {
      await client.set(`rawbox:${workspace}:${workflow}:cell`, packValue('value'));
      await client.rPush(`rawbox:${workspace}:${workflow}:queue`, [packValue('a'), packValue('b')]);

      const before = await scanWorkspaceKeys(client, workspace);

      const observer = (
        await BoxObserverRedis.create(workspace, connection, cache)
      )._unsafeUnwrap();

      try {
        await observer.listWorkflows();
        const keysResult = await observer.listKeys(workflow);
        const keyList = keysResult._unsafeUnwrap();

        for (const entry of keyList) {
          const location: BoxLocation = {
            workspace,
            workflow,
            key: entry.key,
            strategy:
              entry.strategy === 'redis-fifo' ? redisFifoStrategy(10) : REDIS_KV,
          };
          await observer.peek(location);
          await observer.peekAll(location);
          if (entry.strategy === 'redis-fifo') {
            await observer.depth(location);
          }
        }
      } finally {
        await observer.close();
      }

      const after = await scanWorkspaceKeys(client, workspace);
      expect(after).toEqual(before);
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('surfaces a connection failure as an Err, never a rejected promise or a throw', async (ctx) => {
    const target = await resolveRedisTarget();
    if (!target.ok) {
      ctx.skip(target.message);
      return;
    }

    const unreachableUrl = 'redis://127.0.0.1:1';
    const cache = new RedisClientCache();

    const observerResult = await BoxObserverRedis.create(
      randomWorkspace(),
      unreachableUrl,
      cache,
    );

    expect(observerResult.isErr()).toBe(true);
    expect(observerResult._unsafeUnwrapErr()).toContain(unreachableUrl);

    await cache.closeAll();
  }, 20_000);
});
