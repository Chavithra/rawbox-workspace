/**
 * `store watch <workspace> [key…] [--interval ms]` — polls a workspace's
 * storage and prints keys whose value changed since the previous poll, with
 * timestamps.
 *
 * **Snapshot hygiene is the whole design constraint here**
 * (OBSERVABILITY.md, "Snapshot hygiene"): a `BoxObserverLmdb` resets its shared
 * MVCC read transaction in a `finally` after *every* method call
 * (rawbox-store/README.md, "Observation — `peek` is not `get`"), so the correct — and only supported — way to
 * poll is what that README itself prescribes: open **one** observer for the
 * whole watch and call its synchronous methods again on an interval, never
 * hold a transaction or an iterator across polls, and never re-open the
 * environment per poll. This command does exactly that: one `openSync` at
 * start, one `closeSync` in a `finally` at the end, and nothing in between
 * but plain synchronous reads. No transaction handling of this command's own
 * invention exists anywhere in this file.
 *
 * `key` selectors are `<workflow>:<key>` (`:` cannot appear in either half —
 * FORMAT.md, "Storage keys", excludes it from the character set — so the separator is
 * unambiguous). With none given, every key currently in the workspace is
 * watched, re-discovered each poll so a key or workflow that appears after
 * `watch` started is picked up rather than missed.
 */

import { BoxObserverLmdb } from '@rawbox/store/box-observer-lmdb';
import type { BoxObserver, BoxStrategy } from '@rawbox/store';
import { ok, err, type Result } from 'neverthrow';

import { resolveStoreTarget } from '../../store/target.js';
import { reconstructQueueSizeMax } from '../../store/fifo-reconstruct.js';
import {
  hasDeclaredBackends,
  openWorkspaceObserverSet,
  queueDepthOf,
  type ObservedInspection,
  type WorkspaceObserverSet,
} from '../../store/observers.js';

export interface StoreWatchKeySelector {
  readonly workflow: string;
  readonly key: string;
}

