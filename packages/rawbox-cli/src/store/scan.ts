/**
 * Finding a workspace's LMDB data root from nothing but a starting directory
 * — what lets `store list <name>` work with a bare workspace name rather than
 * a document path, the same "no flag needed for the common case" convenience
 * `runs/scan.ts` gives `runs show`/`runs tail`.
 *
 * A bounded recursive walk down from the starting directory, skipping
 * `node_modules`/`.git` and never descending *into* a `.rawbox` directory once
 * found (mirrors `runs/scan.ts`'s own walk, generalised from `runs/` to
 * `data/` — the two are kept as separate small files rather than one
 * parameterised over the marker its callers were never asked to share).
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Directory names never descended into while scanning for `.rawbox/data`. */
const SKIP_NAME_SET = new Set(['node_modules', '.git']);

/** Safety valve: total directory entries inspected before the walk gives up. */
const MAX_ENTRIES_VISITED = 20_000;

/** The `.rawbox` marker directory this walk looks for. */
const TARGET_FOLDER_MARKER = '.rawbox';

/** One workspace's resolved target folder and its `data/` directory, both found under a scan root. */
export interface DataDirHit {
  /** The resolved target folder — a `.rawbox` directory, conventionally. */
  targetFolder: string;
  /** `<targetFolder>/data` — the root `BoxObserverLmdb.openSync` resolves a workspace name under. */
  dataDir: string;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every `<targetFolder>/data` directory found under `rootDir`, bounded by
 * {@link MAX_ENTRIES_VISITED} total entries read.
 */
export async function findDataDirectories(rootDir: string): Promise<DataDirHit[]> {
  const hitList: DataDirHit[] = [];
  let visited = 0;

  async function walk(directory: string): Promise<void> {
    if (visited >= MAX_ENTRIES_VISITED) {
      return;
    }

    let entryList: import('node:fs').Dirent[];
    try {
      entryList = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    visited += entryList.length;

    if (path.basename(directory) === TARGET_FOLDER_MARKER) {
      const dataDir = path.join(directory, 'data');
      if (await isDirectory(dataDir)) {
        hitList.push({ targetFolder: directory, dataDir });
      }
      // Never descend into `.rawbox` itself — `runs/`, `node_modules/`,
      // `logs/` are either large or irrelevant to this scan.
      return;
    }

    for (const entry of entryList) {
      if (visited >= MAX_ENTRIES_VISITED) {
        return;
      }
      if (!entry.isDirectory() || SKIP_NAME_SET.has(entry.name)) {
        continue;
      }
      await walk(path.join(directory, entry.name));
    }
  }

  await walk(path.resolve(rootDir));
  return hitList;
}
