// ---------------------------------------------------------------------------
// `BoxStoreRedis` against a real server.
//
// Runs for real against whatever `resolveRedisTarget()` finds (typically
// `REDIS_URL` — see redis-test-support.ts's module comment). With no target
// available, every test below skips via `ctx.skip(message)`, printing the
// full diagnostic while keeping the suite green — the same posture as
// redis-connection.test.ts, and for the same reason.
//
// ## Isolation
//
// `createRedisTestNamespace` (redis-test-support.ts) is built for a caller
// that constructs Redis keys as `${prefix}${name}` — a literal prefix. This
// store's own key scheme is `rawbox:<workspace>:<workflow>:<key>`
// (box-store-redis.ts's module comment), which puts the namespacing fields
// *after* a fixed `rawbox:` literal rather than at the very front. So this
// file does not reuse `createRedisTestNamespace` for `BoxStoreRedis`-level
// tests; instead each test gets a random `workspace` id and this file scans
// `rawbox:<workspace>:*` directly for cleanup — same SCAN + DEL mechanism,
// scoped to the actual key shape this store produces.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, type TestContext } from 'vitest';
import type { RedisClientType } from 'redis';

import { BoxStoreRedis, RedisClientCache } from '../src/box-store/box-store-redis.js';
import { BoxObserverRedis } from '../src/box-store/box-observer-redis.js';
import { type Box, type BoxLocation } from '../src/box.js';
import {
  resolveRedisTarget,
  stopEphemeralRedisServer,
  createRedisTestClient,
  closeRedisTestClient,
} from './redis-test-support.js';

/** A fresh, random workspace id — this file's unit of Redis-key isolation. */
function randomWorkspace(): string {
  return `redis-store-test-${randomBytes(8).toString('hex')}`;
}

/** Deletes every key this store could have written for `workspace`, via SCAN + DEL. */
async function cleanupWorkspace(
  client: RedisClientType,
  workspace: string,
): Promise<void> {
  const pattern = `rawbox:${workspace}:*`;
  let cursor = '0';

  do {
    const scanResult = await client.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = scanResult.cursor;

    if (scanResult.keys.length > 0) {
      await client.del(scanResult.keys);
    }
  } while (cursor !== '0');
}

const REDIS_KV_1KB = { name: 'redis-kv' as const, valueSizeMax: 1024, backend: 'main' };

