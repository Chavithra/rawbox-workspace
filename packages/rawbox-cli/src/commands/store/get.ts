/**
 * `store get <workspace> <workflow> <key> [--full]` — prints one storage
 * key's value, non-destructively on both strategies.
 *
 * Reads exclusively through `BoxObserverLmdb.peekSync`/`peekAllSync` — never
 * `getSync`, which on an `lmdb-fifo` box is a *destructive dequeue*
 * (rawbox-store/README.md, "Observation — `peek` is not `get`"). There is no write or delete flag on this
 * command, anywhere, on purpose: mutating state by hand is out of scope for
 * `store` (OBSERVABILITY.md, "CLI surfaces"'s no-write-flag rule).
 *
 * The strategy needed to build a `BoxLocation` (`peekSync` takes one) comes
 * from the observer's own enumeration — `BoxObserverLmdb.listKeysSync`
 * infers it from the layout, so this command never has to be told, and never
 * needs a workflow document. For a FIFO, `queueSizeMax` is reconstructed from
 * the enumerated cursors (`../../store/fifo-reconstruct.js`) rather than
 * declared — see that module for why the reconstruction is exact.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { BoxObserverLmdb } from '@rawbox/store/box-observer-lmdb';
import type { BoxInspection, BoxLocation, BoxObserver } from '@rawbox/store';

import { resolveStoreTarget } from '../../store/target.js';
import { reconstructQueueSizeMax } from '../../store/fifo-reconstruct.js';
import {
  hasDeclaredBackends,
  openWorkspaceObserverSet,
  queueDepthOf,
  type ObservedInspection,
} from '../../store/observers.js';

export interface StoreGetOptions {
  full?: boolean;
  output?: 'text' | 'json';
  cwd?: string;
}

/** Text-mode values longer than this are truncated unless `--full` is passed. */
const TRUNCATE_AT_CHARS = 2000;

function renderValue(value: unknown, full: boolean): string {
  const json = JSON.stringify(value, null, 2) ?? String(value);
  if (full || json.length <= TRUNCATE_AT_CHARS) {
    return json;
  }
  return (
    `${json.slice(0, TRUNCATE_AT_CHARS)}\n` +
    `… truncated at ${TRUNCATE_AT_CHARS} characters (pass --full to see the whole value)`
  );
}

