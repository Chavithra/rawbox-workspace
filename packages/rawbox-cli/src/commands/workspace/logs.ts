/**
 * `workspace logs [path] [-f] [--workflow w…] [--since t] [--run id…]
 * [--output json]` — NDJSON event streams merged by timestamp, one line per
 * event, prefixed and coloured per workflow (OBSERVABILITY.md, "CLI surfaces",
 * the `docker compose logs` shape).
 *
 * **Run selection**, tried in this order:
 *
 * 1. `--run <id>…` — exactly those runs, by registry id, **including
 *    finished ones**. A requested id with no registry entry is a hard error
 *    naming it, never a silent drop.
 * 2. `--since <t>` — every run whose lifetime overlaps `[t, now]`: a run
 *    still live counts (its `ended_at` is absent, i.e. "still running" is
 *    treated as "ends now"), and a finished run counts if it ended at or
 *    after `t`. `t` is a plain ISO-8601 instant or a relative shorthand
 *    (`15m`, `2h`, `90s`, `1d`) measured back from now. **This is the
 *    post-mortem path, and it is not optional**: reconstructing what
 *    happened across several already-finished workflows is the scenario
 *    this command exists for, and it must merge those runs exactly as it
 *    would merge live ones (`../../workspace/log-merge.js`'s own framing).
 * 3. Neither given (the default) — every run the registry reports
 *    `running`/`bootstrapping` **with a verified live pid**, i.e. "what is
 *    happening right now".
 *
 * `--workflow <name>…` narrows whichever of the above was selected, by the
 * registry's own `workflow` field.
 *
 * `-f`/`--follow` keeps polling every selected run's log for appended lines
 * (see `../../workspace/log-merge.js`'s `readNewEvents`) and, for the
 * default/`--since` selection modes, re-scans the registry each poll so a
 * new matching run joins the merge instead of being missed — `--run` is a
 * fixed, explicit list and never grows.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';

import { getErrorMessage } from '../../utils/error.js';
import { classifyDisplayStatus } from '../../runs/classify.js';
import type { ProbeFn } from '../../runs/pid-probe.js';
import { probeProcess } from '../../runs/pid-probe.js';
import { listRegistryEntries } from '../../runs/registry-io.js';
import { DISPLAY_STATUS, type RunRegistryEntry } from '../../runs/types.js';
import { resolveStoreTarget } from '../../store/target.js';
import { ensureEpipeGuard } from '../../render/terminal-sink.js';
import {
  initTailState,
  parseSince,
  readAllMerged,
  readNewEvents,
  sortMerged,
  type LogSource,
  type MergedEvent,
  type TailState,
} from '../../workspace/log-merge.js';

export interface WorkspaceLogsOptions {
  follow?: boolean;
  workflowList?: string[];
  since?: string;
  runIdList?: string[];
  output?: 'text' | 'json';
  cwd?: string;
  probe?: ProbeFn;
  /** Where output goes. Defaults to `process.stdout.write`; tests capture instead. */
  write?: (text: string) => void;
  pollIntervalMs?: number;
  /** Test seam: bounds how many follow-polls this command performs before returning. */
  maxPolls?: number;
}

type SelectionMode = 'run' | 'since' | 'live';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A run's lifetime end, for `--since` overlap: `ended_at` if terminal, "now" if still live. */
function runEndMs(entry: RunRegistryEntry, nowMs: number): number {
  return entry.ended_at !== undefined ? Date.parse(entry.ended_at) : nowMs;
}

function isLive(entry: RunRegistryEntry, probe: ProbeFn): boolean {
  const status = classifyDisplayStatus(entry, probe);
  return status === DISPLAY_STATUS.RUNNING || status === DISPLAY_STATUS.BOOTSTRAPPING;
}

/** Applies `--workflow`, if given, on top of whichever selection mode chose the base set. */
function applyWorkflowFilter(
  entryList: readonly RunRegistryEntry[],
  workflowList: readonly string[] | undefined,
): RunRegistryEntry[] {
  if (workflowList === undefined || workflowList.length === 0) {
    return [...entryList];
  }
  const workflowSet = new Set(workflowList);
  return entryList.filter((entry) => workflowSet.has(entry.workflow));
}

interface Selection {
  mode: SelectionMode;
  entryList: RunRegistryEntry[];
  sinceMs?: number;
}

