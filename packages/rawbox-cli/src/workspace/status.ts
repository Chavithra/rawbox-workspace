/**
 * The data model behind `workspace status [path]` (OBSERVABILITY.md,
 * "CLI surfaces") — "one snapshot of the whole system": every workflow the workspace
 * document lists, its latest recorded run (registry) with liveness
 * classification and a tail of its NDJSON log, plus a compact storage panel
 * via the read-only observer.
 *
 * Pure assembly over existing surfaces — nothing here re-derives what
 * `runs`/`store` already know:
 *
 * - Liveness: `../runs/classify.js`'s `classifyDisplayStatus`, the same
 *   pid+start-time check `runs list` uses.
 * - The latest run's tail: `../runs/log-summary.js`'s `summarizeRunLog`, the
 *   same NDJSON reader `runs show` uses.
 * - Storage: `BoxObserverLmdb`, the same read-only observer `store list`
 *   uses — never `BoxStoreLmdb`, for the same reason documented there.
 *
 * A workflow whose document fails to load or validate degrades rather than
 * failing the whole snapshot (`workspace verify`'s own posture): it is still
 * listed, with `nameResolved: false` and its load error, so one rotted
 * workflow file never blanks out the other N-1 a workspace has.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { BoxObserverLmdb } from '@rawbox/store/box-observer-lmdb';
import type { BoxInspection, BoxObserver } from '@rawbox/store';
import {
  parseConfig,
  resolveWorkspaceWorkflowPath,
  validateWorkflowType,
  type Workflow,
} from '@rawbox/runner';

import { getErrorMessage } from '../utils/error.js';
import { classifyDisplayStatus } from '../runs/classify.js';
import { formatAge } from '../runs/format.js';
import { summarizeRunLog } from '../runs/log-summary.js';
import type { ProbeFn } from '../runs/pid-probe.js';
import { probeProcess } from '../runs/pid-probe.js';
import { listRegistryEntries } from '../runs/registry-io.js';
import type { DisplayStatus, RunRegistryEntry } from '../runs/types.js';
import type { StoreTarget } from '../store/target.js';
import {
  hasDeclaredBackends,
  openWorkspaceObserverSet,
  queueDepthOf,
} from '../store/observers.js';

/** One `latestRun`'s liveness, age and log-tail summary. */
export interface WorkspaceLatestRun {
  readonly runId: string;
  readonly startedAt: string;
  readonly age: string;
  readonly displayStatus: DisplayStatus;
  readonly pid: number;
  readonly lastEvent?: { readonly event: string; readonly ts: string };
  /**
   * Set exactly when `lastEvent.event` is `"run.heartbeat"` and the line
   * parsed enough to say what step it named — the detail `workflowStatusCell`
   * (`../commands/workspace/status.js`) renders as "in `<step>` for `<age>`"
   * instead of the bare `run.heartbeat @<ts>` a generic last-event render
   * would otherwise show (OBSERVABILITY.md, "`run.heartbeat`").
   */
  readonly heartbeat?: { readonly stepLabel: string; readonly inFlightMs: number };
  readonly steps: { readonly ok: number; readonly failed: number };
  readonly lastError?: { readonly message: string; readonly ts?: string; readonly event?: string };
}

/** One `workflowPathList` entry's status row. */
export interface WorkspaceWorkflowStatus {
  readonly workflowPath: string;
  /** The workflow's declared `name:`, or a filename fallback when the document did not load. */
  readonly workflowName: string;
  /** `false` when the workflow document failed to load/validate — `workflowName` is a fallback then. */
  readonly nameResolved: boolean;
  /** Present only when `nameResolved` is `false`. */
  readonly loadError?: string;
  /** Absent entirely when the workflow has never been run — "never run". */
  readonly latestRun?: WorkspaceLatestRun;
}

/** One storage panel row — a single key in a single workflow's database. */
export interface WorkspaceStorageKey {
  readonly key: string;
  readonly strategy: BoxInspection['strategy'];
  readonly valueSizeBytes: number;
  readonly fifo?: { readonly depth: number };
}

/** One workflow database's storage rows. */
export interface WorkspaceStorageWorkflow {
  readonly workflow: string;
  readonly keyList: readonly WorkspaceStorageKey[];
}

export interface WorkspaceStatusSnapshot {
  readonly workspace: string;
  readonly targetFolder: string;
  readonly generatedAt: string;
  readonly workflowList: readonly WorkspaceWorkflowStatus[];
  readonly storage: readonly WorkspaceStorageWorkflow[];
  /** Set instead of `storage` when no LMDB environment exists yet ("nothing has run"). */
  readonly storageUnavailable?: string;
  /**
   * One entry per declared `backends:` entry that could not be observed
   * (unresolvable connection, unreachable server) — non-fatal, the same
   * degrade-per-workflow posture this snapshot already has for a rotted
   * workflow document. Absent for a workspace with no `backends:` block, and
   * empty (never absent-vs-empty ambiguous) whenever every declared backend
   * connected fine.
   */
  readonly storageWarningList?: readonly string[];
}

