/**
 * The segment naming scheme, in both directions, in one place.
 *
 * `workspace/logs.ts` ({@link LogRotate}) states the rule normatively:
 *
 * ```
 * <run_id>.ndjson      segment 0 — the oldest, and the name the run registry's
 *                      `log_path` records forever
 * <run_id>.1.ndjson    segment 1
 * <run_id>.N.ndjson    segment N — the highest-numbered one is live
 * ```
 *
 * This module is the executable form of that rule, and it lives in
 * `@rawbox/runner` because **both sides of it need to agree byte for byte**:
 * `events/ndjson-file-sink.ts` *writes* these names, and `@rawbox/cli`'s
 * `workspace/log-segments.ts` *reads* them back (as does `runs prune`, `runs
 * tail`, `workspace logs`). `@rawbox/cli` depends on `@rawbox/runner` and never
 * the reverse, so this is the only package the two can share — a second copy on
 * the CLI side would be a naming scheme that can drift, and the failure it
 * drifts into is silent: a writer producing `<run>.1.ndjson` and a reader
 * looking for `<run>.ndjson.1` simply shows a rotated run's oldest events and
 * stops.
 *
 * {@link segmentPathFor} and {@link numberedSegmentIndexOf} are exact inverses
 * and are kept adjacent for that reason.
 *
 * Nothing here touches the filesystem. Enumerating what actually exists is the
 * caller's job — asynchronously through `listLogSegments` for the readers, once
 * per run through a synchronous scan for the sink.
 */

import path from 'node:path';

/**
 * `.1`, `.2`, `.10` — never `.0` (segment 0 carries no numeric suffix at all)
 * and never `.01`, so one segment has exactly one spelling.
 */
const SEGMENT_SUFFIX_PATTERN = /^[1-9][0-9]*$/;

/** `logPath` split into the parts the naming rule is expressed against. */
export interface SegmentNameParts {
  /** The containing directory. */
  readonly directory: string;
  /** The full filename of segment 0 — `logPath`'s basename. */
  readonly base: string;
  /** `base` without its last extension: `run-1`, or `run-1.error` for an error log. */
  readonly stem: string;
  /** The last extension, dot included — `.ndjson` — or `''` when there is none. */
  readonly extension: string;
}

/**
 * Splits `logPath` at its **last** extension.
 *
 * Last rather than first is what keeps the two sequences of one run apart:
 * `run-1.error.ndjson` has stem `run-1.error`, so its segments are
 * `run-1.error.N.ndjson` and can never collide with the main log's
 * `run-1.N.ndjson`.
 */
export function splitSegmentName(logPath: string): SegmentNameParts {
  const directory = path.dirname(logPath);
  const base = path.basename(logPath);
  const extension = path.extname(base);
  const stem = extension.length > 0 ? base.slice(0, -extension.length) : base;
  return { directory, base, stem, extension };
}

/**
 * The path of one segment of `logPath`.
 *
 * Segment 0 is `logPath` itself, unchanged — that identity is what keeps a
 * registry entry written before rotation existed valid after it, and what lets
 * a reader hold a path across a roll. Higher segments insert `.N` before the
 * last extension.
 */
export function segmentPathFor(logPath: string, segment: number): string {
  if (segment === 0) {
    return logPath;
  }
  const { directory, stem, extension } = splitSegmentName(logPath);
  return path.join(directory, `${stem}.${segment}${extension}`);
}

/**
 * The segment index a directory entry names, or `undefined` when it belongs to
 * some other file entirely. The exact inverse of {@link segmentPathFor} for
 * every segment above 0; segment 0 is `base` itself and is matched by the
 * caller, since equality needs no parsing.
 *
 * This is what keeps another run's logs, and the error log of *this* run, out
 * of the main log's enumeration: the entry must be exactly
 * `<stem>.<digits><extension>`. `<run_id>.error.ndjson` fails on `error` not
 * being digits; `<run_id>.error.3.ndjson` fails because it does not end at
 * `<run_id>.<digits>.ndjson`; and a run id that is a prefix of another
 * (`run-1` vs `run-12`) is excluded by the mandatory `.` after the stem.
 */
export function numberedSegmentIndexOf(
  entry: string,
  stem: string,
  extension: string,
): number | undefined {
  if (!entry.startsWith(`${stem}.`) || !entry.endsWith(extension)) {
    return undefined;
  }
  const middle = entry.slice(stem.length + 1, entry.length - extension.length);
  if (!SEGMENT_SUFFIX_PATTERN.test(middle)) {
    return undefined;
  }
  const parsed = Number.parseInt(middle, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
