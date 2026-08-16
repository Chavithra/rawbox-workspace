/**
 * `store list <workspace-or-path> [--workflow w]` — every storage key a
 * workspace has actually written, read through `BoxObserverLmdb` (never
 * `BoxStoreLmdb`, whose in-process `listKeysSync`-equivalent creates an empty
 * database for a workflow that never ran — the observer's read-only open is
 * the zero-write path (OBSERVABILITY.md, "The out-of-process observer")).
 *
 * Sizes are the **uncompressed** bytes `valueSizeMax` is checked against —
 * never on-disk bytes, which `compression: true` makes different — matching
 * `BoxInspection.valueSizeBytes` exactly (rawbox-store/README.md, "Observation — `peek` is not `get`").
 *
 * When the workspace document is resolvable (a document or directory
 * argument, or a bare name found under a discovered data root whose sibling
 * workspace document `resolveStoreTarget` also located), each row is joined
 * against the declared `valueSizeMax`/`queueSizeMax` for that key
 * (`../../store/declared.js`) — the runtime counterpart to `verify`'s static
 * budget report. A key bound only by a step and declared nowhere falls back
 * to `defaultStrategy`, exactly as the runner resolves it, and is labelled
 * `bound` rather than `declared`.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { BoxObserverLmdb } from '@rawbox/store/box-observer-lmdb';
import { seedCapacityOf, type BoxInspection, type BoxObserver } from '@rawbox/store';

import { renderTable } from '../../runs/format.js';
import { resolveStoreTarget } from '../../store/target.js';
import { buildDeclaredIndex, type DeclaredIndex } from '../../store/declared.js';
import {
  hasDeclaredBackends,
  openWorkspaceObserverSet,
  type ObservedInspection,
} from '../../store/observers.js';

export interface StoreListOptions {
  workflow?: string;
  output?: 'text' | 'json';
  cwd?: string;
}

interface DeclaredView {
  readonly source: 'declared' | 'bound';
  readonly valueSizeMax: number;
  readonly queueSizeMax?: number;
}

interface ListRow {
  readonly workflow: string;
  readonly key: string;
  readonly strategy: BoxInspection['strategy'];
  readonly valueSizeBytes: number;
  readonly valueSizeMaxBytes: number;
  readonly fifo?: { readonly depth: number; readonly capacity?: number };
  readonly declared?: DeclaredView;
}

function declaredViewFor(
  declaredIndex: DeclaredIndex | undefined,
  workflow: string,
  key: string,
): DeclaredView | undefined {
  const declared = declaredIndex?.get(workflow)?.get(key);
  if (declared === undefined) {
    return undefined;
  }

  const hasQueueSizeMax =
    declared.strategy.name === 'lmdb-fifo' || declared.strategy.name === 'redis-fifo';

  return {
    source: declared.source,
    valueSizeMax: declared.strategy.valueSizeMax,
    ...(hasQueueSizeMax ? { queueSizeMax: declared.strategy.queueSizeMax } : {}),
  };
}

/**
 * The declared queue capacity for `key`, via `seedCapacityOf` on the FULL
 * declared strategy — `queueSizeMax - 1` for `lmdb-fifo`'s ring,
 * `queueSizeMax` unreduced for `redis-fifo`'s native list (`@rawbox/store`,
 * `strategy/descriptor.ts`). Deliberately a separate lookup from
 * {@link declaredViewFor} rather than a field folded into its `DeclaredView`:
 * that return value is serialised verbatim into `store list --output json`'s
 * `declared` field (`buildListRow` below), and adding a field there would be
 * a JSON output shape change for the plain-LMDB path this task must leave
 * untouched. `row.fifo.capacity` is the existing, already-stable field this
 * number feeds instead.
 */
function declaredCapacityFor(
  declaredIndex: DeclaredIndex | undefined,
  workflow: string,
  key: string,
): number | undefined {
  const declared = declaredIndex?.get(workflow)?.get(key);
  return declared === undefined ? undefined : seedCapacityOf(declared.strategy);
}

