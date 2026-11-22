/**
 * `workflow run`'s auto-setup step (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)"), made
 * mutually exclusive per dependency env directory via `setup-lock.ts`.
 *
 * The hazard this closes: several `rawbox-cli run` processes started
 * concurrently against workflows declaring the same `dependencies:` map —
 * and therefore the same env, `<targetFolder>/envs/<hash>/` — each run their
 * own cheap {@link findUnresolvedInEnv} pre-check, each find the env not yet
 * installed, and each would call `setupDependencyEnv` (an `npm install`) into
 * the very same env directory at the same time. npm does not tolerate two
 * concurrent installs sharing one prefix.
 *
 * The algorithm, independent of the CLI plumbing around it (kept here so it
 * is unit-testable without spawning a child process per scenario):
 *
 * 1. The initial "is anything even missing" decision is unlocked — the
 *    common case (the env is already installed) must never touch the
 *    filesystem lock at all.
 * 2. Otherwise, race for the env's lock. The winner runs `deps.install` and
 *    releases the lock in a `finally`, whether it succeeded or not.
 * 3. A loser waits (bounded) for the lock to disappear, then re-runs the
 *    same cheap pre-check. If the winner already installed the env, it
 *    proceeds having installed nothing itself (`'joined-existing-install'`).
 *    If the env is still not ready — the winner's install failed, say — it
 *    loops back and races for the lock itself. Workflows declaring different
 *    `dependencies:` maps never meet here at all: they hash to different env
 *    directories, take different locks, and install in parallel.
 * 4. A bounded wait that expires is reported as a failure naming the lock
 *    path, never as a silent proceed.
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { DEPENDENCY_ENV_READY_FILENAME, PluginDiscoverer } from '@rawbox/runner';

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
  | { ok: true; envDir: string }
  | { ok: false; error: string };

export interface AutoSetupDeps {
  /**
   * The cheap pre-check: names of declared plugins the env does NOT
   * currently provide. Called more than once (before locking, and again by
   * a loser after waiting) — must be cheap and side-effect-free, which
   * {@link findUnresolvedInEnv} is.
   */
  findUnresolved: () => string[];
  /** Performs the real install — `setupDependencyEnv` — while this process holds the lock. */
  install: () => Promise<AutoSetupInstallResult>;
  logger: AutoSetupLogger;
  /** Forwarded to `acquireSetupLock`/`waitForSetupLockRelease`; tests use this to inject a fake pid probe or shrink the wait bound. */
  lockOptions?: AcquireSetupLockOptions & WaitForSetupLockOptions;
}

export type AutoSetupOutcome =
  | { kind: 'not-needed' }
  | { kind: 'installed'; envDir: string }
  | { kind: 'joined-existing-install' }
  | { kind: 'failed'; message: string };

/**
 * The declared plugins `envDir` does not provide: every one of them while the
 * env's `.rawbox-env-ready.json` is missing, otherwise those that do not
 * resolve from `envDir`.
 *
 * The ready marker is checked first because name resolution alone cannot
 * tell versions apart. After a specifier changes, the new env does not exist
 * yet, but the package name may still resolve from `<targetFolder>/node_modules`,
 * a hoisted copy, or the cwd — and the run would silently use whatever
 * version it found there.
 */
export function findUnresolvedInEnv(
  envDir: string,
  declaredPluginList: readonly string[],
): string[] {
  if (!existsSync(path.join(envDir, DEPENDENCY_ENV_READY_FILENAME))) {
    return [...declaredPluginList];
  }
  return PluginDiscoverer.findUnresolvedPlugins(declaredPluginList, { resolveFrom: [envDir] });
}

/**
 * Runs the algorithm described above against `envDir`, creating it first so
 * the lock file has somewhere to live.
 *
 * `forceSetup` (`--setup`) only affects the *initial* decision to attempt an
 * install at all — it does not skip the lock (point 3 of the fix: "`--setup`
 * also honors the lock") and it does not skip the loser fast path either: a
 * concurrent `--setup` that another process already satisfied is exactly as
 * "joined" as an ordinary missing-plugin one, since the result on disk is
 * identical either way.
 */
export async function performAutoSetup(
  envDir: string,
  forceSetup: boolean,
  deps: AutoSetupDeps,
): Promise<AutoSetupOutcome> {
  const { findUnresolved, install, logger, lockOptions } = deps;

  if (!forceSetup && findUnresolved().length === 0) {
    return { kind: 'not-needed' };
  }

  await fs.mkdir(envDir, { recursive: true });

  for (;;) {
    const acquireResult = await acquireSetupLock(envDir, {
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
          ? { kind: 'installed', envDir: result.envDir }
          : { kind: 'failed', message: result.error };
      } finally {
        await releaseSetupLock(setupLockPathFor(envDir));
      }
    }

    const holderPid = acquireResult.payload?.pid;
    logger.info(
      'Auto-setup already in progress' +
        (holderPid !== undefined ? ` (pid ${holderPid})` : '') +
        ` — waiting for it to finish setting up "${envDir}"...`,
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
