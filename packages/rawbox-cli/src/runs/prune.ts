/**
 * `runs prune` — deletes registry entries **and** their log files down to a
 * bound (OBSERVABILITY.md, "Retention"). Also invoked opportunistically,
 * bounded and silently, at the start of every `workflow run`
 * (`commands/workflow/run.ts`) — see {@link pruneRunsOpportunistically}.
 *
 * The bounds themselves — an explicit flag, a workspace's `logs.prune:`, or
 * the built-in default — are resolved by `@rawbox/runner`'s
 * `resolveLogsConfig` (`workspace/logs.ts`) before either caller reaches this
 * module; nothing here reads a document or a flag. `DEFAULT_PRUNE_KEEP` (the
 * built-in `keep` default, now the one bound always in effect — `maxBytes`
 * has no unconditional fallback of its own since segment rotation gave every
 * run a self-bound of `rotate.maxBytes * rotate.maxFiles`) lives in
 * `@rawbox/runner`, the only direction the dependency between the two
 * packages runs, and this module never needs it directly.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedLogPrune } from '@rawbox/runner';

import { getErrorMessage } from '../utils/error.js';
import { classifyDisplayStatus } from './classify.js';
import { probeProcess, type ProbeFn } from './pid-probe.js';
import { listRegistryEntries, runsDirFor } from './registry-io.js';
import { DISPLAY_STATUS, type RunRegistryEntry } from './types.js';
import { listLogSegments } from '../workspace/log-segments.js';

/** `runs prune`'s three bounds. All optional; see {@link pruneRuns} for how they compose. */
export interface PruneOptions {
  /** Keep only the `keep` most recently started runs. */
  keep?: number;
  /** Delete anything started more than this many days ago. */
  olderThanDays?: number;
  /** Delete oldest-first until the surviving set's total bytes are at or under this. */
  maxBytes?: number;
}

/**
 * Converts a resolved `logs.prune:` ({@link ResolvedLogPrune}, from
 * `@rawbox/runner`'s `resolveLogsConfig`) into the {@link PruneOptions}
 * {@link pruneRuns} accepts.
 *
 * The two shapes differ under `exactOptionalPropertyTypes`:
 * `ResolvedLogPrune`'s `olderThanDays`/`maxBytes` are always-present fields
 * whose value may be `undefined` ("no bound of this kind" is a real, resolved
 * outcome — see that type's own doc), while `PruneOptions`'s are genuinely
 * optional keys that must be absent rather than present-with-`undefined`.
 * `keep` needs no such guard on this side: it always resolves to a number
 * (`DEFAULT_PRUNE_KEEP` when nothing else supplies one), so it is always
 * passed through. One conversion here, shared by `runs prune`'s command and
 * `workflow run`'s opportunistic pass, so the two callers cannot drift into
 * two ways of bridging the same two types.
 */
export function pruneOptionsFromResolvedLogs(prune: ResolvedLogPrune): PruneOptions {
  return {
    keep: prune.keep,
    ...(prune.olderThanDays !== undefined ? { olderThanDays: prune.olderThanDays } : {}),
    ...(prune.maxBytes !== undefined ? { maxBytes: prune.maxBytes } : {}),
  };
}

/** One deleted run, reported back to the caller for `runs prune`'s own summary. */
export interface PrunedRun {
  runId: string;
  bytes: number;
}

export interface PruneResult {
  prunedList: PrunedRun[];
  bytesFreed: number;
  survivorCount: number;
}

interface SizedEntry {
  entry: RunRegistryEntry;
  registryFilePath: string;
  bytes: number;
  /** `true` when this run's process is still alive — see {@link isEntryLive}. */
  live: boolean;
}

/**
 * `true` when this entry's run is still alive, and therefore exempt from
 * deletion (OBSERVABILITY.md, "Retention": "Pruning MUST NOT remove an entry
 * whose run is still alive").
 *
 * Delegates to the same {@link classifyDisplayStatus} `runs list` uses rather
 * than doing its own `process.kill(pid, 0)`. That matters: `kill(pid, 0)`
 * alone reports a *recycled* pid as alive, which here would be the harmless
 * direction — but it also has no way to tell a live run from a crashed one
 * whose pid has since been reused by an unrelated long-lived process, which
 * would pin a dead run's log files forever. `classifyDisplayStatus` pairs
 * `pid` with `pid_started_at`, so both directions stay correct and prune's
 * notion of "alive" is by construction the one the operator sees.
 *
 * **An inconclusive or failing probe counts as alive.** `classifyDisplayStatus`
 * already treats an undeterminable start time as a match (`startTimesMatch`),
 * and any throw from the probe itself is caught here and answered `true`. The
 * two error directions are not symmetric: wrongly believing a run dead deletes
 * a log file that is still being written, which is unrecoverable; wrongly
 * believing it alive only leaves bytes on disk until the next pass. Retention
 * is a best-effort cleanup, so it always errs toward keeping the file.
 */
