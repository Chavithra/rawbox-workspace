import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUN_EVENT,
  OUTCOME,
  SEVERITY,
  createNdjsonFileSink,
  type RunEvent,
  type RunEventSink,
  type SegmentRotationInfo,
} from '../src/events/index.js';
import { segmentPathFor } from '../src/workspace/log-segment-path.js';

// ---------------------------------------------------------------------------
// Segment rotation, from the WRITING side.
//
// The contract under test is `workspace/logs.ts`'s `LogRotate`, and the reader
// that has to agree with it is `@rawbox/cli`'s `log-segments.ts`. Three
// properties are asserted over and over here because a reader depends on each
// of them:
//
//   1. `<run>.ndjson` is segment 0 and the OLDEST, `<run>.N.ndjson` is newer,
//      and no file is ever renamed, truncated or reopened once superseded.
//   2. A segment ends at a **line boundary**. A reader drops an unterminated
//      final line of a sealed segment as damage, so a mid-line split would
//      lose an event silently.
//   3. The successor exists only once the predecessor is complete on disk —
//      the rule `readNewSegmentBytes` uses to conclude a segment is final.
//
// Every size here is exact rather than approximate: `eventOfBytes` builds an
// event whose encoded line is a requested number of bytes, so "ten 100-byte
// lines fill a 1000-byte segment" is arithmetic, not an estimate.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-ndjson-rotation-test');

let caseDir: string;
let caseCounter = 0;
let errorList: string[];

beforeEach(() => {
  caseCounter += 1;
  caseDir = path.join(rootDir, `case-${caseCounter}`);
  fsSync.mkdirSync(caseDir, { recursive: true });
  errorList = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errorList.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fsSync.rmSync(rootDir, { recursive: true, force: true });
});

function casePath(...segments: string[]): string {
  return path.join(caseDir, ...segments);
}

const ENVELOPE = {
  ts: '2026-08-15T10:11:12.345Z',
  run_id: 'run-1770000000000-abcde',
  workspace: 'my-workspace',
  workflow: 'example',
} as const;

/**
 * A `log` event whose encoded line — `JSON.stringify(event)` plus the newline
 * — is **exactly** `bytes` long, carrying `index` as its first field so a line
 * can be identified wherever it lands.
 *
 * Padding goes in `message` as plain ASCII, so no JSON escaping changes the
 * length. Throws rather than approximating: a test that silently wrote
 * 99-byte lines into a 1000-byte segment would assert nothing about the bound.
 */
function eventOfBytes(index: number, bytes: number): RunEvent {
  const build = (message: string): RunEvent => ({
    ...ENVELOPE,
    event: RUN_EVENT.LOG,
    level: 'info',
    message,
  });
  const marker = `#${index}:`;
  const overhead = Buffer.byteLength(JSON.stringify(build(marker))) + 1;
  const padding = bytes - overhead;
  if (padding < 0) {
    throw new Error(`${bytes} bytes is too small for one event line (minimum ${overhead})`);
  }
  const event = build(`${marker}${'a'.repeat(padding)}`);
  const actual = Buffer.byteLength(JSON.stringify(event)) + 1;
  if (actual !== bytes) {
    throw new Error(`asked for a ${bytes}-byte line, built a ${actual}-byte one`);
  }
  return event;
}

/** A failure-shaped event of exactly `bytes`, so the error log can be filled to a bound too. */
function failureOfBytes(index: number, bytes: number): RunEvent {
  const build = (message: string): RunEvent => ({
    ...ENVELOPE,
    event: RUN_EVENT.BOOTSTRAP_ERROR,
    stage: 'resolve',
    message,
    severity: SEVERITY.ERROR,
  });
  const marker = `#${index}:`;
  const overhead = Buffer.byteLength(JSON.stringify(build(marker))) + 1;
  const event = build(`${marker}${'a'.repeat(bytes - overhead)}`);
  if (Buffer.byteLength(JSON.stringify(event)) + 1 !== bytes) {
    throw new Error(`could not build a ${bytes}-byte failure line`);
  }
  return event;
}

