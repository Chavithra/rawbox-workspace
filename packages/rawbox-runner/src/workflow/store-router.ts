import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ok, err, type Result } from 'neverthrow';
import {
  storeIdentityOf,
  type Box,
  type BoxLocation,
  type BoxStrategy,
  type BoxStore,
  type BoxTransactionBatch,
} from '@rawbox/store';
import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import { BoxStorePg, PgPoolCache } from '@rawbox/store/box-store-pg';

import {
  collectBackendEnvProblems,
  collectBackendReferenceList,
  collectUnknownBackendProblems,
  resolveBackendConnection,
} from '../workspace/backends.js';
import type { Workspace } from '../workspace/workspace-types.js';
import type { ResolvedWorkflow, Workflow } from './workflow-types.js';

export interface OpenedWorkflowStore {
  readonly boxStore: BoxStore;
  close(): Promise<void>;
}

/**
 * Collects every {@link BoxStrategy} reachable during a workflow run — seeds,
 * step inputs/outputs/errors, and `storage.defaultStrategy` — so the store
 * opener allocates only the backends the run can actually touch.
 */
function collectStrategyList(
  authoredWorkflow: Workflow,
  resolvedWorkflow: ResolvedWorkflow,
): BoxStrategy[] {
  const strategyList: BoxStrategy[] = [authoredWorkflow.storage.defaultStrategy];

  for (const seed of resolvedWorkflow.seedData ?? []) {
    strategyList.push(seed.strategy);
  }

  for (const step of resolvedWorkflow.stepList) {
    for (const loc of Object.values(step.storageLocation.input)) {
      strategyList.push(loc.strategy);
    }
    for (const loc of Object.values(step.storageLocation.output)) {
      strategyList.push(loc.strategy);
    }
    for (const loc of Object.values(step.storageLocation.error)) {
      strategyList.push(loc.strategy);
    }
  }

  return strategyList;
}

class WorkflowStoreRouter implements BoxStore {
  public constructor(
    private readonly primaryIdentityId: string,
    private readonly primaryStore: BoxStore,
    private readonly storeByIdentity: ReadonlyMap<string, BoxStore>,
  ) {}

  private resolveStoreForStrategy(strategy: BoxStrategy): Result<BoxStore, string> {
    const id = storeIdentityOf(strategy).id;
    const store = this.storeByIdentity.get(id);
    if (store === undefined) {
      return err(
        `No store opened for strategy '${strategy.name}' (store identity '${id}')`,
      );
    }
    return ok(store);
  }

  public async get(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    const storeResult = this.resolveStoreForStrategy(boxLocation.strategy);
    if (storeResult.isErr()) {
      return err(storeResult.error);
    }
    return storeResult.value.get(boxLocation);
  }

  public async put(box: Box<unknown>): Promise<Result<void, string>> {
    const storeResult = this.resolveStoreForStrategy(box.location.strategy);
    if (storeResult.isErr()) {
      return err(storeResult.error);
    }
    return storeResult.value.put(box);
  }

  public async transact(
    batch: BoxTransactionBatch,
  ): Promise<Result<Record<string, unknown>, string>> {
    const puts = batch.puts ?? [];
    const getEntries = Object.entries(batch.gets ?? {});

    // Verify all puts target the primary workflow store (or a single store if seeding)
    const primaryPuts: Box<unknown>[] = [];
    for (const box of puts) {
      const storeId = storeIdentityOf(box.location.strategy).id;
      if (storeId !== this.primaryIdentityId) {
        return err(
          `Write for key '${box.location.key}' targets '${storeId}', which is outside the workflow's primary store '${this.primaryIdentityId}'`,
        );
      }
      primaryPuts.push(box);
    }

    const primaryGets: Record<string, BoxLocation> = {};
    const foreignGetsByStore = new Map<string, Record<string, BoxLocation>>();

    for (const [inputKey, loc] of getEntries) {
      const storeId = storeIdentityOf(loc.strategy).id;
      if (storeId === this.primaryIdentityId) {
        primaryGets[inputKey] = loc;
        continue;
      }

      if (!this.storeByIdentity.has(storeId)) {
        return err(
          `Cross-workflow read for key '${loc.key}' targets unopened store '${storeId}'`,
        );
      }

      let group = foreignGetsByStore.get(storeId);
      if (group === undefined) {
        group = {};
        foreignGetsByStore.set(storeId, group);
      }
      group[inputKey] = loc;
    }

    const mergedOutput: Record<string, unknown> = {};

    if (primaryPuts.length > 0 || Object.keys(primaryGets).length > 0) {
      const primaryResult = await this.primaryStore.transact({
        puts: primaryPuts,
        gets: primaryGets,
      });
      if (primaryResult.isErr()) {
        return err(primaryResult.error);
      }
      Object.assign(mergedOutput, primaryResult.value);
    }

    for (const [foreignId, foreignGets] of foreignGetsByStore) {
      const foreignStore = this.storeByIdentity.get(foreignId);
      if (foreignStore === undefined) {
        return err(`Cross-workflow read targets unopened store '${foreignId}'`);
      }
      const foreignResult = await foreignStore.transact({ gets: foreignGets });
      if (foreignResult.isErr()) {
        return err(foreignResult.error);
      }
      Object.assign(mergedOutput, foreignResult.value);
    }

    return ok(mergedOutput);
  }
}