function isEntryLive(entry: RunRegistryEntry, probe: ProbeFn): boolean {
  try {
    // Exactly `workspace/logs.ts`'s `isLive`: the two non-terminal statuses,
    // and only when the probe confirmed them (`classifyDisplayStatus` returns
    // `crashed` instead when it did not). A terminal status is never live —
    // the run already reported how it ended.
    const status = classifyDisplayStatus(entry, probe);
    return status === DISPLAY_STATUS.RUNNING || status === DISPLAY_STATUS.BOOTSTRAPPING;
  } catch {
    return true;
  }
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return 0;
  }
}

/**
 * What one run occupies: its registry file plus **every segment** of its main
 * and error logs.
 *
 * Measuring only `log_path` would report a rotated run at the size of its
 * oldest segment alone — `maxBytes` is the primary bound (see {@link
 * pruneRuns}), so under-measuring is not a cosmetic error: the pass would
 * believe it had room it does not have and keep runs it should have deleted,
 * which is the exact opposite of what a byte ceiling is for. Enumeration goes
 * through `../workspace/log-segments.js`, the same one every log *reader*
 * uses.
 *
 * Paths are unioned before sizing, which subsumes the old
 * `error_log_path === log_path` special case: two runs pointed at one file by
 * `--log-file` (see {@link deleteSized}) still contribute it once.
 */
async function sizeOf(
  targetFolder: string,
  entry: RunRegistryEntry,
  probe: ProbeFn,
): Promise<SizedEntry> {
  const registryFilePath = path.join(runsDirFor(targetFolder), `${entry.run_id}.json`);
  const logFilePathSet = new Set(await listRunSegments(entry));
  const [registryBytes, logBytesList] = await Promise.all([
    fileSize(registryFilePath),
    Promise.all([...logFilePathSet].map((filePath) => fileSize(filePath))),
  ]);
  return {
    entry,
    registryFilePath,
    bytes: logBytesList.reduce((sum, bytes) => sum + bytes, registryBytes),
    live: isEntryLive(entry, probe),
  };
}

