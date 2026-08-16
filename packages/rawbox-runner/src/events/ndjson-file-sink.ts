/**
 * The NDJSON sinks — one `JSON.stringify`d event per line.
 *
 * This module is what puts the run-event stream on disk: the CLI names the
 * default files `.rawbox/logs/<workflow name>/<run-id>.ndjson`, and an embedder
 * that calls `runWorkflowInstance` with its own log paths gets files at the
 * paths it chose (OBSERVABILITY.md, "The run-event stream"). It is one sink among several —
 * the terminal renderer and the OTel bridge consume the same stream
 * — one producer, N sinks. The file sink is always registered **first**, so
 * caller-supplied sinks add observers rather than replacing the files. The
 * *format* below is the normative one; only who chooses the paths varies by
 * caller.
 *
 * Two files, one schema. The error log is a **filtered view** of the main log,
 * never a third format: it receives every event whose `outcome` is `"error"`
 * plus every `bootstrap.error`. A tool that reads the main log can read the
 * error log with the same parser.
 *
 * The main log has one dial on *how much* of a step event it keeps —
 * `logs.steps:` / {@link STEP_DETAIL} — and the error log has none, by design.
 * See the "`logs.steps`" section below.
 *
 * {@link createNdjsonStdoutSink} writes that same stream to a file descriptor
 * instead of a file — fd 1 for `@rawbox/cli`'s `--output ndjson`, so a run
 * under systemd or Docker hands its log stack the event stream directly. Same
 * writer, same bytes, no second format.
 *
 * ## The writer
 *
 * Lines go through `pino.destination()` — pino as a **destination, not a
 * logger**. Nothing here constructs a `pino()` logger or calls `logger.info()`:
 * the envelope (OBSERVABILITY.md, "Envelope") is normative and these events are
 * already fully-formed typed objects, so a logger would only inject `level`,
 * `time`, `pid`, `hostname` and a `msg` wrapper for this module to then
 * neutralise. What the destination is taken for is the writing:
 *
 * - **one open file descriptor per segment**, held for as long as that segment
 *   is the live one — one `write` syscall per event, where `appendFileSync`
 *   cost three (open, write, close). For the overwhelming majority of runs,
 *   which never reach `rotate.maxBytes`, that is one descriptor for the run;
 * - **partial-write and `EAGAIN`/`EBUSY` retry handling**, which a hand-rolled
 *   persistent-fd writer would have to get right and which is precisely what
 *   keeps a half-written line out of the file;
 * - **`sync: true | false` as one flag**, which is exactly the shape
 *   `logs.async` (`workspace/logs.ts`) needs.
 *
 * The descriptor is opened by this module with `openSync` rather than left to
 * SonicBoom's own path handling, for two reasons: an open failure is then a
 * synchronous throw this module can turn into its own diagnostic, and `fd` is
 * set the instant the destination exists, so `flushSync()` is valid
 * immediately — SonicBoom's asynchronous `open` would leave it throwing "sonic
 * boom is not ready yet" for the first turns of a run, which is exactly when a
 * fast-failing run needs its lines.
 *
 * It is opened **lazily, on the first line that file receives**, which is what
 * keeps the on-disk footprint identical to the `appendFileSync` era: a run with
 * no failures still leaves no `<run-id>.error.ndjson` behind, rather than an
 * empty one. That lazy open is also the seam rotation grew from — switching
 * segments mid-run is closing one descriptor and opening the next, and it is
 * what lets recovery (which segment does this writer append to?) cost nothing
 * for a file that never receives a line.
 *
 * ## Rotation
 *
 * One run's log is one or more **segments** — `<run-id>.ndjson`,
 * `<run-id>.1.ndjson`, … — and this module is what produces them. The scheme is
 * fixed by `workspace/logs.ts` ({@link LogRotate}) and spelled by
 * `workspace/log-segment-path.ts`, which `@rawbox/cli`'s readers import so that
 * writer and reader cannot drift; the rules that matter here are that **segment
 * 0 is the oldest**, that numbering runs forward so the highest-numbered
 * segment is the live one, and that a segment is **never renamed, truncated or
 * reopened** once superseded.
 *
 * Rotation is **on by default** ({@link LOG_ROTATE_DEFAULT_MAX_BYTES} *
 * {@link LOG_ROTATE_DEFAULT_MAX_FILES}), so a sink built with no options
 * rotates. Only a file target rotates: a descriptor target (`--output ndjson`,
 * fd 1) is a stream someone else owns, has no size to bound and no successor to
 * open.
 *
 * Three properties are load-bearing, and each costs something in the code
 * below:
 *
 * - **A segment ends at a line boundary.** The bound is checked *between*
 *   lines, against a byte count kept in process, so a segment may exceed
 *   `maxBytes` by the length of its last line and never splits one. A reader
 *   treats an unterminated line in a sealed segment as damage and drops it, so
 *   a mid-line split would silently lose an event.
 * - **The successor is created only once the predecessor is complete on disk.**
 *   That is what lets a reader conclude "segment N+1 exists, so segment N is
 *   final" — see `@rawbox/cli`'s `readNewSegmentBytes`. In synchronous mode it
 *   is free: every line is already written. In buffered mode it is the reason
 *   the seal is *asynchronous* (see {@link createLineWriter}).
 * - **The oldest segment is deleted, never the live one.** `maxFiles` counts
 *   the segments of one run that survive; `maxFiles: 1` therefore keeps the
 *   live segment alone.
 *
 * ### The `log.rotate` marker and its re-entrancy
 *
 * {@link NdjsonSinkOptions.onSegmentRotate}, when supplied, is called once per
 * roll of the **main** log — never the error log, see {@link
 * createNdjsonFileSink} — with enough to build `event-types.ts`'s
 * `log.rotate` event: which segment sealed, which is now live, which segment
 * (if any) was actually unlinked to honour `maxFiles`, and the bounds in
 * force. The caller (`producer.ts`'s `logRotate`) turns that into a real event
 * and emits it through the normal producer, which is what reaches every sink,
 * not only this file — see that method's doc for why routing through the
 * producer, rather than writing the marker's bytes directly and only into
 * this file, is the right call.
 *
 * The hook fires from inside {@link open}, synchronously, the instant the new
 * segment's descriptor exists and `enforceMaxFiles` has run — which is before
 * a single byte of real content has been written to it. If the caller's
 * `onSegmentRotate` ends up calling back into *this very sink* (which it
 * does: the producer fans the event out to every registered sink, and this
 * one is among them), that reentrant call finds `destination` already
 * assigned (set immediately before `enforceMaxFiles` runs, above) and
 * `liveBytes` still `0`, so it takes the fast path in {@link open}, skips the
 * `maxBytes` check (`liveBytes > 0` guards it, exactly as it does for an
 * oversized line), and writes the marker whole. Control then returns up
 * through the reentrant call and back to whichever `appendLine` triggered the
 * roll in the first place — the sync-mode caller's own retry, or the
 * buffered-mode seal's `drainPendingLines` — which writes the line that
 * necessitated (or was queued behind) the roll *after* the marker. That is
 * the entire mechanism that makes `log.rotate` the segment's first line: no
 * microtask, no deferral, and no unbounded recursion, because the marker's
 * own write can never itself trigger another roll (an empty segment never
 * rotates) and `pendingRotationSeal` is cleared *before* `onSegmentRotate` is
 * called, so a third nested `open()` call — should one somehow occur — finds
 * nothing pending and does nothing extra.
 *
 * `tests/ndjson-rotation.test.ts` pins this: a burst that crosses several
 * segment boundaries in one synchronous loop, and the same burst again in
 * buffered mode, both come back with the marker as segment N's first line,
 * every other line intact and in order, and no stack overflow.
 */