/** The `#N` marker of every line of one segment file, in file order. */
function markerListOf(filePath: string): number[] {
  const text = fsSync.readFileSync(filePath, 'utf-8');
  if (text.length > 0 && !text.endsWith('\n')) {
    throw new Error(`segment "${path.basename(filePath)}" does not end at a line boundary`);
  }
  return text
    .split('\n')
    .slice(0, -1)
    .map((line) => {
      const parsed = JSON.parse(line) as { message: string };
      const marker = /^#(\d+):/.exec(parsed.message);
      if (!marker) {
        throw new Error(`unmarked line in "${path.basename(filePath)}": ${line.slice(0, 40)}`);
      }
      return Number(marker[1]);
    });
}

/** Every existing segment index of `logPath`, ascending — the writer's own view, read back. */
function segmentIndexListOf(logPath: string): number[] {
  const base = path.basename(logPath);
  const stem = base.slice(0, -'.ndjson'.length);
  const indexList: number[] = [];
  for (const entry of fsSync.readdirSync(path.dirname(logPath))) {
    if (entry === base) {
      indexList.push(0);
      continue;
    }
    const match = new RegExp(`^${stem}\\.([1-9][0-9]*)\\.ndjson$`).exec(entry);
    if (match) {
      indexList.push(Number(match[1]));
    }
  }
  return indexList.sort((a, b) => a - b);
}

/** Every line of every segment of `logPath`, oldest segment first. */
function allMarkersOf(logPath: string): number[] {
  return segmentIndexListOf(logPath).flatMap((index) =>
    markerListOf(segmentPathFor(logPath, index)),
  );
}

function sizeOf(filePath: string): number {
  return fsSync.statSync(filePath).size;
}

// ---------------------------------------------------------------------------
// The regression that matters most: a run that never fills a segment must be
// exactly the file it was before rotation existed.
// ---------------------------------------------------------------------------

