/**
 * Merging an LMDB observer with zero or more Redis observers into one
 * async-facing set, for `store list`/`store get`/`store watch`/`workspace
 * status` — the four call sites named in `@rawbox/store`'s `box-observer.ts`
 * doc comment ("The resolution for Redis"), written once here rather than
 * four times.
 *
 * ## Why this exists at all
 *
 * `BoxObserver` (LMDB, synchronous) and `BoxObserverAsync` (Redis,
 * asynchronous) are deliberately two different shapes — see
 * `@rawbox/store`'s `box-observer.ts` for why a single polymorphic handle was
 * rejected. A workspace whose `backends:` map declares one or more Redis
 * servers therefore needs BOTH kinds open at once, and a caller that wants
 * "every key in this workspace" has to ask each one and combine the answers
 * itself. This module is that combination, done in one place so each of the
 * four commands only has to call it.
 *
 * ## Which observers get opened, and from what
 *
 * Resolved from the workspace document's `backends:` map
 * (`@rawbox/runner`'s `workspace/backends.ts`, task #9) — never from a new
 * CLI flag, so `store list <workspace>` keeps working with no new arguments.
 * One `BoxObserverRedis` per declared backend id, each pointed at that id's
 * resolved connection string (`resolveBackendConnection`). A workspace with
 * no `backends:` block opens none, and the LMDB-only behaviour every command
 * already had is untouched: every one of the four call sites checks for a
 * non-empty `backends:` map BEFORE reaching this module at all, and takes
 * its pre-existing, synchronous `BoxObserverLmdb`-only path when there is
 * none — see each command file's own top-of-function branch. This module
 * exists for the case that branch does NOT take.
 *
 * ## Failure is per-backend and never fatal here
 *
 * A backend whose connection cannot be resolved (an unset `${VARIABLE}`) or
 * reached (server down) is recorded in `redisWarningList` and excluded from
 * every merge — it does not fail `listWorkflows`/`listKeys` for the backends
 * that DID connect, and it does not stop the LMDB observer (if any) from
 * being read. A workspace mixing a live LMDB environment with one
 * unreachable Redis backend should still show what it can, the same
 * degrade-per-workflow posture `workspace status` already has for a rotted
 * workflow document.
 */

import { BoxObserverLmdb } from '@rawbox/store/box-observer-lmdb';
import { BoxObserverRedis } from '@rawbox/store/box-observer-redis';
import { RedisClientCache } from '@rawbox/store/box-store-redis';
import { ok, err, type Result } from 'neverthrow';
import type { BoxInspection, BoxLocation } from '@rawbox/store';
import { resolveBackendConnection } from '@rawbox/runner';

import { reconstructQueueSizeMax } from './fifo-reconstruct.js';
import type { StoreTarget } from './target.js';

/**
 * One `BoxInspection`, tagged with which observer produced it: `'lmdb'` for
 * the workspace's LMDB environment, or the Redis `backend:` id otherwise.
 * `peek`/`peekAll` below read this field back to route the read to the same
 * observer that reported the key, since neither `BoxInspection` alone nor a
 * bare key name says which store a Redis-strategy key lives in.
 */
export interface ObservedInspection extends BoxInspection {
  readonly source: 'lmdb' | string;
}

export interface WorkspaceObserverSet {
  /**
   * `BoxObserverLmdb.openSync`'s error, verbatim, when the LMDB environment
   * could not be opened — most commonly "nothing has been written to this
   * workspace yet". `undefined` when it opened. A workspace whose only
   * strategies are Redis-backed will legitimately have no LMDB environment at
   * all, so this being set is not on its own a reason to treat the whole
   * workspace as empty — check whether `listWorkflows()`/`listKeys()` found
   * anything instead.
   */
  readonly lmdbOpenError: string | undefined;
  /** One entry per declared backend that could not be connected to, naming the backend and the reason. Never fatal — see the module comment. */
  readonly redisWarningList: readonly string[];
  listWorkflows(): Promise<Result<string[], string>>;
  listKeys(workflow: string): Promise<Result<ObservedInspection[], string>>;
  peek(entry: ObservedInspection, workflow: string, key: string): Promise<Result<unknown, string>>;
  peekAll(
    entry: ObservedInspection,
    workflow: string,
    key: string,
  ): Promise<Result<unknown[], string>>;
  /** Closes every observer this set opened, and the Redis client cache backing them. Idempotent, never throws. */
  close(): Promise<void>;
}

