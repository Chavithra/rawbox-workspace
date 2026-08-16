/**
 * Merging several runs' NDJSON event streams into one timestamp-ordered
 * stream — the engine behind `workspace logs`
 * (OBSERVABILITY.md, "CLI surfaces").
 *
 * **The post-mortem path is not a special case here.** Reading a finished
 * run's log and reading a live run's still-growing log go through the exact
 * same {@link readNewEvents} call — the only difference is whether the file
 * has stopped growing. `workspace logs --run <finished-id-1> --run
 * <finished-id-2>` therefore merges identically to two live runs; there is no
 * separate "historical" code path to fall out of sync with the live one.
 *
 * Ordering is a **stable sort on `ts`, with `run_id` as the tiebreak** — two
 * events sharing a millisecond (or a run's own clock resolution) are ordered
 * deterministically rather than by array position. **Cross-process clock
 * skew between the machines/processes that produced these logs is not
 * corrected** — `ts` is trusted as recorded; a system whose clocks disagree
 * by more than the events' natural spacing will see runs interleaved
 * slightly wrong, and no attempt is made to detect or fix that here.
 *
 * **A run's log may be several files.** Reading one run's stream means
 * reading its segments in order — `<run_id>.ndjson`, then `<run_id>.1.ndjson`,
 * then `<run_id>.2.ndjson` … — and that enumeration lives entirely in
 * `log-segments.ts`; nothing here opens `logPath` directly. The identity above
 * survives it: {@link readNewEvents} crosses a boundary the same way whether
 * the run finished an hour ago or is rotating right now, so the post-mortem
 * path is still not a special case.
 */

import {
  INITIAL_SEGMENT_CURSOR,
  readNewSegmentBytes,
  type SegmentCursor,
} from './log-segments.js';

/** One run's NDJSON log, as a merge input. */
export interface LogSource {
  readonly runId: string;
  readonly workflow: string;
  readonly logPath: string;
}

/** One event, tagged with which run produced it and its parsed sort key. */
export interface MergedEvent {
  readonly ts: string;
  /** `Date.parse(ts)`, or `0` when `ts` is missing/unparseable — sorts first rather than throwing. */
  readonly tsMs: number;
  readonly runId: string;
  readonly workflow: string;
  /** The raw parsed JSON line, verbatim — what `--output json` prints. */
  readonly event: Record<string, unknown>;
}

/** Per-source progress through its log, carried from one poll to the next during `-f`. */
export interface TailState {
  readonly source: LogSource;
  /**
   * Which segment of `source.logPath` is being read, and how many of its bytes
   * are already consumed (whether or not they formed complete lines).
   *
   * This is the same byte-offset model as before segments existed, qualified
   * by *which file* the offset counts bytes of — for a run that never rotates,
   * `cursor.segment` is `0` for the run's whole life and `cursor.offset` is
   * exactly the old `offset`.
   */
  readonly cursor: SegmentCursor;
  /** A trailing, not-yet-newline-terminated fragment carried over from the last read. */
  readonly leftover: string;
}

export function initTailState(source: LogSource): TailState {
  return { source, cursor: INITIAL_SEGMENT_CURSOR, leftover: '' };
}

/**
 * Reads whatever bytes of this run's log have been appended since
 * `state.cursor` — **crossing into the run's next segment when the current one
 * is finished** — parses the complete NDJSON lines among them, and returns both
 * the parsed events and the next `TailState` to poll from.
 *
 * The advance rule, and the proof that nothing is read twice or skipped, live
 * in `log-segments.ts`'s `readNewSegmentBytes`; this function only turns the
 * bytes it hands back into events. What it adds is the line layer:
 *
 * - A partial trailing line **inside the live segment** (the writer's
 *   `appendFileSync` landed between polls) is kept as `leftover` rather than
 *   parsed or discarded — the next call prepends it, so a line is never
 *   dropped for having been read in two pieces. Unchanged from before
 *   segments existed.
 * - A partial trailing line **at the end of a sealed segment** is
 *   **dropped, with a diagnostic on stderr**. It is a genuine anomaly:
 *   rotation closes a segment between lines (`@rawbox/runner`'s `LogRotate`
 *   — "a segment file is always whole NDJSON"), so a sealed segment ending
 *   mid-line means the file was truncated or damaged, not merely mid-write.
 *   Carrying the fragment forward would splice it onto the first line of the
 *   next segment and corrupt *that* event too — quite possibly into something
 *   that still parses, which would fabricate an event out of two half ones.
 *   Losing one damaged line loudly beats inventing one silently, so the
 *   fragment is discarded at the boundary and the reader resynchronises on
 *   the next segment's first line.
 *
 * A missing log (a run that has not written yet, or one that was pruned) is
 * still treated as "nothing new" rather than an error.
 */