describe('createNdjsonFileSink — a run under maxBytes is unchanged', () => {
  it('leaves exactly one file, byte-identical to the unrotated writer', async () => {
    const log = casePath('run.ndjson');
    const eventList = Array.from({ length: 20 }, (_, index) => eventOfBytes(index, 200));
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 1_000_000, maxFiles: 8 },
    });
    for (const event of eventList) {
      sink.emit(event);
    }
    await sink.close?.();

    expect(fsSync.readdirSync(caseDir)).toEqual(['run.ndjson']);
    expect(fsSync.readFileSync(log, 'utf-8')).toBe(
      eventList.map((event) => `${JSON.stringify(event)}\n`).join(''),
    );
  });

  it('rotates by default, with no `rotate` option supplied at all', async () => {
    // On by default is the settled decision (`LOG_ROTATE_DEFAULT_MAX_BYTES`),
    // so the guard here is that the default is a *large* bound rather than an
    // absent one: 4000 bytes of events stay in one file, and the writer that
    // produced them is the same one a 128 MiB run would roll.
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'));
    for (let index = 0; index < 20; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    expect(segmentIndexListOf(log)).toEqual([0]);
  });

  it('creates no file at all for a log that receives no line, segment scan included', async () => {
    // The lazy open is what keeps a clean run from leaving an empty
    // `<run-id>.error.ndjson`; discovering which segment to append to must not
    // change that.
    const log = casePath('run.ndjson');
    const errorLog = casePath('run.error.ndjson');
    const sink = createNdjsonFileSink(log, errorLog, {
      rotate: { maxBytes: 4096, maxFiles: 4 },
    });
    sink.emit(eventOfBytes(0, 200));
    await sink.close?.();

    expect(fsSync.existsSync(errorLog)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The roll itself
// ---------------------------------------------------------------------------

describe('createNdjsonFileSink — crossing maxBytes', () => {
  it('seals segment 0 at a whole line and opens .1, splitting nothing', async () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 2000, maxFiles: 8 },
    });
    // Ten 100-byte lines fill segment 0 exactly; the eleventh would carry it
    // to 1100, so it opens segment 1 instead.
    for (let index = 0; index < 13; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    expect(segmentIndexListOf(log)).toEqual([0, 1]);
    expect(sizeOf(log)).toBe(2000);
    // `markerListOf` throws unless the file ends at a line boundary, so this
    // is the no-split assertion as much as the ordering one.
    expect(markerListOf(log)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(markerListOf(segmentPathFor(log, 1))).toEqual([10, 11, 12]);
  });

  it('rolls again and again, and never renames or reopens a sealed segment', async () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });
    for (let index = 0; index < 35; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    const sealedBytes = fsSync.readFileSync(log);
    for (let index = 35; index < 45; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    expect(segmentIndexListOf(log)).toEqual([0, 1, 2, 3, 4]);
    // Segment 0 kept its name and its exact bytes while four more were
    // written: a reader holding this path is never invalidated.
    expect(fsSync.readFileSync(log).equals(sealedBytes)).toBe(true);
    expect(allMarkersOf(log)).toEqual(Array.from({ length: 45 }, (_, index) => index));
  });

  it('writes a line longer than maxBytes whole, in a segment of its own', async () => {
    // The policy: a segment with nothing in it never rotates, so an oversized
    // line goes in whole rather than being split (both halves unparseable) or
    // dropped (losing the one giant `output` most likely to explain the run).
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 2000, maxFiles: 8 },
    });
    sink.emit(eventOfBytes(0, 200));
    sink.emit(eventOfBytes(1, 5000));
    sink.emit(eventOfBytes(2, 200));
    await sink.close?.();

    expect(segmentIndexListOf(log)).toEqual([0, 1, 2]);
    expect(markerListOf(log)).toEqual([0]);
    expect(markerListOf(segmentPathFor(log, 1))).toEqual([1]);
    expect(sizeOf(segmentPathFor(log, 1))).toBe(5000);
    expect(markerListOf(segmentPathFor(log, 2))).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// Retention within one run
// ---------------------------------------------------------------------------

describe('createNdjsonFileSink — maxFiles', () => {
  it('deletes from the low end, leaving exactly maxFiles segments — the newest ones', async () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 2000, maxFiles: 3 },
    });
    // 45 lines of 100 bytes = ten per segment, so segments 0..4 are opened and
    // 0 and 1 are retired.
    for (let index = 0; index < 45; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    expect(segmentIndexListOf(log)).toEqual([2, 3, 4]);
    expect(fsSync.existsSync(log)).toBe(false);
    expect(allMarkersOf(log)).toEqual(Array.from({ length: 25 }, (_, index) => index + 20));
    expect(errorList).toEqual([]);
  });

  it('keeps the live segment alone when maxFiles is 1, rather than deleting what it is writing', async () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 2000, maxFiles: 1 },
    });
    for (let index = 0; index < 25; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }

    // Mid-run, before any flush or close: the file being appended to is on
    // disk with its lines in it, and it is the only one left.
    expect(segmentIndexListOf(log)).toEqual([2]);
    expect(markerListOf(segmentPathFor(log, 2))).toEqual([20, 21, 22, 23, 24]);

    // And it is still the live segment — the writer was not disabled by
    // deleting its own predecessors.
    sink.emit(eventOfBytes(25, 200));
    await sink.close?.();
    expect(segmentIndexListOf(log)).toEqual([2]);
    expect(markerListOf(segmentPathFor(log, 2))).toEqual([20, 21, 22, 23, 24, 25]);
  });

  it('reports a failed retirement once and keeps writing', async () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 2000, maxFiles: 1 },
    });
    const unlinkSync = vi
      .spyOn(fsSync, 'unlinkSync')
      .mockImplementation(() => {
        throw new Error('EPERM, operation not permitted');
      });
    for (let index = 0; index < 35; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    unlinkSync.mockRestore();
    await sink.close?.();

    // Three retirements were attempted and all failed; one diagnostic.
    expect(errorList.filter((message) => message.includes('retire'))).toHaveLength(1);
    // The run's own lines are all still there — a broken unlink is not a
    // broken log.
    expect(allMarkersOf(log)).toEqual(Array.from({ length: 35 }, (_, index) => index));
  });
});