export async function storeListCommand(
  workspaceArg: string,
  options: StoreListOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  const targetResult = await resolveStoreTarget(workspaceArg, cwd);
  if (targetResult.isErr()) {
    p.log.error(pc.red(targetResult.error));
    process.exit(1);
    return;
  }
  const target = targetResult.value;

  const declaredIndex =
    target.workspaceDoc !== undefined && target.workspaceDocPath !== undefined
      ? await buildDeclaredIndex(target.workspaceDocPath, target.workspaceDoc)
      : undefined;

  // Every LMDB-only workspace — which is every workspace with no `backends:`
  // block, and therefore every workspace this command served before task #13
  // — takes this branch, byte-for-byte unchanged from before Redis
  // observation existed. See `../../store/observers.ts`'s module comment for
  // why the merge below is not reached from here.
  if (!hasDeclaredBackends(target)) {
    const openResult = BoxObserverLmdb.openSync(target.workspaceName, target.dataRootUrl);
    if (openResult.isErr()) {
      // Friendly empty state: no data directory / no environment yet. Exit 0 —
      // "nothing has run" is a normal answer for a listing command, not a failure.
      if (options.output === 'json') {
        console.log(JSON.stringify([]));
      } else {
        p.log.info(
          `No runs have written state yet for workspace "${target.workspaceName}" (${openResult.error}).`,
        );
      }
      process.exit(0);
      return;
    }
    const observer: BoxObserver = openResult.value;

    try {
      const workflowListResult = observer.listWorkflowsSync();
      if (workflowListResult.isErr()) {
        p.log.error(pc.red(workflowListResult.error));
        process.exit(1);
        return;
      }

      const workflowList =
        options.workflow !== undefined
          ? workflowListResult.value.filter((workflow) => workflow === options.workflow)
          : workflowListResult.value;

      const rowList: ListRow[] = [];

      for (const workflow of workflowList) {
        const keysResult = observer.listKeysSync(workflow);
        if (keysResult.isErr()) {
          continue;
        }

        for (const entry of keysResult.value) {
          const declared = declaredViewFor(declaredIndex, workflow, entry.key);
          const capacity = declaredCapacityFor(declaredIndex, workflow, entry.key);
          rowList.push(buildListRow(workflow, entry, declared, capacity));
        }
      }

      printListResult(rowList, options, target.workspaceName, declaredIndex !== undefined);
    } finally {
      observer.closeSync();
    }
    return;
  }

  // A `backends:` block is declared: merge the LMDB environment (if one
  // exists) with one `BoxObserverRedis` per backend — see
  // `../../store/observers.ts`.
  const observerSet = await openWorkspaceObserverSet(target);

  try {
    // Printed before anything that might exit early below, so a workspace
    // whose only problem IS an unreachable/unresolvable backend says why —
    // rather than that reason getting silently dropped behind a generic "no
    // workflows found" error.
    for (const warning of observerSet.redisWarningList) {
      p.log.warn(pc.yellow(warning));
    }

    const workflowListResult = await observerSet.listWorkflows();
    if (workflowListResult.isErr()) {
      p.log.error(pc.red(workflowListResult.error));
      process.exit(1);
      return;
    }

    const workflowList =
      options.workflow !== undefined
        ? workflowListResult.value.filter((workflow) => workflow === options.workflow)
        : workflowListResult.value;

    const rowList: ListRow[] = [];

    for (const workflow of workflowList) {
      const keysResult = await observerSet.listKeys(workflow);
      if (keysResult.isErr()) {
        continue;
      }

      for (const entry of keysResult.value) {
        const declared = declaredViewFor(declaredIndex, workflow, entry.key);
        const capacity = declaredCapacityFor(declaredIndex, workflow, entry.key);
        rowList.push(buildListRow(workflow, entry, declared, capacity));
      }
    }

    printListResult(rowList, options, target.workspaceName, declaredIndex !== undefined);
  } finally {
    await observerSet.close();
  }
}

/** One `ListRow` from an enumerated entry and its declared view — shared by both the LMDB-only and the merged path, so the two agree on shape by construction. */
function buildListRow(
  workflow: string,
  entry: Pick<
    ObservedInspection,
    'key' | 'strategy' | 'valueSizeBytes' | 'valueSizeMaxBytes' | 'queueDepth'
  >,
  declared: DeclaredView | undefined,
  capacity: number | undefined,
): ListRow {
  return {
    workflow,
    key: entry.key,
    strategy: entry.strategy,
    valueSizeBytes: entry.valueSizeBytes,
    valueSizeMaxBytes: entry.valueSizeMaxBytes,
    ...(entry.queueDepth === undefined
      ? {}
      : {
          fifo: {
            depth: entry.queueDepth,
            ...(capacity !== undefined ? { capacity } : {}),
          },
        }),
    ...(declared !== undefined ? { declared } : {}),
  };
}

/** Text/JSON rendering, identical for both paths above. */
function printListResult(
  rowList: readonly ListRow[],
  options: StoreListOptions,
  workspaceName: string,
  hasDeclaredIndex: boolean,
): void {
  if (options.output === 'json') {
    console.log(JSON.stringify(rowList, null, 2));
    return;
  }

  if (rowList.length === 0) {
    p.log.info(
      options.workflow !== undefined
        ? `No storage keys found for workflow "${options.workflow}" in workspace "${workspaceName}".`
        : `No storage keys found in workspace "${workspaceName}".`,
    );
    return;
  }

  const rows: string[][] = [
    ['KEY', 'WORKFLOW', 'STRATEGY', 'SIZE (bytes)', 'DECLARED MAX', 'SOURCE', 'DEPTH/CAP'],
    ...rowList.map((row) => [
      row.key,
      row.workflow,
      row.strategy,
      String(row.valueSizeBytes),
      row.declared === undefined
        ? '-'
        : row.declared.queueSizeMax !== undefined
          ? `${row.declared.valueSizeMax} / q${row.declared.queueSizeMax}`
          : String(row.declared.valueSizeMax),
      row.declared?.source ?? (hasDeclaredIndex ? 'undeclared' : '-'),
      row.fifo === undefined
        ? '-'
        : row.fifo.capacity !== undefined
          ? `${row.fifo.depth}/${row.fifo.capacity}`
          : String(row.fifo.depth),
    ]),
  ];

  console.log(renderTable(rows));
}