/**
 * Preflights backend references and environment variables, then opens only the
 * store(s) the workflow actually references (LMDB and/or PostgreSQL backends).
 */
export async function openWorkflowStore(parameters: {
  authoredWorkflow: Workflow;
  resolvedWorkflow: ResolvedWorkflow;
  workspace: Workspace;
  workspaceLabel: string;
  workflowLabel: string;
  resolvedTargetFolder: string;
}): Promise<Result<OpenedWorkflowStore, string>> {
  const {
    authoredWorkflow,
    resolvedWorkflow,
    workspace,
    workspaceLabel,
    workflowLabel,
    resolvedTargetFolder,
  } = parameters;

  // 1. Preflight all backend references & env vars before touching disk/network
  const unknownProblems = collectUnknownBackendProblems({
    document: authoredWorkflow,
    backends: workspace.backends,
    workflowLabel,
    workspaceSource: workspaceLabel,
  });

  const referenceList = collectBackendReferenceList(authoredWorkflow);
  const referencedBackendIds = [
    ...new Set(referenceList.map((reference) => reference.backendId)),
  ];

  const envProblems =
    referencedBackendIds.length > 0
      ? collectBackendEnvProblems({
          backends: workspace.backends,
          source: workspaceLabel,
          env: process.env,
          backendIdList: referencedBackendIds,
        })
      : [];

  const preflightProblems = [...unknownProblems, ...envProblems];
  if (preflightProblems.length > 0) {
    return err(preflightProblems.join('\n'));
  }

  // 2. Collect distinct stores needed by this run
  const strategyList = collectStrategyList(authoredWorkflow, resolvedWorkflow);
  let needsLmdb = false;
  const pgBackendIds = new Set<string>();

  for (const strategy of strategyList) {
    if (strategy.name === 'lmdb-kv' || strategy.name === 'lmdb-fifo') {
      needsLmdb = true;
    } else if (strategy.name === 'pg-kv' || strategy.name === 'pg-fifo') {
      pgBackendIds.add(strategy.backend);
    }
  }

  const storeByIdentity = new Map<string, BoxStore>();
  const pgPoolCache = new PgPoolCache();
  let boxStoreLmdb: BoxStoreLmdb | undefined;

  if (needsLmdb) {
    const dbDirUrl = pathToFileURL(path.join(resolvedTargetFolder, 'data'));
    const lmdbResult = BoxStoreLmdb.create(workspace.name, dbDirUrl);
    if (lmdbResult.isErr()) {
      return err(lmdbResult.error);
    }
    boxStoreLmdb = lmdbResult.value;
    storeByIdentity.set('lmdb:workspace', boxStoreLmdb);
  }

  for (const backendId of pgBackendIds) {
    const connResult = resolveBackendConnection({
      backends: workspace.backends,
      backendId,
      source: workspaceLabel,
      env: process.env,
    });
    if (connResult.isErr()) {
      await pgPoolCache.closeAll();
      return err(connResult.error);
    }

    const pgResult = await BoxStorePg.create(
      workspace.name,
      connResult.value,
      pgPoolCache,
    );
    if (pgResult.isErr()) {
      await pgPoolCache.closeAll();
      return err(`Backend "${backendId}" could not be opened: ${pgResult.error}`);
    }

    storeByIdentity.set(`pg:${backendId}`, pgResult.value);
  }

  // Primary store identity matches the workflow's owned default strategy
  // (enforced by validateCoTransactionalStore; falls back cleanly to defaultStrategy).
  const ownedStrategies = collectOwnedStrategies(authoredWorkflow, resolvedWorkflow);
  const primaryStrategy =
    ownedStrategies[0] ?? authoredWorkflow.storage.defaultStrategy;
  const primaryIdentityId = storeIdentityOf(primaryStrategy).id;
  const primaryStore = storeByIdentity.get(primaryIdentityId);

  if (primaryStore === undefined) {
    await pgPoolCache.closeAll();
    return err(
      `No primary store opened for workflow '${resolvedWorkflow.name}' (${primaryIdentityId})`,
    );
  }

  const router = new WorkflowStoreRouter(
    primaryIdentityId,
    primaryStore,
    storeByIdentity,
  );

  return ok({
    boxStore: router,
    async close(): Promise<void> {
      // Only close network pools (PostgreSQL). `BoxStoreLmdb` is left open for
      // the process lifetime so lmdb-js's deferred `setTimeout(..., 0)` read-txn
      // reset does not race against `env.close()` in short-lived CLI children.
      await pgPoolCache.closeAll();
    },
  });
}

function collectOwnedStrategies(
  authoredWorkflow: Workflow,
  resolvedWorkflow: ResolvedWorkflow,
): BoxStrategy[] {
  const owned: BoxStrategy[] = [];
  for (const seed of resolvedWorkflow.seedData ?? []) {
    owned.push(seed.strategy);
  }
  for (const step of resolvedWorkflow.stepList) {
    for (const loc of Object.values(step.storageLocation.output)) {
      owned.push(loc.strategy);
    }
    for (const loc of Object.values(step.storageLocation.error)) {
      owned.push(loc.strategy);
    }
    for (const loc of Object.values(step.storageLocation.input)) {
      if (loc.workflow === undefined) {
        owned.push(loc.strategy);
      }
    }
  }
  if (owned.length === 0) {
    owned.push(authoredWorkflow.storage.defaultStrategy);
  }
  return owned;
}
