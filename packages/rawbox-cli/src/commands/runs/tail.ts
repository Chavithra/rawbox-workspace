/**
 * `runs tail <run-id> [-f]` — prints (and optionally follows) a run's NDJSON
 * log without the caller ever needing to know its path
 * (OBSERVABILITY.md, "CLI surfaces").
 *
 * "Its path" is a sequence of segments when the run rotated
 * (`../../workspace/log-segments.js`), and this command walks it the same way
 * `workspace logs -f` does — through the one enumerator, so `runs tail` cannot
 * end up showing only the run's oldest file. What it does *not* do is parse:
 * bytes are written through verbatim, malformed lines included, which is the
 * difference between this command and `workspace logs`.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { getErrorMessage } from '../../utils/error.js';
import { readRegistryEntry } from '../../runs/registry-io.js';
import { findRunRegistryFile } from '../../runs/scan.js';
import {
  INITIAL_SEGMENT_CURSOR,
  readNewSegmentBytes,
  type SegmentCursor,
} from '../../workspace/log-segments.js';

export interface RunsTailOptions {
  /** `-f`/`--follow`: keep printing appended lines until the process is stopped. */
  follow?: boolean;
  cwd?: string;
  /** Where output goes. Defaults to `process.stdout.write`; tests capture instead. */
  write?: (text: string) => void;
  /** How often `--follow` polls for new bytes. */
  pollIntervalMs?: number;
  /**
   * Test seam: bounds how many polls `--follow` performs before returning,
   * instead of looping until the process is killed.
   */
  maxPolls?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runsTailCommand(
  runId: string,
  options: RunsTailOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  let registryFilePath: string | undefined;
  try {
    registryFilePath = await findRunRegistryFile(runId, cwd);
  } catch (error) {
    p.log.error(pc.red(`Failed to search for run "${runId}": ${getErrorMessage(error)}`));
    process.exit(1);
    return;
  }

  if (registryFilePath === undefined) {
    p.log.error(pc.red(`No run registry entry found for "${runId}" under ${cwd}.`));
    process.exit(1);
    return;
  }

  const entry = await readRegistryEntry(registryFilePath);
  if (entry === undefined) {
    p.log.error(pc.red(`Run registry entry "${registryFilePath}" could not be read.`));
    process.exit(1);
    return;
  }

  const logFilePath = entry.log_path;
  let cursor: SegmentCursor = INITIAL_SEGMENT_CURSOR;

  const printNewContent = async (): Promise<void> => {
    const result = await readNewSegmentBytes(logFilePath, cursor);
    cursor = result.cursor;
    for (const chunk of result.chunkList) {
      if (chunk.text.length > 0) {
        write(chunk.text);
      }
    }
  };

  await printNewContent();

  if (!options.follow) {
    return;
  }

  const pollIntervalMs = options.pollIntervalMs ?? 250;
  let pollCount = 0;
  // No `maxPolls`: follows until the process is stopped (Ctrl+C), the
  // conventional `tail -f` contract. Tests bound this with `maxPolls`.
  while (options.maxPolls === undefined || pollCount < options.maxPolls) {
    await sleep(pollIntervalMs);
    await printNewContent();
    pollCount += 1;
  }
}
