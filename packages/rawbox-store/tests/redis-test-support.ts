// ---------------------------------------------------------------------------
// Redis test harness — connection resolution and per-test isolation.
//
// This is test infrastructure only. It does not implement `box-store-redis`
// (that is a later task); it exists so the Redis suites in this package can
// run against a real server when one is reachable, and skip loudly — never
// silently — when one is not.
//
// ## Connection resolution, in priority order
//
// 1. `REDIS_URL` — an external server: a container a developer runs by hand
//    (see `docker/redis/`), or a CI service container. This is the only path
//    that is verified to work in every environment this harness runs in.
// 2. `redis-memory-server` — an ephemeral, in-process Redis this file starts
//    itself. It is an `optionalDependency` of `@rawbox/store` (see
//    package.json) because it has no prebuilt binary: on first use it
//    downloads Redis source and runs `make`, which fails outright on any
//    machine without a C toolchain — including the one this harness was
//    authored on. `npm install` still succeeds there because
//    `optionalDependencies` tolerates a failed install; this path is simply
//    absent afterwards, and the `import()` below fails accordingly.
// 3. Neither: callers must skip, and the message names every attempt and why
//    each one failed. A bare "redis unavailable" is exactly what this format
//    is designed to prevent — a developer reading CI output must be able to
//    tell "no server configured" from "server configured but unreachable".
//
// ## Every candidate is PROVED reachable before it is offered
//
// A URL is not a server. `REDIS_URL` naming a host that is down, a port
// nothing listens on, or a container that has not finished starting is the
// single most likely way this harness meets a broken environment — a stale
// `.env`, a compose service still booting, a laptop that has moved network.
//
// This used to be unhandled, and it did not skip: `resolveRedisTarget`
// returned `ok` for any non-empty `REDIS_URL`, the suites called
// `client.connect()`, and node-redis's default reconnect strategy retried
// with backoff instead of failing. `beforeAll` then blew through vitest's
// 10s hook timeout and the file was reported FAILED with `Hook timed out in
// 10000ms` — a red build, exit code 1, and a message naming neither Redis
// nor the URL. The tests themselves said `4 skipped`; the hooks were what
// went red. So the one case this header promises to distinguish was the one
// case that broke the run.
//
// {@link probeRedisUrl} closes that: a candidate is connected to, PINGed and
// closed — under a bounded timeout, with reconnection disabled — before
// `resolveRedisTarget` will call it usable. A candidate that fails becomes an
// *attempt* with a reason, exactly like a candidate that was never
// configured, and the suite skips with exit code 0.
//
// No host is ever hardcoded as a fallback. `redis:6379` resolves inside the
// Docker network this was developed against; it means nothing on a
// contributor's laptop, so it appears only as documentation
// (`docker/redis/README.md`), never as code that runs when `REDIS_URL` is
// unset.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';

import { createClient, type RedisClientType } from 'redis';

/**
 * How long a candidate has to accept a connection and answer `PING`.
 *
 * Short on purpose. This budget is spent on every run where Redis is absent
 * or unreachable — the common case for a contributor who has not set
 * `REDIS_URL` — so it is the cost of *not* running these suites, paid before
 * the skip. Two seconds is far above any real handshake (a local or
 * same-network Redis answers in single-digit milliseconds) and far below
 * vitest's 10s hook timeout, which is what a stalled connect used to hit.
 */
const REDIS_PROBE_TIMEOUT_MS = 2000;

/**
 * Connection options every suite in this package must use.
 *
 * `reconnectStrategy: false` is the load-bearing half. node-redis retries a
 * failed connection with backoff by default, which is right for a service and
 * wrong for a test: it converts "this server is not there" from a prompt
 * rejection into an indefinite hang, and a hang inside `beforeAll` is a
 * hook-timeout failure rather than a skip.
 *
 * `connectTimeout` bounds the other direction — a host that accepts a TCP
 * connection and then says nothing, which no reconnect strategy would ever
 * resolve.
 */
export const REDIS_TEST_SOCKET_OPTIONS = {
  connectTimeout: REDIS_PROBE_TIMEOUT_MS,
  reconnectStrategy: false as const,
};

/**
 * A client configured the way every Redis suite here must configure one.
 *
 * Exported so the three suites cannot drift from the probe: a suite that
 * built its own client with default options would reintroduce the indefinite
 * reconnect this module exists to prevent, and would do it in `beforeAll`
 * where the symptom is an unexplained timeout.
 */
export function createRedisTestClient(url: string): RedisClientType {
  const client: RedisClientType = createClient({
    url,
    socket: REDIS_TEST_SOCKET_OPTIONS,
  });

  // node-redis emits `error` on a failed connection. An EventEmitter with no
  // `error` listener rethrows as an uncaught exception, which in vitest fails
  // an unrelated test — or the whole file — with a stack that points nowhere
  // near the cause. The connect/ping rejection below is the error path this
  // module actually reads.
  client.on('error', () => {});

  return client;
}

/**
 * Closes a client without ever throwing or hanging.
 *
 * `quit()` is a graceful close that speaks to the server, so it is exactly
 * the wrong call for a client whose server is unreachable — it waits.
 * `destroy()` drops the socket locally. Teardown must not be able to fail a
 * suite that has already decided to skip.
 */