// ---------------------------------------------------------------------------
// Buffered mode — the subtle one
// ---------------------------------------------------------------------------

describe('createNdjsonFileSink — rotation in buffered mode', () => {
  it('puts every line in the segment it belongs to, in order, losing none', async () => {
    // The failure this guards: `flushSync()` refuses to touch a chunk already
    // in flight and writes the later ones past it, so a naive seal leaves a
    // sealed segment with its lines out of order — and a burst like this one
    // keeps a write in flight for its whole length.
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      async: true,
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });
    for (let index = 0; index < 200; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.flush?.();
    await sink.close?.();

    // Twenty segments of exactly ten lines each — the same segmentation the
    // synchronous writer produces, with the same content.
    expect(segmentIndexListOf(log)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    for (const index of segmentIndexListOf(log)) {
      expect(markerListOf(segmentPathFor(log, index))).toEqual(
        Array.from({ length: 10 }, (_, offset) => index * 10 + offset),
      );
    }
    expect(allMarkersOf(log)).toEqual(Array.from({ length: 200 }, (_, index) => index));
  });

  it('completes a roll that was still in flight when the run ended', async () => {
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      async: true,
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });
    for (let index = 0; index < 12; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    // `run.end` flushes synchronously, and lands mid-seal here: the two lines
    // held for segment 1 are what `flush()`/`close()` have to deliver.
    sink.emit({
      ...ENVELOPE,
      event: RUN_EVENT.RUN_END,
      outcome: OUTCOME.OK,
      duration_ms: 30,
      steps_total: 1,
      steps_failed: 0,
    });
    await sink.flush?.();
    await sink.close?.();

    expect(markerListOf(log)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const tail = fsSync.readFileSync(segmentPathFor(log, 1), 'utf-8');
    expect(tail.endsWith('\n')).toBe(true);
    // The two held lines and then `run.end` — the event whose absence would
    // read as "the process died" — all in the successor, in order.
    const tailEventList = tail
      .split('\n')
      .slice(0, -1)
      .map((line) => JSON.parse(line) as { event: string; message?: string });
    expect(tailEventList.map((event) => event.message ?? event.event)).toEqual([
      expect.stringMatching(/^#10:/) as unknown as string,
      expect.stringMatching(/^#11:/) as unknown as string,
      RUN_EVENT.RUN_END,
    ]);
  });

  it('seals a segment completely before its successor exists', async () => {
    // The readers' rule — "segment N+1 exists, therefore N is final" — stated
    // as the writer's obligation: at no observable moment does segment 1 exist
    // while segment 0 is still short of its ten lines.
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      async: true,
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });
    for (let index = 0; index < 15; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    // Poll while the seal is in flight rather than after it: every turn of the
    // loop is a moment a `runs tail` poll could have landed on.
    for (let turn = 0; turn < 20; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (fsSync.existsSync(segmentPathFor(log, 1))) {
        expect(sizeOf(log)).toBe(2000);
        expect(markerListOf(log)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      }
    }
    await sink.flush?.();
    await sink.close?.();
    expect(allMarkersOf(log)).toEqual(Array.from({ length: 15 }, (_, index) => index));
  });
});

// ---------------------------------------------------------------------------
// The error log is its own sequence
// ---------------------------------------------------------------------------

describe('createNdjsonFileSink — the error log rotates independently', () => {
  it('names its segments <run>.error.N.ndjson and rolls on its own bytes', async () => {
    const log = casePath('run.ndjson');
    const errorLog = casePath('run.error.ndjson');
    const sink = createNdjsonFileSink(log, errorLog, {
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });
    // Twelve ordinary lines roll the main log once while the error log has no
    // file at all; twelve failures then roll the error log once while the main
    // log — which receives them too — rolls twice more.
    for (let index = 0; index < 12; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    expect(fsSync.existsSync(errorLog)).toBe(false);
    for (let index = 12; index < 24; index += 1) {
      sink.emit(failureOfBytes(index, 200));
    }
    await sink.close?.();

    expect(fsSync.readdirSync(caseDir).sort()).toEqual([
      'run.1.ndjson',
      'run.2.ndjson',
      'run.error.1.ndjson',
      'run.error.ndjson',
      'run.ndjson',
    ]);
    // The suffix order is the load-bearing part: `.error.1.ndjson`, never
    // `.1.error.ndjson`, or the two sequences would enumerate into each other.
    expect(fsSync.existsSync(casePath('run.1.error.ndjson'))).toBe(false);

    expect(markerListOf(errorLog)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(markerListOf(casePath('run.error.1.ndjson'))).toEqual([22, 23]);
    expect(allMarkersOf(log)).toEqual(Array.from({ length: 24 }, (_, index) => index));
  });
});

// ---------------------------------------------------------------------------
// A log directory that already holds segments
// ---------------------------------------------------------------------------

describe('createNdjsonFileSink — segments already on disk', () => {
  it('appends to the highest existing segment rather than to segment 0', async () => {
    // A crashed run's files, or a test's fixtures. Nothing is renamed and
    // nothing is overwritten: the live segment is the highest one there is.
    const log = casePath('run.ndjson');
    const priorSegment0 = `${JSON.stringify(eventOfBytes(90, 200))}\n`;
    fsSync.writeFileSync(log, priorSegment0, 'utf-8');
    fsSync.writeFileSync(
      segmentPathFor(log, 1),
      `${JSON.stringify(eventOfBytes(91, 200))}\n`,
      'utf-8',
    );

    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 2000, maxFiles: 8 },
    });
    sink.emit(eventOfBytes(0, 200));
    await sink.close?.();

    expect(fsSync.readFileSync(log, 'utf-8')).toBe(priorSegment0);
    expect(markerListOf(segmentPathFor(log, 1))).toEqual([91, 0]);
  });

  it('opens the next segment on the first line when the existing one is already over maxBytes', async () => {
    // Deliberate, and it needs no special case: the recovered segment's real
    // size seeds the byte count, so the ordinary between-lines check fires on
    // the first line. Appending would leave a segment permanently over the
    // bound; truncating or renaming is forbidden outright. Nothing is written
    // at all for a run that emits nothing, because the whole path is lazy.
    const log = casePath('run.ndjson');
    fsSync.writeFileSync(log, `${'x'.repeat(4999)}\n`, 'utf-8');

    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 2000, maxFiles: 8 },
    });
    sink.emit(eventOfBytes(0, 200));
    await sink.close?.();

    expect(sizeOf(log)).toBe(5000);
    expect(markerListOf(segmentPathFor(log, 1))).toEqual([0]);
  });

  it('keeps segment 0 as the name of the run even after rolling past it', async () => {
    // The run registry's `log_path` names segment 0 and is written before the
    // first line; rotation must never invalidate it.
    const log = casePath('run.ndjson');
    const sink = createNdjsonFileSink(log, casePath('run.error.ndjson'), {
      rotate: { maxBytes: 2000, maxFiles: 8 },
    });
    for (let index = 0; index < 25; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    expect(fsSync.existsSync(log)).toBe(true);
    expect(markerListOf(log)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

// ---------------------------------------------------------------------------
// The `log.rotate` marker
//
// `onSegmentRotate` is exercised at the sink's own boundary — the same
// reentrancy a real run relies on (`producer.ts`'s `logRotate` calling back
// into `emitter.emit`, which reaches this very sink again), without needing a
// full `RunEventProducer`. `rotateEventOf` below is `producer.ts`'s
// `logRotate` restated as a pure function, for exactly that reason.
// ---------------------------------------------------------------------------

/** Every line of one segment, parsed generically — tolerant of `log.rotate` lines, unlike `markerListOf`. */
function rawLinesOf(filePath: string): Record<string, unknown>[] {
  const text = fsSync.readFileSync(filePath, 'utf-8');
  if (text.length > 0 && !text.endsWith('\n')) {
    throw new Error(`"${path.basename(filePath)}" does not end at a line boundary`);
  }
  return text
    .split('\n')
    .slice(0, -1)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every line of every segment of `logPath`, oldest segment first — the `log.rotate`-tolerant `allMarkersOf`. */
function allLinesOf(logPath: string): Record<string, unknown>[] {
  return segmentIndexListOf(logPath).flatMap((index) => rawLinesOf(segmentPathFor(logPath, index)));
}

/** The `#N` a `log` line's `message` carries. */
function markerOf(line: Record<string, unknown>): number {
  const match = /^#(\d+):/.exec(String(line['message']));
  if (!match) {
    throw new Error(`not a marked "log" line: ${JSON.stringify(line)}`);
  }
  return Number(match[1]);
}

/**
 * `producer.ts`'s `logRotate`, restated as a pure function over the same
 * `SegmentRotationInfo` the real sink hands it, sharing this file's fixed
 * envelope so a rotate line is recognisable exactly like every other line
 * here.
 */
function rotateEventOf(info: SegmentRotationInfo): RunEvent {
  return {
    ...ENVELOPE,
    event: RUN_EVENT.LOG_ROTATE,
    sealed_segment: info.sealedSegment,
    live_segment: info.liveSegment,
    ...(info.deletedSegment === undefined ? {} : { deleted_segment: info.deletedSegment }),
    max_bytes: info.maxBytes,
    max_files: info.maxFiles,
    ...(info.deletedSegment === undefined ? {} : { severity: SEVERITY.WARN }),
  } as RunEvent;
}

/**
 * Builds a sink wired exactly as `run-workflow.ts` wires the real one: a
 * forward reference so `onSegmentRotate`'s callback can call back into the
 * very sink it was constructed by, once it exists.
 */
function sinkWithRotateMarkers(
  logPath: string,
  errorLogPath: string,
  rotate: { maxBytes: number; maxFiles: number },
  async = false,
): { sink: RunEventSink; rotationList: SegmentRotationInfo[] } {
  const rotationList: SegmentRotationInfo[] = [];
  const sinkHolder: { sink?: RunEventSink } = {};
  const sink = createNdjsonFileSink(logPath, errorLogPath, {
    async,
    rotate,
    onSegmentRotate: (info) => {
      rotationList.push(info);
      // Exactly what `producer.ts`'s `logRotate` does: emit the event through
      // the same fan-out this callback is itself nested inside — the
      // reentrancy under test.
      sinkHolder.sink!.emit(rotateEventOf(info));
    },
  });
  sinkHolder.sink = sink;
  return { sink, rotationList };
}

describe('createNdjsonFileSink — the log.rotate marker', () => {
  it('a rotation with no deletion emits the marker naming sealed and live segments', async () => {
    const log = casePath('run.ndjson');
    const { sink, rotationList } = sinkWithRotateMarkers(log, casePath('run.error.ndjson'), {
      maxBytes: 2000,
      maxFiles: 100,
    });
    for (let index = 0; index < 13; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    expect(rotationList).toEqual([
      { sealedSegment: 0, liveSegment: 1, deletedSegment: undefined, maxBytes: 2000, maxFiles: 100 },
    ]);

    const segment1 = rawLinesOf(segmentPathFor(log, 1));
    expect(segment1[0]).toMatchObject({ event: 'log.rotate', sealed_segment: 0, live_segment: 1 });
    expect(segment1[0]).not.toHaveProperty('deleted_segment');
    expect(segment1[0]).not.toHaveProperty('severity');
  });

  it('the marker is the first line of the new segment, ahead of the line that triggered the roll', async () => {
    const log = casePath('run.ndjson');
    const { sink } = sinkWithRotateMarkers(log, casePath('run.error.ndjson'), {
      maxBytes: 2000,
      maxFiles: 100,
    });
    for (let index = 0; index < 13; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    // Segment 0 — the sealed one — carries none of it: the marker belongs to
    // the segment it is the first line of, never to the one it closes out.
    expect(rawLinesOf(log).map((line) => line['event'])).toEqual(
      Array.from({ length: 10 }, () => 'log'),
    );
    const segment1 = rawLinesOf(segmentPathFor(log, 1));
    expect(segment1.map((line) => line['event'])).toEqual(['log.rotate', 'log', 'log', 'log']);
    // The three "#10:"/"#11:"/"#12:" lines that follow, in the order emitted.
    expect(segment1.slice(1).map(markerOf)).toEqual([10, 11, 12]);
  });

  it('a rotation that deletes the oldest segment names the deleted one', async () => {
    const log = casePath('run.ndjson');
    const maxFiles = 3;
    const { sink, rotationList } = sinkWithRotateMarkers(log, casePath('run.error.ndjson'), {
      maxBytes: 2000,
      maxFiles,
    });
    // Comfortably more than enough 200-byte lines to roll past `maxFiles`
    // several times over, regardless of exactly how many real lines a
    // marker-bearing segment holds (the marker's own line costs a few of
    // those 2000 bytes too, so segment fill counts are not round numbers
    // once markers are in play — the assertions below don't depend on them).
    for (let index = 0; index < 200; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    expect(rotationList.length).toBeGreaterThan(maxFiles);
    const withoutDeletion = rotationList.filter((r) => r.deletedSegment === undefined);
    const withDeletion = rotationList.filter((r) => r.deletedSegment !== undefined);
    // Retention only bites once the run has produced more segments than
    // `maxFiles` allows; every rotation before that names no deletion.
    expect(withoutDeletion).toHaveLength(maxFiles - 1);
    // From there, every roll retires exactly the next-oldest surviving
    // segment — 0, then 1, then 2, … — never skipping and never repeating.
    expect(withDeletion.map((r) => r.deletedSegment)).toEqual(
      Array.from({ length: withDeletion.length }, (_, index) => index),
    );
    for (const rotation of withDeletion) {
      // What the event claims actually happened on disk — true forever, since
      // a segment once unlinked is never recreated.
      expect(fsSync.existsSync(segmentPathFor(log, rotation.deletedSegment!))).toBe(false);
    }
    // The marker's payload, checked against the segments that survived to the
    // end of the run — an earlier roll's `liveSegment` may itself have been
    // retired by a later one, so only the final survivors' first lines are
    // still there to read back.
    const survivingSegmentList = segmentIndexListOf(log);
    for (const rotation of withDeletion.filter((r) => survivingSegmentList.includes(r.liveSegment))) {
      const marker = rawLinesOf(segmentPathFor(log, rotation.liveSegment))[0]!;
      expect(marker).toMatchObject({
        event: 'log.rotate',
        deleted_segment: rotation.deletedSegment,
        severity: 'warn',
      });
    }
    // At least one survivor was actually checked above — otherwise the
    // assertion inside the loop would be vacuous.
    expect(withDeletion.some((r) => survivingSegmentList.includes(r.liveSegment))).toBe(true);
  });

  it('does not corrupt a line or recurse when rotating mid-burst, in sync mode', async () => {
    const log = casePath('run.ndjson');
    const total = 200;
    const { sink, rotationList } = sinkWithRotateMarkers(log, casePath('run.error.ndjson'), {
      maxBytes: 2000,
      maxFiles: 1000,
    });
    // A tight synchronous loop: every rotation in here fires `onSegmentRotate`
    // re-entrantly from inside this very `emit()` call, exactly the hazard
    // `ndjson-file-sink.ts`'s "The log.rotate marker" section describes.
    // Finishing at all (no stack overflow, no hang) is part of what this
    // asserts; the rest checks the file it produced is not corrupted.
    for (let index = 0; index < total; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    const segmentList = segmentIndexListOf(log);
    expect(segmentList.length).toBeGreaterThan(5); // several rolls actually happened
    expect(rotationList).toHaveLength(segmentList.length - 1);

    const all = allLinesOf(log);
    const rotateLines = all.filter((line) => line['event'] === 'log.rotate');
    const logLines = all.filter((line) => line['event'] === 'log');
    expect(rotateLines).toHaveLength(rotationList.length);
    // No event lost, none duplicated, none reordered — every JSON.parse above
    // would itself have thrown on a line spliced mid-write.
    expect(logLines.map(markerOf)).toEqual(Array.from({ length: total }, (_, index) => index));
    // Exactly one marker, as line zero, of every segment but the first.
    for (const index of segmentList.filter((each) => each > 0)) {
      const segmentLines = rawLinesOf(segmentPathFor(log, index));
      expect(segmentLines[0]!['event']).toBe('log.rotate');
      expect(segmentLines.slice(1).every((line) => line['event'] === 'log')).toBe(true);
    }
  });

  it('emits the marker correctly in buffered mode too', async () => {
    const log = casePath('run.ndjson');
    const total = 200;
    const { sink, rotationList } = sinkWithRotateMarkers(
      log,
      casePath('run.error.ndjson'),
      { maxBytes: 2000, maxFiles: 1000 },
      true,
    );
    for (let index = 0; index < total; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.flush?.();
    await sink.close?.();

    const segmentList = segmentIndexListOf(log);
    expect(segmentList.length).toBeGreaterThan(5);
    expect(rotationList).toHaveLength(segmentList.length - 1);

    const all = allLinesOf(log);
    const rotateLines = all.filter((line) => line['event'] === 'log.rotate');
    const logLines = all.filter((line) => line['event'] === 'log');
    expect(rotateLines).toHaveLength(rotationList.length);
    expect(logLines.map(markerOf)).toEqual(Array.from({ length: total }, (_, index) => index));
    for (const index of segmentList.filter((each) => each > 0)) {
      const segmentLines = rawLinesOf(segmentPathFor(log, index));
      expect(segmentLines[0]!['event']).toBe('log.rotate');
      expect(segmentLines.slice(1).every((line) => line['event'] === 'log')).toBe(true);
    }
  });

  it('a run that never rotates emits no log.rotate marker at all', async () => {
    const log = casePath('run.ndjson');
    const { sink, rotationList } = sinkWithRotateMarkers(log, casePath('run.error.ndjson'), {
      maxBytes: 1_000_000,
      maxFiles: 8,
    });
    for (let index = 0; index < 20; index += 1) {
      sink.emit(eventOfBytes(index, 200));
    }
    await sink.close?.();

    expect(rotationList).toEqual([]);
    expect(fsSync.readdirSync(caseDir)).toEqual(['run.ndjson']);
    expect(allLinesOf(log).some((line) => line['event'] === 'log.rotate')).toBe(false);
  });

  it('the error log rolling on its own does not emit a marker — onSegmentRotate is main-log only', async () => {
    // `createNdjsonFileSink` wires `onSegmentRotate` to the main writer alone
    // (see its own doc): the error log's independent rotation stays silent
    // exactly as it did before this kind existed.
    const log = casePath('run.ndjson');
    const errorLog = casePath('run.error.ndjson');
    const rotationList: SegmentRotationInfo[] = [];
    const sink = createNdjsonFileSink(log, errorLog, {
      rotate: { maxBytes: 2000, maxFiles: 100 },
      onSegmentRotate: (info) => rotationList.push(info),
    });
    for (let index = 0; index < 24; index += 1) {
      sink.emit(failureOfBytes(index, 200));
    }
    await sink.close?.();

    // The error log itself rolled (it receives every one of these failures
    // and nothing else), but only the main log's rolls are reported.
    expect(segmentIndexListOf(errorLog).length).toBeGreaterThan(1);
    // Every failure also lands in the main log (ACCEPT_ALL), which rolled
    // too — and *that* is what `rotationList` describes, never the error
    // log's own segment numbers.
    const mainSegmentCount = segmentIndexListOf(log).length;
    expect(mainSegmentCount).toBeGreaterThan(1);
    expect(rotationList).toHaveLength(mainSegmentCount - 1);
    expect(allLinesOf(errorLog).some((line) => line['event'] === 'log.rotate')).toBe(false);
  });
});
