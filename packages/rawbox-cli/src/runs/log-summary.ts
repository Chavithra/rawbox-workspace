/**
 * A short summary of a run's NDJSON log — event counts, the last event, the
 * last error — for `runs show <run-id>` (OBSERVABILITY.md, "CLI surfaces").
 *
 * Read-only and line-oriented: this never touches the registry's own status,
 * only the file the run itself wrote (`@rawbox/runner`'s
 * `createNdjsonFileSink`). A malformed or half-written line — a run killed
 * mid-`appendFileSync` — is skipped, never thrown, matching the log format's
 * own "one bad line breaks only that line" posture.
 *
 * "The file" is a sequence of segments for a run that rotated, and both
 * summaries below read all of them through the one enumerator
 * (`../workspace/log-segments.js`). This is not cosmetic: `eventCounts` and
 * `stepsOk`/`stepsFailed` are whole-run totals that `runs show` and
 * `workspace status` print as such, so reading only `<run_id>.ndjson` would
 * under-report them with no indication anything was missing — and `lastEvent`
 * would be stale by a whole segment, which for `workspace status`'s "what is
 * this run doing right now" is the wrong answer rather than a partial one.
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import readline from 'node:readline';

import { listLogSegments } from '../workspace/log-segments.js';

/** The last error-shaped line of a run's error log, reduced to what a summary needs. */
export interface RunLastError {
  ts?: string;
  event?: string;
  message: string;
}

export interface RunLogSummary {
  /** How many lines of the main log parsed as JSON, per `event` kind. */
  eventCounts: Record<string, number>;
  /** Total parseable lines — `sum(eventCounts)`, kept alongside it for convenience. */
  totalEvents: number;
  /** The last successfully parsed line of the main log. */
  lastEvent?: Record<string, unknown>;
  /** The last line of the error log, when one exists and is readable. */
  lastError?: RunLastError;
  /** `false` when the main log could not be opened at all (never written, or removed). */
  readable: boolean;
  /**
   * How many step executions succeeded — used by `workspace status`
   * (OBSERVABILITY.md, "CLI surfaces"). Taken from `run.end`'s
   * `steps_total - steps_failed` when a `run.end` was found; counted directly
   * from `step.end outcome: "ok"` lines otherwise. See the long comment in
   * `summarizeRunLog` for why those two are the same number and why the
   * `run.end` figure is still preferred.
   */
  stepsOk: number;
  /**
   * How many step executions failed. Taken from `run.end`'s `steps_failed`
   * when one was found; counted from `step.end outcome: "error"` lines
   * otherwise.
   */
  stepsFailed: number;
}

function messageOf(event: Record<string, unknown>): string {
  if (typeof event['message'] === 'string') {
    return event['message'];
  }
  const errorField = event['error'];
  if (
    typeof errorField === 'object' &&
    errorField !== null &&
    typeof (errorField as Record<string, unknown>)['message'] === 'string'
  ) {
    return (errorField as Record<string, unknown>)['message'] as string;
  }
  try {
    return JSON.stringify(event);
  } catch {
    return String(event);
  }
}

async function readLastJsonLineOfFile(
  filePath: string,
): Promise<Record<string, unknown> | undefined> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }

  const lineList = content.split('\n').filter((line) => line.length > 0);
  for (let index = lineList.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lineList[index]!) as Record<string, unknown>;
    } catch {
      // Skip a truncated/corrupt trailing line and try the one before it.
    }
  }
  return undefined;
}

/**
 * The last parseable line of a log, searching its segments **newest-first**.
 *
 * Walking backwards is what makes this correct across a rotation: the last
 * error a run reported lives in its highest-numbered error segment, and the
 * older ones are consulted only when the newest holds nothing readable — the
 * same "skip a corrupt line and try the one before it" fallback, one level up.
 */
