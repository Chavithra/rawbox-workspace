/**
 * A file lock making `workflow run`'s auto-setup step mutually exclusive per
 * target folder.
 *
 * Several `rawbox-cli run` processes against one workspace, started
 * concurrently — the documented multi-workflow pattern (see
 * `.agents/skills/rawbox-workflow-creation/SKILL.md`, "Setup and Execution" / "Watching a Run") — each
 * independently discover the same missing plugin(s) via
 * `PluginDiscoverer.findUnresolvedPlugins` and would otherwise each invoke
 * `npm install` into the very same target folder at the same time; npm does
 * not tolerate two concurrent installs sharing one prefix. This module is
 * the fix: an exclusive lock file at `<targetFolder>/.rawbox-setup.lock`,
 * created with Node's `wx` flag — the same `O_EXCL` guarantee a plain
 * `open(2)` gives — so exactly one process ever wins the race to create it.
 * See `auto-setup.ts` for how `workflow run` uses this.
 *
 * Process identity for stale-lock recovery reuses `../../runs/pid-probe.js`
 * verbatim: a lock naming a pid that is no longer alive, or a live pid whose
 * start time no longer matches (a recycled pid number), is exactly the
 * `crashed`-run detection the run registry already relies on
 * (OBSERVABILITY.md, "Lifecycle and crash detection"), applied here to a process that died
 * mid-install instead of one that died mid-run.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import {
  getProcessStartedAtMs,
  probeProcess,
  startTimesMatch,
  type ProbeFn,
} from '../../runs/pid-probe.js';

/** Lock file name, inside the target folder auto-setup installs into. */
export const SETUP_LOCK_FILE_NAME = '.rawbox-setup.lock';

/** `<targetFolder>/.rawbox-setup.lock`. */
export function setupLockPathFor(targetFolder: string): string {
  return path.join(targetFolder, SETUP_LOCK_FILE_NAME);
}

/** Contents of a lock file — enough to identify, and later verify, its owner. */
export interface SetupLockPayload {
  pid: number;
  pid_started_at: number;
  created_at: string;
}

/** How long a lock file may go unreadable/unparseable before it is treated as stale outright. */
export const DEFAULT_SETUP_LOCK_CORRUPT_STALE_MS = 60_000;

/** Total time a loser waits for the winner to finish before giving up. */
export const DEFAULT_SETUP_LOCK_MAX_WAIT_MS = 3 * 60_000;

/** How often a loser re-checks whether the lock has been released. */
export const DEFAULT_SETUP_LOCK_POLL_INTERVAL_MS = 200;

/** Reported when a lock is found stale and removed, so a caller can log it. */
export interface StaleLockRecovery {
  lockPath: string;
  payload: SetupLockPayload | undefined;
  reason: string;
}

export interface AcquireSetupLockOptions {
  /** Injectable so tests can simulate a dead pid or a recycled one without racing a real process. Defaults to the real probe. */
  probe?: ProbeFn;
  /** See {@link DEFAULT_SETUP_LOCK_CORRUPT_STALE_MS}. */
  corruptStaleAfterMs?: number;
  /** Called every time a stale lock is found and removed, before the retry — the "log that recovery" hook. */
  onStaleRecovery?: (info: StaleLockRecovery) => void;
}

export type AcquireSetupLockResult =
  | { status: 'acquired' }
  | { status: 'held'; lockPath: string; payload: SetupLockPayload | undefined };

/**
 * Best-effort read of the lock file's contents plus its filesystem age,
 * tolerating a half-written or corrupt file rather than throwing.
 *
 * `ageMs` comes from the file's own `mtime` rather than its `created_at`
 * field, so a corrupt/truncated payload — the write itself was interrupted,
 * or raced with another reader mid-write — still yields a usable age.
 */
async function readLockDetailed(
  lockPath: string,
): Promise<{ payload?: SetupLockPayload; ageMs?: number }> {
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.stat(lockPath)).mtimeMs;
  } catch {
    // Gone already — treat as if there had never been anything to read.
    return {};
  }
  const ageMs = Date.now() - mtimeMs;

  try {
    const parsed: unknown = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).pid === 'number' &&
      typeof (parsed as Record<string, unknown>).pid_started_at === 'number'
    ) {
      const record = parsed as Record<string, unknown>;
      return {
        payload: {
          pid: record.pid as number,
          pid_started_at: record.pid_started_at as number,
          created_at:
            typeof record.created_at === 'string'
              ? record.created_at
              : new Date(mtimeMs).toISOString(),
        },
        ageMs,
      };
    }
    return { ageMs };
  } catch {
    return { ageMs };
  }
}

