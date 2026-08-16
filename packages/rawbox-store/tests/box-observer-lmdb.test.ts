import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from 'lmdb';

import { BoxObserverLmdb } from '../src/box-store/box-observer-lmdb.js';
import { BoxStoreLmdb } from '../src/box-store/box-store-lmdb.js';
import { type Box, type BoxLocation, type BoxStrategy } from '../src/box.js';

// ---------------------------------------------------------------------------
// What this file is defending
//
// Two failures, both silent, both only visible from outside the process:
//
// 1. **An observer that consumes.** Covered structurally in
//    `box-peek.test.ts`; here it is checked across a real process boundary,
//    against a writer that is running at the time, by reconciling the
//    writer's own enqueue/dequeue counters against the depth left behind. If
//    the observer had dequeued anything, the arithmetic would not close.
//
// 2. **An observer that pins an MVCC read snapshot.** A pinned snapshot stops
//    the *writers'* environment from reclaiming pages, so a parked observer
//    makes someone else's store grow without bound
//    (`@rawbox/runner`'s OBSERVABILITY.md, "Snapshot hygiene": an observer
//    MUST NOT hold a read snapshot open across an `await`). This is measured,
//    not argued: three
//    arms of identical write work — no observer, a polling `BoxObserverLmdb`,
//    and a deliberately pinned raw reader — with `data.mdb` growth compared
//    across them. The pinned arm is the sensitivity control; without it a
//    "no growth" assertion could pass because the workload never grew
//    anything.
// ---------------------------------------------------------------------------

const PACKAGE_ROOT_URL = new URL('../', import.meta.url);
const WRITER_SCRIPT_PATH = fileURLToPath(
  new URL('./fixtures/store-writer.mjs', import.meta.url),
);
const BUILT_STORE_PATH = fileURLToPath(
  new URL('./dist/box-store/box-store-lmdb.js', PACKAGE_ROOT_URL),
);

interface WriterConfig {
  readonly rootDirPath: string;
  readonly workspace: string;
  readonly workflow: string;
  readonly fifoKey?: string;
  readonly kvKey?: string;
  readonly queueSizeMax?: number;
  readonly valueSizeMax?: number;
  readonly payloadBytes?: number;
  readonly batchCount?: number;
  readonly batchSize?: number;
  readonly sleepMs?: number;
  readonly drainRatio?: number;
  readonly readyFile?: string;
}

interface WriterSummary {
  readonly enqueued: number;
  readonly dequeued: number;
  readonly refused: number;
  readonly sequence: number;
  readonly pid: number;
}

/** Runs the writer fixture in a child process and resolves with its summary. */
function runWriter(config: WriterConfig): Promise<WriterSummary> {
  return new Promise<WriterSummary>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WRITER_SCRIPT_PATH, JSON.stringify(config)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(JSON.parse(stdout.trim()) as WriterSummary);
      } else {
        reject(new Error(`writer exited ${String(code)}: ${stderr}`));
      }
    });
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * One row of LMDB's reader lock table: `pid`, thread, and the `txnid` of the
 * snapshot the slot pins — `-` when it pins none, which is the state every
 * slot of a healthy observer sits in between calls.
 */
interface ReaderRow {
  readonly pid: number;
  readonly txnid: string;
}

function parseReaderList(readerList: string): ReaderRow[] {
  const rowList: ReaderRow[] = [];

  for (const line of readerList.split('\n')) {
    const match = /^\s+(\d+)\s+(\S+)\s+(\S+)\s*$/.exec(line);

    if (match !== null && match[1] !== undefined && match[3] !== undefined) {
      rowList.push({ pid: Number(match[1]), txnid: match[3] });
    }
  }

  return rowList;
}

function dataFileSize(rootDirPath: string, workspace: string): number {
  return fs.statSync(path.join(rootDirPath, workspace, 'data.mdb')).size;
}

function makeRootDir(label: string): string {
  const rootDirPath = fileURLToPath(
    new URL(
      `./data/test-observer-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}/`,
      PACKAGE_ROOT_URL,
    ),
  );

  fs.mkdirSync(rootDirPath, { recursive: true });

  return rootDirPath;
}

function rootDirUrl(rootDirPath: string): URL {
  return new URL(
    `file://${rootDirPath.endsWith('/') ? rootDirPath : `${rootDirPath}/`}`,
  );
}

