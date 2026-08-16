import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RUN_EVENT,
  SEVERITY,
  createNdjsonFileSink,
  type RunEvent,
  type RunEventSink,
  type SegmentRotationInfo,
} from '@rawbox/runner';

import {
  initTailState,
  readAllMerged,
  readNewEvents,
  type LogSource,
  type TailState,
} from '../src/workspace/log-merge.js';
import { listLogSegments, segmentPathFor } from '../src/workspace/log-segments.js';

// ---------------------------------------------------------------------------
// Writer and reader, together — the join the whole segment plan hangs on.
//
// `log-segments.test.ts` pins the readers against segments laid down by hand;
// `@rawbox/runner`'s `ndjson-rotation.test.ts` pins the writer against files
// read back by hand. Neither can catch the two disagreeing about what a
// segment is called or when one ends. This file is the only place the real
// sink's output is fed to the real readers, so it is where a drift between
// `<run>.error.1.ndjson` and `<run>.1.error.ndjson`, or a segment sealed
// mid-line, actually surfaces.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-log-rotation-e2e-test');

const RUN_ID = 'run-1770000000000-abcde';

let caseDir: string;
let caseCounter = 0;

beforeEach(async () => {
  caseCounter += 1;
  caseDir = path.join(rootDir, `case-${caseCounter}`);
  await fs.mkdir(caseDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

/**
 * One `log` event of exactly `bytes`, whose `seq` identifies it wherever it
 * lands and whose `ts` increases with it, so the merge reader's ordering is
 * exercised rather than accidentally satisfied.
 */
function eventOfBytes(seq: number, bytes: number): RunEvent {
  const build = (message: string): RunEvent =>
    ({
      ts: `2026-08-15T10:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000Z`,
      run_id: RUN_ID,
      workspace: 'my-workspace',
      workflow: 'example',
      event: RUN_EVENT.LOG,
      level: 'info',
      message,
    }) as RunEvent;
  const marker = `#${seq}:`;
  const overhead = Buffer.byteLength(JSON.stringify(build(marker))) + 1;
  const event = build(`${marker}${'a'.repeat(bytes - overhead)}`);
  if (Buffer.byteLength(JSON.stringify(event)) + 1 !== bytes) {
    throw new Error(`could not build a ${bytes}-byte line for seq ${seq}`);
  }
  return event;
}

/** A failure-shaped event of exactly `bytes` — the error log's filtered view. */
function failureOfBytes(seq: number, bytes: number): RunEvent {
  const build = (message: string): RunEvent =>
    ({
      ts: `2026-08-15T11:${String(Math.floor(seq / 60)).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000Z`,
      run_id: RUN_ID,
      workspace: 'my-workspace',
      workflow: 'example',
      event: RUN_EVENT.BOOTSTRAP_ERROR,
      stage: 'resolve',
      message,
      severity: SEVERITY.ERROR,
    }) as RunEvent;
  const marker = `#${seq}:`;
  const overhead = Buffer.byteLength(JSON.stringify(build(marker))) + 1;
  const event = build(`${marker}${'a'.repeat(bytes - overhead)}`);
  if (Buffer.byteLength(JSON.stringify(event)) + 1 !== bytes) {
    throw new Error(`could not build a ${bytes}-byte failure line for seq ${seq}`);
  }
  return event;
}

/** The `#N` marker of every event a reader produced, in the order it produced them. */
function markerListOf(eventList: readonly { event: Record<string, unknown> }[]): number[] {
  return eventList.map((merged) => {
    const message = String(merged.event['message'] ?? '');
    const match = /^#(\d+):/.exec(message);
    if (!match) {
      throw new Error(`a reader produced an unmarked event: ${JSON.stringify(merged.event)}`);
    }
    return Number(match[1]);
  });
}

function sourceFor(logPath: string): LogSource {
  return { runId: RUN_ID, workflow: 'example', logPath };
}

function ascending(count: number, from = 0): number[] {
  return Array.from({ length: count }, (_, index) => index + from);
}

/**
 * `producer.ts`'s `logRotate`, restated as a pure function — this file's
 * writer-side counterpart to `ndjson-rotation.test.ts`'s own copy. `ts` is a
 * fixed placeholder rather than something derived from a sequence number:
 * `readNewEvents` (unlike `readAllMerged`) never re-sorts by `ts`, it returns
 * events in the order it read them off disk, so the marker's position in a
 * merged read is decided entirely by where the writer put its line — which is
 * exactly the property under test here.
 */
function rotateEventOf(info: SegmentRotationInfo): RunEvent {
  return {
    ts: '2026-08-15T09:00:00.000Z',
    run_id: RUN_ID,
    workspace: 'my-workspace',
    workflow: 'example',
    event: RUN_EVENT.LOG_ROTATE,
    sealed_segment: info.sealedSegment,
    live_segment: info.liveSegment,
    ...(info.deletedSegment === undefined ? {} : { deleted_segment: info.deletedSegment }),
    max_bytes: info.maxBytes,
    max_files: info.maxFiles,
    ...(info.deletedSegment === undefined ? {} : { severity: SEVERITY.WARN }),
  } as RunEvent;
}

/** Wires `onSegmentRotate` exactly as `run-workflow.ts` wires the real producer callback. */
function sinkWithRotateMarkers(
  logPath: string,
  errorLogPath: string,
  rotate: { maxBytes: number; maxFiles: number },
): { sink: ReturnType<typeof createNdjsonFileSink>; rotationList: SegmentRotationInfo[] } {
  const rotationList: SegmentRotationInfo[] = [];
  const sinkHolder: { sink?: RunEventSink } = {};
  const sink = createNdjsonFileSink(logPath, errorLogPath, {
    rotate,
    onSegmentRotate: (info) => {
      rotationList.push(info);
      sinkHolder.sink!.emit(rotateEventOf(info));
    },
  });
  sinkHolder.sink = sink;
  return { sink, rotationList };
}

describe('rotation end to end — the sink writes, the CLI readers read', () => {
  it('reads back exactly the events emitted, in order, across nine segments', async () => {
    const logPath = path.join(caseDir, `${RUN_ID}.ndjson`);
    const sink = createNdjsonFileSink(logPath, path.join(caseDir, `${RUN_ID}.error.ndjson`), {
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });
    for (const seq of ascending(87)) {
      sink.emit(eventOfBytes(seq, 200));
    }
    await sink.close?.();

    // The enumeration the readers do, against the files the sink actually
    // produced — nine segments, oldest first, segment 0 still named `log_path`.
    const segmentList = await listLogSegments(logPath);
    expect(segmentList.map((each) => path.basename(each))).toEqual([
      `${RUN_ID}.ndjson`,
      ...ascending(8, 1).map((index) => `${RUN_ID}.${index}.ndjson`),
    ]);

    const { events, state } = await readNewEvents(initTailState(sourceFor(logPath)));
    expect(markerListOf(events)).toEqual(ascending(87));
    // Left standing on the live segment, with nothing carried over: every
    // segment ended at a line boundary, so no fragment survived a crossing.
    expect(state.cursor.segment).toBe(8);
    expect(state.leftover).toBe('');

    // And the whole-file reader (`workspace logs` without `-f`) agrees.
    expect(markerListOf((await readAllMerged([sourceFor(logPath)])).eventList)).toEqual(
      ascending(87),
    );
  });

  it('carries a log.rotate marker at every segment boundary of a merged read', async () => {
    const logPath = path.join(caseDir, `${RUN_ID}.ndjson`);
    const errorLogPath = path.join(caseDir, `${RUN_ID}.error.ndjson`);
    const { sink, rotationList } = sinkWithRotateMarkers(logPath, errorLogPath, {
      maxBytes: 2000,
      maxFiles: 100,
    });
    for (const seq of ascending(87)) {
      sink.emit(eventOfBytes(seq, 200));
    }
    await sink.close?.();

    expect(rotationList.length).toBeGreaterThan(3);
    const segmentList = await listLogSegments(logPath);
    expect(rotationList).toHaveLength(segmentList.length - 1);

    const { events } = await readNewEvents(initTailState(sourceFor(logPath)));
    const kindList = events.map((merged) => String(merged.event['event']));

    // Every marker the writer fired reached the merged read, none lost and
    // none duplicated; the real `#N` stream underneath is untouched by them —
    // still every one of 0..86, in order.
    expect(kindList.filter((kind) => kind === 'log.rotate')).toHaveLength(rotationList.length);
    expect(markerListOf(events.filter((merged) => merged.event['event'] === 'log'))).toEqual(
      ascending(87),
    );

    // And each marker sits exactly where it belongs: as the very first event
    // of the segment it names `live_segment`, ahead of every real line that
    // segment holds — walked against `listLogSegments`, the same enumeration
    // `workspace logs`/`runs tail` read.
    let cursor = 0;
    for (const [liveIndex, segmentPath] of segmentList.entries()) {
      const lineCount = (await fs.readFile(segmentPath, 'utf-8'))
        .split('\n')
        .filter((line) => line.length > 0).length;
      if (liveIndex > 0) {
        expect(kindList[cursor]).toBe('log.rotate');
        expect(events[cursor]!.event['live_segment']).toBe(liveIndex);
        expect(events[cursor]!.event['sealed_segment']).toBe(liveIndex - 1);
      }
      cursor += lineCount;
    }
    expect(cursor).toBe(events.length);
  });

  it('a run that never rotates carries no log.rotate marker in the merged read', async () => {
    const logPath = path.join(caseDir, `${RUN_ID}.ndjson`);
    const errorLogPath = path.join(caseDir, `${RUN_ID}.error.ndjson`);
    const { sink, rotationList } = sinkWithRotateMarkers(logPath, errorLogPath, {
      maxBytes: 1_000_000,
      maxFiles: 8,
    });
    for (const seq of ascending(10)) {
      sink.emit(eventOfBytes(seq, 200));
    }
    await sink.close?.();

    expect(rotationList).toEqual([]);
    const { events } = await readNewEvents(initTailState(sourceFor(logPath)));
    expect(events.some((merged) => merged.event['event'] === 'log.rotate')).toBe(false);
    expect(markerListOf(events)).toEqual(ascending(10));
  });

  it('follows a live run across a roll without repeating or skipping an event', async () => {
    // `runs tail` / `workspace logs -f`: poll, then let the writer roll, then
    // poll again. The reader must pick up the tail of the sealed segment and
    // the start of its successor exactly once each.
    const logPath = path.join(caseDir, `${RUN_ID}.ndjson`);
    const sink = createNdjsonFileSink(logPath, path.join(caseDir, `${RUN_ID}.error.ndjson`), {
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });

    let state: TailState = initTailState(sourceFor(logPath));
    const seen: number[] = [];
    for (let batch = 0; batch < 6; batch += 1) {
      for (const offset of ascending(7)) {
        sink.emit(eventOfBytes(batch * 7 + offset, 200));
      }
      const poll = await readNewEvents(state);
      state = poll.state;
      seen.push(...markerListOf(poll.events));
    }
    await sink.close?.();
    const final = await readNewEvents(state);
    seen.push(...markerListOf(final.events));

    expect(seen).toEqual(ascending(42));
    // Four rolls happened underneath that tail.
    expect((await listLogSegments(logPath)).length).toBe(5);
  });

  it('reads a run whose oldest segments the sink retired, starting at the lowest survivor', async () => {
    const logPath = path.join(caseDir, `${RUN_ID}.ndjson`);
    const sink = createNdjsonFileSink(logPath, path.join(caseDir, `${RUN_ID}.error.ndjson`), {
      rotate: { maxBytes: 2000, maxFiles: 3 },
    });
    for (const seq of ascending(45)) {
      sink.emit(eventOfBytes(seq, 200));
    }
    await sink.close?.();

    expect((await listLogSegments(logPath)).map((each) => path.basename(each))).toEqual([
      `${RUN_ID}.2.ndjson`,
      `${RUN_ID}.3.ndjson`,
      `${RUN_ID}.4.ndjson`,
    ]);
    // The retained window, and nothing but it — a low-end gap is an ordinary
    // state, not damage.
    const { events } = await readNewEvents(initTailState(sourceFor(logPath)));
    expect(markerListOf(events)).toEqual(ascending(25, 20));
    await expect(fs.stat(logPath)).rejects.toThrow();
  });

  it('reads the rotated error log as its own sequence, not as part of the main one', async () => {
    const logPath = path.join(caseDir, `${RUN_ID}.ndjson`);
    const errorLogPath = path.join(caseDir, `${RUN_ID}.error.ndjson`);
    const sink = createNdjsonFileSink(logPath, errorLogPath, {
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });
    for (const seq of ascending(20)) {
      sink.emit(eventOfBytes(seq, 200));
    }
    for (const seq of ascending(15, 20)) {
      sink.emit(failureOfBytes(seq, 200));
    }
    await sink.close?.();

    expect((await listLogSegments(errorLogPath)).map((each) => path.basename(each))).toEqual([
      `${RUN_ID}.error.ndjson`,
      `${RUN_ID}.error.1.ndjson`,
    ]);
    // Segment 1 of the main log is not mistaken for a segment of the error log
    // and vice versa: the two enumerations are disjoint and complete.
    expect(markerListOf((await readNewEvents(initTailState(sourceFor(errorLogPath)))).events))
      .toEqual(ascending(15, 20));
    expect(markerListOf((await readNewEvents(initTailState(sourceFor(logPath)))).events))
      .toEqual(ascending(35));
  });

  it('reads back a run written in buffered mode identically to a synchronous one', async () => {
    const syncLog = path.join(caseDir, `${RUN_ID}.ndjson`);
    const asyncDir = path.join(caseDir, 'buffered');
    await fs.mkdir(asyncDir, { recursive: true });
    const asyncLog = path.join(asyncDir, `${RUN_ID}.ndjson`);

    const syncSink = createNdjsonFileSink(syncLog, path.join(caseDir, `${RUN_ID}.error.ndjson`), {
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });
    const asyncSink = createNdjsonFileSink(
      asyncLog,
      path.join(asyncDir, `${RUN_ID}.error.ndjson`),
      { async: true, rotate: { maxBytes: 2000, maxFiles: 100 } },
    );
    for (const seq of ascending(120)) {
      const event = eventOfBytes(seq, 200);
      syncSink.emit(event);
      asyncSink.emit(event);
    }
    await syncSink.close?.();
    await asyncSink.flush?.();
    await asyncSink.close?.();

    // Same segmentation, same bytes in each — `logs.async` trades when a line
    // reaches disk, never which segment it belongs to.
    const syncSegmentList = await listLogSegments(syncLog);
    const asyncSegmentList = await listLogSegments(asyncLog);
    expect(asyncSegmentList.map((each) => path.basename(each))).toEqual(
      syncSegmentList.map((each) => path.basename(each)),
    );
    for (const [index, segmentPath] of syncSegmentList.entries()) {
      expect(await fs.readFile(asyncSegmentList[index]!, 'utf-8')).toBe(
        await fs.readFile(segmentPath, 'utf-8'),
      );
    }
    expect(
      markerListOf((await readNewEvents(initTailState(sourceFor(asyncLog)))).events),
    ).toEqual(ascending(120));
  });

  it('keeps segment 0 the path that names the run', async () => {
    // The run registry writes `log_path` before the first line and never
    // updates it, so every reader above starts from that one path.
    const logPath = path.join(caseDir, `${RUN_ID}.ndjson`);
    const sink = createNdjsonFileSink(logPath, path.join(caseDir, `${RUN_ID}.error.ndjson`), {
      rotate: { maxBytes: 2000, maxFiles: 100 },
    });
    for (const seq of ascending(30)) {
      sink.emit(eventOfBytes(seq, 200));
    }
    await sink.close?.();

    expect(segmentPathFor(logPath, 0)).toBe(logPath);
    const segment0 = await fs.readFile(logPath, 'utf-8');
    expect(segment0.split('\n').slice(0, -1)).toHaveLength(10);
  });
});
