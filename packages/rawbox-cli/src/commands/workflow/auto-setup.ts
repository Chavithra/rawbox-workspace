/**
 * `workflow run`'s auto-setup step (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)"), made
 * mutually exclusive per target folder via `setup-lock.ts`.
 *
 * The hazard this closes: several `rawbox-cli run` processes started
 * concurrently against workflows of *one* workspace — the documented
 * multi-workflow pattern — each run their own cheap
 * `PluginDiscoverer.findUnresolvedPlugins` pre-check, each find the same
 * plugin missing, and each would call `setupWorkspace`/`setupNpmPackage`
 * (an `npm install`) into the very same target folder at the same time. npm
 * does not tolerate two concurrent installs sharing one prefix.
 *
 * The algorithm, independent of the CLI plumbing around it (kept here so it
 * is unit-testable without spawning a child process per scenario):
 *
 * 1. The initial "is anything even missing" decision is unlocked — the
 *    common case (everything already resolves) must never touch the
 *    filesystem lock at all.
 * 2. Otherwise, race for the lock. The winner runs `deps.install` and
 *    releases the lock in a `finally`, whether it succeeded or not.
 * 3. A loser waits (bounded) for the lock to disappear, then re-runs the
 *    same cheap pre-check. If the winner already installed everything this
 *    process needed too, it proceeds having installed nothing itself
 *    (`'joined-existing-install'`). If something is still missing — e.g.
 *    two workflows in the same workspace declaring different plugin sets —
 *    it loops back and races for the lock itself.
 * 4. A bounded wait that expires is reported as a failure naming the lock
 *    path, never as a silent proceed.
 */

import {
  acquireSetupLock,
  releaseSetupLock,
  setupLockPathFor,
  waitForSetupLockRelease,
  type AcquireSetupLockOptions,
  type WaitForSetupLockOptions,
} from './setup-lock.js';

export interface AutoSetupLogger {
  info(message: string): void;
  warn(message: string): void;
}

export type AutoSetupInstallResult =
  | { ok: true; targetFolder: string }
  | { ok: false; error: string };

export interface AutoSetupDeps {
  /**
   * The cheap resolution pre-check: names of declared plugins that do NOT
   * currently resolve. Called more than once (before locking, and again by
   * a loser after waiting) — must be cheap and side-effect-free, which
   * `PluginDiscoverer.findUnresolvedPlugins` already is.
   */
  findUnresolved: () => string[];
  /** Performs the real install — `setupWorkspace`/`setupNpmPackage` — while this process holds the lock. */
  install: () => Promise<AutoSetupInstallResult>;
  logger: AutoSetupLogger;
  /** Forwarded to `acquireSetupLock`/`waitForSetupLockRelease`; tests use this to inject a fake pid probe or shrink the wait bound. */
  lockOptions?: AcquireSetupLockOptions & WaitForSetupLockOptions;
}

export type AutoSetupOutcome =
  | { kind: 'not-needed' }
  | { kind: 'installed'; targetFolder: string }
  | { kind: 'joined-existing-install' }
  | { kind: 'failed'; message: string };

/**
 * Runs the algorithm described above against `targetFolder`.
 *
 * `forceSetup` (`--setup`) only affects the *initial* decision to attempt an
 * install at all — it does not skip the lock (point 3 of the fix: "`--setup`
 * also honors the lock") and it does not skip the loser fast path either: a
 * concurrent `--setup` that another process already satisfied is exactly as
 * "joined" as an ordinary missing-plugin one, since the result on disk is
 * identical either way.
 */
export async function performAutoSetup(
  targetFolder: string,
  forceSetup: boolean,
  deps: AutoSetupDeps,
): Promise<AutoSetupOutcome> {
  const { findUnresolved, install, logger, lockOptions } = deps;

  if (!forceSetup && findUnresolved().length === 0) {
    return { kind: 'not-needed' };
  }

  for (;;) {
    const acquireResult = await acquireSetupLock(targetFolder, {
      ...lockOptions,
      onStaleRecovery: (info) => {
        logger.warn(
          `Recovered a stale auto-setup lock at "${info.lockPath}" (${info.reason}) — taking it over.`,
        );
        lockOptions?.onStaleRecovery?.(info);
      },
    });

    if (acquireResult.status === 'acquired') {
      try {
        const result = await install();
        return result.ok
          ? { kind: 'installed', targetFolder: result.targetFolder }
          : { kind: 'failed', message: result.error };
      } finally {
        await releaseSetupLock(setupLockPathFor(targetFolder));
      }
    }

    const holderPid = acquireResult.payload?.pid;
    logger.info(
      'Auto-setup already in progress' +
        (holderPid !== undefined ? ` (pid ${holderPid})` : '') +
        ` — waiting for it to finish setting up "${targetFolder}"...`,
    );

    const waitResult = await waitForSetupLockRelease(acquireResult.lockPath, lockOptions);
    if (waitResult.status === 'timed-out') {
      return {
        kind: 'failed',
        message:
          `Timed out waiting for the auto-setup lock at "${acquireResult.lockPath}"` +
          (holderPid !== undefined ? ` (held by pid ${holderPid})` : '') +
          ' to be released. Remove it manually once you have confirmed no install is really in progress.',
      };
    }

    // Loser fast path: the winner (or whoever held the lock) may already
    // have installed everything this process needed too.
    if (findUnresolved().length === 0) {
      return { kind: 'joined-existing-install' };
    }
    // Still missing something — loop back and race for the lock ourselves.
  }
}