function locationFor(
  workspaceName: string,
  workflow: string,
  key: string,
  entry: BoxInspection,
): BoxLocation {
  if (entry.strategy === 'lmdb-fifo' && entry.fifo !== undefined) {
    return {
      workspace: workspaceName,
      workflow,
      key,
      strategy: {
        name: 'lmdb-fifo',
        queueSizeMax: reconstructQueueSizeMax(entry.fifo),
        // Unused by the read path (`peekStatic`/`peekAllStatic` never
        // consult `valueSizeMax`); kept truthful and schema-legal (>= 1).
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

export async function storeGetCommand(
  workspaceArg: string,
  workflow: string,
  key: string,
  options: StoreGetOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const full = options.full ?? false;

  const targetResult = await resolveStoreTarget(workspaceArg, cwd);
  if (targetResult.isErr()) {
    p.log.error(pc.red(targetResult.error));
    process.exit(1);
    return;
  }
  const target = targetResult.value;

  // Every LMDB-only workspace takes this branch, byte-for-byte unchanged from
  // before Redis observation existed — see `store list`'s identical note and
  // `../../store/observers.ts`'s module comment.
  if (!hasDeclaredBackends(target)) {
    const openResult = BoxObserverLmdb.openSync(target.workspaceName, target.dataRootUrl);
    if (openResult.isErr()) {
      // Friendly empty state, but `get` always needed a specific value, so this
      // is a failure a script can act on — unlike `store list`'s exit 0.
      p.log.error(
        pc.red(
          `No storage state found for workspace "${target.workspaceName}" — nothing has been ` +
            `written yet, so key "${key}" does not exist. (${openResult.error})`,
        ),
      );
      process.exit(1);
      return;
    }
    const observer: BoxObserver = openResult.value;

    try {
      const keysResult = observer.listKeysSync(workflow);
      if (keysResult.isErr()) {
        p.log.error(
          pc.red(
            `Workflow "${workflow}" has no storage state in workspace "${target.workspaceName}": ${keysResult.error}`,
          ),
        );
        process.exit(1);
        return;
      }

      const entryList = keysResult.value.filter((entry) => entry.key === key);
      if (entryList.length === 0) {
        p.log.error(
          pc.red(
            `Key "${key}" does not exist in workflow "${workflow}" of workspace "${target.workspaceName}".`,
          ),
        );
        process.exit(1);
        return;
      }

      const resultList: GetResult[] = entryList.map((entry) => {
        const location = locationFor(target.workspaceName, workflow, key, entry);

        if (entry.strategy === 'lmdb-fifo') {
          const all = observer.peekAllSync(location);
          return {
            entry,
            elements: all.isOk() ? all.value : undefined,
            value: undefined as unknown,
            error: all.isErr() ? all.error : undefined,
          };
        }

        const value = observer.peekSync(location);
        return {
          entry,
          elements: undefined as unknown[] | undefined,
          value: value.isOk() ? value.value : undefined,
          error: value.isErr() ? value.error : undefined,
        };
      });

      printGetResult(resultList, workflow, key, options, full);
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
    // Printed before anything that might exit early below — see `store
    // list`'s identical note.
    for (const warning of observerSet.redisWarningList) {
      p.log.warn(pc.yellow(warning));
    }

    const keysResult = await observerSet.listKeys(workflow);
    if (keysResult.isErr()) {
      p.log.error(
        pc.red(
          `Workflow "${workflow}" has no storage state in workspace "${target.workspaceName}": ${keysResult.error}`,
        ),
      );
      process.exit(1);
      return;
    }

    const entryList = keysResult.value.filter((entry) => entry.key === key);
    if (entryList.length === 0) {
      p.log.error(
        pc.red(
          `Key "${key}" does not exist in workflow "${workflow}" of workspace "${target.workspaceName}".`,
        ),
      );
      process.exit(1);
      return;
    }

    const resultList: GetResult[] = [];
    for (const entry of entryList) {
      const isQueue = entry.strategy === 'lmdb-fifo' || entry.strategy === 'redis-fifo';

      if (isQueue) {
        const all = await observerSet.peekAll(entry, workflow, key);
        resultList.push({
          entry,
          elements: all.isOk() ? all.value : undefined,
          value: undefined,
          error: all.isErr() ? all.error : undefined,
        });
        continue;
      }

      const value = await observerSet.peek(entry, workflow, key);
      resultList.push({
        entry,
        elements: undefined,
        value: value.isOk() ? value.value : undefined,
        error: value.isErr() ? value.error : undefined,
      });
    }

    printGetResult(resultList, workflow, key, options, full);
  } finally {
    await observerSet.close();
  }
}

interface GetResult {
  readonly entry: Pick<ObservedInspection, 'strategy' | 'fifo' | 'queueDepth'>;
  readonly elements: unknown[] | undefined;
  readonly value: unknown;
  readonly error: string | undefined;
}

/** JSON/text rendering, shared by both the LMDB-only and the merged path so the two agree on output shape by construction. */
function printGetResult(
  resultList: readonly GetResult[],
  workflow: string,
  key: string,
  options: StoreGetOptions,
  full: boolean,
): void {
  if (options.output === 'json') {
    console.log(
      JSON.stringify(
        resultList.map(({ entry, value, elements, error }) => {
          const depth = queueDepthOf(entry);
          return {
            workflow,
            key,
            strategy: entry.strategy,
            ...(depth !== undefined ? { depth } : {}),
            ...(elements !== undefined ? { elements } : {}),
            ...(elements === undefined && error === undefined ? { value } : {}),
            ...(error !== undefined ? { error } : {}),
          };
        }),
        null,
        2,
      ),
    );
    return;
  }

  for (const { entry, value, elements, error } of resultList) {
    console.log(`key        ${key}`);
    console.log(`workflow   ${workflow}`);
    console.log(`strategy   ${entry.strategy}`);
    const depth = queueDepthOf(entry);
    if (depth !== undefined) {
      console.log(`depth      ${depth}`);
    }
    if (error !== undefined) {
      console.log(pc.red(`error      ${error}`));
    } else if (elements !== undefined) {
      console.log('elements (oldest first, index 0 is the next dequeue):');
      elements.forEach((element, index) => {
        console.log(`  [${index}] ${renderValue(element, full)}`);
      });
    } else {
      console.log(`value      ${renderValue(value, full)}`);
    }
    console.log('');
  }
}
