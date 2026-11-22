import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { DEPENDENCY_ENV_READY_FILENAME, DEPENDENCY_ENV_SETUP_LOCK_FILENAME } from '@rawbox/runner';

import {
  acquireSetupLock,
  releaseSetupLock,
  setupLockPathFor,
  waitForSetupLockRelease,
  withSetupLock,
  type StaleLockRecovery,
} from '../src/commands/workflow/setup-lock.js';
import {
  findUnresolvedInEnv,
  performAutoSetup,
  type AutoSetupInstallResult,
} from '../src/commands/workflow/auto-setup.js';
import { getProcessStartedAtMs } from '../src/runs/pid-probe.js';

// ---------------------------------------------------------------------------
// Unit-level coverage of the auto-setup mutual-exclusion fix: the filesystem
// lock primitives (`setup-lock.ts`) and the algorithm built on top of them
// (`auto-setup.ts`), independent of spawning a real CLI process per
// scenario. `auto-setup-race.test.ts` covers the real multi-process race
// end-to-end through the built CLI.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-setup-lock-test');

let counter = 0;
/** `<root>/target-N/envs/<16 hex>`, shaped like a real env directory. */
function envDirPath(): string {
  counter += 1;
  return path.join(rootDir, `target-${counter}`, 'envs', counter.toString(16).padStart(16, '0'));
}

async function freshEnvDir(): Promise<string> {
  const dir = envDirPath();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Spawns and immediately waits out a short-lived child, returning its now-dead pid. */
async function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const pid = child.pid!;
    child.on('error', reject);
    child.on('exit', () => resolve(pid));
  });
}

function noopLogger(): { info: (m: string) => void; warn: (m: string) => void } {
  return { info: () => {}, warn: () => {} };
}

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('setup-lock.ts — the exclusive lock primitive', () => {
  it('places the lock inside the env directory, under the name the runner prunes around', () => {
    const envDir = path.join(rootDir, '.rawbox', 'envs', '0123456789abcdef');
    expect(setupLockPathFor(envDir)).toBe(path.join(envDir, '.rawbox-setup.lock'));
    expect(path.basename(setupLockPathFor(envDir))).toBe(DEPENDENCY_ENV_SETUP_LOCK_FILENAME);
  });

  it('acquires a fresh lock and writes its own pid/start-time', async () => {
    const envDir = await freshEnvDir();
    const result = await acquireSetupLock(envDir);
    expect(result.status).toBe('acquired');

    const lockPath = setupLockPathFor(envDir);
    const written = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    expect(written.pid).toBe(process.pid);
    expect(typeof written.pid_started_at).toBe('number');

    await releaseSetupLock(lockPath);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('reports "held" (not stale) when a live, correctly-identified process owns the lock', async () => {
    const envDir = await freshEnvDir();
    const first = await acquireSetupLock(envDir);
    expect(first.status).toBe('acquired');

    // A second attempt, from the same process, must see its own lock as
    // genuinely held (this process is alive and its start time matches) —
    // not stale — rather than clobbering itself.
    const second = await acquireSetupLock(envDir);
    expect(second.status).toBe('held');
    if (second.status === 'held') {
      expect(second.payload?.pid).toBe(process.pid);
    }

    await releaseSetupLock(setupLockPathFor(envDir));
  });

  it('stale-lock recovery: a lock naming a DEAD pid is removed and taken over', async () => {
    const envDir = await freshEnvDir();
    const lockPath = setupLockPathFor(envDir);
    const stalePid = await deadPid();

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: stalePid, pid_started_at: Date.now() - 60_000, created_at: new Date().toISOString() }),
    );

    const recoveries: StaleLockRecovery[] = [];
    const result = await acquireSetupLock(envDir, {
      onStaleRecovery: (info) => recoveries.push(info),
    });

    expect(result.status).toBe('acquired');
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.payload?.pid).toBe(stalePid);

    // And the lock now on disk is this process's, not the dead one's.
    const written = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    expect(written.pid).toBe(process.pid);

    await releaseSetupLock(lockPath);
  });

  it('stale-lock recovery: a LIVE pid (this test\'s own) with the WRONG start time is treated stale', async () => {
    const envDir = await freshEnvDir();
    const lockPath = setupLockPathFor(envDir);

    // `process.pid` is genuinely alive (it's us), but the recorded start
    // time is nowhere near this process's real one — the pid-reuse case
    // `pid-probe.ts` exists to catch.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, pid_started_at: 1, created_at: new Date(0).toISOString() }),
    );

    const recoveries: StaleLockRecovery[] = [];
    const result = await acquireSetupLock(envDir, {
      onStaleRecovery: (info) => recoveries.push(info),
    });

    expect(result.status).toBe('acquired');
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.payload?.pid).toBe(process.pid);

    await releaseSetupLock(lockPath);
  });

  it('a corrupt lock file younger than the staleness threshold is treated as genuinely held', async () => {
    const envDir = await freshEnvDir();
    const lockPath = setupLockPathFor(envDir);
    await fs.writeFile(lockPath, 'not json at all');

    const result = await acquireSetupLock(envDir, { corruptStaleAfterMs: 60_000 });
    expect(result.status).toBe('held');

    await fs.rm(lockPath, { force: true });
  });

  it('a corrupt lock file OLDER than the staleness threshold is recovered', async () => {
    const envDir = await freshEnvDir();
    const lockPath = setupLockPathFor(envDir);
    await fs.writeFile(lockPath, 'not json at all');

    // Back-date the file so it reads as older than the (tiny, test-only) threshold.
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);

    const recoveries: StaleLockRecovery[] = [];
    const result = await acquireSetupLock(envDir, {
      corruptStaleAfterMs: 1_000,
      onStaleRecovery: (info) => recoveries.push(info),
    });

    expect(result.status).toBe('acquired');
    expect(recoveries).toHaveLength(1);

    await releaseSetupLock(lockPath);
  });

  it('waitForSetupLockRelease resolves "released" the moment the lock file disappears', async () => {
    const envDir = await freshEnvDir();
    const lockPath = setupLockPathFor(envDir);
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, pid_started_at: Date.now(), created_at: '' }));

    const waitPromise = waitForSetupLockRelease(lockPath, { maxWaitMs: 5_000, pollIntervalMs: 20 });
    setTimeout(() => {
      void releaseSetupLock(lockPath);
    }, 100);

    const result = await waitPromise;
    expect(result.status).toBe('released');
  });

  it('bounded wait expiry: a lock held by a live, correctly-identified pid times out with a clear error naming the lock path', async () => {
    const envDir = await freshEnvDir();
    const lockPath = setupLockPathFor(envDir);
    // Genuinely alive and correctly identified — never released during the test.
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        pid_started_at: getProcessStartedAtMs(process.pid) ?? Date.now(),
        created_at: new Date().toISOString(),
      }),
    );

    const result = await waitForSetupLockRelease(lockPath, { maxWaitMs: 100, pollIntervalMs: 20 });
    expect(result.status).toBe('timed-out');

    await fs.rm(lockPath, { force: true });
  });
});

