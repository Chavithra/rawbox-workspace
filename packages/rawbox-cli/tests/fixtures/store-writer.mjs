/**
 * A standalone writer, run as a **child process** by `store-watch.test.ts` —
 * a separate process so the test exercises `store watch` the way it is
 * actually deployed: an out-of-process reader against a live writer
 * (OBSERVABILITY.md, "The out-of-process observer"), not two handles inside one process.
 *
 * Writes through the real `@rawbox/store` write API, resolved as an ordinary
 * workspace dependency (no `dist` URL trick needed here — unlike
 * `rawbox-store`'s own fixture, `rawbox-cli` already depends on
 * `@rawbox/store` for its own commands, so the bare specifier resolves the
 * same way it does for the code under test).
 *
 * Usage: `node store-writer.mjs '<json config>'`. Config fields:
 *
 *   rootDirPath   directory holding `<workspace>/data.mdb`
 *   workspace     environment name
 *   workflow      database name
 *   key           the kv key to overwrite repeatedly
 *   batchCount    number of writes
 *   sleepMs       pause between writes, spreading them over wall time
 *   valueSizeMax  the kv strategy's declared limit
 *   readyFile     optional path, created once the first write has committed
 */

import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';

const config = JSON.parse(process.argv[2] ?? '{}');

const {
  rootDirPath,
  workspace,
  workflow,
  key = 'writer_state',
  batchCount = 20,
  sleepMs = 10,
  valueSizeMax = 8192,
  readyFile,
} = config;

const rootDirectoryUrl = pathToFileURL(
  rootDirPath.endsWith('/') ? rootDirPath : `${rootDirPath}/`,
);

const store = BoxStoreLmdb.create(workspace, rootDirectoryUrl);

const location = {
  workspace,
  workflow,
  key,
  strategy: { name: 'lmdb-kv', valueSizeMax },
};

function sleepSync(milliseconds) {
  if (milliseconds <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

for (let sequence = 0; sequence < batchCount; sequence += 1) {
  const result = store.putSync({ content: { sequence }, location });
  if (result.isErr()) {
    console.error(`write failed: ${result.error}`);
    process.exitCode = 1;
    break;
  }

  if (sequence === 0 && readyFile !== undefined) {
    writeFileSync(readyFile, 'ready');
  }

  sleepSync(sleepMs);
}

await store.dbiCache.env.close();