export interface BuildStatusOptions {
  probe?: ProbeFn;
}

/** Best-effort workflow name resolution — never throws, degrades per-workflow. */
async function resolveWorkflowName(
  workspaceDir: string,
  workflowPath: string,
): Promise<{ name: string; resolved: boolean; loadError?: string }> {
  const fallback = path.basename(workflowPath).replace(/\.(ya?ml|json)$/i, '');
  const fullPath = resolveWorkspaceWorkflowPath(workspaceDir, workflowPath);

  try {
    const content = await fs.readFile(fullPath, 'utf-8');
    const document = parseConfig(content, fullPath);
    const typeResult = validateWorkflowType(document, workflowPath);
    if (typeResult.isErr()) {
      return { name: fallback, resolved: false, loadError: typeResult.error.message };
    }
    return { name: (document as Workflow).name, resolved: true };
  } catch (error) {
    return { name: fallback, resolved: false, loadError: getErrorMessage(error) };
  }
}

/** The latest (by `started_at`) registry entry for a given workflow name, if any. */
function latestEntryFor(
  entryList: readonly RunRegistryEntry[],
  workflowName: string,
): RunRegistryEntry | undefined {
  let latest: RunRegistryEntry | undefined;
  for (const entry of entryList) {
    if (entry.workflow !== workflowName) {
      continue;
    }
    if (latest === undefined || Date.parse(entry.started_at) > Date.parse(latest.started_at)) {
      latest = entry;
    }
  }
  return latest;
}

/**
 * Reads a `run.heartbeat` line's `step`/`in_flight_ms` off the raw parsed
 * event, when `lastEvent` names that kind and the fields are shaped as
 * expected. Read generically (no schema import, no throw on a mismatch) —
 * the same "ignore what you don't recognise" posture every other reader of
 * this stream takes (OBSERVABILITY.md, "Versioning").
 */
function heartbeatDetailOf(
  rawLastEvent: Record<string, unknown> | undefined,
): { stepLabel: string; inFlightMs: number } | undefined {
  if (rawLastEvent === undefined || rawLastEvent['event'] !== 'run.heartbeat') {
    return undefined;
  }
  const inFlightMs = rawLastEvent['in_flight_ms'];
  const step = rawLastEvent['step'];
  if (typeof inFlightMs !== 'number' || typeof step !== 'object' || step === null) {
    return undefined;
  }
  const stepRecord = step as Record<string, unknown>;
  const stepLabel =
    typeof stepRecord['label'] === 'string'
      ? stepRecord['label']
      : `step-${typeof stepRecord['index'] === 'number' ? stepRecord['index'] : '?'}`;
  return { stepLabel, inFlightMs };
}

async function buildLatestRun(
  entry: RunRegistryEntry,
  probe: ProbeFn,
): Promise<WorkspaceLatestRun> {
  const summary = await summarizeRunLog(entry.log_path, entry.error_log_path);
  const lastEvent =
    summary.lastEvent !== undefined &&
    typeof summary.lastEvent['event'] === 'string' &&
    typeof summary.lastEvent['ts'] === 'string'
      ? { event: summary.lastEvent['event'] as string, ts: summary.lastEvent['ts'] as string }
      : undefined;
  const heartbeat = heartbeatDetailOf(summary.lastEvent);

  return {
    runId: entry.run_id,
    startedAt: entry.started_at,
    age: formatAge(entry.started_at),
    displayStatus: classifyDisplayStatus(entry, probe),
    pid: entry.pid,
    ...(lastEvent !== undefined ? { lastEvent } : {}),
    ...(heartbeat !== undefined ? { heartbeat } : {}),
    steps: { ok: summary.stepsOk, failed: summary.stepsFailed },
    ...(summary.lastError !== undefined ? { lastError: summary.lastError } : {}),
  };
}

/** One `WorkspaceStorageKey` from an enumerated entry — shared by both paths below. */
function buildStorageKey(entry: Pick<
  BoxInspection,
  'key' | 'strategy' | 'valueSizeBytes' | 'fifo' | 'queueDepth'
>): WorkspaceStorageKey {
  const depth = queueDepthOf(entry);
  return {
    key: entry.key,
    strategy: entry.strategy,
    valueSizeBytes: entry.valueSizeBytes,
    ...(depth !== undefined ? { fifo: { depth } } : {}),
  };
}