/** Builds the `BoxLocation` `peek`/`peekAll` need from what enumeration already reported — no workflow document required, mirroring `store get`'s existing `locationFor`. */
function locationFor(
  workspaceName: string,
  workflow: string,
  key: string,
  entry: ObservedInspection,
): BoxLocation {
  if (entry.source === 'lmdb') {
    if (entry.strategy === 'lmdb-fifo' && entry.fifo !== undefined) {
      return {
        workspace: workspaceName,
        workflow,
        key,
        strategy: {
          name: 'lmdb-fifo',
          queueSizeMax: reconstructQueueSizeMax(entry.fifo),
          valueSizeMax: Math.max(entry.valueSizeMaxBytes, 1),
        },
      };
    }
    return {
      workspace: workspaceName,
      workflow,
      key,
      strategy: { name: 'lmdb-kv', valueSizeMax: Math.max(entry.valueSizeMaxBytes, 1) },
    };
  }

  // Redis. `queueSizeMax` is schema-required on `redis-fifo` but inert for a
  // read: `BoxObserverRedis.peek`/`peekAll` never consult it (no ring
  // arithmetic on a native list) — see that class's doc comment. There is no
  // way to reconstruct the declared figure from the list itself the way
  // `reconstructQueueSizeMax` does for LMDB's cursors, so this is a truthful
  // floor (at least the observed depth), not a guess at the real ceiling.
  if (entry.strategy === 'redis-fifo') {
    return {
      workspace: workspaceName,
      workflow,
      key,
      strategy: {
        name: 'redis-fifo',
        queueSizeMax: Math.max(entry.queueDepth ?? 1, 1),
        valueSizeMax: Math.max(entry.valueSizeMaxBytes, 1),
        backend: entry.source,
      },
    };
  }

  return {
    workspace: workspaceName,
    workflow,
    key,
    strategy: {
      name: 'redis-kv',
      valueSizeMax: Math.max(entry.valueSizeMaxBytes, 1),
      backend: entry.source,
    },
  };
}

/**
 * Opens every observer `target` needs — the LMDB environment (if one exists)
 * plus one `BoxObserverRedis` per backend `target.workspaceDoc.backends`
 * declares — and returns a merged, async-facing view.
 *
 * **Never rejects and never returns an `Err`.** Every failure this function
 * can encounter (no LMDB environment, an unresolvable or unreachable Redis
 * backend) is a normal, expected state for an inspection command — see the
 * module comment — so it is recorded on the returned set
 * (`lmdbOpenError`/`redisWarningList`) rather than propagated as a rejection
 * a caller would have to unwrap before it could look at anything else.
 */