async function readLastJsonLine(logPath: string): Promise<Record<string, unknown> | undefined> {
  const segmentList = await listLogSegments(logPath);
  for (let index = segmentList.length - 1; index >= 0; index -= 1) {
    const parsed = await readLastJsonLineOfFile(segmentList[index]!);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * @param logFilePath - The run's main NDJSON log — segment 0's path, which is
 *   the registry's `log_path`; every segment of it is read, oldest-first.
 * @param errorLogFilePath - The run's filtered error log, when the registry
 *   entry names one. Its own absence (never written — a run with no
 *   failures) is not an error. Its segments are enumerated independently of
 *   the main log's.
 */
export async function summarizeRunLog(
  logFilePath: string,
  errorLogFilePath?: string,
): Promise<RunLogSummary> {
  const eventCounts: Record<string, number> = {};
  let lastEvent: Record<string, unknown> | undefined;
  let totalEvents = 0;
  let readable = false;
  let stepsOk = 0;
  let stepsFailed = 0;

  // Whichever `run.end` line is encountered while walking the segments below —
  // there should only ever be one, since `run.end` is the run's last event by
  // construction, but a hand-built or corrupted fixture could in principle
  // carry more than one, and taking the last-seen one (rather than refusing to
  // choose) matches this file's general posture of degrading gracefully
  // instead of throwing. `undefined` here means "no `run.end` seen with
  // numeric `steps_total`/`steps_failed`", which is also what a `run.end`
  // whose line failed to parse those fields as numbers collapses to — both
  // read as "fall back to counting", not as a hard error.
  let runEndSteps: { total: number; failed: number } | undefined;

  // Oldest segment first, so `lastEvent` ends up being the newest event of the
  // newest segment — the same thing it meant when a run was one file.
  for (const segmentPath of await listLogSegments(logFilePath)) {
    let stream: fsSync.ReadStream | undefined;
    try {
      stream = fsSync.createReadStream(segmentPath, { encoding: 'utf-8' });
    } catch {
      stream = undefined;
    }

    if (stream === undefined) {
      continue;
    }

    try {
      const lineReader = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lineReader) {
        if (line.length === 0) {
          continue;
        }
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        readable = true;
        totalEvents += 1;
        const kind = typeof parsed['event'] === 'string' ? (parsed['event'] as string) : 'unknown';
        eventCounts[kind] = (eventCounts[kind] ?? 0) + 1;
        lastEvent = parsed;
        if (kind === 'step.end') {
          // This counting pass is the fallback, kept alive below for a run
          // that never wrote a `run.end` — still running, or dead without one
          // (OBSERVABILITY.md: a missing `run.end` means "the process died",
          // not "the run failed", and that is exactly the case a summary must
          // still answer for). It has the rotation bug the module header
          // warns about in miniature: a `step.end` from a segment that has
          // since been retired by `logs.rotate.maxFiles` is gone from this
          // count with no trace it ever existed. `run.end`'s own totals,
          // handled below, don't have that problem — they were computed by
          // the producer over the *whole* run before any segment could be
          // unlinked — which is why they are preferred whenever present.
          if (parsed['outcome'] === 'error') {
            stepsFailed += 1;
          } else if (parsed['outcome'] === 'ok') {
            stepsOk += 1;
          }
        } else if (kind === 'run.end') {
          // `run.end`'s `steps_total`/`steps_failed` (`event-types.ts`,
          // `RunEndEvent`) are authoritative: the producer accumulates them
          // over every `step.end` it ever emitted, so unlike the count above
          // they survive rotation untouched. Grabbed here rather than at the
          // end of the function specifically so a `run.end` that lands in a
          // *later* segment than some of its `step.end`s — an ordinary
          // outcome of walking segments oldest-first — is still picked up:
          // this loop runs to completion over every segment before anything
          // downstream reads `runEndSteps`.
          const total = parsed['steps_total'];
          const failed = parsed['steps_failed'];
          if (typeof total === 'number' && typeof failed === 'number') {
            runEndSteps = { total, failed };
          }
        }
      }
    } catch {
      // A stream error mid-read still leaves whatever was gathered so far —
      // and, now, still lets the remaining segments be read.
    }
  }

  // Prefer `run.end`'s own totals over the `step.end` count gathered above,
  // for the reason recorded beside that count: rotation can retire a segment
  // out from under the counting pass, but never out from under a total the
  // producer already published.
  //
  // `stepsFailed` is `run.end`'s `steps_failed` directly — same meaning, same
  // number, nothing to derive. `stepsOk` takes more care: it would be tempting
  // to write it as `runEndSteps.total - runEndSteps.failed` and stop there,
  // but that is only correct because of a fact this file must not assume
  // silently — a `step.end` never carries `outcome: "interrupted"`.
  // `event-types.ts` gives `step.end` the two-value `Outcome` type (`ok` |
  // `error`) and reserves the three-value `RunOutcome` (adding `interrupted`)
  // for `run.end` alone; its `OUTCOME` doc is explicit that `interrupted` is
  // "never a `step.end` outcome" — an in-flight step abandoned by an operator
  // interrupt gets no `step.end` at all; the run's own `run.end` records the
  // interruption instead. So `steps_total` (every `step.end` this run
  // produced) splits exactly two ways, `ok` and `error`, with no third bucket
  // to fold in — `steps_total - steps_failed` and "count of `outcome: ok`"
  // are the same quantity by construction, not by coincidence. If a future
  // change ever gives `step.end` a third outcome, this subtraction becomes
  // wrong silently; the fix is to have the producer publish `steps_ok`
  // alongside `steps_failed` on `run.end` rather than to keep deriving it here.
  if (runEndSteps !== undefined) {
    stepsFailed = runEndSteps.failed;
    stepsOk = runEndSteps.total - runEndSteps.failed;
  }

  const lastErrorRaw = errorLogFilePath ? await readLastJsonLine(errorLogFilePath) : undefined;
  const lastError: RunLastError | undefined = lastErrorRaw
    ? {
        ...(typeof lastErrorRaw['ts'] === 'string' ? { ts: lastErrorRaw['ts'] as string } : {}),
        ...(typeof lastErrorRaw['event'] === 'string' ? { event: lastErrorRaw['event'] as string } : {}),
        message: messageOf(lastErrorRaw),
      }
    : undefined;

  return {
    eventCounts,
    totalEvents,
    ...(lastEvent === undefined ? {} : { lastEvent }),
    ...(lastError === undefined ? {} : { lastError }),
    readable,
    stepsOk,
    stepsFailed,
  };
}
