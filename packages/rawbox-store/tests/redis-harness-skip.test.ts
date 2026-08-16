// ---------------------------------------------------------------------------
// The harness's own skip behaviour — the one Redis suite that never skips.
//
// Every other Redis file here skips when no server is reachable, which is
// correct and which also means none of them can prove that skipping *works*:
// a suite that skips reports the same "0 failed" whether its skip path is
// sound or catastrophically broken. This file tests the skip itself, so it
// must run in every environment, with or without Redis.
//
// ## The regression it exists to catch
//
// `resolveRedisTarget` used to accept any non-empty `REDIS_URL` as a working
// target without contacting it. The suites then called `connect()`, node-redis
// retried with backoff rather than failing, and `beforeAll` ran past vitest's
// 10s hook timeout: `Test Files 1 failed`, exit code 1, and an error naming
// neither Redis nor the URL. The tests inside still said "skipped" — the hooks
// were what went red, which is why a test asserting on test *results* would
// not have caught it.
//
// So the assertion here is on the **process exit code** of a real vitest run,
// not on any in-process value. That is the thing that was wrong, and it is the
// thing CI reads.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A port nothing listens on, in the IANA dynamic range.
 *
 * `127.0.0.1` rather than an unroutable public address on purpose: a closed
 * local port refuses immediately, so the probe's failure path is exercised
 * without waiting out its whole timeout, and the test stays fast even though
 * the behaviour under test is "does not hang".
 */
const DEAD_REDIS_URL = 'redis://127.0.0.1:6399';

/**
 * Runs one Redis suite in a child vitest, with the environment overrides given.
 *
 * A child process is the point: this asserts on the exit code the CI runner
 * sees, which cannot be observed from inside the run being measured.
 */
function runRedisSuite(env: Record<string, string>): {
  status: number | null;
  output: string;
} {
  // The default reporter, deliberately. `--reporter=basic` was removed in
  // vitest 4 and makes the child exit 1 on the flag alone — which would make
  // this test pass or fail for a reason that has nothing to do with Redis.
  // The harness prints its diagnostic through `process.stdout.write`, so it
  // reaches this output under the default reporter without needing a verbose
  // one.
  const result = spawnSync(
    'npx',
    ['vitest', 'run', 'tests/redis-connection.test.ts'],
    {
      cwd: PACKAGE_ROOT,
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: 120_000,
    },
  );

  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

describe('the Redis harness skips instead of failing', () => {
  it('exits 0 when REDIS_URL points at a server that is not there', () => {
    const { status, output } = runRedisSuite({ REDIS_URL: DEAD_REDIS_URL });

    // The whole point. Before the probe existed this was 1, from a hook
    // timeout — an environment problem reported as a broken build.
    expect(status).toBe(0);
    expect(output).not.toContain('Hook timed out');
  }, 130_000);

  it('says the server did not answer, not that the variable is missing', () => {
    const { output } = runRedisSuite({ REDIS_URL: DEAD_REDIS_URL });

    // A developer must be able to act on this without re-running anything:
    // the URL that was tried, and the fact that it was tried and refused.
    expect(output).toContain(DEAD_REDIS_URL);
    expect(output).toMatch(/no Redis answered there/i);
    // The failure mode this must never regress into: reporting a configured
    // server as an absent one, sending someone to set a variable they set.
    expect(output).not.toMatch(/REDIS_URL environment variable — not set/);
  }, 130_000);

  it('exits 0 and says the variable is unset when it is', () => {
    const { status, output } = runRedisSuite({ REDIS_URL: '' });

    expect(status).toBe(0);
    // An empty value is documented as equivalent to unset; the message must
    // reflect what the developer actually did rather than a probe failure.
    expect(output).toMatch(/REDIS_URL environment variable — set, but empty/);
  }, 130_000);
});