beforeAll(() => {
  // The child writer imports the *built* package, deliberately: a test that
  // hand-rolled the FIFO protocol could agree with a broken peek. `tsc
  // --build` is incremental and a no-op when dist is current, so paying for
  // it here costs nothing and removes "did you build first?" as a way for
  // this suite to fail.
  try {
    execFileSync('npx', ['tsc', '--build'], {
      cwd: fileURLToPath(PACKAGE_ROOT_URL),
      stdio: 'pipe',
    });
  } catch (error) {
    // Tolerated only when a build already exists — `build:all` runs before
    // `test:all` in the repository's own verification, and a transient
    // contention with a concurrent build should not fail this suite when the
    // artefact it needs is already on disk.
    if (!fs.existsSync(BUILT_STORE_PATH)) {
      throw error;
    }
  }

  expect(fs.existsSync(BUILT_STORE_PATH)).toBe(true);
}, 180_000);

// ---------------------------------------------------------------------------

describe('openSync guardrails', () => {
  let rootDirPath: string;

  beforeAll(() => {
    rootDirPath = makeRootDir('guardrails');
  });

  afterAll(async () => {
    await fsp.rm(rootDirPath, { recursive: true, force: true });
  });

  it('reports a workspace that has never been written, and creates nothing', () => {
    const result = BoxObserverLmdb.openSync(
      'never-existed',
      rootDirUrl(rootDirPath),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('never-existed');
    expect(result._unsafeUnwrapErr()).toContain('data.mdb');

    // Not incidental. `open()` mkdir -p's its path on the way to failing
    // (lmdb/open.js:138), so an observer that just called it would leave a
    // directory behind in a workspace nobody has ever run.
    expect(fs.existsSync(path.join(rootDirPath, 'never-existed'))).toBe(false);
  });

  it('reports an environment directory with no data file', () => {
    fs.mkdirSync(path.join(rootDirPath, 'half-there'), { recursive: true });

    const result = BoxObserverLmdb.openSync(
      'half-there',
      rootDirUrl(rootDirPath),
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('data.mdb');
    expect(fs.readdirSync(path.join(rootDirPath, 'half-there'))).toEqual([]);
  });

  it('opens an environment that exists but holds no workflow yet', () => {
    const store = BoxStoreLmdb.create('bare', rootDirUrl(rootDirPath));
    void store.dbiCache.env.close();

    const observerResult = BoxObserverLmdb.openSync(
      'bare',
      rootDirUrl(rootDirPath),
    );

    expect(observerResult.isOk()).toBe(true);

    const observer = observerResult._unsafeUnwrap();

    try {
      expect(observer.listWorkflowsSync()._unsafeUnwrap()).toEqual([]);

      // A workflow that does not exist is an error, not a created database:
      // `openDB` on a read-only environment omits MDB_CREATE.
      const missing = observer.listKeysSync('no-such-workflow');
      expect(missing.isErr()).toBe(true);
      expect(missing._unsafeUnwrapErr()).toContain('no-such-workflow');
    } finally {
      observer.closeSync();
    }
  });

  it('confirms the read-only store has no usable write method', () => {
    // The runtime half of the "cannot write" guarantee, asserted rather than
    // assumed: lmdb-js skips `addWriteMethods` entirely when `readOnly` is
    // set (lmdb/open.js:541), so these are `undefined` rather than refused.
    const store = BoxStoreLmdb.create('droppable', rootDirUrl(rootDirPath));
    store.putSync({
      content: 'keep-me',
      location: {
        workspace: 'droppable',
        workflow: 'wf',
        key: 'survivor',
        strategy: { name: 'lmdb-kv', valueSizeMax: 1024 },
      },
    });
    void store.dbiCache.env.close();

    const env = open({
      path: path.join(rootDirPath, 'droppable'),
      cache: false,
      readOnly: true,
    });
    const readOnlyRoot = env as unknown as Record<string, unknown>;

    try {
      for (const method of [
        'put',
        'putSync',
        'remove',
        'removeSync',
        'drop',
        'transaction',
        'transactionSync',
        'ifVersion',
        'batch',
      ]) {
        expect(readOnlyRoot[method], method).toBeUndefined();
      }

      // `dropSync` and `clearSync` are the exception, and worth pinning down
      // rather than glossing: they live on the base prototype
      // (lmdb/open.js:461, 477) and so *exist* on a read-only store. They are
      // inert all the same, because their first act is `this.transactionSync`
      // — which `addWriteMethods` never installed. Asserted here so that a
      // future lmdb-js making them functional under MDB_RDONLY fails loudly
      // in this suite instead of quietly widening what an observer can do.
      const dbi = env.openDB({
        name: 'wf',
        cache: false,
        compression: true,
        encoding: 'msgpack',
      }) as unknown as Record<string, unknown>;

      for (const method of ['dropSync', 'clearSync']) {
        expect(typeof dbi[method], method).toBe('function');
        expect(() => (dbi[method] as () => void)()).toThrow();
      }

      expect(
        (dbi as unknown as { get: (k: string) => unknown }).get('survivor'),
      ).toBe('keep-me');
    } finally {
      void (env as unknown as { close: () => unknown }).close();
    }

    // And it survived in the file, not merely in a cache.
    const reopened = BoxStoreLmdb.create('droppable', rootDirUrl(rootDirPath));

    try {
      expect(
        reopened
          .peekSync({
            workspace: 'droppable',
            workflow: 'wf',
            key: 'survivor',
            strategy: { name: 'lmdb-kv', valueSizeMax: 1024 },
          })
          ._unsafeUnwrap(),
      ).toBe('keep-me');
    } finally {
      void reopened.dbiCache.env.close();
    }
  });
});

// ---------------------------------------------------------------------------

describe('read-only inspection of a populated workspace', () => {
  const WORKSPACE = 'live-trading';
  const GRID = 'grid';
  const RECONCILER = 'reconciler';

  const KV: BoxStrategy = { name: 'lmdb-kv', valueSizeMax: 4096 };
  const QUEUE: BoxStrategy = {
    name: 'lmdb-fifo',
    queueSizeMax: 4,
    valueSizeMax: 4096,
  };

  let rootDirPath: string;
  let observer: BoxObserverLmdb;

  function locate(
    workflow: string,
    key: string,
    strategy: BoxStrategy,
  ): BoxLocation {
    return { workspace: WORKSPACE, workflow, key, strategy };
  }

  const wrappedQueue = () => locate(GRID, 'order_queue', QUEUE);

  beforeAll(() => {
    rootDirPath = makeRootDir('populated');

    const store = BoxStoreLmdb.create(WORKSPACE, rootDirUrl(rootDirPath));
    const put = (location: BoxLocation, content: unknown): void => {
      const result = store.putSync({ content, location } as Box<unknown>);
      expect(result.isOk(), JSON.stringify(result)).toBe(true);
    };

    put(locate(GRID, 'grid_state', KV), { level: 7, side: 'buy' });
    put(locate(RECONCILER, 'last_run', KV), 'never');

    // Fill, drain, refill so the live window straddles ring index 0. This is
    // the state a naive sorted-key read gets wrong.
    put(wrappedQueue(), 'o1');
    put(wrappedQueue(), 'o2');
    put(wrappedQueue(), 'o3');
    expect(store.getSync(wrappedQueue())._unsafeUnwrap()).toBe('o1');
    expect(store.getSync(wrappedQueue())._unsafeUnwrap()).toBe('o2');
    put(wrappedQueue(), 'o4');
    put(wrappedQueue(), 'o5');

    // Closed before the observer opens: lmdb-js dedupes environments by
    // (dev, inode) within a process (lmdb/src/env.cpp:85-117), so leaving the
    // read-write handle open would hand the observer that same environment
    // and quietly skip the MDB_RDONLY path this describe is about.
    void store.dbiCache.env.close();

    observer = BoxObserverLmdb.openSync(
      WORKSPACE,
      rootDirUrl(rootDirPath),
    )._unsafeUnwrap();
  });

  afterAll(async () => {
    observer.closeSync();
    await fsp.rm(rootDirPath, { recursive: true, force: true });
  });

  it('lists the workflows as databases of the workspace environment', () => {
    expect(observer.listWorkflowsSync()._unsafeUnwrap()).toEqual([
      GRID,
      RECONCILER,
    ]);
  });

  it('classifies a mixed kv + fifo workflow without leaking derived keys', () => {
    const inspection = observer.listKeysSync(GRID)._unsafeUnwrap();

    expect(inspection.map((e) => `${e.key}/${e.strategy}`)).toEqual([
      'grid_state/lmdb-kv',
      'order_queue/lmdb-fifo',
    ]);

    const queue = inspection.find((e) => e.strategy === 'lmdb-fifo');
    expect(queue?.fifo?.depth).toBe(3);
    expect(queue?.fifo?.tail).toBe(2);
    expect(queue?.fifo?.head).toBe(1); // wrapped: head is behind tail
    expect(queue?.fifo?.ringIndexMax).toBe(3);
    expect(queue?.valueSizeBytes).toBeGreaterThan(0);
  });

  it('peeks a wrapped FIFO in enqueue order', () => {
    expect(observer.peekSync(wrappedQueue())._unsafeUnwrap()).toBe('o3');
    expect(observer.peekAllSync(wrappedQueue())._unsafeUnwrap()).toEqual([
      'o3',
      'o4',
      'o5',
    ]);
    expect(observer.depthSync(wrappedQueue())._unsafeUnwrap()).toEqual({
      used: 3,
      capacity: 3,
    });
  });

  it('peeks a kv cell in another workflow of the same workspace', () => {
    expect(
      observer.peekSync(locate(RECONCILER, 'last_run', KV))._unsafeUnwrap(),
    ).toBe('never');
  });

  it('refuses a location addressed at a different workspace', () => {
    const foreign: BoxLocation = {
      ...locate(GRID, 'grid_state', KV),
      workspace: 'paper-trading',
    };

    const result = observer.peekSync(foreign);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('paper-trading');
  });

  it('keeps no MVCC snapshot pinned between calls', () => {
    // `readerList()` is a direct `mdb_reader_list` call and starts no read
    // transaction of its own (lmdb/open.js:493), so what it reports here is
    // the state the *previous* call left behind.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      observer.peekAllSync(wrappedQueue());
      observer.listKeysSync(GRID);
      observer.peekSync(locate(GRID, 'grid_state', KV));
    }

    const rowList = parseReaderList(
      observer.readerListSync()._unsafeUnwrap(),
    );

    // One slot for this process, not one per call: `mdb_txn_reset` releases
    // the snapshot and keeps the slot for reuse.
    expect(rowList.length).toBeLessThanOrEqual(2);

    for (const row of rowList) {
      expect(row.txnid, JSON.stringify(row)).toBe('-');
    }
  });

  it('pins no snapshot after a call that failed', () => {
    // The error path is the one most likely to leak a snapshot: it leaves
    // early, possibly mid-scan. `read()` resets in a `finally` precisely so
    // that a failure costs a wrong answer and not a growing store.
    observer.peekSync({
      ...locate(GRID, 'grid_state', KV),
      workspace: 'wrong-workspace',
    });
    observer.listKeysSync('no-such-workflow');
    observer.peekSync(locate(GRID, 'no_such_key', KV));
    observer.depthSync(locate(GRID, 'grid_state', KV));
    observer.peekAllSync({
      ...wrappedQueue(),
      strategy: { name: 'lmdb-fifo', queueSizeMax: 2, valueSizeMax: 4096 },
    });

    for (const row of parseReaderList(
      observer.readerListSync()._unsafeUnwrap(),
    )) {
      expect(row.txnid, JSON.stringify(row)).toBe('-');
    }
  });

  it('leaves the physical database byte-identical after all of the above', () => {
    // Reopened read-write only now, after every observer assertion above has
    // run, so this reads what the observer left behind.
    observer.closeSync();

    const store = BoxStoreLmdb.create(WORKSPACE, rootDirUrl(rootDirPath));

    try {
      const dbi = store.dbiCache.getOrCreateDbi(GRID)._unsafeUnwrap();
      const physical: Array<[string, string]> = [];

      for (const key of dbi.getKeys()) {
        const bytes = dbi.getBinary(key);
        physical.push([String(key), bytes?.toString('hex') ?? '<absent>']);
      }

      expect(physical).toEqual([
        ['fifo:order_queue:data:0', expect.any(String)],
        ['fifo:order_queue:data:2', expect.any(String)],
        ['fifo:order_queue:data:3', expect.any(String)],
        ['fifo:order_queue:head', expect.any(String)],
        ['fifo:order_queue:tail', expect.any(String)],
        ['grid_state', expect.any(String)],
      ]);

      // And the consumer still gets exactly what the observer said it would.
      expect(store.getSync(wrappedQueue())._unsafeUnwrap()).toBe('o3');
      expect(store.getSync(wrappedQueue())._unsafeUnwrap()).toBe('o4');
      expect(store.getSync(wrappedQueue())._unsafeUnwrap()).toBe('o5');
      expect(store.getSync(wrappedQueue())._unsafeUnwrapErr()).toBe(
        'Queue empty',
      );
    } finally {
      void store.dbiCache.env.close();
    }
  });

  it('refuses every call once closed, and closes idempotently', () => {
    observer.closeSync();
    observer.closeSync();

    expect(observer.peekSync(wrappedQueue())._unsafeUnwrapErr()).toContain(
      'closed',
    );
    expect(observer.listWorkflowsSync()._unsafeUnwrapErr()).toContain('closed');
    expect(observer.listKeysSync(GRID)._unsafeUnwrapErr()).toContain('closed');
  });
});

// ---------------------------------------------------------------------------

describe('observing a workspace a child process is writing to', () => {
  const WORKSPACE = 'busy';
  const WORKFLOW = 'producer';
  const FIFO_KEY = 'writer_queue';
  const KV_KEY = 'writer_state';
  const QUEUE_SIZE_MAX = 256;
  const PAYLOAD_BYTES = 128;

  let rootDirPath: string;

  beforeAll(() => {
    rootDirPath = makeRootDir('busy');
  });

  afterAll(async () => {
    await fsp.rm(rootDirPath, { recursive: true, force: true });
  });

  it(
    'peeks and enumerates throughout, consuming nothing',
    async () => {
      const readyFile = path.join(rootDirPath, 'writer.ready');
      const writerConfig: WriterConfig = {
        rootDirPath,
        workspace: WORKSPACE,
        workflow: WORKFLOW,
        fifoKey: FIFO_KEY,
        kvKey: KV_KEY,
        queueSizeMax: QUEUE_SIZE_MAX,
        payloadBytes: PAYLOAD_BYTES,
        batchCount: 60,
        batchSize: 8,
        sleepMs: 15,
        // Enqueue 8, dequeue 4 per batch: the queue is never empty after the
        // first batch and never reaches its ring limit, so `enqueued -
        // dequeued` is an exact prediction of the depth left behind.
        drainRatio: 0.5,
        readyFile,
      };

      const writerDone = runWriter(writerConfig);

      while (!fs.existsSync(readyFile)) {
        await sleep(10);
      }

      const observer = BoxObserverLmdb.openSync(
        WORKSPACE,
        rootDirUrl(rootDirPath),
      )._unsafeUnwrap();

      const fifoLocation: BoxLocation = {
        workspace: WORKSPACE,
        workflow: WORKFLOW,
        key: FIFO_KEY,
        strategy: {
          name: 'lmdb-fifo',
          queueSizeMax: QUEUE_SIZE_MAX,
          valueSizeMax: 8192,
        },
      };
      const kvLocation: BoxLocation = {
        workspace: WORKSPACE,
        workflow: WORKFLOW,
        key: KV_KEY,
        strategy: { name: 'lmdb-kv', valueSizeMax: 8192 },
      };

      const problemList: string[] = [];
      const observedSeqList: number[] = [];
      let observations = 0;
      let writerFinished = false;

      void writerDone.then(() => {
        writerFinished = true;
      });

      try {
        while (!writerFinished) {
          observations += 1;

          const peeked = observer.peekSync(fifoLocation);

          if (peeked.isErr()) {
            problemList.push(`peek: ${peeked.error}`);
          }

          const all = observer.peekAllSync(fifoLocation);

          if (all.isErr()) {
            problemList.push(`peekAll: ${all.error}`);
          } else {
            const seqList = all.value.map(
              (element) => (element as { seq: number }).seq,
            );

            // Every element parses, and the sequence numbers are contiguous
            // and increasing. That is the FIFO invariant, and it can only
            // hold if `head`, `tail` and all the elements came from **one**
            // MVCC snapshot: a peekAll that renewed its read transaction
            // mid-scan would see a dequeue land underneath it and produce a
            // gap.
            for (const element of all.value) {
              const typed = element as { seq: number; payload: string };
              expect(typeof typed.seq).toBe('number');
              expect(typed.payload).toHaveLength(PAYLOAD_BYTES);
            }

            for (let index = 1; index < seqList.length; index += 1) {
              if (seqList[index] !== (seqList[index - 1] ?? 0) + 1) {
                problemList.push(
                  `torn snapshot: ${String(seqList[index - 1])} -> ${String(seqList[index])}`,
                );
              }
            }

            const firstSeq = seqList[0];

            if (peeked.isOk() && firstSeq !== undefined) {
              // Deliberately *not* an equality. Each observer call takes a
              // fresh snapshot — that is the whole point of resetting the
              // read transaction — so a dequeue can land between the `peek`
              // and the `peekAll` above. What must always hold is direction:
              // the queue only ever advances, so the earlier call can never
              // have seen a *later* element than the later call.
              const peekedSeq = (peeked.value as { seq: number }).seq;
              expect(peekedSeq).toBeLessThanOrEqual(firstSeq);
              observedSeqList.push(peekedSeq);
            }
          }

          const depth = observer.depthSync(fifoLocation);

          if (depth.isErr()) {
            problemList.push(`depth: ${depth.error}`);
          }

          const state = observer.peekSync(kvLocation);

          if (state.isErr()) {
            problemList.push(`kv: ${state.error}`);
          } else {
            expect(
              typeof (state.value as { sequence: number }).sequence,
            ).toBe('number');
          }

          const workflowList = observer.listWorkflowsSync();

          if (workflowList.isErr()) {
            problemList.push(`workflows: ${workflowList.error}`);
          } else {
            expect(workflowList.value).toContain(WORKFLOW);
          }

          const keyList = observer.listKeysSync(WORKFLOW);

          if (keyList.isErr()) {
            problemList.push(`keys: ${keyList.error}`);
          } else {
            expect(keyList.value.map((e) => e.key).sort()).toEqual([
              FIFO_KEY,
              KV_KEY,
            ]);
          }

          await sleep(20);
        }
      } finally {
        observer.closeSync();
      }

      const summary = await writerDone;

      expect(problemList).toEqual([]);
      expect(observations).toBeGreaterThan(10);
      expect(summary.refused).toBe(0);

      // Freshness, which is the other half of releasing the snapshot: an
      // observer that pinned one would keep reporting the element it saw
      // first, forever, and this would be a flat line. It has to move.
      const firstObserved = observedSeqList[0] ?? 0;
      const lastObserved = observedSeqList[observedSeqList.length - 1] ?? 0;
      expect(lastObserved).toBeGreaterThan(firstObserved);

      // The load-bearing assertion. The writer counted every enqueue and
      // every dequeue it performed. If a single observation had consumed an
      // element, the depth left behind would be short by that many.
      const store = BoxStoreLmdb.create(WORKSPACE, rootDirUrl(rootDirPath));

      try {
        const remaining = store.depthSync(fifoLocation)._unsafeUnwrap();
        expect(remaining.used).toBe(summary.enqueued - summary.dequeued);

        const remainingAll = store.peekAllSync(fifoLocation)._unsafeUnwrap();
        expect(remainingAll).toHaveLength(remaining.used);

        // Nothing is missing from the middle either: the surviving sequence
        // numbers run contiguously up to the last one the writer produced.
        const seqList = remainingAll.map(
          (element) => (element as { seq: number }).seq,
        );
        expect(seqList[seqList.length - 1]).toBe(summary.sequence);

        for (let index = 1; index < seqList.length; index += 1) {
          expect(seqList[index]).toBe((seqList[index - 1] ?? 0) + 1);
        }
      } finally {
        void store.dbiCache.env.close();
      }
    },
    120_000,
  );

  it(
    'sees a workflow that first appears after the observer opened',
    async () => {
      const workspace = 'late-workflow';

      await runWriter({
        rootDirPath,
        workspace,
        workflow: 'first',
        batchCount: 3,
        batchSize: 2,
        sleepMs: 0,
      });

      const observer = BoxObserverLmdb.openSync(
        workspace,
        rootDirUrl(rootDirPath),
      )._unsafeUnwrap();

      try {
        expect(observer.listWorkflowsSync()._unsafeUnwrap()).toEqual(['first']);
        expect(observer.listKeysSync('second').isErr()).toBe(true);

        // A workflow's first run is the moment its database comes into
        // existence. An observer attached beforehand — the normal case for a
        // supervisor watching a workspace — has to pick it up, which it only
        // does because each call starts a fresh read transaction rather than
        // reusing the snapshot the environment was opened on.
        await runWriter({
          rootDirPath,
          workspace,
          workflow: 'second',
          batchCount: 3,
          batchSize: 2,
          sleepMs: 0,
        });

        expect(observer.listWorkflowsSync()._unsafeUnwrap()).toEqual([
          'first',
          'second',
        ]);
        expect(
          observer.listKeysSync('second')._unsafeUnwrap().map((e) => e.key),
        ).toEqual(['writer_queue', 'writer_state']);
      } finally {
        observer.closeSync();
      }
    },
    120_000,
  );

  it(
    'does not accumulate stale reader slots across successive writers',
    async () => {
      const workspace = 'reader-churn';

      await runWriter({
        rootDirPath,
        workspace,
        workflow: WORKFLOW,
        batchCount: 5,
        batchSize: 4,
        sleepMs: 0,
      });

      const observer = BoxObserverLmdb.openSync(
        workspace,
        rootDirUrl(rootDirPath),
      )._unsafeUnwrap();

      try {
        for (let round = 0; round < 5; round += 1) {
          const writerDone = runWriter({
            rootDirPath,
            workspace,
            workflow: WORKFLOW,
            batchCount: 20,
            batchSize: 4,
            sleepMs: 2,
          });

          while (true) {
            observer.listKeysSync(WORKFLOW);

            const rowList = parseReaderList(
              observer.readerListSync()._unsafeUnwrap(),
            );

            // A dead or idle slot is harmless — it pins nothing. A slot
            // holding a `txnid` is the growth hazard, and the only process
            // entitled to hold one is a writer mid-transaction, never this
            // observer between calls.
            for (const row of rowList) {
              if (row.pid === process.pid) {
                expect(row.txnid, JSON.stringify(row)).toBe('-');
              }
            }

            const settled = await Promise.race([
              writerDone.then(() => true),
              sleep(25).then(() => false),
            ]);

            if (settled) {
              break;
            }
          }
        }

        const rowList = parseReaderList(
          observer.readerListSync()._unsafeUnwrap(),
        );

        // Five writers came and went; the table holds slots, not a slot per
        // process that ever attached.
        expect(rowList.length).toBeLessThanOrEqual(4);
      } finally {
        observer.closeSync();
      }
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------

describe('interference: a polling observer must not unbound the store', () => {
  const WORKFLOW = 'churn';

  let rootDirPath: string;

  /**
   * Identical write work in every arm: a ring churned to a steady state, so
   * a store that reclaims its freed pages stays the size it started and one
   * that cannot reclaim them grows monotonically.
   */
  const WRITER_BASE = {
    workflow: WORKFLOW,
    queueSizeMax: 64,
    valueSizeMax: 8192,
    payloadBytes: 512,
    batchSize: 8,
    sleepMs: 2,
    drainRatio: 1,
  } as const;

  /** ~20 s of sustained writing at 2 ms per batch. */
  const SUSTAINED_BATCH_COUNT = 1800;

  /** The pinned arm blows up in seconds; it does not need the full window. */
  const PINNED_BATCH_COUNT = 300;

  beforeAll(() => {
    rootDirPath = makeRootDir('interference');
  });

  afterAll(async () => {
    await fsp.rm(rootDirPath, { recursive: true, force: true });
  });

  type ObserverMode = 'none' | 'polling' | 'pinned';

  interface ArmResult {
    readonly growthBytes: number;
    readonly polls: number;
    readonly elapsedMs: number;
    readonly readerRowList: ReaderRow[];
  }

  async function runArm(
    workspace: string,
    batchCount: number,
    mode: ObserverMode,
  ): Promise<ArmResult> {
    // Warm the environment up first so the measurement window starts from a
    // steady-state file rather than from initial allocation.
    await runWriter({
      ...WRITER_BASE,
      rootDirPath,
      workspace,
      batchCount: 40,
      sleepMs: 0,
    });

    const sizeBefore = dataFileSize(rootDirPath, workspace);
    const startedAt = Date.now();

    const writerDone = runWriter({
      ...WRITER_BASE,
      rootDirPath,
      workspace,
      batchCount,
    });

    let observer: BoxObserverLmdb | undefined;
    let rawEnv: ReturnType<typeof open> | undefined;
    let pinnedTransaction: { done: () => void } | undefined;
    let timer: NodeJS.Timeout | undefined;
    let polls = 0;
    let readerRowList: ReaderRow[] = [];

    const fifoLocation: BoxLocation = {
      workspace,
      workflow: WORKFLOW,
      key: 'writer_queue',
      strategy: {
        name: 'lmdb-fifo',
        queueSizeMax: WRITER_BASE.queueSizeMax,
        valueSizeMax: WRITER_BASE.valueSizeMax,
      },
    };

    if (mode !== 'none') {
      await sleep(200);
    }

    if (mode === 'polling') {
      observer = BoxObserverLmdb.openSync(
        workspace,
        rootDirUrl(rootDirPath),
      )._unsafeUnwrap();

      timer = setInterval(() => {
        polls += 1;
        observer?.peekSync(fifoLocation);
        observer?.peekAllSync(fifoLocation);
        observer?.listKeysSync(WORKFLOW);
      }, 50);
    }

    if (mode === 'pinned') {
      // What the observer API makes unreachable, done by hand: a raw
      // read-only environment with one `useReadTransaction()` never handed
      // back. `BoxObserverLmdb` cannot be driven into this state — it exposes
      // no transaction, no iterator and no asynchronous read — so the arm has
      // to reach past it to produce the failure it is calibrating against.
      rawEnv = open({
        path: path.join(rootDirPath, workspace),
        cache: false,
        readOnly: true,
      });

      const dbi = rawEnv.openDB({
        name: WORKFLOW,
        cache: false,
        compression: true,
        encoding: 'msgpack',
      });

      pinnedTransaction = rawEnv.useReadTransaction() as unknown as {
        done: () => void;
      };
      dbi.get('writer_state');
      polls = 1;
    }

    await writerDone;

    const elapsedMs = Date.now() - startedAt;

    if (timer !== undefined) {
      clearInterval(timer);
    }

    if (observer !== undefined) {
      readerRowList = parseReaderList(observer.readerListSync()._unsafeUnwrap());
      observer.closeSync();
    }

    if (rawEnv !== undefined) {
      readerRowList = parseReaderList(rawEnv.readerList());

      try {
        pinnedTransaction?.done();
      } catch {
        void 0;
      }

      void rawEnv.close();
    }

    return {
      growthBytes: dataFileSize(rootDirPath, workspace) - sizeBefore,
      polls,
      elapsedMs,
      readerRowList,
    };
  }

  it(
    'matches a no-observer control, while a pinned reader does not',
    async () => {
      const control = await runArm(
        'arm-control',
        SUSTAINED_BATCH_COUNT,
        'none',
      );
      const polling = await runArm(
        'arm-polling',
        SUSTAINED_BATCH_COUNT,
        'polling',
      );
      const pinned = await runArm('arm-pinned', PINNED_BATCH_COUNT, 'pinned');

      // Printed, not merely asserted: the three figures are the evidence the
      // README's growth claim rests on, and a reviewer should be able to read
      // them off a test run rather than take them on trust.
      console.log(
        `[interference] control ${control.growthBytes}B/${control.elapsedMs}ms  ` +
          `polling ${polling.growthBytes}B/${polling.elapsedMs}ms/${polling.polls} polls  ` +
          `pinned ${pinned.growthBytes}B/${pinned.elapsedMs}ms`,
      );

      // The window really was sustained, and really was polled at ~50 ms.
      expect(control.elapsedMs).toBeGreaterThan(15_000);
      expect(polling.elapsedMs).toBeGreaterThan(15_000);
      expect(polling.polls).toBeGreaterThan(200);

      // A churned ring reaches a steady state: the control does not grow.
      expect(control.growthBytes).toBeLessThan(1_000_000);

      // The measurement is only meaningful if it *can* detect the failure.
      // A pinned snapshot, in a sixth of the wall time, must blow past both
      // the control and the polling arm by orders of magnitude — if this
      // assertion ever fails, the two above have stopped proving anything.
      expect(pinned.growthBytes).toBeGreaterThan(10_000_000);
      expect(pinned.growthBytes).toBeGreaterThan(
        Math.max(polling.growthBytes, 1) * 20,
      );

      // And the claim itself: polling for twenty seconds costs the writers
      // a bounded handful of pages, not unbounded growth.
      expect(polling.growthBytes).toBeLessThan(4_000_000);
      expect(polling.growthBytes).toBeLessThan(control.growthBytes + 4_000_000);

      // The polling observer pins nothing once its last call has returned.
      for (const row of polling.readerRowList) {
        if (row.pid === process.pid) {
          expect(row.txnid, JSON.stringify(row)).toBe('-');
        }
      }

      // ...and the pinned arm is the same table entry, holding a snapshot —
      // proving the assertion above is reading a real signal.
      expect(
        pinned.readerRowList.some(
          (row) => row.pid === process.pid && row.txnid !== '-',
        ),
      ).toBe(true);
    },
    300_000,
  );
});
