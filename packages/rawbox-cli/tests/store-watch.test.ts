import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import type { BoxObserverLmdb } from '@rawbox/store/box-observer-lmdb';

import { storeWatchCommand } from '../src/commands/store/watch.js';

// ---------------------------------------------------------------------------
// `store watch` is built entirely on `BoxObserverLmdb`'s documented
// snapshot-hygiene contract: one observer opened for the whole watch, its
// synchronous methods called again on every poll, nothing held open in
// between (rawbox-store/README.md, "Observation — `peek` is not `get`"). This suite checks both halves of
// that: it actually detects a change a *different process* wrote, and its
// own reader slot never shows a pinned transaction — the growth hazard
// OBSERVABILITY.md, "Snapshot hygiene" calls out — across a sustained run against
// a busy writer. The second half is why this file legitimately takes ~50s:
// a short interference window could pass by accident.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-store-watch-test');
const WRITER_SCRIPT_PATH = path.join(__dirname, 'fixtures', 'store-writer.mjs');

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

interface WriterConfig {
  rootDirPath: string;
  workspace: string;
  workflow: string;
  key?: string;
  batchCount?: number;
  sleepMs?: number;
  readyFile?: string;
}

function runWriter(config: WriterConfig): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER_SCRIPT_PATH, JSON.stringify(config)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`writer exited ${String(code)}: ${stderr}`));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function seedWorkspace(name: string, workflow: string): Promise<string> {
  const workspaceDir = path.join(rootDir, name);
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, 'workspace.yaml'),
    `kind: Workspace\nname: ${name}\nworkflowPathList: []\n`,
    'utf-8',
  );

  const dataUrl = pathToFileURL(`${path.join(workspaceDir, '.rawbox', 'data')}/`);
  const store = BoxStoreLmdb.create(name, dataUrl);
  store.putSync({
    content: { sequence: -1 },
    location: {
      workspace: name,
      workflow,
      key: 'writer_state',
      strategy: { name: 'lmdb-kv', valueSizeMax: 8192 },
    },
  });
  await store.dbiCache.env.close();

  return workspaceDir;
}

describe('store watch', () => {
  it('detects a change written by a child process', async () => {
    const workspaceDir = await seedWorkspace('watch-detect', 'writer');

    const writes: string[] = [];
    const writerConfig: WriterConfig = {
      rootDirPath: path.join(workspaceDir, '.rawbox', 'data'),
      workspace: 'watch-detect',
      workflow: 'writer',
      batchCount: 5,
      sleepMs: 20,
    };

    const watchPromise = storeWatchCommand(workspaceDir, ['writer:writer_state'], {
      cwd: rootDir,
      interval: 30,
      maxPolls: 20,
      write: (text) => writes.push(text),
    });

    // Give the watch loop time to take its baseline poll before the writer starts.
    await sleep(50);
    await runWriter(writerConfig);

    await watchPromise;

    const combined = writes.join('');
    expect(combined).toContain('writer:writer_state changed');
  }, 30_000);

  it(
    'leaves no pinned MVCC snapshot across a sustained poll against a busy writer',
    async () => {
      const workspaceDir = await seedWorkspace('watch-interference', 'writer');

      const writerConfig: WriterConfig = {
        rootDirPath: path.join(workspaceDir, '.rawbox', 'data'),
        workspace: 'watch-interference',
        workflow: 'writer',
        batchCount: 500,
        sleepMs: 90, // ~45s of sustained writing
      };

      const writerDone = runWriter(writerConfig);

      const readerRowSnapshots: ReaderRow[][] = [];
      let sawChange = false;

      await storeWatchCommand(workspaceDir, ['writer:writer_state'], {
        cwd: rootDir,
        interval: 50,
        maxPolls: 1000, // 1000 * 50ms = 50s, comfortably covering the writer's ~45s run
        write: (text) => {
          if (text.includes('changed')) {
            sawChange = true;
          }
        },
        onPoll: (observer: BoxObserverLmdb) => {
          const readerListResult = observer.readerListSync();
          if (readerListResult.isOk()) {
            readerRowSnapshots.push(parseReaderList(readerListResult.value));
          }
        },
      });

      await writerDone;

      expect(sawChange).toBe(true);
      expect(readerRowSnapshots.length).toBeGreaterThan(100);

      // The load-bearing assertion: this process's own reader slot pins no
      // transaction at any poll boundary — `BoxObserverLmdb`'s `read()`
      // wrapper resets the shared read transaction in a `finally` after
      // every call, so between polls the slot must read `-`.
      for (const rowList of readerRowSnapshots) {
        for (const row of rowList) {
          if (row.pid === process.pid) {
            expect(row.txnid, JSON.stringify(row)).toBe('-');
          }
        }
      }
    },
    90_000,
  );
});
