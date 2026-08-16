/**
 * One run's log is one or more **segments**, and this module is the single
 * place that knows it. Every reader of a run's NDJSON log — `workspace logs`
 * (`log-merge.ts`), `runs tail`, `runs show`/`workspace status`
 * (`../runs/log-summary.ts`) and `runs prune`'s sizing (`../runs/prune.ts`) —
 * enumerates through here rather than opening `log_path` directly, so none of
 * them can silently see only the first segment.
 *
 * ## The naming scheme, restated from where it is fixed
 *
 * `@rawbox/runner`'s `workspace/logs.ts` (`LogRotate`) fixes it:
 *
 * ```
 * <run_id>.ndjson      segment 0 — byte-identical to the single-file layout
 * <run_id>.1.ndjson    segment 1
 * <run_id>.N.ndjson    segment N — the highest-numbered one is live
 * ```
 *
 * **Segment 0 is the OLDEST.** Numbering runs forward, so chronological order
 * is `0, 1, 2, … N` and the *highest* number is the newest, still-growing
 * file. This is the opposite of logrotate's shift-everything-up convention,
 * and it is the whole reason a reader may hold a path across a roll: segment 0
 * keeps today's exact name (so the registry's `log_path` stays correct
 * forever) and no file is ever renamed or truncated.
 *
 * A segment below the highest is **sealed**: complete, immutable, and never
 * appended to again.
 *
 * ## Two states that are normal, not corruption
 *
 * - **A gap at the low end.** Rotation deletes the OLDEST surviving segment
 *   once `maxFiles` is exceeded, so `{2, 3, 4}` with 0 and 1 gone is an
 *   ordinary retained window. A reader must start at the lowest surviving
 *   segment, not assume segment 0 exists.
 * - **No numbered segment at all.** The overwhelmingly common case — a run
 *   that never reached `rotate.maxBytes` — and the one that has to stay cheap.
 *
 * ## Why the common case costs two `stat`s and no directory scan
 *
 * {@link listLogSegments} answers the common case from `stat(<run>.ndjson)`
 * and `stat(<run>.1.ndjson)` alone: segment 0 present and segment 1 absent
 * means unrotated, because rotation only ever deletes from the low end, so a
 * surviving window containing 0 is contiguous from 0 and would contain 1 the
 * moment it contained anything above it. Only when that cheap test comes back
 * ambiguous — segment 1 exists (rotation has happened), or segment 0 is
 * missing (nothing written yet, or a low-end gap) — is the directory read, and
 * then it is read authoritatively, so an arbitrary gap left by something other
 * than rotation is still enumerated correctly rather than silently truncating
 * the run's history.
 *
 * {@link readNewSegmentBytes} does not scan a directory at all on the normal
 * path: it finds the successor of the segment it is on by `stat`ing that one
 * exact path. A poll of an unrotated run therefore costs one `stat` more than
 * it did before segments existed.
 */

import fs from 'node:fs/promises';

import {
  numberedSegmentIndexOf,
  segmentPathFor,
  splitSegmentName,
} from '@rawbox/runner';

/**
 * The naming rule itself lives in `@rawbox/runner`
 * (`workspace/log-segment-path.ts`) because the **sink writes these names** and
 * everything here reads them back; `@rawbox/cli` depends on `@rawbox/runner` and
 * never the reverse, so that is the one package both sides can share. Keeping a
 * second copy here would be a scheme that can drift, and it would drift
 * silently: a reader looking for a name the writer never produces just shows a
 * rotated run's oldest events and stops.
 *
 * Re-exported so this module stays the single import every reader in the CLI
 * uses for segments — what changed is where the spelling is defined, not who
 * asks for it.
 */
export { segmentPathFor };

/**
 * Where a reader currently stands in one run's segment sequence.
 *
 * This is the byte-offset model `TailState` has always used, with the one
 * field it was missing: `offset` counts bytes of **`segment`**, not of
 * `log_path`. For an unrotated run `segment` is `0` forever and the two are
 * the same thing.
 */
export interface SegmentCursor {
  /** `0` for `<run_id>.ndjson`, `N` for `<run_id>.N.ndjson`. */
  readonly segment: number;
  /** Bytes of that segment already read, whether or not they formed complete lines. */
  readonly offset: number;
}

/** Where every reader starts: the oldest segment, from byte zero. */
export const INITIAL_SEGMENT_CURSOR: SegmentCursor = { segment: 0, offset: 0 };

/** Size in bytes, or `undefined` when the file is not there. */
async function sizeOfFile(filePath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(filePath)).size;
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return (await sizeOfFile(filePath)) !== undefined;
}

/**
 * Every segment index of `logPath` actually on disk, ascending — the
 * authoritative but expensive answer, one `readdir` of the containing
 * directory.
 *
 * Sorted **numerically**: `[9, 10]`, never the lexicographic `['10', '9']`
 * that a sort on filenames would give.
 *
 * An unreadable directory answers `[]` rather than throwing, matching every
 * other reader in this area — a run whose log directory does not exist yet is
 * "nothing to read", not an error.
 */
