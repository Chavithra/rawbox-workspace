/**
 * Merges the workspace's local LMDB observer (`BoxObserverLmdb`, synchronous)
 * with zero or more remote PostgreSQL observers (`BoxObserverPg`, async) into
 * one async-facing `WorkspaceObserverSet` for `store list`, `store get`,
 * `store watch`, and `workspace status`.
 *
 * Workspaces without a `backends:` block stay on each command's pre-existing
 * synchronous `BoxObserverLmdb` fast path (`!hasDeclaredBackends(target)`).
 */

import { BoxObserverLmdb } from '@rawbox/store/box-observer-lmdb';
import { BoxObserverPg } from '@rawbox/store/box-observer-pg';
import { PgPoolCache } from '@rawbox/store/box-store-pg';
import { ok, err, type Result } from 'neverthrow';
import type { BoxInspection, BoxLocation } from '@rawbox/store';
import { resolveBackendConnection } from '@rawbox/runner';

import { reconstructQueueSizeMax } from './fifo-reconstruct.js';
import type { StoreTarget } from './target.js';

export interface ObservedInspection extends BoxInspection {
  readonly source: 'lmdb' | string;
}

export interface WorkspaceObserverSet {
  readonly lmdbOpenError: string | undefined;
  readonly backendWarningList: readonly string[];
  listWorkflows(): Promise<Result<string[], string>>;
  listKeys(workflow: string): Promise<Result<ObservedInspection[], string>>;
  peek(entry: ObservedInspection, workflow: string, key: string): Promise<Result<unknown, string>>;
  peekAll(
    entry: ObservedInspection,
    workflow: string,
    key: string,
  ): Promise<Result<unknown[], string>>;
  close(): Promise<void>;
}

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

  if (entry.strategy === 'pg-fifo') {
    return {
      workspace: workspaceName,
      workflow,
      key,
      strategy: {
        name: 'pg-fifo',
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
      name: 'pg-kv',
      valueSizeMax: Math.max(entry.valueSizeMaxBytes, 1),
      backend: entry.source,
    },
  };
}

export async function openWorkspaceObserverSet(
  target: Pick<StoreTarget, 'workspaceName' | 'dataRootUrl' | 'workspaceDoc' | 'workspaceDocPath'>,
): Promise<WorkspaceObserverSet> {
  const lmdbOpenResult = BoxObserverLmdb.openSync(target.workspaceName, target.dataRootUrl);
  const lmdbObserver = lmdbOpenResult.isOk() ? lmdbOpenResult.value : undefined;
  const lmdbOpenError = lmdbOpenResult.isErr() ? lmdbOpenResult.error : undefined;

  const poolCache = new PgPoolCache();
  const backendWarningList: string[] = [];
  const pgObserverList: { backendId: string; observer: BoxObserverPg }[] = [];

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
        backendWarningList.push(connectionResult.error);
        continue;
      }

      const observerResult = await BoxObserverPg.create(
        target.workspaceName,
        connectionResult.value,
        poolCache,
      );

      if (observerResult.isErr()) {
        backendWarningList.push(
          `Backend "${backendId}" could not be observed: ${observerResult.error}`,
        );
        continue;
      }

      pgObserverList.push({ backendId, observer: observerResult.value });
    }
  }

  const workspaceName = target.workspaceName;

  return {
    lmdbOpenError,
    backendWarningList,

    async listWorkflows(): Promise<Result<string[], string>> {
      const nameSet = new Set<string>();
      const errorList: string[] = [];
      let sawSource = false;

      if (lmdbObserver !== undefined) {
        const result = lmdbObserver.listWorkflowsSync();
        if (result.isOk()) {
          sawSource = true;
          for (const name of result.value) {
            nameSet.add(name);
          }
        } else {
          errorList.push(result.error);
        }
      }

      for (const { observer } of pgObserverList) {
        const result = await observer.listWorkflows();
        if (result.isOk()) {
          sawSource = true;
          for (const name of result.value) {
            nameSet.add(name);
          }
        } else {
          errorList.push(result.error);
        }
      }

      if (!sawSource) {
        return err(
          errorList.length > 0
            ? errorList.join('; ')
            : (lmdbOpenError ?? 'No observers available'),
        );
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
          for (const entry of result.value) {
            merged.push({ ...entry, source: 'lmdb' });
          }
        } else {
          errorList.push(result.error);
        }
      }

      for (const { backendId, observer } of pgObserverList) {
        const result = await observer.listKeys(workflow);
        if (result.isOk()) {
          sawSource = true;
          for (const entry of result.value) {
            merged.push({ ...entry, source: backendId });
          }
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

      const match = pgObserverList.find((candidate) => candidate.backendId === entry.source);
      if (match === undefined) {
        return err(`No open PostgreSQL observer for backend "${entry.source}"`);
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

      const match = pgObserverList.find((candidate) => candidate.backendId === entry.source);
      if (match === undefined) {
        return err(`No open PostgreSQL observer for backend "${entry.source}"`);
      }
      return match.observer.peekAll(location);
    },

    async close(): Promise<void> {
      lmdbObserver?.closeSync();
      for (const { observer } of pgObserverList) {
        await observer.close();
      }
      await poolCache.closeAll();
    },
  };
}

export function hasDeclaredBackends(target: Pick<StoreTarget, 'workspaceDoc'>): boolean {
  const backends = target.workspaceDoc?.backends;
  return backends !== undefined && Object.keys(backends).length > 0;
}

export function queueDepthOf(
  entry: Pick<BoxInspection, 'fifo' | 'queueDepth'>,
): number | undefined {
  return entry.fifo?.depth ?? entry.queueDepth;
}