export function closeRedisTestClient(client: RedisClientType | undefined): void {
  if (client === undefined) {
    return;
  }

  try {
    if (client.isOpen) {
      client.destroy();
    }
  } catch {
    // A client that is already gone is the state we wanted.
  }
}

/**
 * Whether `url` is a Redis that answers, within {@link REDIS_PROBE_TIMEOUT_MS}.
 *
 * Connect, `PING`, close. The `PING` is not ceremony: a TCP accept proves
 * something is listening on the port, not that it speaks RESP — an SSH
 * daemon, an HTTP server or a port-forward to the wrong container all accept
 * connections and would otherwise be reported as a working Redis, failing
 * later inside a test with a protocol error instead of skipping here with a
 * reason.
 */
async function probeRedisUrl(
  url: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  let client: RedisClientType | undefined;

  try {
    client = createRedisTestClient(url);
    await client.connect();
    await client.ping();
    return { ok: true };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      detail:
        `set to ${url}, but no Redis answered there within ` +
        `${REDIS_PROBE_TIMEOUT_MS}ms (${error}). The variable is set, so this ` +
        `is a server that is down, still starting, or on a host this process ` +
        `cannot reach — not a missing configuration.`,
    };
  } finally {
    closeRedisTestClient(client);
  }
}

/** One thing this file tried, and why it did not produce a usable target. */
export interface RedisTargetAttempt {
  /** What was tried, e.g. `'REDIS_URL environment variable'`. */
  readonly name: string;
  /** Why it did not work, in one sentence a developer can act on. */
  readonly detail: string;
}

/** Where the Redis suites should connect, or why they cannot. */
export type RedisTarget =
  | {
      readonly ok: true;
      readonly url: string;
      /** Which of the priority-ordered paths produced `url`, for test output. */
      readonly source: string;
    }
  | {
      readonly ok: false;
      /** Every attempt, in priority order, with its own reason — never bare. */
      readonly attempts: readonly RedisTargetAttempt[];
      /** The full diagnostic, ready to hand to `ctx.skip()`. */
      readonly message: string;
    };

const REDIS_MEMORY_SERVER_MODULE_SPECIFIER = 'redis-memory-server';

/**
 * Starts (and later stops) an ephemeral `redis-memory-server` instance.
 *
 * A minimal structural type rather than the package's own types: the module
 * is an `optionalDependency` and may not be installed at all, so this file
 * cannot statically import it (see `resolveRedisTargetUncached` for why the
 * `import()` specifier is routed through a `string`-typed variable — that is
 * what keeps `tsc --build` green whether or not the package is present).
 */
interface RedisMemoryServerLike {
  getHost(): Promise<string>;
  getPort(): Promise<number>;
  stop(): Promise<boolean>;
}

let ephemeralServer: RedisMemoryServerLike | undefined;

async function tryRedisMemoryServer(): Promise<
  { ok: true; url: string } | { ok: false; detail: string }
> {
  let redisMemoryServerModule: {
    RedisMemoryServer: new () => RedisMemoryServerLike;
  };

  try {
    // Routed through a variable, not a string literal, so TypeScript types
    // the result `any` instead of resolving the module at compile time — a
    // literal `import('redis-memory-server')` would fail `tsc --build` in
    // this environment, where the package's install is expected to fail and
    // leave no type declarations behind. The runtime behaviour is identical
    // either way: Node resolves the specifier at `import()` time regardless.
    redisMemoryServerModule = (await import(
      REDIS_MEMORY_SERVER_MODULE_SPECIFIER
    )) as typeof redisMemoryServerModule;
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      detail:
        `package not importable (${error}). Its optionalDependency install ` +
        `likely failed — it ships no prebuilt binary and compiles Redis from ` +
        `source on first use, which needs a C toolchain (gcc/make). See ` +
        `docker/redis/README.md for the REDIS_URL alternative.`,
    };
  }

  try {
    const server = new redisMemoryServerModule.RedisMemoryServer();
    const host = await server.getHost();
    const port = await server.getPort();
    ephemeralServer = server;

    const url = `redis://${host}:${port}`;
    // Probed like any other candidate. `getPort()` resolving proves the
    // library thinks it started a server, not that one is accepting
    // connections — and an unreachable ephemeral server would hang a suite
    // exactly as an unreachable external one does.
    const probe = await probeRedisUrl(url);

    if (!probe.ok) {
      return {
        ok: false,
        detail: `package started a server at ${url}, but ${probe.detail}`,
      };
    }

    return { ok: true, url };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      detail:
        `package imported but failed to start a server (${error}). This is ` +
        `usually the source download or the \`make\` build failing at first ` +
        `use rather than at install time. See docker/redis/README.md for the ` +
        `REDIS_URL alternative.`,
    };
  }
}