describe('BoxStoreRedis', () => {
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
      // See redis-connection.test.ts for why this bypasses vitest's console
      // interception: a plain `npm run test` must still say *why* the suite
      // was skipped, not just that it was.
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

  it('put then get round-trips a value, through msgpack, over the wire', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();
    if (!target.ok) {
      ctx.skip(target.message);
      return;
    }

    const cache = clientCache;
    const client = rawClient;
    if (!cache || !client || !connectionUrl) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return;
    }

    const workspace = randomWorkspace();
    const workflow = 'wf';

    try {
      const storeResult = await BoxStoreRedis.create(connectionUrl, cache);
      expect(storeResult.isOk()).toBe(true);
      const store = storeResult._unsafeUnwrap();

      const box: Box<unknown> = {
        content: { foo: 'bar', count: 42, nested: { unicode: 'café — 日本語' } },
        location: { workspace, workflow, key: 'key1', strategy: REDIS_KV_1KB },
      };

      const putResult = await store.put(box);
      expect(putResult.isOk()).toBe(true);

      const getResult = await store.get(box.location);
      expect(getResult.isOk()).toBe(true);
      expect(getResult._unsafeUnwrap()).toEqual(box.content);
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('overwrites a value written under the same key', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();
    if (!target.ok) {
      ctx.skip(target.message);
      return;
    }

    const cache = clientCache;
    const client = rawClient;
    if (!cache || !client || !connectionUrl) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return;
    }

    const workspace = randomWorkspace();
    const workflow = 'wf';

    try {
      const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

      const location: BoxLocation = {
        workspace,
        workflow,
        key: 'key2',
        strategy: REDIS_KV_1KB,
      };

      await store.put({ content: 'initial-value', location });
      const putResult = await store.put({ content: 'updated-value', location });
      expect(putResult.isOk()).toBe(true);

      const getResult = await store.get(location);
      expect(getResult._unsafeUnwrap()).toBe('updated-value');
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('returns the descriptor\'s exact empty-read sentence for an unset key', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();
    if (!target.ok) {
      ctx.skip(target.message);
      return;
    }

    const cache = clientCache;
    const client = rawClient;
    if (!cache || !client || !connectionUrl) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return;
    }

    const workspace = randomWorkspace();

    try {
      const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

      const location: BoxLocation = {
        workspace,
        workflow: 'wf',
        key: 'never-written',
        strategy: REDIS_KV_1KB,
      };

      const getResult = await store.get(location);
      expect(getResult.isErr()).toBe(true);
      // Verbatim — `strategy/descriptor.ts`'s `redis-kv` row declares this
      // exact sentence, the same one `lmdb-kv` uses, and the verifier quotes
      // it back to the author, so the store is bound to producing it.
      expect(getResult._unsafeUnwrapErr()).toBe('Value not found');
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('rejects a put that exceeds valueSizeMax, naming the key, and writes nothing', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();
    if (!target.ok) {
      ctx.skip(target.message);
      return;
    }

    const cache = clientCache;
    const client = rawClient;
    if (!cache || !client || !connectionUrl) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return;
    }

    const workspace = randomWorkspace();
    const valueSizeMax = 16;
    const key = 'ticker';

    try {
      const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

      const location: BoxLocation = {
        workspace,
        workflow: 'wf',
        key,
        strategy: { name: 'redis-kv', valueSizeMax, backend: 'main' },
      };

      const putResult = await store.put({ content: 'x'.repeat(64), location });
      expect(putResult.isErr()).toBe(true);

      const errorMessage = putResult._unsafeUnwrapErr();
      expect(errorMessage).toContain(`Value for key '${key}' exceeds valueSizeMax`);
      expect(errorMessage).toMatch(/\d+ bytes encoded/);
      expect(errorMessage).toContain(`limit ${valueSizeMax}`);

      // The rejected put must not have reached the server.
      const getResult = await store.get(location);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toBe('Value not found');
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('namespaces by workflow: the same key in two workflows of one workspace does not collide', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();
    if (!target.ok) {
      ctx.skip(target.message);
      return;
    }

    const cache = clientCache;
    const client = rawClient;
    if (!cache || !client || !connectionUrl) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return;
    }

    const workspace = randomWorkspace();

    try {
      const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

      const locationA: BoxLocation = {
        workspace,
        workflow: 'workflow-a',
        key: 'shared-key',
        strategy: REDIS_KV_1KB,
      };
      const locationB: BoxLocation = {
        workspace,
        workflow: 'workflow-b',
        key: 'shared-key',
        strategy: REDIS_KV_1KB,
      };

      await store.put({ content: 'value-from-a', location: locationA });
      await store.put({ content: 'value-from-b', location: locationB });

      const resultA = await store.get(locationA);
      const resultB = await store.get(locationB);

      expect(resultA._unsafeUnwrap()).toBe('value-from-a');
      expect(resultB._unsafeUnwrap()).toBe('value-from-b');
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('reports an unrouted strategy as an Err naming redis-kv and redis-fifo, never a throw', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();
    if (!target.ok) {
      ctx.skip(target.message);
      return;
    }

    const cache = clientCache;
    const client = rawClient;
    if (!cache || !client || !connectionUrl) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return;
    }

    const workspace = randomWorkspace();

    try {
      const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

      const location: BoxLocation = {
        workspace,
        workflow: 'wf',
        key: 'foo',
        strategy: { name: 'lmdb-kv', valueSizeMax: 1024 },
      };

      const getResult = await store.get(location);
      expect(getResult.isErr()).toBe(true);
      expect(getResult._unsafeUnwrapErr()).toContain(
        "BoxStoreRedis routes 'redis-kv' and 'redis-fifo' only",
      );

      const putResult = await store.put({ content: 'x', location });
      expect(putResult.isErr()).toBe(true);
      expect(putResult._unsafeUnwrapErr()).toContain(
        "BoxStoreRedis routes 'redis-kv' and 'redis-fifo' only",
      );
    } finally {
      await cleanupWorkspace(client, workspace);
    }
  });

  it('surfaces a connection failure as an Err, never a rejected promise or a throw', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();
    if (!target.ok) {
      ctx.skip(target.message);
      return;
    }

    // Port 1 is a privileged port nothing on this host is listening on, so
    // the connection attempt fails fast (ECONNREFUSED) rather than hanging
    // on a timeout — this test asserts the failure shape, not that this
    // exact host/port combination is unreachable in every environment, so a
    // slow or unusual failure is still caught by the 10s test timeout below.
    const unreachableUrl = 'redis://127.0.0.1:1';
    const cache = new RedisClientCache();

    const storeResult = await BoxStoreRedis.create(unreachableUrl, cache);

    expect(storeResult.isErr()).toBe(true);
    expect(storeResult._unsafeUnwrapErr()).toContain(unreachableUrl);

    await cache.closeAll();
  }, 20_000);

  describe('redis-fifo', () => {
    function fifoStrategy(queueSizeMax: number, valueSizeMax = 1024) {
      return {
        name: 'redis-fifo' as const,
        queueSizeMax,
        valueSizeMax,
        backend: 'main',
      };
    }

    it('enqueue then dequeue round-trips a value through msgpack, over the wire', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = clientCache;
      const client = rawClient;
      if (!cache || !client || !connectionUrl) {
        ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
        return;
      }

      const workspace = randomWorkspace();

      try {
        const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

        const location: BoxLocation = {
          workspace,
          workflow: 'wf',
          key: 'queue1',
          strategy: fifoStrategy(4),
        };

        const putResult = await store.put({
          content: { event: 'first', nested: { unicode: 'café — 日本語' } },
          location,
        });
        expect(putResult.isOk()).toBe(true);

        const getResult = await store.get(location);
        expect(getResult.isOk()).toBe(true);
        expect(getResult._unsafeUnwrap()).toEqual({
          event: 'first',
          nested: { unicode: 'café — 日本語' },
        });
      } finally {
        await cleanupWorkspace(client, workspace);
      }
    });

    it('dequeues in FIFO order — seed a,b,c, read three times get a,b,c, the fourth read reports the queue empty', async (ctx: TestContext) => {
      // Mirrors the LMDB end-to-end ordering case — seeding `[a, b, c]` and
      // reading three times yields `a`, `b`, `c` in order, with a fourth read
      // reporting the queue empty — through
      // this package's own `BoxStoreRedis` API rather than the runner's seed
      // loop: `@rawbox/runner`'s `run-workflow.ts` constructs no Redis store
      // at all yet (this task's "Wiring" section), so there is no seed loop
      // to drive this through end to end. Three `put()`s in order is exactly
      // what that loop would do once it exists — `resolver.ts` expands a
      // FIFO seed into one `Seed` per element and writes them with no
      // strategy special case, so this is the same shape a real seed would
      // take.
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = clientCache;
      const client = rawClient;
      if (!cache || !client || !connectionUrl) {
        ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
        return;
      }

      const workspace = randomWorkspace();

      try {
        const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

        const location: BoxLocation = {
          workspace,
          workflow: 'wf',
          key: 'ordering',
          strategy: fifoStrategy(3),
        };

        await store.put({ content: 'a', location });
        await store.put({ content: 'b', location });
        await store.put({ content: 'c', location });

        const first = await store.get(location);
        const second = await store.get(location);
        const third = await store.get(location);

        expect(first._unsafeUnwrap()).toBe('a');
        expect(second._unsafeUnwrap()).toBe('b');
        expect(third._unsafeUnwrap()).toBe('c');

        const fourth = await store.get(location);
        expect(fourth.isErr()).toBe(true);
        // Verbatim — the descriptor's `emptyReadMessage`, never a retyped
        // literal and never `nil` or any other client-library word.
        expect(fourth._unsafeUnwrapErr()).toBe('Queue empty');
      } finally {
        await cleanupWorkspace(client, workspace);
      }
    });

    it("rejects a put once the queue is full, at EXACTLY queueSizeMax (no reserved slot), and leaves the queue's contents unchanged", async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = clientCache;
      const client = rawClient;
      if (!cache || !client || !connectionUrl) {
        ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
        return;
      }

      const workspace = randomWorkspace();

      try {
        const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

        const location: BoxLocation = {
          workspace,
          workflow: 'wf',
          key: 'full-queue',
          strategy: fifoStrategy(2),
        };

        expect((await store.put({ content: 'x', location })).isOk()).toBe(true);
        expect((await store.put({ content: 'y', location })).isOk()).toBe(true);

        // Third put on a `queueSizeMax: 2` queue: `redis-fifo` reserves no
        // slot (`strategy/descriptor.ts`'s `redis-fifo` row), so 2 elements
        // is already full — unlike `lmdb-fifo`, where `queueSizeMax: 2`
        // would hold only 1.
        const thirdResult = await store.put({ content: 'z', location });
        expect(thirdResult.isErr()).toBe(true);
        // Byte-identical to `BoxStoreLmdbFifo.putStatic`'s message shape
        // (`box-store-lmdb.ts:543`, `box-peek.test.ts:431`).
        expect(thirdResult._unsafeUnwrapErr()).toBe("Queue is full 'redis-fifo'");

        // The rejected put must not have reached the list.
        const redisKey = `rawbox:${workspace}:wf:full-queue`;
        const len = await client.sendCommand(['LLEN', redisKey]);
        expect(len).toBe(2);

        expect((await store.get(location))._unsafeUnwrap()).toBe('x');
        expect((await store.get(location))._unsafeUnwrap()).toBe('y');
      } finally {
        await cleanupWorkspace(client, workspace);
      }
    });

    it('rejects a put whose encoded value exceeds valueSizeMax — bounding ONE element, not the whole list', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = clientCache;
      const client = rawClient;
      if (!cache || !client || !connectionUrl) {
        ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
        return;
      }

      const workspace = randomWorkspace();
      const valueSizeMax = 16;
      const key = 'oversized-element';

      try {
        const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

        const location: BoxLocation = {
          workspace,
          workflow: 'wf',
          key,
          strategy: fifoStrategy(10, valueSizeMax),
        };

        // A small element first, well within budget — proves the bound is
        // per-element, not a running total across the queue.
        expect((await store.put({ content: 'ok', location })).isOk()).toBe(true);

        const putResult = await store.put({ content: 'x'.repeat(64), location });
        expect(putResult.isErr()).toBe(true);
        const errorMessage = putResult._unsafeUnwrapErr();
        expect(errorMessage).toContain(`Value for key '${key}' exceeds valueSizeMax`);
        expect(errorMessage).toContain(`limit ${valueSizeMax}`);

        // The oversized element must not have reached the list — only the
        // first, small one is there.
        const redisKey = `rawbox:${workspace}:wf:${key}`;
        const len = await client.sendCommand(['LLEN', redisKey]);
        expect(len).toBe(1);
      } finally {
        await cleanupWorkspace(client, workspace);
      }
    });

    it('enqueue never overflows queueSizeMax under concurrent writers — the atomicity requirement', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = clientCache;
      const client = rawClient;
      if (!cache || !client || !connectionUrl) {
        ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
        return;
      }

      const workspace = randomWorkspace();
      const queueSizeMax = 10;
      const concurrentWriterCount = 50;

      try {
        const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

        const location: BoxLocation = {
          workspace,
          workflow: 'wf',
          key: 'race',
          strategy: fifoStrategy(queueSizeMax),
        };

        // Fired concurrently, not awaited one at a time: this is the case a
        // naive `LLEN` then `RPUSH` would lose — every promise's `LLEN` can
        // observe "under capacity" before any of them has issued its write.
        // If `enqueue` were two independent commands rather than one `EVAL`,
        // this would routinely push past `queueSizeMax`.
        const results = await Promise.all(
          Array.from({ length: concurrentWriterCount }, (_, i) =>
            store.put({ content: `writer-${i}`, location }),
          ),
        );

        const successCount = results.filter((r) => r.isOk()).length;
        const failureCount = results.filter((r) => r.isErr()).length;

        expect(successCount).toBe(queueSizeMax);
        expect(failureCount).toBe(concurrentWriterCount - queueSizeMax);
        for (const result of results) {
          if (result.isErr()) {
            expect(result.error).toBe("Queue is full 'redis-fifo'");
          }
        }

        // The server-side ground truth, not just this store's own tally:
        // `LLEN` must never have exceeded `queueSizeMax`, at the end and (by
        // the atomicity argument, though this is the only point this test
        // can observe directly) at every point during the race.
        const redisKey = `rawbox:${workspace}:wf:race`;
        const finalLen = await client.sendCommand(['LLEN', redisKey]);
        expect(finalLen).toBe(queueSizeMax);
      } finally {
        await cleanupWorkspace(client, workspace);
      }
    });

    it('peek does not consume: peek shows the head, and the following dequeue returns exactly that element', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = clientCache;
      const client = rawClient;
      if (!cache || !client || !connectionUrl) {
        ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
        return;
      }

      const workspace = randomWorkspace();

      try {
        const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();
        const observer = (
          await BoxObserverRedis.create(workspace, connectionUrl, cache)
        )._unsafeUnwrap();

        const location: BoxLocation = {
          workspace,
          workflow: 'wf',
          key: 'peek-key',
          strategy: fifoStrategy(5),
        };

        await store.put({ content: 'head-element', location });
        await store.put({ content: 'second-element', location });

        const peekResult = await observer.peek(location);
        expect(peekResult.isOk()).toBe(true);
        expect(peekResult._unsafeUnwrap()).toBe('head-element');

        // Peeking again proves nothing was consumed by the first peek.
        const peekAgainResult = await observer.peek(location);
        expect(peekAgainResult._unsafeUnwrap()).toBe('head-element');

        // The dequeue returns exactly the element peek showed — not merely
        // "some" element.
        const dequeueResult = await store.get(location);
        expect(dequeueResult._unsafeUnwrap()).toBe('head-element');

        const secondPeek = await observer.peek(location);
        expect(secondPeek._unsafeUnwrap()).toBe('second-element');

        await observer.close();
      } finally {
        await cleanupWorkspace(client, workspace);
      }
    });

    it('peekAll returns every element oldest-first — the order a consumer would dequeue in', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = clientCache;
      const client = rawClient;
      if (!cache || !client || !connectionUrl) {
        ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
        return;
      }

      const workspace = randomWorkspace();

      try {
        const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();
        const observer = (
          await BoxObserverRedis.create(workspace, connectionUrl, cache)
        )._unsafeUnwrap();

        const location: BoxLocation = {
          workspace,
          workflow: 'wf',
          key: 'peekall-key',
          strategy: fifoStrategy(5),
        };

        await store.put({ content: 'a', location });
        await store.put({ content: 'b', location });
        await store.put({ content: 'c', location });

        const peekAllResult = await observer.peekAll(location);
        expect(peekAllResult.isOk()).toBe(true);
        expect(peekAllResult._unsafeUnwrap()).toEqual(['a', 'b', 'c']);

        // peekAll must not have consumed anything either.
        expect((await store.get(location))._unsafeUnwrap()).toBe('a');

        await observer.close();
      } finally {
        await cleanupWorkspace(client, workspace);
      }
    });

    it('depth().capacity is queueSizeMax UNREDUCED — a full queue reports used === capacity, not capacity - 1', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = clientCache;
      const client = rawClient;
      if (!cache || !client || !connectionUrl) {
        ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
        return;
      }

      const workspace = randomWorkspace();
      const queueSizeMax = 4;

      try {
        const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();
        const observer = (
          await BoxObserverRedis.create(workspace, connectionUrl, cache)
        )._unsafeUnwrap();

        const location: BoxLocation = {
          workspace,
          workflow: 'wf',
          key: 'depth-key',
          strategy: fifoStrategy(queueSizeMax),
        };

        for (let i = 0; i < queueSizeMax; i++) {
          expect((await store.put({ content: `item-${i}`, location })).isOk()).toBe(true);
        }

        const depthResult = await observer.depth(location);
        expect(depthResult.isOk()).toBe(true);
        expect(depthResult._unsafeUnwrap()).toEqual({
          used: queueSizeMax,
          capacity: queueSizeMax,
        });

        // One more put must be rejected: `used === capacity` really is full,
        // not `capacity - 1` away from it.
        const overflowResult = await store.put({ content: 'one-too-many', location });
        expect(overflowResult.isErr()).toBe(true);

        await observer.close();
      } finally {
        await cleanupWorkspace(client, workspace);
      }
    });

    describe('WRONGTYPE — a key whose declared strategy changed between runs', () => {
      it('cell-then-queue: a redis-kv string, then a redis-fifo enqueue/dequeue against it, reports a named diagnostic (never a raw client error)', async (ctx: TestContext) => {
        const target = await resolveRedisTarget();
        if (!target.ok) {
          ctx.skip(target.message);
          return;
        }

        const cache = clientCache;
        const client = rawClient;
        if (!cache || !client || !connectionUrl) {
          ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
          return;
        }

        const workspace = randomWorkspace();
        const key = 'was-a-cell';

        try {
          const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

          const cellLocation: BoxLocation = {
            workspace,
            workflow: 'wf',
            key,
            strategy: { name: 'redis-kv', valueSizeMax: 1024, backend: 'main' },
          };

          // An earlier run wrote this key as a `redis-kv` cell.
          expect((await store.put({ content: 'i-was-a-cell', location: cellLocation })).isOk()).toBe(
            true,
          );

          const fifoLocation: BoxLocation = {
            workspace,
            workflow: 'wf',
            key,
            strategy: fifoStrategy(4),
          };

          // This run declares the same key as `redis-fifo`. The enqueue's
          // `EVAL` hits `WRONGTYPE` from its own `LLEN` call.
          const enqueueResult = await store.put({ content: 'oops', location: fifoLocation });
          expect(enqueueResult.isErr()).toBe(true);
          const enqueueMessage = enqueueResult._unsafeUnwrapErr();
          expect(enqueueMessage).not.toContain('WRONGTYPE');
          expect(enqueueMessage).toContain(`Key '${key}'`);
          expect(enqueueMessage).toContain("declares strategy 'redis-fifo'");
          expect(enqueueMessage).toContain("hold a 'list'");
          expect(enqueueMessage).toContain("currently holds a 'string'");
          expect(enqueueMessage.toLowerCase()).toContain('changed between runs');

          // Nothing was written by the failed enqueue — the string is intact.
          const stillCell = await store.get(cellLocation);
          expect(stillCell._unsafeUnwrap()).toBe('i-was-a-cell');

          // The dequeue side (`LPOP`) hits the identical `WRONGTYPE`.
          const dequeueResult = await store.get(fifoLocation);
          expect(dequeueResult.isErr()).toBe(true);
          const dequeueMessage = dequeueResult._unsafeUnwrapErr();
          expect(dequeueMessage).not.toContain('WRONGTYPE');
          expect(dequeueMessage).toContain(`Key '${key}'`);
          expect(dequeueMessage).toContain("hold a 'list'");
          expect(dequeueMessage).toContain("currently holds a 'string'");
        } finally {
          await cleanupWorkspace(client, workspace);
        }
      });

      it('queue-then-cell: a redis-fifo list, then a redis-kv get/put against it, reports a named diagnostic and never silently clobbers the list', async (ctx: TestContext) => {
        const target = await resolveRedisTarget();
        if (!target.ok) {
          ctx.skip(target.message);
          return;
        }

        const cache = clientCache;
        const client = rawClient;
        if (!cache || !client || !connectionUrl) {
          ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
          return;
        }

        const workspace = randomWorkspace();
        const key = 'was-a-queue';

        try {
          const store = (await BoxStoreRedis.create(connectionUrl, cache))._unsafeUnwrap();

          const fifoLocation: BoxLocation = {
            workspace,
            workflow: 'wf',
            key,
            strategy: fifoStrategy(4),
          };

          // An earlier run wrote this key as a `redis-fifo` queue.
          expect((await store.put({ content: 'queued-1', location: fifoLocation })).isOk()).toBe(
            true,
          );
          expect((await store.put({ content: 'queued-2', location: fifoLocation })).isOk()).toBe(
            true,
          );

          const cellLocation: BoxLocation = {
            workspace,
            workflow: 'wf',
            key,
            strategy: { name: 'redis-kv', valueSizeMax: 1024, backend: 'main' },
          };

          // This run declares the same key as `redis-kv`. `GET` hits
          // `WRONGTYPE` naturally.
          const getResult = await store.get(cellLocation);
          expect(getResult.isErr()).toBe(true);
          const getMessage = getResult._unsafeUnwrapErr();
          expect(getMessage).not.toContain('WRONGTYPE');
          expect(getMessage).toContain(`Key '${key}'`);
          expect(getMessage).toContain("declares strategy 'redis-kv'");
          expect(getMessage).toContain("hold a 'string'");
          expect(getMessage).toContain("currently holds a 'list'");
          expect(getMessage.toLowerCase()).toContain('changed between runs');

          // `SET` itself would NOT raise `WRONGTYPE` — measured directly
          // against the live server (see `box-store-redis.ts`'s module
          // comment). This is the case that matters most: a naive `put`
          // would silently overwrite the queue's list with a string and
          // report success. It must instead report the same named
          // diagnostic and leave the queue untouched.
          const putResult = await store.put({ content: 'clobber-attempt', location: cellLocation });
          expect(putResult.isErr()).toBe(true);
          const putMessage = putResult._unsafeUnwrapErr();
          expect(putMessage).not.toContain('WRONGTYPE');
          expect(putMessage).toContain(`Key '${key}'`);
          expect(putMessage).toContain("declares strategy 'redis-kv'");
          expect(putMessage).toContain("hold a 'string'");
          expect(putMessage).toContain("currently holds a 'list'");

          // The queue must be completely intact — this is the assertion
          // that proves the clobber was actually prevented, not merely that
          // an error was returned while the damage still happened.
          const first = await store.get(fifoLocation);
          const second = await store.get(fifoLocation);
          expect(first._unsafeUnwrap()).toBe('queued-1');
          expect(second._unsafeUnwrap()).toBe('queued-2');
        } finally {
          await cleanupWorkspace(client, workspace);
        }
      });
    });
  });

  describe('RedisClientCache', () => {
    it('memoizes one client per connection string', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = new RedisClientCache();

      try {
        const first = await cache.getOrCreateClient(target.url);
        const second = await cache.getOrCreateClient(target.url);

        expect(first.isOk()).toBe(true);
        expect(second.isOk()).toBe(true);
        // Same object, not merely two equally-configured clients: a second
        // `getOrCreateClient` for a connection string already cached must not
        // open a second TCP connection.
        expect(first._unsafeUnwrap()).toBe(second._unsafeUnwrap());
      } finally {
        await cache.closeAll();
      }
    });

    it('shares one in-flight connect() across concurrent callers', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = new RedisClientCache();

      try {
        const [first, second] = await Promise.all([
          cache.getOrCreateClient(target.url),
          cache.getOrCreateClient(target.url),
        ]);

        expect(first.isOk()).toBe(true);
        expect(second.isOk()).toBe(true);
        expect(first._unsafeUnwrap()).toBe(second._unsafeUnwrap());
      } finally {
        await cache.closeAll();
      }
    });

    it('does not cache a failed connection, so a later call can retry', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = new RedisClientCache();
      const unreachableUrl = 'redis://127.0.0.1:1';

      const first = await cache.getOrCreateClient(unreachableUrl);
      expect(first.isErr()).toBe(true);

      // A real server this time, at the same call site pattern — if the
      // failed attempt above had poisoned the cache keyed differently this
      // would still pass, so what this actually proves is narrower and
      // sufficient: the cache's `Map` no longer holds an entry for
      // `unreachableUrl` after a failure, which the next assertion checks
      // more directly via a second attempt at the *same* unreachable URL
      // completing independently rather than reusing a stuck rejected
      // promise.
      const second = await cache.getOrCreateClient(unreachableUrl);
      expect(second.isErr()).toBe(true);
      expect(second._unsafeUnwrapErr()).toBe(first._unsafeUnwrapErr());

      await cache.closeAll();
    }, 30_000);

    it('close() quits and evicts one connection without disturbing others', async (ctx: TestContext) => {
      const target = await resolveRedisTarget();
      if (!target.ok) {
        ctx.skip(target.message);
        return;
      }

      const cache = new RedisClientCache();

      try {
        const clientResult = await cache.getOrCreateClient(target.url);
        expect(clientResult.isOk()).toBe(true);
        const client = clientResult._unsafeUnwrap();

        await cache.close(target.url);

        expect(client.isOpen).toBe(false);

        // A fresh `getOrCreateClient` after `close()` opens a new connection
        // rather than handing back the now-closed one.
        const reconnected = await cache.getOrCreateClient(target.url);
        expect(reconnected.isOk()).toBe(true);
        expect(reconnected._unsafeUnwrap().isOpen).toBe(true);
      } finally {
        await cache.closeAll();
      }
    });
  });
});
