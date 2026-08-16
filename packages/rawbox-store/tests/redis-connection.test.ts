// ---------------------------------------------------------------------------
// Proves the Redis test harness reaches a real server end to end. This does
// NOT test a store implementation — `box-store-redis` does not exist yet
// (see redis-test-support.ts's module comment) — it tests the harness the
// store's own tests will build on: connection resolution, and per-test
// key-namespace isolation against a genuinely shared keyspace.
//
// Runs for real against whatever `resolveRedisTarget()` finds (typically
// `REDIS_URL`). With no target available, every test below skips via
// `ctx.skip(message)`, which prints the full diagnostic — every attempt and
// why each failed — while keeping the suite green.
//
// Two narrowing notes for whoever edits this next, both compiler quirks
// rather than logic bugs:
//
// - `ctx` is annotated `TestContext` explicitly on every callback. Left
//   inferred, `ctx.skip(...)`'s return type does not resolve to `never`
//   (vitest's `it` is generic enough that the inferred parameter type loses
//   the overload TypeScript needs for control-flow analysis to treat the
//   `if (!target.ok) { ctx.skip(...) }` block as always throwing), and
//   `target.url` below it is then flagged as not existing on the `ok: false`
//   arm of the union.
// - `client` (the connected `RedisClientType`, or `undefined` if
//   `resolveRedisTarget()` found nothing) is set in `beforeAll` and read in
//   each `it` — different closures over the same outer `let`. TypeScript
//   does not carry narrowing of a captured mutable variable across separate
//   closures, so each test reassigns it to a local `const` first and
//   narrows that instead.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, type TestContext } from 'vitest';
import type { RedisClientType } from 'redis';

import {
  resolveRedisTarget,
  stopEphemeralRedisServer,
  createRedisTestNamespace,
  createRedisTestClient,
  closeRedisTestClient,
} from './redis-test-support.js';

describe('Redis test harness', () => {
  let client: RedisClientType | undefined;

  beforeAll(async () => {
    const target = await resolveRedisTarget();

    if (target.ok) {
      client = createRedisTestClient(target.url);
      await client.connect();
    } else {
      // Printed unconditionally, not only via `ctx.skip()`'s note: vitest's
      // default reporter collapses a passing/skipped file to its summary
      // line and neither prints per-test skip notes nor forwards
      // `console.*` output for a test that does not fail — both are only
      // shown with `--reporter=verbose`. A plain `npm run test` would
      // otherwise report "4 skipped" with no way to tell "no server
      // configured" from "server configured but unreachable" without
      // re-running verbosely, which is exactly the silent skip this harness
      // exists to avoid. `process.stdout.write` goes around vitest's
      // console interception and always reaches the terminal / CI log.
      process.stdout.write(`\n${target.message}\n\n`);
    }
  });

  afterAll(async () => {
    closeRedisTestClient(client);
    await stopEphemeralRedisServer();
  });

  it('resolves a connection target, or explains every attempt that failed', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();

    if (!target.ok) {
      // The message names each thing tried (REDIS_URL, redis-memory-server)
      // and why it failed — printed by the reporter as the skip reason, so
      // a developer never sees a bare "skipped" with no explanation.
      ctx.skip(target.message);
    }

    expect(target.url.length).toBeGreaterThan(0);
  });

  it('round-trips SET/GET against the live server, under an isolated prefix', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();

    if (!target.ok) {
      ctx.skip(target.message);
    }

    const activeClient = client;

    if (!activeClient) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return;
    }

    const namespace = createRedisTestNamespace(activeClient);

    try {
      const key = namespace.key('probe-set-get');

      await activeClient.set(key, 'hello-from-rawbox');
      const value = await activeClient.get(key);

      expect(value).toBe('hello-from-rawbox');
    } finally {
      await namespace.cleanup();
    }
  });

  it('round-trips EVAL (Lua scripting) against the live server', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();

    if (!target.ok) {
      ctx.skip(target.message);
    }

    const activeClient = client;

    if (!activeClient) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return;
    }

    const namespace = createRedisTestNamespace(activeClient);

    try {
      const key = namespace.key('probe-eval');

      await activeClient.set(key, 'via-lua');
      const evalResult = await activeClient.eval(
        "return redis.call('GET', KEYS[1])",
        { keys: [key] },
      );

      expect(evalResult).toBe('via-lua');
    } finally {
      await namespace.cleanup();
    }
  });

  it('cleanup() removes only its own namespace, never the whole keyspace', async (ctx: TestContext) => {
    const target = await resolveRedisTarget();

    if (!target.ok) {
      ctx.skip(target.message);
    }

    const activeClient = client;

    if (!activeClient) {
      ctx.skip('resolveRedisTarget() reported ok but beforeAll left no client connected');
      return;
    }

    const ownNamespace = createRedisTestNamespace(activeClient);
    const bystanderNamespace = createRedisTestNamespace(activeClient);

    try {
      const ownKey = ownNamespace.key('mine');
      const bystanderKey = bystanderNamespace.key('not-mine');

      await activeClient.set(ownKey, '1');
      await activeClient.set(bystanderKey, '1');

      await ownNamespace.cleanup();

      const ownValueAfter = await activeClient.get(ownKey);
      const bystanderValueAfter = await activeClient.get(bystanderKey);

      expect(ownValueAfter).toBeNull();
      expect(bystanderValueAfter).toBe('1');
    } finally {
      await bystanderNamespace.cleanup();
    }
  });
});