export interface StoreWatchOptions {
  /** Poll period in milliseconds. */
  interval?: number;
  output?: 'text' | 'json';
  cwd?: string;
  /** Where output goes. Defaults to `process.stdout.write`; tests capture instead. */
  write?: (text: string) => void;
  /**
   * Test seam: bounds how many polls this command performs before returning,
   * instead of looping until the process is stopped — mirrors `runs tail
   * --follow`'s `maxPolls`.
   */
  maxPolls?: number;
  /**
   * Test seam, invoked once per poll with the live observer. Lets a test
   * assert `readerListSync()` shows no pinned transaction *during* a watch
   * loop, not merely after `closeSync` — see `box-observer-lmdb.test.ts`'s
   * own interference suite for the pattern this mirrors.
   *
   * **Deliberately typed to the concrete class, unlike every other observer
   * parameter in this file.** {@link discoverAllKeys} and {@link pollOnce} do
   * ordinary observation and take the backend-agnostic {@link BoxObserver}.
   * This one exists solely to inspect LMDB's *reader table*, and
   * `readerListSync` is deliberately absent from that interface because a
   * reader table has no cross-backend meaning. Widening this to `BoxObserver`
   * would leave the hook unable to do the one thing it is for, and push a cast
   * into the test to compensate.
   *
   * When a second backend supplies an observer, this seam needs a decision
   * rather than a widening: the snapshot-hygiene property it asserts is an
   * LMDB property, and the Redis equivalent is a different assertion.
   */
  onPoll?: (observer: BoxObserverLmdb, pollIndex: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseWatchKeySelector(raw: string): Result<StoreWatchKeySelector, string> {
  const separatorIndex = raw.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    return err(`Key selector "${raw}" must be "<workflow>:<key>".`);
  }
  return ok({
    workflow: raw.slice(0, separatorIndex),
    key: raw.slice(separatorIndex + 1),
  });
}

interface ChangeRecord {
  readonly ts: string;
  readonly workflow: string;
  readonly key: string;
  /**
   * Echoed straight from `BoxInspection.strategy`, whose type is
   * `BoxStrategy['name']` (`@rawbox/store`, `box-store/box-peek.ts:118`).
   *
   * **Derived, not a hand-written pair.** This used to spell out
   * `'lmdb-kv' | 'lmdb-fifo'`, which made it a second, narrower statement of
   * what a strategy may be — and a JSON record's field type is exactly the sort
   * of thing that gets copied and then forgotten. A strategy joining the union
   * widens this with no edit, and the code below still only ever *constructs*
   * LMDB strategies, because this command reads an LMDB environment: what it
   * reports is whatever the observer found, and what it can inspect is the LMDB
   * store's business.
   */
  readonly strategy: BoxStrategy['name'];
  readonly valueSizeBytes: number;
  readonly depth?: number;
}

/** Every `{workflow, key}` currently visible, used when no explicit selector was given. */
function discoverAllKeys(observer: BoxObserver): StoreWatchKeySelector[] {
  const workflowListResult = observer.listWorkflowsSync();
  if (workflowListResult.isErr()) {
    return [];
  }

  const selectorList: StoreWatchKeySelector[] = [];
  for (const workflow of workflowListResult.value) {
    const keysResult = observer.listKeysSync(workflow);
    if (keysResult.isErr()) {
      continue;
    }
    for (const entry of keysResult.value) {
      selectorList.push({ workflow, key: entry.key });
    }
  }
  return selectorList;
}

/**
 * One poll's worth of change detection over `selectorSource`, updating
 * `fingerprintMap` in place.
 *
 * `workspaceName` is threaded in explicitly rather than read off `observer` —
 * unlike {@link BoxObserverLmdb}, the {@link BoxObserver} interface
 * (`@rawbox/store/box-store/box-observer.js`) only promises the six
 * observation methods, not a `workspace` property, so a backend-agnostic
 * caller cannot rely on one.
 */
function pollOnce(
  observer: BoxObserver,
  workspaceName: string,
  explicitSelectorList: readonly StoreWatchKeySelector[],
  fingerprintMap: Map<string, string>,
  emit: (record: ChangeRecord) => void,
): void {
  const selectorList =
    explicitSelectorList.length > 0 ? explicitSelectorList : discoverAllKeys(observer);

  for (const { workflow, key } of selectorList) {
    const keysResult = observer.listKeysSync(workflow);
    if (keysResult.isErr()) {
      continue;
    }
    const entry = keysResult.value.find((candidate) => candidate.key === key);
    if (entry === undefined) {
      continue;
    }

    let fingerprint: string;
    if (entry.strategy === 'lmdb-fifo' && entry.fifo !== undefined) {
      const all = observer.peekAllSync({
        workspace: workspaceName,
        workflow,
        key,
        strategy: {
          name: 'lmdb-fifo',
          queueSizeMax: reconstructQueueSizeMax(entry.fifo),
          valueSizeMax: Math.max(entry.valueSizeMaxBytes, 1),
        },
      });
      fingerprint = all.isOk() ? JSON.stringify(all.value) : `err:${all.error}`;
    } else {
      const value = observer.peekSync({
        workspace: workspaceName,
        workflow,
        key,
        strategy: { name: 'lmdb-kv', valueSizeMax: Math.max(entry.valueSizeMaxBytes, 1) },
      });
      fingerprint = value.isOk() ? JSON.stringify(value.value) : `err:${value.error}`;
    }

    const id = `${workflow}:${key}`;
    const previous = fingerprintMap.get(id);
    fingerprintMap.set(id, fingerprint);

    // First sighting of a key establishes the baseline silently; only a
    // change from a *previous* poll is reported.
    if (previous !== undefined && previous !== fingerprint) {
      emit({
        ts: new Date().toISOString(),
        workflow,
        key,
        strategy: entry.strategy,
        valueSizeBytes: entry.valueSizeBytes,
        ...(entry.fifo !== undefined ? { depth: entry.fifo.depth } : {}),
      });
    }
  }
}

/** The `discoverAllKeys` counterpart for a merged `WorkspaceObserverSet` — see that function for the "no explicit selector" contract. */
async function discoverAllKeysAsync(
  observerSet: WorkspaceObserverSet,
): Promise<StoreWatchKeySelector[]> {
  const workflowListResult = await observerSet.listWorkflows();
  if (workflowListResult.isErr()) {
    return [];
  }

  const selectorList: StoreWatchKeySelector[] = [];
  for (const workflow of workflowListResult.value) {
    const keysResult = await observerSet.listKeys(workflow);
    if (keysResult.isErr()) {
      continue;
    }
    for (const entry of keysResult.value) {
      selectorList.push({ workflow, key: entry.key });
    }
  }
  return selectorList;
}

/**
 * The `pollOnce` counterpart for a merged `WorkspaceObserverSet` — same
 * change-detection contract, over `observerSet.peek`/`peekAll` instead of a
 * single LMDB observer's synchronous methods, so a workspace whose
 * `backends:` map declares a Redis server can be watched the same way an
 * LMDB-only one always has been.
 */
async function pollOnceAsync(
  observerSet: WorkspaceObserverSet,
  explicitSelectorList: readonly StoreWatchKeySelector[],
  fingerprintMap: Map<string, string>,
  emit: (record: ChangeRecord) => void,
): Promise<void> {
  const selectorList =
    explicitSelectorList.length > 0
      ? explicitSelectorList
      : await discoverAllKeysAsync(observerSet);

  for (const { workflow, key } of selectorList) {
    const keysResult = await observerSet.listKeys(workflow);
    if (keysResult.isErr()) {
      continue;
    }
    const entry: ObservedInspection | undefined = keysResult.value.find(
      (candidate) => candidate.key === key,
    );
    if (entry === undefined) {
      continue;
    }

    const isQueue = entry.strategy === 'lmdb-fifo' || entry.strategy === 'redis-fifo';
    const readResult = isQueue
      ? await observerSet.peekAll(entry, workflow, key)
      : await observerSet.peek(entry, workflow, key);
    const fingerprint = readResult.isOk()
      ? JSON.stringify(readResult.value)
      : `err:${readResult.error}`;

    const id = `${workflow}:${key}`;
    const previous = fingerprintMap.get(id);
    fingerprintMap.set(id, fingerprint);

    if (previous !== undefined && previous !== fingerprint) {
      const depth = queueDepthOf(entry);
      emit({
        ts: new Date().toISOString(),
        workflow,
        key,
        strategy: entry.strategy,
        valueSizeBytes: entry.valueSizeBytes,
        ...(depth !== undefined ? { depth } : {}),
      });
    }
  }
}

export async function storeWatchCommand(
  workspaceArg: string,
  keyArgList: readonly string[],
  options: StoreWatchOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const intervalMs = options.interval ?? 1000;

  const targetResult = await resolveStoreTarget(workspaceArg, cwd);
  if (targetResult.isErr()) {
    write(`${targetResult.error}\n`);
    process.exit(1);
    return;
  }
  const target = targetResult.value;

  const selectorList: StoreWatchKeySelector[] = [];
  for (const raw of keyArgList) {
    const parsed = parseWatchKeySelector(raw);
    if (parsed.isErr()) {
      write(`${parsed.error}\n`);
      process.exit(1);
      return;
    }
    selectorList.push(parsed.value);
  }

  const fingerprintMap = new Map<string, string>();
  const emit = buildEmit(options, write);

  // Every LMDB-only workspace takes this branch, byte-for-byte unchanged from
  // before Redis observation existed — see `store list`'s identical note and
  // `../../store/observers.ts`'s module comment.
  if (!hasDeclaredBackends(target)) {
    const openResult = BoxObserverLmdb.openSync(target.workspaceName, target.dataRootUrl);
    if (openResult.isErr()) {
      write(
        `No storage state found for workspace "${target.workspaceName}" yet (${openResult.error}). ` +
          `Nothing to watch until a workflow writes to it.\n`,
      );
      process.exit(0);
      return;
    }
    // Left at its inferred concrete type rather than annotated `BoxObserver`.
    // Everything this function *does* with it goes through the interface —
    // `discoverAllKeys` and `pollOnce` both take `BoxObserver`, and a
    // `BoxObserverLmdb` satisfies it — but the `onPoll` test seam needs the
    // reader table, which the interface deliberately does not promise. Widening
    // here would only move that mismatch to the callback.
    const observer = openResult.value;

    try {
      let pollIndex = 0;
      // No `maxPolls`: polls until the process is stopped (Ctrl+C), the same
      // open-ended contract `runs tail --follow` uses. Tests bound this.
      while (options.maxPolls === undefined || pollIndex < options.maxPolls) {
        pollOnce(observer, target.workspaceName, selectorList, fingerprintMap, emit);
        options.onPoll?.(observer, pollIndex);
        pollIndex += 1;

        if (options.maxPolls === undefined || pollIndex < options.maxPolls) {
          await sleep(intervalMs);
        }
      }
    } finally {
      observer.closeSync();
    }
    return;
  }

  // A `backends:` block is declared: merge the LMDB environment (if one
  // exists) with one `BoxObserverRedis` per backend — see
  // `../../store/observers.ts`. There is no `onPoll` seam on this path: that
  // hook inspects LMDB's reader table specifically (see its doc comment on
  // `StoreWatchOptions`), which has no meaning once a poll may also be
  // reading Redis.
  const observerSet = await openWorkspaceObserverSet(target);

  // Printed once, up front, rather than after the polling loop exits — a
  // user watching wants to know immediately why a backend is not
  // contributing, not only once they stop the command.
  for (const warning of observerSet.redisWarningList) {
    write(`${warning}\n`);
  }

  try {
    let pollIndex = 0;
    while (options.maxPolls === undefined || pollIndex < options.maxPolls) {
      await pollOnceAsync(observerSet, selectorList, fingerprintMap, emit);
      pollIndex += 1;

      if (options.maxPolls === undefined || pollIndex < options.maxPolls) {
        await sleep(intervalMs);
      }
    }
  } finally {
    await observerSet.close();
  }
}

/** The `emit` closure both paths above share — identical output for either backend, since `ChangeRecord` itself is already backend-agnostic. */
function buildEmit(
  options: StoreWatchOptions,
  write: (text: string) => void,
): (record: ChangeRecord) => void {
  return (record: ChangeRecord): void => {
    if (options.output === 'json') {
      write(`${JSON.stringify(record)}\n`);
      return;
    }
    const depthNote = record.depth !== undefined ? `, depth ${record.depth}` : '';
    write(
      `[${record.ts}] ${record.workflow}:${record.key} changed ` +
        `(${record.strategy}${depthNote}, ${record.valueSizeBytes}B)\n`,
    );
  };
}