/**
 * Every key currently in the workspace's storage, grouped by workflow.
 *
 * Every LMDB-only workspace — no `backends:` block declared — takes the
 * first branch, byte-for-byte unchanged from before Redis observation
 * existed: `BoxObserverLmdb` only, synchronous, the same "no environment yet"
 * `storageUnavailable` answer `store list` gives (see that command's
 * identical branch and `../store/observers.ts`'s module comment). A
 * workspace that DOES declare backends merges the LMDB environment (if any)
 * with one `BoxObserverRedis` per backend.
 */
async function buildStoragePanel(
  target: Pick<StoreTarget, 'workspaceName' | 'dataRootUrl' | 'workspaceDoc' | 'workspaceDocPath'>,
): Promise<
  | { storage: WorkspaceStorageWorkflow[]; warningList?: readonly string[] }
  | { storageUnavailable: string; warningList?: readonly string[] }
> {
  if (!hasDeclaredBackends(target)) {
    const openResult = BoxObserverLmdb.openSync(target.workspaceName, target.dataRootUrl);
    if (openResult.isErr()) {
      return { storageUnavailable: openResult.error };
    }
    const observer: BoxObserver = openResult.value;

    try {
      const workflowListResult = observer.listWorkflowsSync();
      if (workflowListResult.isErr()) {
        return { storageUnavailable: workflowListResult.error };
      }

      const storage: WorkspaceStorageWorkflow[] = [];
      for (const workflow of workflowListResult.value) {
        const keysResult = observer.listKeysSync(workflow);
        if (keysResult.isErr()) {
          continue;
        }
        storage.push({
          workflow,
          keyList: keysResult.value.map(buildStorageKey),
        });
      }
      return { storage };
    } finally {
      observer.closeSync();
    }
  }

  const observerSet = await openWorkspaceObserverSet(target);

  try {
    const workflowListResult = await observerSet.listWorkflows();
    if (workflowListResult.isErr()) {
      // Named so a workspace whose only problem IS an unreachable/
      // unresolvable backend says why, rather than that reason getting
      // silently dropped behind a generic "storage unavailable".
      return {
        storageUnavailable: workflowListResult.error,
        warningList: observerSet.redisWarningList,
      };
    }

    const storage: WorkspaceStorageWorkflow[] = [];
    for (const workflow of workflowListResult.value) {
      const keysResult = await observerSet.listKeys(workflow);
      if (keysResult.isErr()) {
        continue;
      }
      storage.push({
        workflow,
        keyList: keysResult.value.map(buildStorageKey),
      });
    }
    // Redis connection problems degrade the same way a rotted workflow
    // document does elsewhere in this file: reported (via
    // `storageWarningList`, wired in by the caller), never fatal to the rest
    // of the snapshot.
    return { storage, warningList: observerSet.redisWarningList };
  } finally {
    await observerSet.close();
  }
}

/**
 * Builds one `workspace status` snapshot. `target` must have resolved to a
 * workspace document (`workspaceDoc`/`workspaceDocPath` set) — the caller is
 * responsible for that precondition, since only a resolved document carries
 * `workflowPathList`.
 */
export async function buildWorkspaceStatusSnapshot(
  target: StoreTarget & { workspaceDoc: NonNullable<StoreTarget['workspaceDoc']>; workspaceDocPath: NonNullable<StoreTarget['workspaceDocPath']> },
  options: BuildStatusOptions = {},
): Promise<WorkspaceStatusSnapshot> {
  const probe = options.probe ?? probeProcess;
  const workspaceDir = path.dirname(target.workspaceDocPath);

  const entryList = await listRegistryEntries(target.targetFolder);

  const workflowList: WorkspaceWorkflowStatus[] = [];
  for (const workflowPath of target.workspaceDoc.workflowPathList) {
    const { name, resolved, loadError } = await resolveWorkflowName(workspaceDir, workflowPath);
    const latestEntry = latestEntryFor(entryList, name);
    const latestRun = latestEntry !== undefined ? await buildLatestRun(latestEntry, probe) : undefined;

    workflowList.push({
      workflowPath,
      workflowName: name,
      nameResolved: resolved,
      ...(loadError !== undefined ? { loadError } : {}),
      ...(latestRun !== undefined ? { latestRun } : {}),
    });
  }

  const storagePart = await buildStoragePanel(target);
  const warningList = storagePart.warningList;

  return {
    workspace: target.workspaceName,
    targetFolder: target.targetFolder,
    generatedAt: new Date().toISOString(),
    workflowList,
    storage: 'storage' in storagePart ? storagePart.storage : [],
    ...('storageUnavailable' in storagePart ? { storageUnavailable: storagePart.storageUnavailable } : {}),
    ...(warningList !== undefined ? { storageWarningList: warningList } : {}),
  };
}
