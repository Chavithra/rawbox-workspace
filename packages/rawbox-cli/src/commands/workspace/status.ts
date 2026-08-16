/**
 * `workspace status [path] [--watch [ms]] [--output json]` — one snapshot of
 * the whole system: every workflow the workspace document lists, its latest
 * run's liveness/age/log-tail, and a compact storage panel
 * (OBSERVABILITY.md, "CLI surfaces").
 *
 * `path` is resolved exactly like `store list`'s `<workspace>` argument
 * (`../../store/target.js`'s `resolveStoreTarget`) — a workspace document, a
 * directory holding exactly one, or a bare name under a discovered data
 * root — except a bare name is rejected here: this command needs
 * `workflowPathList`, which only a resolved *document* carries. Path omitted
 * defaults to the current directory, mirroring `workspace verify`'s own
 * "run it from the workspace directory" convention.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { getErrorMessage } from '../../utils/error.js';
import { colourStatus, formatDurationMs, renderTable } from '../../runs/format.js';
import type { ProbeFn } from '../../runs/pid-probe.js';
import { probeProcess } from '../../runs/pid-probe.js';
import { resolveStoreTarget, type StoreTarget } from '../../store/target.js';
import { ensureEpipeGuard } from '../../render/terminal-sink.js';
import {
  buildWorkspaceStatusSnapshot,
  type WorkspaceStatusSnapshot,
} from '../../workspace/status.js';

export interface WorkspaceStatusOptions {
  output?: 'text' | 'json';
  /** `--watch`: re-render on an interval instead of printing once. */
  watch?: boolean;
  /** Poll period in milliseconds, active only alongside `watch`. Defaults to 2000. */
  watchIntervalMs?: number;
  cwd?: string;
  probe?: ProbeFn;
  /** Test seam: bounds how many renders `--watch` performs before returning. */
  maxPolls?: number;
  /** Whether `--watch` clears the screen between renders. Default `true`; tests set `false`. */
  clearScreen?: boolean;
}

const DEFAULT_WATCH_INTERVAL_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stepsCell(run: WorkspaceStatusSnapshot['workflowList'][number]['latestRun']): string {
  if (run === undefined) {
    return '-';
  }
  return `${run.steps.ok}/${run.steps.ok + run.steps.failed}`;
}

/**
 * The `LAST EVENT` cell. When the tail's last line is a `run.heartbeat` —
 * "alive, blocked in a long step" rather than "just did something" — this
 * renders the step and how long it has been running instead of the bare
 * `run.heartbeat @<ts>` a generic render would show, which is the one piece
 * of information `workspace status` exists to surface here
 * (OBSERVABILITY.md, "`run.heartbeat`").
 */
function lastEventCell(run: WorkspaceStatusSnapshot['workflowList'][number]['latestRun']): string {
  if (run === undefined || run.lastEvent === undefined) {
    return '-';
  }
  if (run.heartbeat !== undefined) {
    return `in ${run.heartbeat.stepLabel} for ${formatDurationMs(run.heartbeat.inFlightMs)}`;
  }
  return `${run.lastEvent.event} @${run.lastEvent.ts}`;
}

function lastErrorCell(run: WorkspaceStatusSnapshot['workflowList'][number]['latestRun']): string {
  return run?.lastError?.message ?? '-';
}