function selectEntries(
  entryList: readonly RunRegistryEntry[],
  options: Pick<WorkspaceLogsOptions, 'runIdList' | 'since' | 'workflowList'>,
  probe: ProbeFn,
): { ok: true; selection: Selection } | { ok: false; error: string } {
  if (options.runIdList !== undefined && options.runIdList.length > 0) {
    const byId = new Map(entryList.map((entry) => [entry.run_id, entry]));
    const missing = options.runIdList.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `No run registry entry found for: ${missing.join(', ')}.`,
      };
    }
    const selected = options.runIdList.map((id) => byId.get(id)!);
    return { ok: true, selection: { mode: 'run', entryList: applyWorkflowFilter(selected, options.workflowList) } };
  }

  if (options.since !== undefined) {
    const sinceMs = parseSince(options.since);
    if (sinceMs === undefined) {
      return {
        ok: false,
        error: `--since "${options.since}" is not a recognised instant — use ISO-8601 (e.g. "2026-08-09T10:00:00Z") or a relative shorthand ("15m", "2h", "90s", "1d").`,
      };
    }
    const nowMs = Date.now();
    const overlapping = entryList.filter((entry) => runEndMs(entry, nowMs) >= sinceMs);
    return {
      ok: true,
      selection: { mode: 'since', entryList: applyWorkflowFilter(overlapping, options.workflowList), sinceMs },
    };
  }

  const live = entryList.filter((entry) => isLive(entry, probe));
  return { ok: true, selection: { mode: 'live', entryList: applyWorkflowFilter(live, options.workflowList) } };
}

function toSource(entry: RunRegistryEntry): LogSource {
  return { runId: entry.run_id, workflow: entry.workflow, logPath: entry.log_path };
}

// ---------------------------------------------------------------------------
// Rendering — one line per event
// ---------------------------------------------------------------------------

const PALETTE: readonly ((text: string) => string)[] = [pc.cyan, pc.magenta, pc.yellow, pc.green, pc.blue, pc.red];

function makeColourFor(): (workflow: string) => (text: string) => string {
  const assigned = new Map<string, (text: string) => string>();
  return (workflow: string) => {
    let colour = assigned.get(workflow);
    if (colour === undefined) {
      colour = PALETTE[assigned.size % PALETTE.length]!;
      assigned.set(workflow, colour);
    }
    return colour;
  };
}

/** `HH:MM:SS.mmm` out of an ISO-8601 UTC instant — a plain substring, since `ts` is always that shape. */
function clockOf(tsIso: string): string {
  if (tsIso.length >= 23) {
    return tsIso.slice(11, 23);
  }
  const parsed = new Date(tsIso);
  return Number.isNaN(parsed.getTime()) ? '??:??:??.???' : parsed.toISOString().slice(11, 23);
}

function stepLabelOf(step: unknown): string {
  if (typeof step !== 'object' || step === null) {
    return '?';
  }
  const record = step as Record<string, unknown>;
  if (typeof record['label'] === 'string') {
    return record['label'];
  }
  return typeof record['index'] === 'number' ? `step-${record['index']}` : '?';
}

function errorMessageOf(errorField: unknown): string | undefined {
  if (typeof errorField !== 'object' || errorField === null) {
    return undefined;
  }
  const message = (errorField as Record<string, unknown>)['message'];
  return typeof message === 'string' ? message : undefined;
}

/** One event reduced to the summary `workspace logs` prints after `[workflow]`. */
export function summarizeEvent(event: Record<string, unknown>): string {
  const kind = typeof event['event'] === 'string' ? event['event'] : 'unknown';

  switch (kind) {
    case 'run.start':
      return 'run.start';

    case 'run.end': {
      const total = event['steps_total'];
      const failed = event['steps_failed'];
      const partList = [`outcome=${event['outcome'] ?? '?'}`];
      if (typeof total === 'number') {
        partList.push(`steps=${total - (typeof failed === 'number' ? failed : 0)}/${total}`);
      }
      if (typeof event['duration_ms'] === 'number') {
        partList.push(`${event['duration_ms']}ms`);
      }
      const message = errorMessageOf(event['error']);
      if (message !== undefined) {
        partList.push(`error="${message}"`);
      }
      return `run.end ${partList.join(' ')}`;
    }

    case 'step.start':
      return `step.start ${stepLabelOf(event['step'])}`;

    case 'step.end': {
      const partList = [stepLabelOf(event['step']), `outcome=${event['outcome'] ?? '?'}`];
      if (typeof event['duration_ms'] === 'number') {
        partList.push(`${event['duration_ms']}ms`);
      }
      const message = errorMessageOf(event['error']);
      if (message !== undefined) {
        partList.push(`error="${message}"`);
      }
      return `step.end ${partList.join(' ')}`;
    }

    case 'storage.seed':
      return `storage.seed keys=${event['key_count'] ?? '?'} writes=${event['seed_count'] ?? '?'}`;

    case 'bootstrap.error': {
      const message = typeof event['message'] === 'string' ? event['message'].split('\n')[0] : '';
      return `bootstrap.error stage=${event['stage'] ?? '?'} ${message}`;
    }

    case 'log':
      return `log[${event['level'] ?? '?'}] ${event['message'] ?? ''}`;

    default:
      return kind;
  }
}

