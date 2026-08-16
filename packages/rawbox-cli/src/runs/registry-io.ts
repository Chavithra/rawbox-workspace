/**
 * Reading and writing `<resolved target folder>/runs/<run-id>.json` — the run
 * registry files OBSERVABILITY.md, "The run registry" specifies.
 *
 * No locking, by design: each file is owned by exactly one process (the one
 * running it) for writes, and every reader (`runs list/show/tail/prune`)
 * opens it read-only, best-effort. A corrupt or half-written entry is skipped
 * rather than thrown, matching the framework's existing "observation must
 * never fail on a damaged artifact" posture (`ndjson-file-sink.ts`).
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getErrorMessage } from '../utils/error.js';
import type { RunRegistryEntry } from './types.js';

/** The subdirectory of a resolved target folder holding registry entries. */
export const RUNS_SUBDIR = 'runs';

/** `<targetFolder>/runs`. */
export function runsDirFor(targetFolder: string): string {
  return path.join(targetFolder, RUNS_SUBDIR);
}

/** `<targetFolder>/runs/<runId>.json`. */
export function registryFilePathFor(targetFolder: string, runId: string): string {
  return path.join(runsDirFor(targetFolder), `${runId}.json`);
}

/**
 * Writes a brand-new registry entry, creating `runs/` if needed.
 *
 * Synchronous and best-effort, like `ndjson-file-sink.ts`'s writes: called at
 * CLI entry, before the run's own event stream exists, so there is nowhere
 * to route a failure but a console warning — an unwritable registry must
 * never be what stops a run.
 */
export function writeRegistryEntrySync(filePath: string, entry: RunRegistryEntry): boolean {
  try {
    fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
    fsSync.writeFileSync(filePath, `${JSON.stringify(entry, null, 2)}\n`);
    return true;
  } catch (error) {
    console.error(
      `[rawbox] failed to write run registry entry "${filePath}": ${getErrorMessage(error)}`,
    );
    return false;
  }
}

/**
 * Reads, transforms and rewrites one registry entry — the shape
 * `createRunRegistrySink` (`registry-sink.ts`) needs for each lifecycle
 * transition. Synchronous, matching the `RunEventSink.emit` contract
 * (`sink.ts`: "synchronous and must not throw").
 *
 * A read/parse failure (the file went missing, or a concurrent `runs prune`
 * deleted it) is reported and skipped rather than thrown — losing one status
 * transition must never fail the run it describes.
 */
export function updateRegistryEntrySync(
  filePath: string,
  update: (entry: RunRegistryEntry) => RunRegistryEntry,
): boolean {
  try {
    const raw = fsSync.readFileSync(filePath, 'utf-8');
    const entry = JSON.parse(raw) as RunRegistryEntry;
    const nextEntry = update(entry);
    fsSync.writeFileSync(filePath, `${JSON.stringify(nextEntry, null, 2)}\n`);
    return true;
  } catch (error) {
    console.error(
      `[rawbox] failed to update run registry entry "${filePath}": ${getErrorMessage(error)}`,
    );
    return false;
  }
}

/** Reads one registry entry, or `undefined` if it is missing, unreadable or unparseable. */
export async function readRegistryEntry(
  filePath: string,
): Promise<RunRegistryEntry | undefined> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as RunRegistryEntry;
  } catch {
    return undefined;
  }
}

/**
 * Every registry entry under one target folder's `runs/` directory.
 *
 * An empty list when the directory does not exist yet — a workspace that has
 * never run a workflow — rather than an error.
 */
export async function listRegistryEntries(targetFolder: string): Promise<RunRegistryEntry[]> {
  const dir = runsDirFor(targetFolder);
  let fileList: string[];
  try {
    fileList = await fs.readdir(dir);
  } catch {
    return [];
  }

  const entryList: RunRegistryEntry[] = [];
  for (const file of fileList) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const entry = await readRegistryEntry(path.join(dir, file));
    if (entry) {
      entryList.push(entry);
    }
  }
  return entryList;
}