import fsSync from 'node:fs';
import path from 'node:path';

import pino from 'pino';

import { getErrorMessage } from '../utils/error.js';
import {
  numberedSegmentIndexOf,
  segmentPathFor,
  splitSegmentName,
} from '../workspace/log-segment-path.js';
import {
  LOG_ROTATE_DEFAULT_MAX_BYTES,
  LOG_ROTATE_DEFAULT_MAX_FILES,
  type ResolvedLogRotate,
} from '../workspace/logs.js';
import { RUN_EVENT, OUTCOME, type RunEvent } from './event-types.js';
import type { RunEventSink } from './sink.js';

/**
 * What `pino.destination()` hands back — a SonicBoom, used purely as a line
 * writer. Named through `ReturnType` rather than imported from `sonic-boom`,
 * which is pino's dependency and not this package's to reach into.
 */
type NdjsonDestination = ReturnType<typeof pino.destination>;

/**
 * `minLength` for an asynchronous destination: bytes buffered before a write is
 * issued.
 *
 * `sync: false` on its own does **not** buffer — SonicBoom issues one
 * `fs.write` per `write()` whenever `minLength` is `0`, so the syscall count
 * would be unchanged and only the blocking would go away. `logs.async`
 * promises a throughput trade (`workspace/logs.ts`), and this is the field that
 * actually makes it one. 4096 is one filesystem block, and must stay below
 * SonicBoom's 16 KiB `maxWrite` or the destination refuses to construct.
 */
const ASYNC_MIN_LENGTH = 4096;

/** `minLength` for a synchronous destination: never buffer, write every line. */
const SYNC_MIN_LENGTH = 0;

/**
 * True when an event belongs in the error log.
 *
 * Deliberately structural — `outcome: "error"` or the bootstrap kind — rather
 * than a list of kinds, so a future kind carrying an outcome is filtered
 * correctly the day it is added.
 *
 * **Not** a `severity` threshold, though OBSERVABILITY.md, "`severity`" makes
 * that look equivalent. It is not: a `log` event whose handler chose
 * `level: "error"` carries `severity: "error"` (`event-types.ts`,
 * {@link LogEvent}) while carrying no `outcome` at all, so a threshold would
 * pull workflow-authored log lines into a file documented above as "every event
 * whose `outcome` is `"error"` plus every `bootstrap.error`" — a *run* failure
 * record. §1.3 says as much in its own first line: severity "classifies an
 * event for alerting; it is not the log level a handler chose". The two
 * predicates disagree on exactly that kind, and `tests/ndjson-sink.test.ts`
 * pins the disagreement so nobody later "simplifies" this into the threshold.
 */
function isFailureEvent(event: RunEvent): boolean {
  if (event.event === RUN_EVENT.BOOTSTRAP_ERROR) {
    return true;
  }
  return 'outcome' in event && event.outcome === OUTCOME.ERROR;
}

/**
 * What {@link NdjsonSinkOptions.onSegmentRotate} is called with, once per roll
 * of the main log — see this module's "The `log.rotate` marker" section.
 */
export interface SegmentRotationInfo {
  /** The segment that was just sealed. */
  readonly sealedSegment: number;
  /** The segment now live — about to receive the marker as its first line. */
  readonly liveSegment: number;
  /**
   * The segment unlinked to honour `maxFiles`, when the unlink succeeded.
   * `undefined` when the roll retired nothing, or when the one retirement
   * attempted failed — that failure is already reported on `console.error`
   * by the writer, so this field simply stays honest rather than claiming a
   * removal that did not happen.
   */
  readonly deletedSegment: number | undefined;
  readonly maxBytes: number;
  readonly maxFiles: number;
}

/** Where one {@link LineWriter} sends its bytes. */
type WriterTarget =
  | {
      readonly kind: 'file';
      /** Segment 0's path — the name the run registry's `log_path` records. */
      readonly filePath: string;
      readonly rotate: ResolvedLogRotate;
    }
  | { readonly kind: 'descriptor'; readonly fd: number; readonly label: string };

/**
 * Every segment index of `logPath` currently on disk, ascending — segment 0
 * included, as index `0`.
 *
 * Synchronous, and read exactly **once per file writer**, at the first line it
 * receives: the sink's `write` is synchronous, and the answer is only needed to
 * decide which segment to append to. The readers' equivalent
 * (`@rawbox/cli`'s `listLogSegments`) is asynchronous and polled, so it pays for
 * a two-`stat` fast path; one `readdir` per run does not need one.
 *
 * An unreadable directory answers `[]` — "no segments known" — which lands the
 * writer on segment 0, exactly where it wrote before rotation existed. Failing
 * the run over a directory listing would violate this module's whole contract.
 */