function formatTextLine(
  line: MergedEvent,
  colourFor: (workflow: string) => (text: string) => string,
): string {
  const colour = colourFor(line.workflow);
  return `${clockOf(line.ts)} [${colour(line.workflow)}] ${summarizeEvent(line.event)}`;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

export async function workspaceLogsCommand(
  pathArg: string | undefined,
  options: WorkspaceLogsOptions = {},
): Promise<void> {
  // `workspace logs … | head` closing its read end early is the ordinary
  // shape of piping a line-oriented, "stays pipeable" stream into something
  // else — install the same one-time EPIPE-swallowing guard `workflow run`'s
  // terminal sink uses, rather than letting Node's default reaction crash
  // the process.
  if (options.write === undefined) {
    ensureEpipeGuard();
  }

  const cwd = options.cwd ?? process.cwd();
  const probe = options.probe ?? probeProcess;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const colourFor = makeColourFor();

  const targetResult = await resolveStoreTarget(pathArg ?? '.', cwd);
  if (targetResult.isErr()) {
    p.log.error(pc.red(targetResult.error));
    process.exit(1);
    return;
  }
  const target = targetResult.value;

  let entryList: RunRegistryEntry[];
  try {
    entryList = await listRegistryEntries(target.targetFolder);
  } catch (error) {
    p.log.error(pc.red(`Failed to read the run registry: ${getErrorMessage(error)}`));
    process.exit(1);
    return;
  }

  const selectionResult = selectEntries(entryList, options, probe);
  if (!selectionResult.ok) {
    p.log.error(pc.red(selectionResult.error));
    process.exit(1);
    return;
  }
  const { selection } = selectionResult;

  if (selection.entryList.length === 0) {
    const reason =
      selection.mode === 'run'
        ? 'none of the requested runs matched'
        : selection.mode === 'since'
          ? 'no run overlaps the requested --since window'
          : 'no live runs (registry: running/bootstrapping with a verified pid) were found';
    p.log.info(`No log lines to show for workspace "${target.workspaceName}" — ${reason}.`);
    return;
  }

  const emit = (line: MergedEvent): void => {
    if (options.output === 'json') {
      write(`${JSON.stringify(line.event)}\n`);
      return;
    }
    write(`${formatTextLine(line, colourFor)}\n`);
  };

  // `--since` selects *runs* whose lifetime overlaps the window — once a run
  // is selected, its whole log is shown. Trimming individual events older
  // than the window would cut the very context a post-mortem read needs
  // (a still-live run's `run.start` from long before the window, say).
  const sourceList = selection.entryList.map(toSource);
  const { eventList, stateMap } = await readAllMerged(sourceList);
  for (const line of eventList) {
    emit(line);
  }

  if (!options.follow) {
    return;
  }

  const pollIntervalMs = options.pollIntervalMs ?? 500;
  // `--run` is a fixed, explicit list: it never grows during `-f`. The other
  // two modes describe a *query* ("what's live", "what overlaps this
  // window"), so a run appearing mid-follow that now matches joins the merge
  // — see the module doc.
  const dynamicMembership = selection.mode !== 'run';
  let pollIndex = 0;

  // No `maxPolls`: follows until the process is stopped (Ctrl+C), the
  // conventional `-f` contract shared with `runs tail`/`store watch`. Tests
  // bound this.
  while (options.maxPolls === undefined || pollIndex < options.maxPolls) {
    await sleep(pollIntervalMs);

    if (dynamicMembership) {
      let freshEntryList: RunRegistryEntry[];
      try {
        freshEntryList = await listRegistryEntries(target.targetFolder);
      } catch {
        freshEntryList = [];
      }
      const freshSelection = selectEntries(freshEntryList, options, probe);
      if (freshSelection.ok) {
        for (const entry of freshSelection.selection.entryList) {
          if (!stateMap.has(entry.run_id)) {
            stateMap.set(entry.run_id, initTailState(toSource(entry)));
          }
        }
      }
    }

    const batch: MergedEvent[] = [];
    for (const [runId, state] of stateMap) {
      const result: { events: MergedEvent[]; state: TailState } = await readNewEvents(state);
      stateMap.set(runId, result.state);
      batch.push(...result.events);
    }

    for (const line of sortMerged(batch)) {
      emit(line);
    }

    pollIndex += 1;
  }
}
