/**
 * A standalone writer, run as a **child process** by the observer tests.
 *
 * It has to be a separate process, not an in-process store, for two reasons:
 *
 * 1. lmdb-js dedupes `MDB_env` handles by `(dev, inode)` within a process
 *    (`lmdb/src/env.cpp:85-117`, `checkExistingEnvs`). A read-only `open()`
 *    of a path already open read-write in the same process therefore hands
 *    back the *existing* environment and shares its reader bookkeeping — which
 *    would quietly mask exactly what the interference test is trying to
 *    measure.
 * 2. Observers are separate processes in the design
 *    (`@rawbox/runner`'s OBSERVABILITY.md, "The out-of-process observer").
 *    A test that
 *    never crosses a process boundary is not testing the deployed shape.
 *
 * It writes through the **built** `@rawbox/store`, not a hand-rolled copy of
 * the FIFO protocol: a writer that re-implemented `fifo:<key>:data:<n>` in the
 * test tree could agree with a broken peek and both be wrong together.
 *
 * Usage: `node store-writer.mjs '<json config>'`, writing one JSON summary
 * line to stdout on exit. Config fields:
 *
 *   rootDirPath   directory that contains the workspace environments
 *   workspace     environment name
 *   workflow      database name
 *   fifoKey       lmdb-fifo key to churn
 *   kvKey         lmdb-kv key to overwrite once per batch
 *   queueSizeMax  ring size for fifoKey
 *   valueSizeMax  per-value limit for both keys
 *   payloadBytes  filler bytes per queued element
 *   batchCount    number of batches
 *   batchSize     enqueue+dequeue pairs per batch
 *   sleepMs       pause between batches, spreading the run over wall time
 *   drainRatio    fraction of each batch's enqueues that are dequeued again
 *                 (1 = churn to a steady state, <1 = leave the queue filling)
 *   readyFile     optional path; created once the first batch has committed
 */

import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

const storeModuleUrl = new URL(
  '../../dist/box-store/box-store-lmdb.js',
  import.meta.url,
);

const { BoxStoreLmdb } = await import(storeModuleUrl.href);

const config = JSON.parse(process.argv[2] ?? '{}');

const {
  rootDirPath,
  workspace,
  workflow,
  fifoKey = 'writer_queue',
  kvKey = 'writer_state',
  queueSizeMax = 64,
  valueSizeMax = 8192,
  payloadBytes = 512,
  batchCount = 100,
  batchSize = 8,
  sleepMs = 2,
  drainRatio = 1,
  readyFile,
} = config;

const rootDirectoryUrl = pathToFileURL(
  rootDirPath.endsWith('/') ? rootDirPath : `${rootDirPath}/`,
);

const store = BoxStoreLmdb.create(workspace, rootDirectoryUrl);

const fifoLocation = {
  workspace,
  workflow,
  key: fifoKey,
  strategy: { name: 'lmdb-fifo', queueSizeMax, valueSizeMax },
};

const kvLocation = {
  workspace,
  workflow,
  key: kvKey,
  strategy: { name: 'lmdb-kv', valueSizeMax },
};

const payload = 'x'.repeat(payloadBytes);

/** Blocking sleep: keeps every batch one uninterrupted synchronous unit. */
function sleepSync(milliseconds) {
  if (milliseconds <= 0) {
    return;
  }

  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

let enqueued = 0;
let dequeued = 0;
let refused = 0;
let sequence = 0;

const drainPerBatch = Math.max(0, Math.round(batchSize * drainRatio));

for (let batch = 0; batch < batchCount; batch += 1) {
  for (let index = 0; index < batchSize; index += 1) {
    sequence += 1;

    const putResult = store.putSync({
      content: { seq: sequence, payload },
      location: fifoLocation,
    });

    if (putResult.isOk()) {
      enqueued += 1;
    } else {
      refused += 1;
    }
  }

  for (let index = 0; index < drainPerBatch; index += 1) {
    if (store.getSync(fifoLocation).isOk()) {
      dequeued += 1;
    }
  }

  store.putSync({
    content: { batch, sequence, at: Date.now() },
    location: kvLocation,
  });

  if (batch === 0 && readyFile) {
    writeFileSync(readyFile, String(process.pid));
  }

  sleepSync(sleepMs);
}

const summary = { enqueued, dequeued, refused, sequence, pid: process.pid };

try {
  store.dbiCache.env.close();
} catch {
  // Nothing to do: the process is exiting either way.
}

process.stdout.write(`${JSON.stringify(summary)}\n`);
