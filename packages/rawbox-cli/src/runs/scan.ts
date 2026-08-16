/**
 * Finding a workspace's `runs/` directory (or a single run within it) from
 * nothing but a starting directory — what lets `runs show <run-id>` and
 * `runs tail <run-id>` work with no `--workspace` at all, and what lets
 * `runs list` default to a project-wide view rather than a single
 * discovered workspace (OBSERVABILITY.md, "CLI surfaces").
 *
 * A bounded recursive walk down from the starting directory, skipping
 * `node_modules`/`.git` entirely and never descending *into* a `.rawbox`
 * directory once found (its `data/`, `node_modules/`, `logs/` siblings are
 * either large, irrelevant, or both) — only checking it for a `runs/`
 * subdirectory.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Directory names never descended into while scanning for `.rawbox/runs`. */
const SKIP_NAME_SET = new Set(['node_modules', '.git']);

/** Safety valve: total directory entries inspected before the walk gives up. */
const MAX_ENTRIES_VISITED = 20_000;

/** The `.rawbox` marker directory this walk looks for. */
const TARGET_FOLDER_MARKER = '.rawbox';

/** One workspace's resolved target folder and its `runs/` directory, both found under a scan root. */
export interface RunsDirHit {
  /** The resolved target folder — a `.rawbox` directory, conventionally. */
  targetFolder: string;
  /** `<targetFolder>/runs`. */
  runsDir: string;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Every `<targetFolder>/runs` directory found under `rootDir`, bounded by
 * {@link MAX_ENTRIES_VISITED} total entries read.
 */
export async function findRunsDirectories(rootDir: string): Promise<RunsDirHit[]> {
  const hitList: RunsDirHit[] = [];
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
      const runsDir = path.join(directory, 'runs');
      if (await isDirectory(runsDir)) {
        hitList.push({ targetFolder: directory, runsDir });
      }
      // Never descend into `.rawbox` itself — `data/`, `node_modules/`,
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

/**
 * Finds `<some .rawbox found under rootDir>/runs/<runId>.json`, or
 * `undefined` if no such file exists under any `.rawbox` reachable from
 * `rootDir`.
 */
export async function findRunRegistryFile(
  runId: string,
  rootDir: string,
): Promise<string | undefined> {
  const hitList = await findRunsDirectories(rootDir);
  for (const hit of hitList) {
    const candidate = path.join(hit.runsDir, `${runId}.json`);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Not under this workspace's runs/ directory — keep looking.
    }
  }
  return undefined;
}
