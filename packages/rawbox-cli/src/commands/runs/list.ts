/**
 * `runs list [workspace]` — every run this project (or, with an explicit
 * `workspace`, one workspace) has recorded, with crash detection
 * (OBSERVABILITY.md, "CLI surfaces").
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { getErrorMessage } from '../../utils/error.js';
import { resolveStoreTarget } from '../../store/target.js';
import { classifyDisplayStatus } from '../../runs/classify.js';
import { colourStatus, formatAge, formatDurationMs, renderTable } from '../../runs/format.js';
import type { ProbeFn } from '../../runs/pid-probe.js';
import { probeProcess } from '../../runs/pid-probe.js';
import { listRegistryEntries } from '../../runs/registry-io.js';
import { findRunsDirectories } from '../../runs/scan.js';
import type { DisplayStatus } from '../../runs/types.js';
import type { RunRegistryEntry } from '../../runs/types.js';

export interface RunsListOptions {
  /**
   * The workspace whose runs to list, resolved exactly like `store list`'s
   * `<workspace>` argument (`../../store/target.js`'s `resolveStoreTarget`):
   * a workspace document, a directory holding exactly one, or a bare name
   * under a discovered data root. Omitted: scans project-wide from `cwd`.
   */
  workspace?: string;
  output?: 'text' | 'json';
  /** Test seam — overrides the real pid liveness probe. */
  probe?: ProbeFn;
  /** Test seam — overrides `process.cwd()` for the project-wide scan. */
  cwd?: string;
}

interface ListedRun extends RunRegistryEntry {
  displayStatus: DisplayStatus;
}

async function collectEntries(options: RunsListOptions): Promise<RunRegistryEntry[]> {
  if (options.workspace !== undefined) {
    // `resolveStoreTarget` rather than a bare "treat it as a document path":
    // it accepts a directory holding exactly one workspace document too, the
    // way `workspace status` and `store list` already do — and it *errors*
    // on a directory holding none, instead of silently listing no runs.
    const resolved = await resolveStoreTarget(options.workspace, options.cwd ?? process.cwd());
    if (resolved.isErr()) {
      throw new Error(resolved.error);
    }
    return listRegistryEntries(resolved.value.targetFolder);
  }

  const hitList = await findRunsDirectories(options.cwd ?? process.cwd());
  const perTargetFolder = await Promise.all(
    hitList.map((hit) => listRegistryEntries(hit.targetFolder)),
  );
  return perTargetFolder.flat();
}

function stepsCell(entry: RunRegistryEntry): string {
  if (entry.steps_total === undefined) {
    return '-';
  }
  const okCount = entry.steps_total - (entry.steps_failed ?? 0);
  return `${okCount}/${entry.steps_total}`;
}

export async function runsListCommand(options: RunsListOptions = {}): Promise<void> {
  const probe = options.probe ?? probeProcess;

  let entryList: RunRegistryEntry[];
  try {
    entryList = await collectEntries(options);
  } catch (error) {
    p.log.error(pc.red(`Failed to list runs: ${getErrorMessage(error)}`));
    process.exit(1);
    return;
  }

  const listedList: ListedRun[] = entryList
    .map((entry) => ({ ...entry, displayStatus: classifyDisplayStatus(entry, probe) }))
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));

  if (options.output === 'json') {
    console.log(JSON.stringify(listedList, null, 2));
    return;
  }

  if (listedList.length === 0) {
    p.log.info('No runs found.');
    return;
  }

  const rows: string[][] = [
    ['RUN ID', 'WORKFLOW', 'STATUS', 'AGE', 'DURATION', 'STEPS'],
    ...listedList.map((entry) => [
      entry.run_id,
      entry.workflow,
      colourStatus(entry.displayStatus),
      formatAge(entry.started_at),
      entry.duration_ms !== undefined ? formatDurationMs(entry.duration_ms) : '-',
      stepsCell(entry),
    ]),
  ];

  console.log(renderTable(rows));
}