/** Renders `snapshot` as the plain-text panel — one call per render, watch or not. */
function renderText(snapshot: WorkspaceStatusSnapshot): string {
  const lineList: string[] = [];
  lineList.push(`Workspace ${pc.cyan(`"${snapshot.workspace}"`)} — ${snapshot.targetFolder}`);
  lineList.push(pc.dim(`generated ${snapshot.generatedAt}`));
  lineList.push('');

  const rows: string[][] = [
    ['WORKFLOW', 'STATUS', 'AGE', 'LAST EVENT', 'STEPS', 'LAST ERROR'],
    ...snapshot.workflowList.map((workflow) => {
      if (workflow.latestRun === undefined) {
        return [
          workflow.workflowName,
          workflow.nameResolved ? 'never run' : pc.red('invalid document'),
          '-',
          '-',
          '-',
          workflow.loadError ?? '-',
        ];
      }
      const run = workflow.latestRun;
      return [
        workflow.workflowName,
        colourStatus(run.displayStatus),
        run.age,
        lastEventCell(run),
        stepsCell(run),
        lastErrorCell(run),
      ];
    }),
  ];
  lineList.push(renderTable(rows));

  lineList.push('');
  lineList.push(pc.bold('STORAGE'));
  if (snapshot.storageUnavailable !== undefined) {
    lineList.push(`  (no storage state yet: ${snapshot.storageUnavailable})`);
  } else if (snapshot.storage.length === 0) {
    lineList.push('  (no keys written yet)');
  } else {
    for (const workflowStorage of snapshot.storage) {
      lineList.push(`  ${pc.cyan(workflowStorage.workflow)}:`);
      if (workflowStorage.keyList.length === 0) {
        lineList.push('    (no keys)');
        continue;
      }
      const storageRows: string[][] = [
        ['KEY', 'STRATEGY', 'SIZE (bytes)', 'DEPTH'],
        ...workflowStorage.keyList.map((key) => [
          key.key,
          key.strategy,
          String(key.valueSizeBytes),
          key.fifo !== undefined ? String(key.fifo.depth) : '-',
        ]),
      ];
      for (const line of renderTable(storageRows).split('\n')) {
        lineList.push(`    ${line}`);
      }
    }
  }

  return lineList.join('\n');
}

export async function workspaceStatusCommand(
  pathArg: string | undefined,
  options: WorkspaceStatusOptions = {},
): Promise<void> {
  // A wide-open pipe closing early (`workspace status … | head`) is the
  // ordinary shape of piping this into something else — Node's default
  // reaction is to crash on the resulting EPIPE, so this installs the same
  // one-time swallowing guard `../../render/terminal-sink.js` uses for `run`.
  ensureEpipeGuard();

  const cwd = options.cwd ?? process.cwd();
  const probe = options.probe ?? probeProcess;

  const targetResult = await resolveStoreTarget(pathArg ?? '.', cwd);
  if (targetResult.isErr()) {
    p.log.error(pc.red(targetResult.error));
    process.exit(1);
    return;
  }
  const target = targetResult.value;

  if (target.workspaceDoc === undefined || target.workspaceDocPath === undefined) {
    p.log.error(
      pc.red(
        `"workspace status" needs to resolve the workspace document itself to know its ` +
          `workflowPathList — pass a path to the document or its directory, not a bare name.`,
      ),
    );
    process.exit(1);
    return;
  }
  const resolvedTarget = target as StoreTarget & {
    workspaceDoc: NonNullable<StoreTarget['workspaceDoc']>;
    workspaceDocPath: NonNullable<StoreTarget['workspaceDocPath']>;
  };

  const renderOnce = async (): Promise<void> => {
    let snapshot: WorkspaceStatusSnapshot;
    try {
      snapshot = await buildWorkspaceStatusSnapshot(resolvedTarget, { probe });
    } catch (error) {
      p.log.error(pc.red(`Failed to build workspace status: ${getErrorMessage(error)}`));
      process.exit(1);
      return;
    }

    if (options.output === 'json') {
      console.log(JSON.stringify(snapshot, null, 2));
      return;
    }
    console.log(renderText(snapshot));
  };

  if (!options.watch) {
    await renderOnce();
    return;
  }

  const intervalMs = options.watchIntervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
  let pollIndex = 0;
  // No `maxPolls`: re-renders until the process is stopped (Ctrl+C), the same
  // open-ended contract `runs tail --follow`/`store watch` use. Tests bound this.
  while (options.maxPolls === undefined || pollIndex < options.maxPolls) {
    if (pollIndex > 0 && options.clearScreen !== false) {
      // Clear + redraw, no TUI library — resets the terminal (`\x1Bc`) so
      // each render replaces the last rather than scrolling.
      process.stdout.write('\x1Bc');
    }
    await renderOnce();
    pollIndex += 1;

    if (options.maxPolls === undefined || pollIndex < options.maxPolls) {
      await sleep(intervalMs);
    }
  }
}
