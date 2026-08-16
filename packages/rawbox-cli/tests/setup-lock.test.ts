import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import {
  acquireSetupLock,
  releaseSetupLock,
  setupLockPathFor,
  waitForSetupLockRelease,
  type StaleLockRecovery,
} from '../src/commands/workflow/setup-lock.js';
import { performAutoSetup, type AutoSetupInstallResult } from '../src/commands/workflow/auto-setup.js';
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
async function freshTargetFolder(): Promise<string> {
  counter += 1;
  const dir = path.join(rootDir, `target-${counter}`);
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
  it('acquires a fresh lock and writes its own pid/start-time', async () => {
    const targetFolder = await freshTargetFolder();
    const result = await acquireSetupLock(targetFolder);
    expect(result.status).toBe('acquired');

    const lockPath = setupLockPathFor(targetFolder);
    const written = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    expect(written.pid).toBe(process.pid);
    expect(typeof written.pid_started_at).toBe('number');

    await releaseSetupLock(lockPath);
    await expect(fs.access(lockPath)).rejects.toThrow();
  });

  it('reports "held" (not stale) when a live, correctly-identified process owns the lock', async () => {
    const targetFolder = await freshTargetFolder();
    const first = await acquireSetupLock(targetFolder);
    expect(first.status).toBe('acquired');

    // A second attempt, from the same process, must see its own lock as
    // genuinely held (this process is alive and its start time matches) —
    // not stale — rather than clobbering itself.
    const second = await acquireSetupLock(targetFolder);
    expect(second.status).toBe('held');
    if (second.status === 'held') {
      expect(second.payload?.pid).toBe(process.pid);
    }

    await releaseSetupLock(setupLockPathFor(targetFolder));
  });

  it('stale-lock recovery: a lock naming a DEAD pid is removed and taken over', async () => {
    const targetFolder = await freshTargetFolder();
    const lockPath = setupLockPathFor(targetFolder);
    const stalePid = await deadPid();

    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: stalePid, pid_started_at: Date.now() - 60_000, created_at: new Date().toISOString() }),
    );

    const recoveries: StaleLockRecovery[] = [];
    const result = await acquireSetupLock(targetFolder, {
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
    const targetFolder = await freshTargetFolder();
    const lockPath = setupLockPathFor(targetFolder);

    // `process.pid` is genuinely alive (it's us), but the recorded start
    // time is nowhere near this process's real one — the pid-reuse case
    // `pid-probe.ts` exists to catch.
    await fs.writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, pid_started_at: 1, created_at: new Date(0).toISOString() }),
    );

    const recoveries: StaleLockRecovery[] = [];
    const result = await acquireSetupLock(targetFolder, {
      onStaleRecovery: (info) => recoveries.push(info),
    });

    expect(result.status).toBe('acquired');
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.payload?.pid).toBe(process.pid);

    await releaseSetupLock(lockPath);
  });

  it('a corrupt lock file younger than the staleness threshold is treated as genuinely held', async () => {
    const targetFolder = await freshTargetFolder();
    const lockPath = setupLockPathFor(targetFolder);
    await fs.writeFile(lockPath, 'not json at all');

    const result = await acquireSetupLock(targetFolder, { corruptStaleAfterMs: 60_000 });
    expect(result.status).toBe('held');

    await fs.rm(lockPath, { force: true });
  });

  it('a corrupt lock file OLDER than the staleness threshold is recovered', async () => {
    const targetFolder = await freshTargetFolder();
    const lockPath = setupLockPathFor(targetFolder);
    await fs.writeFile(lockPath, 'not json at all');

    // Back-date the file so it reads as older than the (tiny, test-only) threshold.
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);

    const recoveries: StaleLockRecovery[] = [];
    const result = await acquireSetupLock(targetFolder, {
      corruptStaleAfterMs: 1_000,
      onStaleRecovery: (info) => recoveries.push(info),
    });

    expect(result.status).toBe('acquired');
    expect(recoveries).toHaveLength(1);

    await releaseSetupLock(lockPath);
  });

  it('waitForSetupLockRelease resolves "released" the moment the lock file disappears', async () => {
    const targetFolder = await freshTargetFolder();
    const lockPath = setupLockPathFor(targetFolder);
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, pid_started_at: Date.now(), created_at: '' }));

    const waitPromise = waitForSetupLockRelease(lockPath, { maxWaitMs: 5_000, pollIntervalMs: 20 });
    setTimeout(() => {
      void releaseSetupLock(lockPath);
    }, 100);

    const result = await waitPromise;
    expect(result.status).toBe('released');
  });

  it('bounded wait expiry: a lock held by a live, correctly-identified pid times out with a clear error naming the lock path', async () => {
    const targetFolder = await freshTargetFolder();
    const lockPath = setupLockPathFor(targetFolder);
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
    const targetFolder = await freshTargetFolder();
    let installCalls = 0;

    const outcome = await performAutoSetup(targetFolder, false, {
      findUnresolved: () => [],
      install: async () => {
        installCalls += 1;
        return { ok: true, targetFolder };
      },
      logger: noopLogger(),
    });

    expect(outcome.kind).toBe('not-needed');
    expect(installCalls).toBe(0);
    await expect(fs.access(setupLockPathFor(targetFolder))).rejects.toThrow();
  });

  it('installs, holding then releasing the lock, when something is unresolved', async () => {
    const targetFolder = await freshTargetFolder();
    let installCalls = 0;

    const outcome = await performAutoSetup(targetFolder, false, {
      findUnresolved: () => ['some-plugin'],
      install: async (): Promise<AutoSetupInstallResult> => {
        installCalls += 1;
        // The lock must be held while the install runs.
        await expect(fs.access(setupLockPathFor(targetFolder))).resolves.toBeUndefined();
        return { ok: true, targetFolder };
      },
      logger: noopLogger(),
    });

    expect(outcome).toEqual({ kind: 'installed', targetFolder });
    expect(installCalls).toBe(1);
    await expect(fs.access(setupLockPathFor(targetFolder))).rejects.toThrow();
  });

  it('propagates an install failure as "failed", still releasing the lock', async () => {
    const targetFolder = await freshTargetFolder();

    const outcome = await performAutoSetup(targetFolder, false, {
      findUnresolved: () => ['some-plugin'],
      install: async () => ({ ok: false, error: 'npm exploded' }),
      logger: noopLogger(),
    });

    expect(outcome).toEqual({ kind: 'failed', message: 'npm exploded' });
    await expect(fs.access(setupLockPathFor(targetFolder))).rejects.toThrow();
  });

  it('loser fast path: a winner installs while a concurrent loser waits, then joins without installing', async () => {
    const targetFolder = await freshTargetFolder();
    let installed = false;
    let installCalls = 0;

    const winner = performAutoSetup(targetFolder, false, {
      findUnresolved: () => (installed ? [] : ['some-plugin']),
      install: async () => {
        installCalls += 1;
        // Hold the lock for a bit so the loser below reliably observes 'held'.
        await new Promise((resolve) => setTimeout(resolve, 250));
        installed = true;
        return { ok: true, targetFolder };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    // Give the winner a moment to win the race and take the lock first.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const loser = performAutoSetup(targetFolder, false, {
      findUnresolved: () => (installed ? [] : ['some-plugin']),
      install: async () => {
        installCalls += 1;
        return { ok: true, targetFolder };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    const [winnerOutcome, loserOutcome] = await Promise.all([winner, loser]);

    expect(winnerOutcome).toEqual({ kind: 'installed', targetFolder });
    expect(loserOutcome).toEqual({ kind: 'joined-existing-install' });
    // Exactly one install call across both — the whole point of the fix.
    expect(installCalls).toBe(1);
  });

  it('a loser whose own plugins are still missing after waiting installs them itself (differing plugin sets)', async () => {
    const targetFolder = await freshTargetFolder();
    let pluginAInstalled = false;
    let pluginBInstalled = false;
    const installedBy: string[] = [];

    const winner = performAutoSetup(targetFolder, false, {
      findUnresolved: () => (pluginAInstalled ? [] : ['plugin-a']),
      install: async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        pluginAInstalled = true;
        installedBy.push('winner');
        return { ok: true, targetFolder };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // This process needs a *different* plugin — the winner installing
    // plugin-a never satisfies it, so it must install for itself once it
    // gets the lock.
    const other = performAutoSetup(targetFolder, false, {
      findUnresolved: () => (pluginBInstalled ? [] : ['plugin-b']),
      install: async () => {
        pluginBInstalled = true;
        installedBy.push('other');
        return { ok: true, targetFolder };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    const [winnerOutcome, otherOutcome] = await Promise.all([winner, other]);

    expect(winnerOutcome).toEqual({ kind: 'installed', targetFolder });
    expect(otherOutcome).toEqual({ kind: 'installed', targetFolder });
    expect(installedBy.sort()).toEqual(['other', 'winner']);
  });

  it('bounded wait expiry surfaces as "failed", naming the lock path', async () => {
    const targetFolder = await freshTargetFolder();
    const lockPath = setupLockPathFor(targetFolder);
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

    const outcome = await performAutoSetup(targetFolder, false, {
      findUnresolved: () => ['some-plugin'],
      install: async () => ({ ok: true, targetFolder }),
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
    const targetFolder = await freshTargetFolder();
    let installed = false;
    let installCalls = 0;

    const first = performAutoSetup(targetFolder, true, {
      findUnresolved: () => (installed ? [] : ['some-plugin']),
      install: async () => {
        installCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 250));
        installed = true;
        return { ok: true, targetFolder };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = performAutoSetup(targetFolder, true, {
      findUnresolved: () => (installed ? [] : ['some-plugin']),
      install: async () => {
        installCalls += 1;
        return { ok: true, targetFolder };
      },
      logger: noopLogger(),
      lockOptions: { pollIntervalMs: 20, maxWaitMs: 5_000 },
    });

    await Promise.all([first, second]);
    expect(installCalls).toBe(1);
  });
});