describe('auto-setup.ts — performAutoSetup', () => {
  it('"not-needed": the lock is never touched when nothing is unresolved and setup was not forced', async () => {
    const envDir = await freshEnvDir();
    let installCalls = 0;

    const outcome = await performAutoSetup(envDir, false, {
      findUnresolved: () => [],
      install: async () => {
        installCalls += 1;
        return { ok: true, envDir };
      },
      logger: noopLogger(),
    });

    expect(outcome.kind).toBe('not-needed');
    expect(installCalls).toBe(0);
    await expect(fs.access(setupLockPathFor(envDir))).rejects.toThrow();
  });

  it('installs, holding then releasing the lock, when something is unresolved', async () => {
    const envDir = await freshEnvDir();
    let installCalls = 0;

    const outcome = await performAutoSetup(envDir, false, {
      findUnresolved: () => ['some-plugin'],
      install: async (): Promise<AutoSetupInstallResult> => {
        installCalls += 1;
        // The lock must be held while the install runs.
        await expect(fs.access(setupLockPathFor(envDir))).resolves.toBeUndefined();
        return { ok: true, envDir };
      },
      logger: noopLogger(),
    });

    expect(outcome).toEqual({ kind: 'installed', envDir });
    expect(installCalls).toBe(1);
    await expect(fs.access(setupLockPathFor(envDir))).rejects.toThrow();
  });

  it('propagates an install failure as "failed", still releasing the lock', async () => {
    const envDir = await freshEnvDir();

    const outcome = await performAutoSetup(envDir, false, {
      findUnresolved: () => ['some-plugin'],
      install: async () => ({ ok: false, error: 'npm exploded' }),
      logger: noopLogger(),
    });

    expect(outcome).toEqual({ kind: 'failed', message: 'npm exploded' });
    await expect(fs.access(setupLockPathFor(envDir))).rejects.toThrow();
  });

  it('loser fast path: a winner installs while a concurrent loser waits, then joins without installing', async () => {
    const envDir = await freshEnvDir();
    let installed = false;
    let installCalls = 0;

    const winner = performAutoSetup(envDir, false, {
      findUnresolved: () => (installed ? [] : ['some-plugin']),
      install: async () => {
        installCalls += 1;
        // Hold the lock for a bit so the loser below reliably observes 'held'.
        await new Promise((resolve) => setTimeout(resolve, 250));
        installed = true;
        return { ok: true, envDir };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    // Give the winner a moment to win the race and take the lock first.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const loser = performAutoSetup(envDir, false, {
      findUnresolved: () => (installed ? [] : ['some-plugin']),
      install: async () => {
        installCalls += 1;
        return { ok: true, envDir };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    const [winnerOutcome, loserOutcome] = await Promise.all([winner, loser]);

    expect(winnerOutcome).toEqual({ kind: 'installed', envDir });
    expect(loserOutcome).toEqual({ kind: 'joined-existing-install' });
    // Exactly one install call across both — the whole point of the fix.
    expect(installCalls).toBe(1);
  });

  it('a loser that still finds the env not ready after waiting installs it itself (the winner failed)', async () => {
    const envDir = await freshEnvDir();
    let ready = false;
    const installedBy: string[] = [];

    const winner = performAutoSetup(envDir, false, {
      findUnresolved: () => (ready ? [] : ['plugin-a']),
      install: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        installedBy.push('winner');
        return { ok: false, error: 'npm exploded' };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const other = performAutoSetup(envDir, false, {
      findUnresolved: () => (ready ? [] : ['plugin-a']),
      install: async () => {
        ready = true;
        installedBy.push('other');
        return { ok: true, envDir };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    const [winnerOutcome, otherOutcome] = await Promise.all([winner, other]);

    expect(winnerOutcome).toEqual({ kind: 'failed', message: 'npm exploded' });
    expect(otherOutcome).toEqual({ kind: 'installed', envDir });
    expect(installedBy).toEqual(['winner', 'other']);
  });

  it('different env directories never contend: both install at once', async () => {
    const envDirA = await freshEnvDir();
    const envDirB = await freshEnvDir();
    let inFlight = 0;
    let maxInFlight = 0;

    const installInto = (envDir: string) => async (): Promise<AutoSetupInstallResult> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 200));
      inFlight -= 1;
      return { ok: true, envDir };
    };

    const outcomes = await Promise.all(
      [envDirA, envDirB].map((envDir) =>
        performAutoSetup(envDir, false, {
          findUnresolved: () => ['some-plugin'],
          install: installInto(envDir),
          logger: noopLogger(),
          lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
        }),
      ),
    );

    expect(outcomes).toEqual([
      { kind: 'installed', envDir: envDirA },
      { kind: 'installed', envDir: envDirB },
    ]);
    expect(maxInFlight).toBe(2);
  });

  it('creates a missing env directory and holds the lock inside it during the install', async () => {
    const envDir = envDirPath();
    await expect(fs.access(envDir)).rejects.toThrow();

    const outcome = await performAutoSetup(envDir, false, {
      findUnresolved: () => ['some-plugin'],
      install: async (): Promise<AutoSetupInstallResult> => {
        await expect(
          fs.access(path.join(envDir, DEPENDENCY_ENV_SETUP_LOCK_FILENAME)),
        ).resolves.toBeUndefined();
        return { ok: true, envDir };
      },
      logger: noopLogger(),
    });

    expect(outcome).toEqual({ kind: 'installed', envDir });
    expect((await fs.stat(envDir)).isDirectory()).toBe(true);
  });

  it('bounded wait expiry surfaces as "failed", naming the lock path', async () => {
    const envDir = await freshEnvDir();
    const lockPath = setupLockPathFor(envDir);
    // A lock that is genuinely held (live, correctly-identified pid) and
    // never released during the test — the loser must give up, not hang.
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        pid_started_at: getProcessStartedAtMs(process.pid) ?? Date.now(),
        created_at: new Date().toISOString(),
      }),
    );

    const outcome = await performAutoSetup(envDir, false, {
      findUnresolved: () => ['some-plugin'],
      install: async () => ({ ok: true, envDir }),
      logger: noopLogger(),
      lockOptions: { maxWaitMs: 100, pollIntervalMs: 20 },
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.message).toContain(lockPath);
    }

    await fs.rm(lockPath, { force: true });
  });

  it('"--setup" (force) still honors the lock: a concurrent forced run does not double-install', async () => {
    const envDir = await freshEnvDir();
    let installed = false;
    let installCalls = 0;

    const first = performAutoSetup(envDir, true, {
      findUnresolved: () => (installed ? [] : ['some-plugin']),
      install: async () => {
        installCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
        installed = true;
        return { ok: true, envDir };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = performAutoSetup(envDir, true, {
      findUnresolved: () => (installed ? [] : ['some-plugin']),
      install: async () => {
        installCalls += 1;
        return { ok: true, envDir };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    await Promise.all([first, second]);
    expect(installCalls).toBe(1);
  });
});

describe('auto-setup.ts — findUnresolvedInEnv', () => {
  // Resolves from this monorepo's hoisted `node_modules` from anywhere under
  // it — exactly the "right name, wrong install" a version bump leaves behind.
  const RESOLVABLE_ELSEWHERE = '@rawbox/rawbox-plugin-default';

  it('reports every declared plugin while the ready marker is missing, even one that resolves elsewhere', async () => {
    const envDir = await freshEnvDir();

    expect(findUnresolvedInEnv(envDir, [RESOLVABLE_ELSEWHERE])).toEqual([RESOLVABLE_ELSEWHERE]);
  });

  it('a missing ready marker makes performAutoSetup install, even though the package resolves elsewhere', async () => {
    const envDir = await freshEnvDir();
    let installCalls = 0;

    const outcome = await performAutoSetup(envDir, false, {
      findUnresolved: () => findUnresolvedInEnv(envDir, [RESOLVABLE_ELSEWHERE]),
      install: async () => {
        installCalls += 1;
        return { ok: true, envDir };
      },
      logger: noopLogger(),
    });

    expect(outcome).toEqual({ kind: 'installed', envDir });
    expect(installCalls).toBe(1);
  });

  it('with the ready marker present, falls back to resolution from the env', async () => {
    const envDir = await freshEnvDir();
    await fs.writeFile(path.join(envDir, DEPENDENCY_ENV_READY_FILENAME), '{}\n');

    expect(findUnresolvedInEnv(envDir, [RESOLVABLE_ELSEWHERE])).toEqual([]);
    expect(findUnresolvedInEnv(envDir, ['rawbox-plugin-that-exists-nowhere'])).toEqual([
      'rawbox-plugin-that-exists-nowhere',
    ]);
  });
});

describe('setup-lock.ts — withSetupLock', () => {
  it('serializes callers on one env directory and releases the lock afterwards', async () => {
    const envDir = await freshEnvDir();
    let inFlight = 0;
    let maxInFlight = 0;

    const task = async (): Promise<string> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await expect(fs.access(setupLockPathFor(envDir))).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 100));
      inFlight -= 1;
      return 'done';
    };

    const results = await Promise.all([
      withSetupLock(envDir, task, { pollIntervalMs: 20, maxWaitMs: 5_000 }),
      withSetupLock(envDir, task, { pollIntervalMs: 20, maxWaitMs: 5_000 }),
    ]);

    expect(results).toEqual(['done', 'done']);
    expect(maxInFlight).toBe(1);
    await expect(fs.access(setupLockPathFor(envDir))).rejects.toThrow();
  });

  it('releases the lock when the wrapped function throws', async () => {
    const envDir = await freshEnvDir();

    await expect(
      withSetupLock(envDir, async () => {
        throw new Error('install blew up');
      }),
    ).rejects.toThrow('install blew up');
    await expect(fs.access(setupLockPathFor(envDir))).rejects.toThrow();
  });

  it('rejects naming the lock path when the wait times out', async () => {
    const envDir = await freshEnvDir();
    const lockPath = setupLockPathFor(envDir);
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        pid_started_at: getProcessStartedAtMs(process.pid) ?? Date.now(),
        created_at: new Date().toISOString(),
      }),
    );

    await expect(
      withSetupLock(envDir, async () => 'never', { maxWaitMs: 100, pollIntervalMs: 20 }),
    ).rejects.toThrow(lockPath);

    await fs.rm(lockPath, { force: true });
  });
});
