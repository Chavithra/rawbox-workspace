/**
 * `runs show <run-id>` — the registry entry plus a short summary derived from
 * its NDJSON log: event counts, the last event, the last error
 * (OBSERVABILITY.md, "CLI surfaces").
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { getErrorMessage } from '../../utils/error.js';
import { classifyDisplayStatus } from '../../runs/classify.js';
import { colourStatus, formatAge, formatDurationMs } from '../../runs/format.js';
import { summarizeRunLog } from '../../runs/log-summary.js';
import type { ProbeFn } from '../../runs/pid-probe.js';
import { probeProcess } from '../../runs/pid-probe.js';
import { readRegistryEntry } from '../../runs/registry-io.js';
import { findRunRegistryFile } from '../../runs/scan.js';

export interface RunsShowOptions {
  output?: 'text' | 'json';
  probe?: ProbeFn;
  cwd?: string;
}

export async function runsShowCommand(
  runId: string,
  options: RunsShowOptions = {},
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const probe = options.probe ?? probeProcess;

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

  const displayStatus = classifyDisplayStatus(entry, probe);
  const summary = await summarizeRunLog(entry.log_path, entry.error_log_path);

  if (options.output === 'json') {
    console.log(JSON.stringify({ entry: { ...entry, displayStatus }, summary }, null, 2));
    return;
  }

  console.log(`run           ${entry.run_id}`);
  console.log(`workspace     ${entry.workspace}`);
  console.log(`workflow      ${entry.workflow}`);
  console.log(`status        ${colourStatus(displayStatus)}`);
  console.log(`started       ${entry.started_at} (${formatAge(entry.started_at)} ago)`);
  if (entry.ended_at !== undefined) {
    console.log(`ended         ${entry.ended_at}`);
  }
  if (entry.duration_ms !== undefined) {
    console.log(`duration      ${formatDurationMs(entry.duration_ms)}`);
  }
  if (entry.steps_total !== undefined) {
    console.log(`steps         ${entry.steps_total - (entry.steps_failed ?? 0)}/${entry.steps_total} ok`);
  }
  console.log(`pid           ${entry.pid}`);
  console.log(`log           ${entry.log_path}`);
  console.log(`error log     ${entry.error_log_path}`);
  if (entry.error !== undefined) {
    console.log(pc.red(`error         ${entry.error.message}`));
  }

  console.log('');
  console.log(`log events    ${summary.totalEvents} total${summary.readable ? '' : ' (log not readable)'}`);
  for (const [kind, count] of Object.entries(summary.eventCounts)) {
    console.log(`  ${kind.padEnd(18)} ${count}`);
  }
  if (summary.lastEvent !== undefined) {
    console.log(`last event    ${JSON.stringify(summary.lastEvent)}`);
  }
  if (summary.lastError !== undefined) {
    console.log(pc.red(`last error    ${summary.lastError.message}`));
  }
}