export async function readNewEvents(state: TailState): Promise<{ events: MergedEvent[]; state: TailState }> {
  const { chunkList, cursor } = await readNewSegmentBytes(state.source.logPath, state.cursor);

  const events: MergedEvent[] = [];
  let leftover = state.leftover;

  for (const chunk of chunkList) {
    const lineList = (leftover + chunk.text).split('\n');
    leftover = lineList.pop() ?? '';

    for (const line of lineList) {
      if (line.length === 0) {
        continue;
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ts = typeof parsed['ts'] === 'string' ? (parsed['ts'] as string) : '';
      const tsMs = Date.parse(ts);
      events.push({
        ts,
        tsMs: Number.isNaN(tsMs) ? 0 : tsMs,
        runId: state.source.runId,
        workflow: typeof parsed['workflow'] === 'string' ? (parsed['workflow'] as string) : state.source.workflow,
        event: parsed,
      });
    }

    if (chunk.sealed && leftover.length > 0) {
      console.error(
        `[rawbox] run "${state.source.runId}": dropped ${leftover.length} byte(s) of an ` +
          `unterminated final line in sealed log segment ${chunk.segment} of ` +
          `"${state.source.logPath}" — a sealed segment always ends at a line boundary, so ` +
          `this one was truncated or damaged.`,
      );
      leftover = '';
    }
  }

  return { events, state: { source: state.source, cursor, leftover } };
}

/** Stable sort on `tsMs`, tiebroken by `runId` — the ordering rule this whole module exists for. */
export function sortMerged(eventList: readonly MergedEvent[]): MergedEvent[] {
  return [...eventList].sort((a, b) => {
    if (a.tsMs !== b.tsMs) {
      return a.tsMs - b.tsMs;
    }
    return a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0;
  });
}

/**
 * Reads every source's log fully — from the oldest surviving segment's byte
 * zero through the live segment's end, in one {@link readNewEvents} call per
 * source, since that call walks forward across every boundary it finds —
 * merges and sorts the result: the "historical" read, and also what a
 * `--follow` command uses
 * for its first frame before switching to {@link readNewEvents} polls, so
 * the two modes share one reader rather than diverging.
 */
export async function readAllMerged(
  sourceList: readonly LogSource[],
): Promise<{ eventList: MergedEvent[]; stateMap: Map<string, TailState> }> {
  const stateMap = new Map<string, TailState>();
  const all: MergedEvent[] = [];
  for (const source of sourceList) {
    const { events, state } = await readNewEvents(initTailState(source));
    stateMap.set(source.runId, state);
    all.push(...events);
  }
  return { eventList: sortMerged(all), stateMap };
}

// ---------------------------------------------------------------------------
// `--since`
// ---------------------------------------------------------------------------

/** `<number><unit>` shorthand `--since` accepts, alongside a plain ISO-8601 instant. */
const RELATIVE_SINCE_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_TO_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses `--since`'s argument into an absolute epoch-milliseconds instant:
 * either a relative shorthand (`15m`, `2h`, `90s`, `1d`) measured back from
 * `nowMs`, or an ISO-8601 instant parsed directly. `undefined` on anything
 * else — the caller reports that as a usage error rather than guessing.
 */
export function parseSince(raw: string, nowMs: number = Date.now()): number | undefined {
  const relative = RELATIVE_SINCE_PATTERN.exec(raw.trim());
  if (relative) {
    const amount = Number.parseInt(relative[1]!, 10);
    const unitMs = UNIT_TO_MS[relative[2]!];
    if (unitMs === undefined || !Number.isFinite(amount)) {
      return undefined;
    }
    return nowMs - amount * unitMs;
  }

  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}