/** `true` when the lock's named owner is no longer the process that created it. */
function isLockStale(payload: SetupLockPayload, probe: ProbeFn): boolean {
  const result = probe(payload.pid);
  if (!result.alive) {
    return true;
  }
  return !startTimesMatch(payload.pid_started_at, result.startedAtMs);
}

/**
 * Attempts to acquire the auto-setup lock for `targetFolder`, recovering a
 * stale one along the way: a dead or recycled owning pid, or a corrupt file
 * old enough that it cannot just be a write still in progress.
 *
 * Returns `'acquired'` the moment this process holds the lock — the caller
 * must release it (via {@link releaseSetupLock}) in a `finally`, and must
 * treat everything between acquiring and releasing as the critical section.
 * Returns `'held'` when another, still-live process genuinely owns it; the
 * caller is then expected to wait ({@link waitForSetupLockRelease}) rather
 * than retry this call in a loop itself.
 */
export async function acquireSetupLock(
  targetFolder: string,
  options: AcquireSetupLockOptions = {},
): Promise<AcquireSetupLockResult> {
  const lockPath = setupLockPathFor(targetFolder);
  const probe = options.probe ?? probeProcess;
  const corruptStaleAfterMs = options.corruptStaleAfterMs ?? DEFAULT_SETUP_LOCK_CORRUPT_STALE_MS;

  await fs.mkdir(targetFolder, { recursive: true });

  for (;;) {
    const payload: SetupLockPayload = {
      pid: process.pid,
      pid_started_at: getProcessStartedAtMs(process.pid) ?? Date.now(),
      created_at: new Date().toISOString(),
    };

    try {
      // `wx`: fails with EEXIST when the file already exists — the same
      // O_EXCL guarantee a plain open(2) gives, so exactly one concurrent
      // writer ever succeeds at this line for a given lock path.
      await fs.writeFile(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
      return { status: 'acquired' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    const { payload: existing, ageMs } = await readLockDetailed(lockPath);
    if (existing === undefined && ageMs === undefined) {
      // Vanished between our failed create above and this read — someone
      // else's release, or our own stale-recovery on a previous loop turn
      // that lost to a concurrent recovery. Just try creating it again.
      continue;
    }

    const stale = existing !== undefined ? isLockStale(existing, probe) : ageMs! > corruptStaleAfterMs;

    if (!stale) {
      return { status: 'held', lockPath, payload: existing };
    }

    options.onStaleRecovery?.({
      lockPath,
      payload: existing,
      reason:
        existing === undefined
          ? `its contents were unreadable/corrupt and it is older than ${corruptStaleAfterMs}ms`
          : `pid ${existing.pid} is no longer alive, or a different process now holds that pid`,
    });

    await fs.rm(lockPath, { force: true });
    // Loop back and race to create it again — another process recovering
    // the same stale lock may win that race instead, which is fine.
  }
}

/** Releases a lock this process holds. Idempotent — an already-missing file is not an error. */
export async function releaseSetupLock(lockPath: string): Promise<void> {
  await fs.rm(lockPath, { force: true });
}

export interface WaitForSetupLockOptions {
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

export type WaitForSetupLockResult = { status: 'released' } | { status: 'timed-out' };

/**
 * Polls `lockPath` until it no longer exists, bounded by `maxWaitMs`.
 *
 * Existence, not content, is what is being waited on: the winner's own
 * `releaseSetupLock` is an unconditional `rm`, so "the file is gone" is a
 * sufficient and race-free signal that the critical section ended, without
 * this side ever needing to re-read or interpret the winner's payload.
 */
export async function waitForSetupLockRelease(
  lockPath: string,
  options: WaitForSetupLockOptions = {},
): Promise<WaitForSetupLockResult> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_SETUP_LOCK_MAX_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SETUP_LOCK_POLL_INTERVAL_MS;
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    try {
      await fs.access(lockPath);
    } catch {
      return { status: 'released' };
    }
    if (Date.now() >= deadline) {
      return { status: 'timed-out' };
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