async function resolveRedisTargetUncached(): Promise<RedisTarget> {
  const attempts: RedisTargetAttempt[] = [];

  const envUrl = process.env.REDIS_URL;

  if (envUrl !== undefined && envUrl.length > 0) {
    const probe = await probeRedisUrl(envUrl);

    if (probe.ok) {
      return { ok: true, url: envUrl, source: `REDIS_URL=${envUrl}` };
    }

    // Falls through to the next candidate rather than returning here. A set
    // but dead `REDIS_URL` should not veto an ephemeral server that would
    // have worked — the variable states a preference, not a prohibition —
    // and the attempt below carries the reason either way.
    attempts.push({
      name: 'REDIS_URL environment variable',
      detail: probe.detail,
    });
  } else {
    attempts.push({
      name: 'REDIS_URL environment variable',
      detail:
        envUrl === undefined
          ? 'not set'
          : 'set, but empty — treated the same as unset',
    });
  }

  const memoryServerResult = await tryRedisMemoryServer();

  if (memoryServerResult.ok) {
    return {
      ok: true,
      url: memoryServerResult.url,
      source: `redis-memory-server (ephemeral, ${memoryServerResult.url})`,
    };
  }

  attempts.push({
    name: 'redis-memory-server',
    detail: memoryServerResult.detail,
  });

  const attemptLines = attempts
    .map(
      (attempt, index) => `  ${index + 1}) ${attempt.name} — ${attempt.detail}`,
    )
    .join('\n');

  return {
    ok: false,
    attempts,
    message:
      `Redis suite skipped: no server available. Tried, in order:\n` +
      `${attemptLines}\n` +
      `To run these tests, set REDIS_URL to a reachable server — for example ` +
      `\`REDIS_URL=redis://localhost:6379\` against docker/redis/ (see its ` +
      `README), or against any Redis you already have running.`,
  };
}

let cachedTargetPromise: Promise<RedisTarget> | undefined;

/**
 * Resolves where the Redis suites should connect, memoized for the life of
 * the worker process: every test in a file calls this, and the second
 * attempt above (a dynamic import, possibly a source download) is too
 * expensive to repeat per test.
 */
export function resolveRedisTarget(): Promise<RedisTarget> {
  if (!cachedTargetPromise) {
    cachedTargetPromise = resolveRedisTargetUncached();
  }

  return cachedTargetPromise;
}

/**
 * Stops the ephemeral `redis-memory-server` started by {@link
 * resolveRedisTarget}, if one was. A no-op on the `REDIS_URL` path, where
 * there is nothing this process started and therefore nothing for it to
 * stop. Call from a suite's `afterAll`.
 */
export async function stopEphemeralRedisServer(): Promise<void> {
  if (ephemeralServer) {
    await ephemeralServer.stop();
    ephemeralServer = undefined;
  }
}

// ---------------------------------------------------------------------------
// Per-test isolation
//
// Redis is ONE shared keyspace — unlike the LMDB tests, which get isolation
// free from separate temp directories (see box-store-lmdb.test.ts). Vitest
// runs test files in parallel workers against the *same* server, so two
// suites racing on the same keys is a real failure mode, and the worst kind:
// it looks like a bug in the store rather than in the harness.
//
// The fix is a prefix unique per namespace, drawn from 8 random bytes
// (2^64 space) rather than from anything derived from the process — a
// worker id or a timestamp is exactly the kind of thing two racing workers
// can share. Teardown scopes to that prefix with SCAN + DEL, never FLUSHDB:
// the server this harness points at may be shared with something else (a
// developer's own data against docker/redis/, or another suite entirely),
// and wiping the whole keyspace to clean up one test's keys is not
// acceptable.
// ---------------------------------------------------------------------------

/** The subset of a `redis` client this helper needs — see {@link RedisScanDel}. */
export interface RedisScanDel {
  scan(
    cursor: string,
    options: { MATCH: string; COUNT: number },
  ): Promise<{ cursor: string; keys: string[] }>;
  del(keys: string[]): Promise<number>;
}

export interface RedisTestNamespace {
  /** The unique prefix this namespace's keys share, e.g. `rawbox-test:ab12…:`. */
  readonly prefix: string;
  /** Builds a key under this namespace's prefix. */
  key(name: string): string;
  /**
   * Deletes every key under this namespace's prefix via SCAN + DEL, in
   * batches, and only those keys — never FLUSHDB. Safe to call even if the
   * namespace wrote nothing.
   */
  cleanup(): Promise<void>;
}

/**
 * Builds an isolated key namespace for one test (or one test file) against
 * `client`. Call once per test, and `cleanup()` it in `afterEach`/`afterAll`
 * — see the module comment above for why a shared keyspace makes this
 * mandatory rather than a nicety.
 */
export function createRedisTestNamespace(
  client: RedisScanDel,
): RedisTestNamespace {
  const prefix = `rawbox-test:${randomBytes(8).toString('hex')}:`;

  return {
    prefix,
    key: (name: string) => `${prefix}${name}`,
    cleanup: async () => {
      let cursor = '0';

      do {
        const scanResult = await client.scan(cursor, {
          MATCH: `${prefix}*`,
          COUNT: 100,
        });

        cursor = scanResult.cursor;

        if (scanResult.keys.length > 0) {
          await client.del(scanResult.keys);
        }
      } while (cursor !== '0');
    },
  };
}