function existingSegmentIndexList(logPath: string): number[] {
  const { directory, base, stem, extension } = splitSegmentName(logPath);
  let entryList: string[];
  try {
    entryList = fsSync.readdirSync(directory);
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
 * One destination's worth of writing, with every failure mode already absorbed.
 *
 * Every method is best-effort and none throws: a broken log destination has no
 * business failing a run.
 */
interface LineWriter {
  /** False once this destination has been disabled or closed. */
  isUsable(): boolean;
  /** Appends one complete line (trailing `\n` included). */
  write(line: string): void;
  /** Makes everything written so far durable, synchronously. */
  flushSync(): void;
  /** Drains a buffered destination, waiting for the write to land. */
  flush(): Promise<void>;
  /** Flushes and releases the descriptor. */
  close(): Promise<void>;
}

/**
 * Builds a {@link LineWriter} over one target.
 *
 * ## How a segment's size is known
 *
 * `liveBytes` is a running count of what this writer has put in the live
 * segment, seeded from `fstat` at the one moment the descriptor is opened and
 * advanced by `Buffer.byteLength(line)` per line. There is no `stat` per line
 * and no reliance on SonicBoom having written anything yet: the bound is about
 * the bytes this writer has *committed* to that segment, buffered or not, which
 * is exactly what will end up in the file.
 *
 * ## How a segment is sealed, and why the two modes differ
 *
 * Sealing must leave the segment **complete on disk before its successor
 * exists** — the readers' "segment N+1 exists, therefore N is final" rule.
 *
 * In synchronous mode that is already true: every line went through
 * `fs.writeSync`, so the writer simply stops using the descriptor and opens the
 * next one.
 *
 * In buffered mode it is not, and the obvious seal is **wrong**. `flushSync()`
 * declines to touch a chunk that is already in flight (`sonic-boom`'s own
 * guard) and writes the *later* buffered chunks synchronously past it, so the
 * in-flight bytes land after them: the sealed segment ends up with its lines
 * out of order. That is not theoretical — a burst of lines keeps a write in
 * flight for the whole burst, which is precisely when a segment fills — and it
 * is the same window `createNdjsonSink` documents for `run.end`'s `flushSync`,
 * except that here it would corrupt a file that is never appended to again.
 *
 * So a buffered seal is **asynchronous**: `end()` drains whatever is buffered
 * to the segment's own descriptor, in SonicBoom's order, and closes it. Lines
 * emitted while that is in flight are held in `pendingLineList` and written to
 * the successor once the predecessor has closed — which is also the moment the
 * successor file is first created, so the readers' rule holds by construction.
 * `flush()` and `close()` wait for a seal in progress, and the producer awaits
 * both at the end of every run (`sink.ts`), so nothing is left pending. The one
 * gap this leaves is `run.end`'s synchronous flush landing *during* a seal:
 * the pending lines are not yet durable at that instant, and the ordered
 * `flush()` immediately after it is what makes them so. That is a narrower
 * version of the durability window `logs.async` already trades away.
 *
 * @param target - The file or descriptor to write to.
 * @param sync - `true` writes each line with `fs.writeSync` before returning;
 *   `false` buffers and writes asynchronously — `logs.async`'s trade.
 * @param onRotate - Called once per roll, from inside {@link open} — see this
 *   module's "The `log.rotate` marker" section. `undefined` for a target that
 *   should stay silent about its own rolls (the error log).
 */
function createLineWriter(
  target: WriterTarget,
  sync: boolean,
  onRotate?: (info: SegmentRotationInfo) => void,
): LineWriter {
  const label = target.kind === 'file' ? target.filePath : target.label;

  /**
   * Rotation state, present only for a file target — a descriptor is someone
   * else's stream, with no size to bound and no successor to open.
   */
  const rotation =
    target.kind === 'file'
      ? {
          filePath: target.filePath,
          maxBytes: target.rotate.maxBytes,
          maxFiles: target.rotate.maxFiles,
        }
      : undefined;

  // A file's directory is created once, up front, rather than lazily at the
  // first write, so a run whose log directory does not exist yet — the common
  // case, since `.rawbox/logs/` is machine-owned — still records the bootstrap
  // errors it emits before anything else has had a reason to create it.
  let usable = target.kind === 'file' ? ensureDirectory(target.filePath) : true;
  let destination: NdjsonDestination | undefined;

  /** False until the first open has read the segments already on disk. */
  let segmentsDiscovered = false;
  /** Segment indices believed to exist, ascending; the live one is last. */
  let segmentIndexList: number[] = [];
  /** The segment being appended to. Only ever increases. */
  let liveSegment = 0;
  /** Bytes this writer has committed to the live segment — see this function's doc. */
  let liveBytes = 0;
  /** Set only while a buffered seal is in flight; resolves once it has completed. */
  let sealPromise: Promise<void> | undefined;
  /** Lines that arrived during a seal, in order, awaiting the next segment. */
  let pendingLineList: string[] = [];
  /** Deletion is best-effort, and one broken directory must not shout per roll. */
  let unlinkFailureReported = false;
  /**
   * The segment {@link advanceSegment} just sealed, awaiting the next {@link
   * open} to know whether `maxFiles` retired anything — `undefined` when no
   * roll is in flight (including always, for a writer with no `onRotate`).
   * Cleared *before* {@link onRotate} is called, which is what stops the
   * reentrant `open()` that call triggers from finding anything pending.
   */
  let pendingRotationSeal: number | undefined;

  const disable = (error: unknown): void => {
    if (!usable) {
      return;
    }
    usable = false;
    destination = undefined;
    console.error(
      `[rawbox] failed to write "${label}", further writes disabled: ${getErrorMessage(error)}`,
    );
  };

  /**
   * Deletes the oldest segments until `maxFiles` remain.
   *
   * Called from {@link open}, i.e. once the *successor* is on disk, so the run
   * never has zero segments; and it stops at the live segment, so `maxFiles: 1`
   * retires everything except the file being written rather than that file. A
   * failed unlink drops the index anyway — retrying it on every subsequent roll
   * would report the same broken directory for the rest of the run.
   *
   * @returns Every segment index actually unlinked, ascending — normally at
   *   most one, since `maxFiles` is fixed for a writer's whole life and
   *   {@link segmentIndexList} grows by exactly one per {@link advanceSegment}
   *   call. Returned rather than left implicit so {@link open} can tell
   *   {@link onRotate} which segment (if any) `log.rotate`'s `deleted_segment`
   *   should name — a failed unlink is *not* in this list, so that field
   *   never claims a removal that did not happen.
   */
  const enforceMaxFiles = (): number[] => {
    if (rotation === undefined) {
      return [];
    }
    const deletedList: number[] = [];
    while (segmentIndexList.length > rotation.maxFiles) {
      const oldest = segmentIndexList[0];
      if (oldest === undefined || oldest === liveSegment) {
        return deletedList;
      }
      segmentIndexList.shift();
      try {
        fsSync.unlinkSync(segmentPathFor(rotation.filePath, oldest));
        deletedList.push(oldest);
      } catch (error) {
        if (!unlinkFailureReported) {
          unlinkFailureReported = true;
          console.error(
            `[rawbox] failed to retire an old log segment of "${rotation.filePath}", ` +
              `keeping it: ${getErrorMessage(error)}`,
          );
        }
      }
    }
    return deletedList;
  };

  /** The destination for the live segment, opened on demand, or `undefined` once disabled. */
  const open = (): NdjsonDestination | undefined => {
    if (!usable) {
      return undefined;
    }
    if (destination !== undefined) {
      return destination;
    }
    try {
      let fd: number;
      if (target.kind === 'file') {
        // Recovery, done once: a log directory may already hold segments of
        // this path (a crashed run, or a test that laid them down), and this
        // writer appends to the **highest** one rather than to segment 0 —
        // nothing is ever renamed, truncated or overwritten, and segment 0
        // stays the name the registry recorded. Whether that segment is
        // already over `maxBytes` needs no special case: `liveBytes` below is
        // its real size, so the ordinary between-lines check rotates on the
        // first line rather than on the second. A run that emits nothing still
        // leaves no new file behind, because this whole path is lazy.
        if (!segmentsDiscovered) {
          segmentsDiscovered = true;
          const indexList = existingSegmentIndexList(target.filePath);
          liveSegment = indexList[indexList.length - 1] ?? 0;
          segmentIndexList = indexList.length > 0 ? indexList : [0];
        }
        fd = fsSync.openSync(segmentPathFor(target.filePath, liveSegment), 'a');
        liveBytes = fsSync.fstatSync(fd).size;
      } else {
        fd = target.fd;
      }
      const opened = pino.destination({
        dest: fd,
        sync,
        minLength: sync ? SYNC_MIN_LENGTH : ASYNC_MIN_LENGTH,
      });
      // SonicBoom reports write failures as an `error` event, not a throw, and
      // an EventEmitter with no `error` listener throws the error at the
      // process instead — so this listener is what makes "a broken log
      // disables that file" true rather than "a broken log kills the run".
      // (`pino.destination` installs one of its own ahead of this that
      // swallows EPIPE by neutering the stream, which is what lets
      // `--output ndjson | head -2` end without a diagnostic.)
      opened.on('error', disable);
      destination = opened;
      // After the file exists, never before — see {@link enforceMaxFiles}.
      const deletedList = enforceMaxFiles();
      // Fires exactly once per roll, synchronously — see this module's "The
      // `log.rotate` marker" section for the reentrancy this relies on.
      // Cleared *before* the call so a reentrant `open()` the call triggers
      // (the marker's own write) finds nothing pending.
      if (onRotate !== undefined && pendingRotationSeal !== undefined) {
        const sealedSegment = pendingRotationSeal;
        pendingRotationSeal = undefined;
        // `rotation` is defined here: `pendingRotationSeal` is only ever set
        // by `advanceSegment`, which only a `rotation !== undefined` target
        // ever calls into a seal to reach (see `appendLine`'s guard).
        if (rotation !== undefined) {
          onRotate({
            sealedSegment,
            liveSegment,
            deletedSegment: deletedList[0],
            maxBytes: rotation.maxBytes,
            maxFiles: rotation.maxFiles,
          });
        }
      }
      return opened;
    } catch (error) {
      disable(error);
      return undefined;
    }
  };

  /** Moves the live pointer to the next segment. Its file is created by the next {@link open}. */
  const advanceSegment = (): void => {
    const sealedSegment = liveSegment;
    liveSegment += 1;
    liveBytes = 0;
    segmentIndexList.push(liveSegment);
    if (onRotate !== undefined) {
      pendingRotationSeal = sealedSegment;
    }
  };

  /**
   * Seals the live segment: every byte written to it lands in it, its
   * descriptor is released, and the writer moves on to the next segment.
   *
   * Synchronous for a synchronous destination, deferred for a buffered one —
   * see this function's doc for why the buffered case cannot be done with
   * `flushSync()`.
   */
  const sealLiveSegment = (): void => {
    const stream = destination;
    destination = undefined;
    if (stream === undefined) {
      advanceSegment();
      return;
    }
    if (sync) {
      try {
        stream.flushSync();
      } catch (error) {
        disable(error);
      }
      try {
        stream.end();
      } catch {
        // Best-effort: the bytes are already on disk, this only releases the fd.
      }
      advanceSegment();
      return;
    }
    const closed = new Promise<void>((resolve) => {
      // `close` fires after SonicBoom has drained its buffer to this
      // descriptor, fsynced it and closed it — the point at which the segment
      // is genuinely final. `error` resolves too: `disable` (attached at open)
      // has already reported it, and a seal that can never finish must not
      // hang the run's shutdown.
      stream.once('close', () => resolve());
      stream.once('error', () => resolve());
      try {
        stream.end();
      } catch (error) {
        disable(error);
        resolve();
      }
    });
    sealPromise = closed.then(() => {
      sealPromise = undefined;
      advanceSegment();
      drainPendingLines();
    });
  };

  /** Writes everything held during a seal into the segment that opened after it. */
  const drainPendingLines = (): void => {
    if (pendingLineList.length === 0) {
      return;
    }
    // Taken by value first: one of these lines may fill the new segment too,
    // and the re-entrant `appendLine` must find an empty list to push the
    // remainder onto, in order.
    const lineList = pendingLineList;
    pendingLineList = [];
    for (const line of lineList) {
      appendLine(line);
    }
  };

  const appendLine = (line: string): void => {
    if (sealPromise !== undefined) {
      pendingLineList.push(line);
      return;
    }
    const lineBytes = Buffer.byteLength(line);
    let stream = open();
    if (stream === undefined) {
      return;
    }
    if (
      rotation !== undefined &&
      liveBytes > 0 &&
      liveBytes + lineBytes > rotation.maxBytes
    ) {
      sealLiveSegment();
      if (sealPromise !== undefined) {
        pendingLineList.push(line);
        return;
      }
      stream = open();
      if (stream === undefined) {
        return;
      }
    }
    // Unconditional, and that is the policy for an oversized line: a segment
    // with nothing in it never rotates (`liveBytes > 0` above), so a single
    // line longer than `maxBytes` is written **whole** into a segment of its
    // own instead of being split across two or dropped. Splitting would leave
    // both halves unparseable; dropping would lose the one event — a giant
    // step `output` — most likely to explain what the run did.
    try {
      stream.write(line);
      liveBytes += lineBytes;
    } catch (error) {
      disable(error);
    }
  };

  /** Waits out a seal in progress, including one its own drain starts. */
  const settleSeal = async (): Promise<void> => {
    while (sealPromise !== undefined) {
      await sealPromise;
    }
  };

  return {
    isUsable: () => usable,

    write(line: string): void {
      appendLine(line);
    },

    flushSync(): void {
      if (destination === undefined) {
        return;
      }
      try {
        destination.flushSync();
      } catch (error) {
        disable(error);
      }
    },

    async flush(): Promise<void> {
      await settleSeal();
      const stream = destination;
      if (stream === undefined) {
        return;
      }
      // Returns immediately for a synchronous destination (`minLength: 0`),
      // where every line is already on disk; waits for `drain` for a buffered
      // one. Ordered, unlike `flushSync`, because it lets an in-flight write
      // finish rather than writing past it.
      await new Promise<void>((resolve) => {
        try {
          stream.flush((error) => {
            if (error) {
              disable(error);
            }
            resolve();
          });
        } catch (error) {
          disable(error);
          resolve();
        }
      });
    },

    async close(): Promise<void> {
      // Before anything else: a seal in progress still owns lines this run
      // emitted, and its drain is what puts them in the next segment.
      await settleSeal();
      const stream = destination;
      usable = false;
      destination = undefined;
      if (stream === undefined) {
        return;
      }
      try {
        stream.flushSync();
      } catch {
        // Already reported by whatever failed first, and there is nothing left
        // to disable — this writer is closing.
      }
      // A descriptor this module did not open is not this module's to close:
      // fd 1 stays open for whatever the process prints after the run.
      if (target.kind === 'file') {
        try {
          stream.end();
        } catch {
          // Best-effort: the bytes are already durable above.
        }
      }
    },
  };
}

/**
 * One writer plus the two decisions about what reaches it: *which* events, and
 * in *what shape*.
 */
interface WriterRoute {
  readonly writer: LineWriter;
  readonly accepts: (event: RunEvent) => boolean;
  /**
   * The event this route writes, when that is not the event the producer
   * emitted — {@link STEP_DETAIL.SUMMARY}'s stripped `step.start`/`step.end`
   * is the only one today. Absent means "the event itself", which is every
   * other route and the default policy, and is what keeps the ordinary
   * fan-out at one `JSON.stringify` for the whole sink.
   *
   * Function *identity* is load-bearing: {@link createNdjsonSink} groups
   * routes by this reference so that routes sharing a policy encode once
   * between them. A transform must therefore be a module-level function, not
   * a closure built per route — see {@link mainRouteStepPolicy}, which hands
   * back the one shared {@link withoutStepPayload} rather than wrapping it.
   */
  readonly transform?: (event: RunEvent) => RunEvent;
}

/** Every event. */
const ACCEPT_ALL = (): boolean => true;

// ---------------------------------------------------------------------------
// `logs.steps:` — how much of a step event the MAIN log keeps
//
// `step.start` and `step.end` are the two kinds that carry a workflow's
// *state*: `input` is the record the machine read out of storage, `output` is
// what the handler returned, and both grow with whatever the workflow
// accumulates. In a measured workspace of four looping workflows they were
// **91% of all log bytes** — 9.66 GB of 10.6 GB a day — with one step's
// payload growing from ~1 KB to ~120 KB as an accumulating map filled its
// retention window, written ~9 times a second. Nothing in the format could
// reduce that: the main route is `ACCEPT_ALL`, there is no level threshold,
// and neither kind carries a `level` a threshold could read (only `log`
// does, see {@link isFailureEvent}).
//
// This is that dial, and it sits **on the sink route rather than at the
// producer** deliberately. The producer's event is the one *every* sink sees:
// the terminal renderer's `-v`/`-vv` prints `input`/`output` out of it, the
// OTel bridge maps it onto span attributes, and the error route below writes
// it whole. Trimming at the producer would take the payload away from all of
// them at once — a rendering flag and a tracing backend degraded to save
// bytes in a file neither one writes. Trimming here takes it away from
// exactly the file that is 91% of the bytes, and from nothing else.
//
// Three consequences, and none of them is a corner to be tidied away later:
//
// - **The error log is never affected.** Its route carries no transform and
//   keeps `isFailureEvent` unchanged under every value, so a failed
//   `step.end` still has its full `input`/`output` in `<run-id>.error.ndjson`
//   even under `off`. Losing the *successful* step records is the trade an
//   operator makes; losing the diagnostics for the step that actually failed
//   is not, and a policy that did that is a policy nobody could afford to
//   turn on.
// - **Only `step.start` and `step.end`.** `step.progress`, `log`,
//   `run.start`, `run.end`, `storage.seed`, `seed.override.applied`,
//   `run.heartbeat` and `bootstrap.error` are untouched by every value. This
//   bounds the size of step payloads; it is not a way to thin the stream.
// - **`log.rotate` is never filtered.** That follows from the point above,
//   but it is worth stating on its own: it must be the first line of every
//   new segment, in every sink (OBSERVABILITY.md, "Event kinds"; this
//   module's "The `log.rotate` marker" section), and a reader that finds a
//   segment beginning with anything else concludes the file is damaged.
// ---------------------------------------------------------------------------

/**
 * `logs.steps:` — how much of a `step.start` / `step.end` reaches the main
 * log. See the section above for why the policy exists and where it applies.
 */
export const STEP_DETAIL = {
  /**
   * Every field, exactly as the producer emitted it — the default, and
   * byte-for-byte what this sink wrote before the option existed.
   */
  FULL: 'full',
  /**
   * The step event minus `input` and `output`. Everything else is kept —
   * `step`, `outcome`, `duration_ms`, `timed_out`/`timeout_ms`, `error`,
   * `severity` and the whole envelope — so the run's shape, timings and
   * failures are all still on disk; only the values the step moved are gone.
   */
  SUMMARY: 'summary',
  /**
   * No `step.start` / `step.end` in the main log at all. The run's start, end,
   * logs, progress, heartbeats, seeding and rotation markers remain, as does
   * every failed step in the error log.
   */
  OFF: 'off',
} as const;

/** The `logs.steps:` policy — see {@link STEP_DETAIL}. */
export type StepDetail = (typeof STEP_DETAIL)[keyof typeof STEP_DETAIL];

/**
 * Every value the policy accepts, in the order `--help` should list them, for
 * a yargs `choices:` — the same job `OUTPUT_MODE_LIST` does for `--output`.
 */
export const STEP_DETAIL_LIST: readonly StepDetail[] = [
  STEP_DETAIL.FULL,
  STEP_DETAIL.SUMMARY,
  STEP_DETAIL.OFF,
];

/**
 * True for the two kinds {@link STEP_DETAIL} governs, and **only** those.
 *
 * Written once and used by both the `off` predicate and (in spirit) the
 * `summary` transform, so "which kinds does this policy touch?" has a single
 * answer in the code as well as in the documentation.
 */
function isStepDetailEvent(event: RunEvent): boolean {
  return event.event === RUN_EVENT.STEP_START || event.event === RUN_EVENT.STEP_END;
}

/** {@link STEP_DETAIL.OFF}: every event except the two the policy governs. */
const ACCEPT_EXCEPT_STEPS = (event: RunEvent): boolean => !isStepDetailEvent(event);

/**
 * {@link STEP_DETAIL.SUMMARY}'s transform: the same step event, minus the one
 * field that carries the payload.
 *
 * A rest-destructure rather than a rebuilt object literal, and that is about
 * bytes rather than brevity: the envelope's field order is documented as
 * load-bearing (`event-types.ts` — "so a line is recognisable before it is
 * parsed"), and object rest preserves the insertion order of everything it
 * keeps. What a reader gets is therefore the line it would have got had the
 * payload simply never been set, not a reordered near-copy of it.
 *
 * `input` and `output` are already `Type.Optional` on their schemas
 * (`event-types.ts`), so what comes out still validates as a
 * `StepStartEvent`/`StepEndEvent`: this omits an optional field, it does not
 * invent a shape (OBSERVABILITY.md, "Compatibility" — the format is additive
 * only). The two kinds are destructured separately because they are separate
 * schemas: `input` exists on one, `output` on the other, and a union-wide
 * destructure of both would not type-check against either.
 *
 * Every other kind is returned unchanged, by identity — the transform is
 * installed on a whole route, not on a per-event basis, so it sees the entire
 * stream and has to be a no-op for the rest of it.
 */
function withoutStepPayload(event: RunEvent): RunEvent {
  if (event.event === RUN_EVENT.STEP_START) {
    const { input: _input, ...rest } = event;
    return rest;
  }
  if (event.event === RUN_EVENT.STEP_END) {
    const { output: _output, ...rest } = event;
    return rest;
  }
  return event;
}

/**
 * What one {@link StepDetail} value puts on the **main** route.
 *
 * One function called by both sinks rather than the same three-way branch
 * written twice: this module's header promises that
 * {@link createNdjsonStdoutSink} is "the same stream, same writer, same
 * bytes" as the file, and a policy applied in two places is a policy that
 * eventually diverges in one of them.
 *
 * Note what is *not* here: nothing hands the error route anything. It keeps
 * `isFailureEvent` and no transform under all three values, which is the
 * invariant the section above spends its third paragraph on.
 */
function mainRouteStepPolicy(steps: StepDetail): Pick<WriterRoute, 'accepts' | 'transform'> {
  switch (steps) {
    case STEP_DETAIL.OFF:
      return { accepts: ACCEPT_EXCEPT_STEPS };
    case STEP_DETAIL.SUMMARY:
      // The shared module-level function, never a wrapper closure — see
      // {@link WriterRoute.transform} for why its identity matters.
      return { accepts: ACCEPT_ALL, transform: withoutStepPayload };
    // `full`, and anything a JavaScript caller passes that is none of the
    // three. The default being the old behaviour is deliberate: an
    // unrecognised value must not quietly delete a run's step records. The
    // schema (`workspace/logs.ts`) is what refuses a bad value in a document;
    // this is what refuses to *act* on one that reached the sink anyway.
    default:
      return { accepts: ACCEPT_ALL };
  }
}

/** Routes that write the same shape, and therefore share one encoded line. */
interface RouteGroup {
  readonly transform: WriterRoute['transform'];
  readonly routeList: readonly WriterRoute[];
}

/**
 * Groups routes by transform **identity**, preserving order within a group.
 *
 * Done once, at sink construction, so {@link createNdjsonSink}'s hot path
 * pays nothing per event for a grouping that can never change: the route list
 * is fixed for a sink's whole life. With no transform anywhere — the default
 * policy, and every sink that existed before `logs.steps` — this returns a
 * single group holding every route, which is exactly the one-encode fan-out
 * that came before it.
 */
function groupRoutesByTransform(routeList: readonly WriterRoute[]): readonly RouteGroup[] {
  const groupList: { transform: WriterRoute['transform']; routeList: WriterRoute[] }[] = [];
  for (const route of routeList) {
    const group = groupList.find((candidate) => candidate.transform === route.transform);
    if (group === undefined) {
      groupList.push({ transform: route.transform, routeList: [route] });
      continue;
    }
    group.routeList.push(route);
  }
  return groupList;
}

/**
 * One event as one NDJSON line, or `undefined` when it cannot be encoded.
 *
 * A step's `output`/`error` record is whatever a plugin returned, so encoding
 * it can throw (a circular structure, a BigInt). Dropping the one line is the
 * only safe answer: a half-written line would break every reader of the file,
 * not just that line.
 *
 * Taking pino's *destination* changes nothing here on purpose. Pino's logger
 * would encode a circular structure rather than drop it (that is
 * `safe-stable-stringify`'s job), but a destination takes a string — the
 * encoding stays this module's, and it has to: `safe-stable-stringify`
 * **sorts object keys**, which would reorder every envelope on every line. The
 * envelope's field order is documented as load-bearing ("so a line is
 * recognisable before it is parsed", `event-types.ts`), so adopting it to
 * rescue the rare circular payload would change the bytes of every ordinary
 * one. Dropping the line stays the answer.
 */
function encodeLine(event: RunEvent): string | undefined {
  try {
    return `${JSON.stringify(event)}\n`;
  } catch (error) {
    console.error(
      `[rawbox] dropped an unencodable "${event.event}" event: ${getErrorMessage(error)}`,
    );
    return undefined;
  }
}

/**
 * The sink shared by {@link createNdjsonFileSink} and
 * {@link createNdjsonStdoutSink}: encode once *per distinct shape*, fan out to
 * every route that wants the line.
 */
function createNdjsonSink(routeList: readonly WriterRoute[]): RunEventSink {
  const groupList = groupRoutesByTransform(routeList);

  return {
    emit(event: RunEvent): void {
      if (!routeList.some((route) => route.writer.isUsable())) {
        return;
      }

      // One encode per group, not per route and not per file. With no
      // `logs.steps` policy in force there is exactly one group, so this is
      // the single `JSON.stringify` and the single fan-out loop it always
      // was, plus one `line === undefined` test per route.
      //
      // The encode is **lazy — after `accepts`** — where it used to be the
      // first thing `emit` did, and that is the entire point of
      // {@link STEP_DETAIL.OFF}: a 120 KB `output` that no route is going to
      // write must not be stringified in order to be thrown away. The one
      // visible consequence is that an unencodable event nobody wanted is no
      // longer reported on `console.error`, which is right — nothing was
      // dropped, because nothing was going to be written.
      for (const group of groupList) {
        let line: string | undefined;
        for (const route of group.routeList) {
          if (!route.writer.isUsable() || !route.accepts(event)) {
            continue;
          }
          if (line === undefined) {
            line = encodeLine(
              group.transform === undefined ? event : group.transform(event),
            );
            if (line === undefined) {
              // This group's shape is unencodable; another group's may not
              // be. A circular structure inside `input` sinks the full line
              // while the `summary` line encodes perfectly, and the route
              // that *can* write must not be silenced by the route that
              // cannot. With one group — the default — this is the same
              // "drop the event" it always was.
              break;
            }
          }
          route.writer.write(line);
        }
      }

      // `run.end` is the one event whose absence changes how a run is read: a
      // stream ending without one means "the process died", not "the run
      // failed" (`event-types.ts`, {@link RunEndEvent}). So it is made durable
      // the moment it is written, in both modes and regardless of what the
      // caller does next — once per run, not once per event, so a buffered
      // destination still buys what it was turned on for.
      //
      // In synchronous mode this is a no-op that cannot fail: every line is
      // already on disk. In buffered mode it is SonicBoom's `flushSync` — the
      // same primitive `pino.final` uses for crash safety — and it carries
      // that primitive's one caveat: if an asynchronous write happens to be in
      // flight at this instant, the buffer is written *past* it rather than
      // after it. That window is what `logs.async` trades away and says so
      // (`workspace/logs.ts`); `flush()` below is the ordered drain, and the
      // producer awaits it immediately after this event, so the window closes
      // as soon as the run concludes. Losing `run.end` outright would be
      // strictly worse than either.
      if (event.event === RUN_EVENT.RUN_END) {
        for (const route of routeList) {
          route.writer.flushSync();
        }
      }
    },

    // Implemented in both modes, not only the buffered one. Sync mode has
    // nothing buffered to drain — but it now holds an open file descriptor,
    // which the `appendFileSync` era did not, and a descriptor is a thing to
    // release. The producer awaits these once, in this order, after the run's
    // last event (`sink.ts`).
    async flush(): Promise<void> {
      for (const route of routeList) {
        await route.writer.flush();
      }
    },

    async close(): Promise<void> {
      for (const route of routeList) {
        await route.writer.close();
      }
    },
  };
}

/** Options shared by the NDJSON sinks. */
export interface NdjsonSinkOptions {
  /**
   * Buffer writes instead of writing each line before returning —
   * `logs.async` / `--log-async`, resolved by `resolveLogsConfig`
   * (`workspace/logs.ts`). Defaults to `false`, which is the safe value on
   * purpose: the failure modes are not symmetric, and a run killed
   * mid-workflow is exactly the run whose last lines explain why.
   *
   * With `true`, `flush()`/`close()` are what make the tail of the stream
   * durable — and every `process.exit()` on a run path must therefore come
   * after them. `run.end` itself is flushed synchronously either way; see
   * {@link createNdjsonSink}.
   */
  async?: boolean;
  /**
   * When one segment of a run's log ends and how many segments survive —
   * `logs.rotate:` in the workspace document, resolved by `resolveLogsConfig`
   * (`workspace/logs.ts`).
   *
   * **Omitting it rotates**, at {@link LOG_ROTATE_DEFAULT_MAX_BYTES} *
   * {@link LOG_ROTATE_DEFAULT_MAX_FILES} — 1 GiB per run. There is no way to
   * turn rotation off here and that is deliberate (see
   * {@link LOG_ROTATE_DEFAULT_MAX_BYTES}); a caller wanting more history raises
   * `maxFiles`.
   *
   * The pair is taken as given. `LogRotate`'s schema is what refuses a
   * `maxBytes` below {@link LOG_ROTATE_MAX_BYTES_MIN} or a `maxFiles` below 1
   * in an authored document, and re-clamping here would only hide a bad
   * embedder value behind a silently different one — the exact behaviour
   * `logs:` exists to end. A test may therefore ask for a 200-byte segment and
   * get one.
   *
   * Ignored by {@link createNdjsonStdoutSink}: a descriptor is not this
   * module's file to roll.
   */
  rotate?: ResolvedLogRotate;
  /**
   * Called once per roll of the **main** log — never the error log's own,
   * independent rolls — so the caller can turn it into a `log.rotate` event
   * and emit it through the producer. See this module's "The `log.rotate`
   * marker" section, and `producer.ts`'s `logRotate`.
   *
   * Ignored by {@link createNdjsonStdoutSink}, for the reason {@link rotate}
   * is: a descriptor never rolls.
   */
  onSegmentRotate?: (info: SegmentRotationInfo) => void;
  /**
   * How much of a `step.start` / `step.end` reaches the **main** log —
   * `logs.steps:` in the workspace document, `--log-steps` on the CLI, both
   * resolved by `resolveLogsConfig` (`workspace/logs.ts`). Defaults to
   * {@link STEP_DETAIL.FULL}: every field, the bytes this sink has always
   * written.
   *
   * The main route only. The error log keeps full fidelity under every value
   * — see this module's "`logs.steps`" section for why that is settled rather
   * than configurable.
   *
   * **Honoured by {@link createNdjsonStdoutSink} too**, unlike {@link rotate}
   * and {@link onSegmentRotate}. Those two are ignored there because a
   * descriptor has no size to bound and no successor to open; this one is
   * about the *content* of the stream, and stdout is documented as
   * byte-for-byte the main log's own lines. A stdout stream still carrying
   * payloads the file had dropped would be the second format this module
   * exists not to have.
   */
  steps?: StepDetail;
}

/** {@link NdjsonSinkOptions.rotate}'s default — rotation is on unless overridden. */
const DEFAULT_ROTATE: ResolvedLogRotate = {
  maxBytes: LOG_ROTATE_DEFAULT_MAX_BYTES,
  maxFiles: LOG_ROTATE_DEFAULT_MAX_FILES,
};

/**
 * Builds a sink that appends events to `logFilePath`, mirroring failures into
 * `errorLogFilePath`.
 *
 * Writes are **synchronous by default**: a run's log has to survive the process
 * being killed mid-workflow, which is precisely when a buffered writer loses the
 * lines that explain why. Volumes are one line per step, not per byte of data,
 * so the cost is not the bottleneck it would be in a request logger.
 * `options.async` trades that for throughput, for a caller who has measured it.
 *
 * Both files **rotate into segments** (see this module's header): `logFilePath`
 * and `errorLogFilePath` name segment 0 of their respective sequences and keep
 * that name for the life of the run, which is what lets the run registry record
 * them once. Each file rotates on its own bytes.
 *
 * Everything here is **best-effort**: both directories are created up front, and
 * a failure at any point disables that file rather than failing the run. Losing
 * a log line must never change a run's outcome, and a read-only log directory
 * must never mask the real error the run was about to report. Retiring an old
 * segment is best-effort in the same sense: a failed unlink is reported once and
 * leaves the file on disk.
 *
 * `options.onSegmentRotate` is wired to the main log's writer only — see that
 * option's own doc for why the error log's rolls stay silent.
 *
 * @param logFilePath - Absolute path of the full event log.
 * @param errorLogFilePath - Absolute path of the filtered failure log.
 * @param options - See {@link NdjsonSinkOptions}.
 */
export function createNdjsonFileSink(
  logFilePath: string,
  errorLogFilePath: string,
  options?: NdjsonSinkOptions,
): RunEventSink {
  const sync = !(options?.async ?? false);
  const rotate = options?.rotate ?? DEFAULT_ROTATE;
  // Two independent rotations of one bound, not one shared counter: the error
  // log is a filtered view, so it fills at its own rate, and a run that fails
  // once must not have its main log rolled by that one line — nor be denied a
  // roll because the other file has not had one.
  return createNdjsonSink([
    {
      writer: createLineWriter(
        { kind: 'file', filePath: logFilePath, rotate },
        sync,
        options?.onSegmentRotate,
      ),
      // The one route `logs.steps` governs — see {@link NdjsonSinkOptions.steps}
      // and this module's "`logs.steps`" section. Under the default `full`
      // this is `accepts: ACCEPT_ALL` and no transform, i.e. exactly the route
      // that stood here before the option existed.
      ...mainRouteStepPolicy(options?.steps ?? STEP_DETAIL.FULL),
    },
    {
      writer: createLineWriter({ kind: 'file', filePath: errorLogFilePath, rotate }, sync),
      // Untouched by `logs.steps`, under every one of its values, and with no
      // transform: a failed `step.end` keeps its full `input`/`output` here
      // even when the main log has stopped carrying either. Losing successful
      // step records is the trade; losing the failing step's diagnostics is
      // not. Nothing about this route may be made to depend on `options.steps`.
      accepts: isFailureEvent,
    },
  ]);
}

/**
 * Builds a sink that writes the same NDJSON stream to a file descriptor —
 * fd 1 by default, which is `@rawbox/cli`'s `--output ndjson`.
 *
 * Byte-for-byte the main log file's lines, through the same writer, so a run
 * under systemd or Docker can hand its own log stack the stream without a
 * second format to learn or a file to tail. The file sinks stay registered
 * alongside it: stdout is a *fan-out*, not a replacement, and a run's own log
 * is what `runs show`/`workspace logs` read afterwards.
 *
 * Using the writer rather than `process.stdout.write` is the point. Node's
 * `process.stdout` is asynchronous when fd 1 is a **pipe** — the exact case
 * this mode exists for — so a `process.exit()` can drop the tail of the stream
 * on the floor. A synchronous destination cannot.
 *
 * The descriptor is never closed by this sink; only flushed. Whatever the
 * process prints after the run still needs fd 1.
 *
 * @param options - See {@link NdjsonSinkOptions}.
 * @param fd - The descriptor to write to. Defaults to `1` (stdout).
 */
export function createNdjsonStdoutSink(
  options?: NdjsonSinkOptions,
  fd = 1,
): RunEventSink {
  const sync = !(options?.async ?? false);
  return createNdjsonSink([
    {
      writer: createLineWriter(
        { kind: 'descriptor', fd, label: `<fd ${fd}>` },
        sync,
      ),
      // The same policy the main *file* route gets, from the same function:
      // this sink's whole contract is that it is the main log's lines on a
      // descriptor, so a `logs.steps` value the file honours and this one
      // ignored would make "same bytes" false the first time anyone set it.
      ...mainRouteStepPolicy(options?.steps ?? STEP_DETAIL.FULL),
    },
  ]);
}

/**
 * Creates a file's parent directory, reporting whether the file is writable at
 * all.
 *
 * Done once at construction rather than lazily per write so that a run whose log
 * directory does not exist yet — the common case, since `.rawbox/logs/` is
 * machine-owned — still records the bootstrap errors it emits before anything
 * else has had a reason to create it.
 */
function ensureDirectory(filePath: string): boolean {
  try {
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    return true;
  } catch (error) {
    console.error(
      `[rawbox] cannot create the log directory for "${filePath}", logging there is disabled: ${getErrorMessage(error)}`,
    );
    return false;
  }
}