function startedAtMs(entry: RunRegistryEntry): number {
  const ms = Date.parse(entry.started_at);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Deletes one run's registry entry and **every segment** of its logs, skipping
 * any path `survivorPathSet` still points at.
 *
 * That guard is the second half of OBSERVABILITY.md, "Retention" — "MUST NOT
 * delete a log file a surviving entry points at" — and it is reachable, not
 * theoretical: `log_path`/`error_log_path` default to per-run-id filenames,
 * but `workflow run`'s `--log-file`/`--error-log` let a user point two runs at
 * one file. Without the guard, pruning the older of those two entries would
 * unlink the surviving one's log.
 *
 * **Segments are enumerated, not assumed.** Deleting `log_path` alone would
 * remove segment 0 and leave `<run_id>.1.ndjson` and up on disk with no
 * registry entry left to name them — invisible to `runs list`, uncounted by
 * every later pass's {@link sizeOf}, and unreachable by anything but a manual
 * `rm`, while this pass *reported* their bytes as freed. Enumeration goes
 * through the same `listLogSegments` {@link sizeOf} measures with, so what is
 * charged and what is removed are the same set of files by construction.
 *
 * A path union rather than two sequences: with `--log-file` pointing both logs
 * of a run at one file, its segments would otherwise be unlinked twice (which
 * `force: true` tolerates, but the intent is clearer stated once).
 */
async function deleteSized(sized: SizedEntry, survivorPathSet: ReadonlySet<string>): Promise<void> {
  await fs.rm(sized.registryFilePath, { force: true });
  const segmentPathSet = new Set(await listRunSegments(sized.entry));
  for (const filePath of segmentPathSet) {
    if (!survivorPathSet.has(filePath)) {
      await fs.rm(filePath, { force: true });
    }
  }
}

/**
 * Every log file one entry owns — both sequences, every segment of each.
 *
 * The one enumeration {@link deleteSized} and `pruneRuns`'s `survivorPathSet`
 * both go through. They have to agree: the survivor set is what stops a
 * deletion from unlinking a file another entry still needs, so a survivor whose
 * segments were enumerated less thoroughly than a deletion's would be exactly
 * the file that goes missing.
 */
async function listRunSegments(entry: RunRegistryEntry): Promise<string[]> {
  const [logSegmentList, errorSegmentList] = await Promise.all([
    listLogSegments(entry.log_path),
    listLogSegments(entry.error_log_path),
  ]);
  return [...logSegmentList, ...errorSegmentList];
}

/**
 * Deletes registry entries and their log files down to the given bounds.
 *
 * **A live run is never deleted, by any bound.** Before the bounds are applied
 * at all, every entry is classified live or not ({@link isEntryLive}), and a
 * live one is exempt from all three — age, count and bytes alike. This is
 * OBSERVABILITY.md, "Retention": "Pruning MUST NOT remove an entry whose run
 * is still alive". The exemption is not cosmetic: the opportunistic pass runs
 * at the start of *every* `workflow run`, so without it, starting one run in a
 * workspace shared with long-lived daemon workflows deletes those siblings'
 * registry entries and logs out from under them while they are still
 * appending — and because the NDJSON sink appends by path, the unlinked file
 * is silently recreated and all history before that moment is simply gone.
 *
 * The three bounds compose, applied in this order against a newest-first
 * ordering by `started_at`:
 *
 * 1. `olderThanDays` — drop anything older than the cutoff outright.
 * 2. `keep` — among what survives (1), keep only the newest `keep`. Live runs
 *    do occupy their place in that ordering (they are among the "newest N"
 *    like any other entry); they are simply also re-added afterwards if the
 *    slice would have excluded them.
 * 3. `maxBytes` — **the primary bound when it is set**: walking what survives
 *    (1) and (2) newest-first, accumulate bytes and cut everything from the
 *    point the budget is exceeded — even an entry `keep`/`olderThanDays`
 *    would have kept. This is what gives the directory a hard byte ceiling
 *    regardless of the other two. At least one entry always survives the
 *    whole pass, even if it alone exceeds the budget — pruning to zero
 *    surviving runs would make `runs list` report a system with no history at
 *    all, which is a worse failure mode than a one-run budget overrun.
 *
 * This function itself treats all three purely as `options` — it resolves no
 * default of its own. It is `@rawbox/runner`'s `resolveLogsConfig` that
 * decides what "unset" means for each caller: `keep` always resolves to a
 * number (`DEFAULT_PRUNE_KEEP` when nothing else supplies one, so a workspace
 * with no `logs:` at all still gets bound 2 above), while `olderThanDays` and
 * `maxBytes` resolve to `undefined` — and are consequently absent from
 * `options` here, per {@link pruneOptionsFromResolvedLogs} — when nothing
 * configures them. `maxBytes` therefore no longer has an unconditional
 * built-in default the way it once did: it remains the primary bound when an
 * explicit flag or a workspace's `logs.prune.maxBytes` supplies one, but an
 * unconfigured workspace is bounded by `keep` alone.
 *
 * **How a live run's bytes interact with `maxBytes`:** they are charged to the
 * budget in full, before any deletable run is considered — a live run is
 * exempt from *deletion*, not from *accounting*. The budget exists to bound
 * what this directory occupies on disk, and a live run's 4 GB log is 4 GB on
 * disk; pretending it were 0 would let the pass believe it had room it does
 * not have, keep finished runs on that false credit, and overshoot the
 * ceiling. The consequence, which is deliberate: when live runs alone exceed
 * `maxBytes`, every deletable run is pruned and the directory *still* exceeds
 * the budget. That is correct. The bound is best-effort pressure on retained
 * history, and the only way to honour it against a live 4 GB writer would be
 * to delete the file it is writing — which is the exact failure this exemption
 * exists to prevent.
 *
 * Every step is best-effort per entry: a corrupt registry file or a missing
 * log is sized as `0`, a probe that fails or cannot determine a start time
 * resolves to "alive, do not delete" ({@link isEntryLive}), neither aborts the
 * pass, and one deletion failing is reported and skipped rather than thrown —
 * this runs silently at every `workflow run` start, so it must never be able
 * to fail a run.
 *
 * @param probe - Defaults to the real {@link probeProcess}; tests inject a
 *   fake to simulate a dead pid, a recycled one, or a probe that throws.
 */
export async function pruneRuns(
  targetFolder: string,
  options: PruneOptions,
  probe: ProbeFn = probeProcess,
): Promise<PruneResult> {
  const entryList = await listRegistryEntries(targetFolder);
  const sizedList = await Promise.all(
    entryList.map((entry) => sizeOf(targetFolder, entry, probe)),
  );

  sizedList.sort((a, b) => startedAtMs(b.entry) - startedAtMs(a.entry));

  const liveList = sizedList.filter((sized) => sized.live);

  let survivorList = sizedList;

  if (options.olderThanDays !== undefined) {
    const cutoffMs = Date.now() - options.olderThanDays * 24 * 60 * 60 * 1000;
    survivorList = survivorList.filter((sized) => startedAtMs(sized.entry) >= cutoffMs);
  }

  if (options.keep !== undefined) {
    survivorList = survivorList.slice(0, Math.max(0, options.keep));
  }

  if (options.maxBytes !== undefined) {
    const keptList: SizedEntry[] = [];
    // Live runs' bytes are charged up front — see the "How a live run's bytes
    // interact with `maxBytes`" note above — and skipped in the walk so they
    // are never counted twice. They rejoin the survivor set unconditionally
    // below, so dropping them here costs them nothing.
    let totalBytes = liveList.reduce((sum, sized) => sum + sized.bytes, 0);
    for (const sized of survivorList) {
      if (sized.live) {
        continue;
      }
      // The "at least one survivor" guarantee: force-keep this entry only if
      // nothing at all would otherwise survive. A live run already surviving
      // satisfies the guarantee, so it must not also buy a finished run a
      // free pass past the budget.
      const somethingSurvives = keptList.length > 0 || liveList.length > 0;
      if (totalBytes + sized.bytes > options.maxBytes && somethingSurvives) {
        break;
      }
      keptList.push(sized);
      totalBytes += sized.bytes;
    }
    survivorList = keptList;
  }

  // The exemption itself: whatever the bounds decided, every live run
  // survives. Union by run id, since a live run may or may not already be in
  // `survivorList` depending on which bounds were supplied.
  const survivorIdSet = new Set(survivorList.map((sized) => sized.entry.run_id));
  for (const sized of liveList) {
    survivorIdSet.add(sized.entry.run_id);
  }

  const deleteList = sizedList.filter((sized) => !survivorIdSet.has(sized.entry.run_id));

  // Every log file a surviving entry still points at — **segments included**,
  // so a deletion can never unlink a file another entry needs (see {@link
  // deleteSized}). Only the two named paths would leave a survivor's
  // `<run_id>.1.ndjson` unprotected, and a run pointed at a shared `--log-file`
  // is exactly the run whose successor segments the other entry is still
  // appending to.
  const survivorPathSet = new Set<string>();
  for (const sized of sizedList) {
    if (survivorIdSet.has(sized.entry.run_id)) {
      for (const filePath of await listRunSegments(sized.entry)) {
        survivorPathSet.add(filePath);
      }
    }
  }

  const prunedList: PrunedRun[] = [];
  let bytesFreed = 0;
  for (const sized of deleteList) {
    try {
      await deleteSized(sized, survivorPathSet);
      prunedList.push({ runId: sized.entry.run_id, bytes: sized.bytes });
      bytesFreed += sized.bytes;
    } catch (error) {
      console.error(
        `[rawbox] failed to prune run "${sized.entry.run_id}": ${getErrorMessage(error)}`,
      );
    }
  }

  return { prunedList, bytesFreed, survivorCount: survivorIdSet.size };
}

/**
 * Runs {@link pruneRuns} for the opportunistic pass at `workflow run` start:
 * bounded by whatever `options` resolved to, and silent — a pruning failure
 * must never surface as, or cause, a run failure.
 *
 * This is the caller that makes the liveness exemption load-bearing: it fires
 * on every single `workflow run`, against a directory that may be shared with
 * other workflows' still-running processes.
 */
export async function pruneRunsOpportunistically(
  targetFolder: string,
  options: PruneOptions,
  probe: ProbeFn = probeProcess,
): Promise<void> {
  try {
    await pruneRuns(targetFolder, options, probe);
  } catch {
    // Never allowed to affect the run it is piggybacking on.
  }
}