async function scanSegmentIndexList(logPath: string): Promise<number[]> {
  const { directory, base, stem, extension } = splitSegmentName(logPath);

  let entryList: string[];
  try {
    entryList = await fs.readdir(directory);
  } catch {
    return [];
  }

  const indexList: number[] = [];
  for (const entry of entryList) {
    if (entry === base) {
      indexList.push(0);
      continue;
    }
    const index = numberedSegmentIndexOf(entry, stem, extension);
    if (index !== undefined) {
      indexList.push(index);
    }
  }
  return indexList.sort((a, b) => a - b);
}

/**
 * Every segment of `logPath` that exists, as full paths in **chronological
 * order** — oldest (lowest-numbered) first, the live segment last.
 *
 * Returns `[logPath]` unchanged both when the run never rotated *and* when
 * nothing has been written at all. The second case matters: every caller here
 * already treats a missing log as "no events"/"zero bytes"/"not readable"
 * rather than as an error, and answering `[]` instead would push a new empty
 * case into all of them for no gain.
 *
 * Cheap in the common case — see this module's header for why segment 0
 * present plus segment 1 absent is conclusive.
 */
export async function listLogSegments(logPath: string): Promise<string[]> {
  const [zeroExists, oneExists] = await Promise.all([
    fileExists(logPath),
    fileExists(segmentPathFor(logPath, 1)),
  ]);

  if (zeroExists && !oneExists) {
    return [logPath];
  }

  const indexList = await scanSegmentIndexList(logPath);
  if (indexList.length === 0) {
    return [logPath];
  }
  return indexList.map((index) => segmentPathFor(logPath, index));
}

/** A run of bytes read out of one segment. */
export interface SegmentChunk {
  /** Which segment these bytes came from. */
  readonly segment: number;
  /** The bytes, decoded as UTF-8. May be empty when only the boundary is being reported. */
  readonly text: string;
  /**
   * `true` when the reader has finished with this segment and moved past it:
   * the segment is sealed, `text` carries the last bytes it will ever produce,
   * and anything left unterminated at its end is unterminated for good.
   */
  readonly sealed: boolean;
}

/**
 * Reads whatever has been appended since `cursor`, following the run across
 * segment boundaries, and returns the bytes as one chunk per segment plus the
 * cursor to poll from next.
 *
 * **Why no event can be read twice.** The cursor is `(segment, offset)` and
 * both only ever move forward: within a segment `offset` advances to exactly
 * the size that was read, and a boundary is crossed only by setting `offset`
 * back to `0` *for a strictly higher `segment`*. A given byte of a given
 * segment is therefore handed out at most once, whatever the poll interval.
 *
 * **Why no event can be skipped.** Before leaving a segment, this drains it
 * *again*. The successor file is created only after the writer has finished
 * with its predecessor, so observing segment `N+1` proves segment `N` is final
 * — and the second drain, which happens after that observation, is guaranteed
 * to see every byte `N` will ever hold. Without it there is a real race: bytes
 * appended to `N` between the first drain and the boundary check would be
 * stepped over and lost.
 *
 * A missing current segment is not an error. It means either that nothing has
 * been written yet (stay put, report nothing) or that rotation deleted the
 * segment being read out from under the reader (advance to the lowest
 * surviving segment above it) — the one case that needs the directory, and the
 * only one that pays for it.
 */
export async function readNewSegmentBytes(
  logPath: string,
  cursor: SegmentCursor,
): Promise<{ chunkList: SegmentChunk[]; cursor: SegmentCursor }> {
  const chunkList: SegmentChunk[] = [];
  let current = cursor;

  // Terminates because every iteration either breaks or strictly increases
  // `current.segment`, which is bounded by the highest segment on disk.
  for (;;) {
    const segmentPath = segmentPathFor(logPath, current.segment);
    const size = await sizeOfFile(segmentPath);

    if (size === undefined) {
      // Either nothing written yet, or this segment was retired beneath us.
      const indexList = await scanSegmentIndexList(logPath);
      // Having already consumed bytes here, the same index cannot be the
      // answer twice — a re-created file at this index would replay them.
      const lowestAllowed = current.offset > 0 ? current.segment + 1 : current.segment;
      const next = indexList.find(
        (index) => index >= lowestAllowed && index !== current.segment,
      );
      if (next === undefined) {
        break;
      }
      // Report the boundary even with no bytes: a caller holding a partial
      // line from this now-vanished segment needs to know it will never be
      // completed.
      chunkList.push({ segment: current.segment, text: '', sealed: true });
      current = { segment: next, offset: 0 };
      continue;
    }

    let text = '';
    if (size > current.offset) {
      text = await readRange(segmentPath, current.offset, size - current.offset);
      current = { segment: current.segment, offset: size };
    }

    if (!(await fileExists(segmentPathFor(logPath, current.segment + 1)))) {
      if (text.length > 0) {
        chunkList.push({ segment: current.segment, text, sealed: false });
      }
      break;
    }

    // The successor exists, so this segment is sealed — drain the remainder
    // before stepping over it (see this function's doc).
    const finalSize = await sizeOfFile(segmentPath);
    if (finalSize !== undefined && finalSize > current.offset) {
      text += await readRange(segmentPath, current.offset, finalSize - current.offset);
      current = { segment: current.segment, offset: finalSize };
    }
    chunkList.push({ segment: current.segment, text, sealed: true });
    current = { segment: current.segment + 1, offset: 0 };
  }

  return { chunkList, cursor: current };
}

async function readRange(filePath: string, offset: number, length: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return buffer.toString('utf-8');
  } finally {
    await handle.close();
  }
}