export async function openWorkspaceObserverSet(
  target: Pick<StoreTarget, 'workspaceName' | 'dataRootUrl' | 'workspaceDoc' | 'workspaceDocPath'>,
): Promise<WorkspaceObserverSet> {
  const lmdbOpenResult = BoxObserverLmdb.openSync(target.workspaceName, target.dataRootUrl);
  const lmdbObserver = lmdbOpenResult.isOk() ? lmdbOpenResult.value : undefined;
  const lmdbOpenError = lmdbOpenResult.isErr() ? lmdbOpenResult.error : undefined;

  const clientCache = new RedisClientCache();
  const redisWarningList: string[] = [];
  const redisObserverList: { backendId: string; observer: BoxObserverRedis }[] = [];

  const backends = target.workspaceDoc?.backends;
  const workspaceDocPath = target.workspaceDocPath;

  if (backends !== undefined && workspaceDocPath !== undefined) {
    for (const backendId of Object.keys(backends)) {
      const connectionResult = resolveBackendConnection({
        backends,
        backendId,
        source: workspaceDocPath,
        env: process.env,
      });

      if (connectionResult.isErr()) {
        redisWarningList.push(connectionResult.error);
        continue;
      }

      const observerResult = await BoxObserverRedis.create(
        target.workspaceName,
        connectionResult.value,
        clientCache,
      );

      if (observerResult.isErr()) {
        redisWarningList.push(
          `Backend "${backendId}" could not be observed: ${observerResult.error}`,
        );
        continue;
      }

      redisObserverList.push({ backendId, observer: observerResult.value });
    }
  }

  const workspaceName = target.workspaceName;

  return {
    lmdbOpenError,
    redisWarningList,

    async listWorkflows(): Promise<Result<string[], string>> {
      const nameSet = new Set<string>();
      const errorList: string[] = [];
      let sawSource = false;

      if (lmdbObserver !== undefined) {
        const result = lmdbObserver.listWorkflowsSync();
        if (result.isOk()) {
          sawSource = true;
          for (const name of result.value) nameSet.add(name);
        } else {
          errorList.push(result.error);
        }
      }

      for (const { observer } of redisObserverList) {
        const result = await observer.listWorkflows();
        if (result.isOk()) {
          sawSource = true;
          for (const name of result.value) nameSet.add(name);
        } else {
          errorList.push(result.error);
        }
      }

      if (!sawSource) {
        return err(errorList.length > 0 ? errorList.join('; ') : (lmdbOpenError ?? 'No observers available'));
      }

      return ok([...nameSet].sort());
    },

    async listKeys(workflow: string): Promise<Result<ObservedInspection[], string>> {
      const merged: ObservedInspection[] = [];
      const errorList: string[] = [];
      let sawSource = false;

      if (lmdbObserver !== undefined) {
        const result = lmdbObserver.listKeysSync(workflow);
        if (result.isOk()) {
          sawSource = true;
          for (const entry of result.value) merged.push({ ...entry, source: 'lmdb' });
        } else {
          errorList.push(result.error);
        }
      }

      for (const { backendId, observer } of redisObserverList) {
        const result = await observer.listKeys(workflow);
        if (result.isOk()) {
          sawSource = true;
          for (const entry of result.value) merged.push({ ...entry, source: backendId });
        } else {
          errorList.push(result.error);
        }
      }

      if (!sawSource && errorList.length > 0) {
        return err(errorList.join('; '));
      }

      merged.sort((left, right) => left.key.localeCompare(right.key));
      return ok(merged);
    },

    async peek(
      entry: ObservedInspection,
      workflow: string,
      key: string,
    ): Promise<Result<unknown, string>> {
      const location = locationFor(workspaceName, workflow, key, entry);

      if (entry.source === 'lmdb') {
        if (lmdbObserver === undefined) {
          return err(`LMDB observer is not open for workspace "${workspaceName}"`);
        }
        return lmdbObserver.peekSync(location);
      }

      const match = redisObserverList.find((candidate) => candidate.backendId === entry.source);
      if (match === undefined) {
        return err(`No open Redis observer for backend "${entry.source}"`);
      }
      return match.observer.peek(location);
    },

    async peekAll(
      entry: ObservedInspection,
      workflow: string,
      key: string,
    ): Promise<Result<unknown[], string>> {
      const location = locationFor(workspaceName, workflow, key, entry);

      if (entry.source === 'lmdb') {
        if (lmdbObserver === undefined) {
          return err(`LMDB observer is not open for workspace "${workspaceName}"`);
        }
        return lmdbObserver.peekAllSync(location);
      }

      const match = redisObserverList.find((candidate) => candidate.backendId === entry.source);
      if (match === undefined) {
        return err(`No open Redis observer for backend "${entry.source}"`);
      }
      return match.observer.peekAll(location);
    },

    async close(): Promise<void> {
      lmdbObserver?.closeSync();
      for (const { observer } of redisObserverList) {
        await observer.close();
      }
      await clientCache.closeAll();
    },
  };
}

/** `true` when `target`'s workspace document declares at least one Redis backend — the sole switch between each command's untouched LMDB-only path and the merged path this module provides. */
export function hasDeclaredBackends(target: Pick<StoreTarget, 'workspaceDoc'>): boolean {
  const backends = target.workspaceDoc?.backends;
  return backends !== undefined && Object.keys(backends).length > 0;
}

/**
 * The depth to display for one entry, independent of which backend produced
 * it: `fifo.depth` when present (an `lmdb-fifo` entry, which never sets
 * `queueDepth` without also setting `fifo`), `queueDepth` otherwise (a
 * `redis-fifo` entry, which sets only `queueDepth` — see `BoxInspection`'s
 * doc comment in `@rawbox/store` on why `redis-fifo` never populates `fifo`).
 * `undefined` for a cell, on either backend.
 *
 * One function so `store get` and `store watch` — the two call sites that
 * print a depth outside `store list`'s own capacity-aware column — read it
 * the same way rather than each re-deriving the `??` by hand.
 */
export function queueDepthOf(entry: Pick<BoxInspection, 'fifo' | 'queueDepth'>): number | undefined {
  return entry.fifo?.depth ?? entry.queueDepth;
}
