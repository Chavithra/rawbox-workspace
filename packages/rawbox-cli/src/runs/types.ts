/**
 * The run registry — the on-disk record `runs list/show/tail/prune` read, and
 * the lifecycle `workflow run` writes to (OBSERVABILITY.md, "The run registry").
 *
 * One JSON file per run, at `<resolved target folder>/runs/<run-id>.json`
 * (see `registry-io.ts`), written by the CLI process that owns the run — no
 * locking, no second producer. It is a *separate* record from the NDJSON
 * event stream (`@rawbox/runner`'s `events/event-types.ts`): the stream is
 * the source of truth for what happened during a run, this file is the
 * source of truth for whether a run *exists at all* and whether it is still
 * alive, which the stream alone cannot answer once a process has been
 * SIGKILLed mid-run.
 */

/** The value of `format:` on every registry entry this revision writes. */
export const RUN_REGISTRY_FORMAT = 1;

/**
 * The lifecycle a registry entry's `status` field walks through.
 *
 * Written in this order by `workflow run`, via `createRunRegistrySink`
 * (`registry-sink.ts`):
 *
 * 1. `bootstrapping` — written at CLI entry, before `runWorkflowInstance` is
 *    even called. A run that dies before its own `run.start` event (an
 *    invalid document, a missing plugin discovered during preflight) leaves
 *    the entry parked here — visible, rather than absent.
 * 2. `running` — written on the stream's `run.start` event.
 * 3. `ok` / `error` / `interrupted` — written on `run.end`, from its
 *    `outcome`. `interrupted` is the graceful-shutdown record: an operator
 *    signal (SIGTERM/SIGINT) stopped the run and it still wrote its final
 *    `run.end` — deliberately distinguishable from `crashed`, which is what a
 *    SIGKILL (no chance to write anything) still classifies as at read time.
 * 4. `bootstrap-failed` — written on a `bootstrap.error` event. This can
 *    happen *after* `running` was already written: the `lock`/`resolve`/
 *    `seed-validation`/`store`/`seed` preflight stages fail after `run.start` has
 *    fired (see `event-types.ts`'s `BOOTSTRAP_STAGE`), so a `run.end` with
 *    `outcome: "error"` follows right behind. `bootstrap-failed` takes
 *    precedence over that later `run.end` — see `registry-sink.ts`.
 */
export const RUN_STATUS = {
  BOOTSTRAPPING: 'bootstrapping',
  RUNNING: 'running',
  OK: 'ok',
  ERROR: 'error',
  INTERRUPTED: 'interrupted',
  BOOTSTRAP_FAILED: 'bootstrap-failed',
} as const;

export type RunStatus = (typeof RUN_STATUS)[keyof typeof RUN_STATUS];

/**
 * Every `RunStatus`, plus `crashed` — the one status a registry file never
 * itself carries, because the process that would write it is the one that
 * died. `crashed` is computed at read time (`pid-probe.ts`'s
 * `classifyDisplayStatus`) by checking pid liveness against a
 * non-terminal (`bootstrapping`/`running`) entry.
 */
export const DISPLAY_STATUS = {
  ...RUN_STATUS,
  CRASHED: 'crashed',
} as const;

export type DisplayStatus = (typeof DISPLAY_STATUS)[keyof typeof DISPLAY_STATUS];

const TERMINAL_STATUS_SET: ReadonlySet<RunStatus> = new Set([
  RUN_STATUS.OK,
  RUN_STATUS.ERROR,
  RUN_STATUS.INTERRUPTED,
  RUN_STATUS.BOOTSTRAP_FAILED,
]);

/** `true` once a run has reached one of its four terminal statuses. */
export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUS_SET.has(status);
}

/** The error shape a registry entry carries on `error`/`bootstrap-failed`. */
export interface RunRegistryErrorInfo {
  message: string;
  stack?: string;
}

/**
 * One run's registry entry — the JSON document at
 * `<resolved target folder>/runs/<run-id>.json`.
 *
 * `pid_started_at` is the field that makes `pid` alone trustworthy: see
 * `pid-probe.ts` for how it is produced and compared. It is epoch
 * milliseconds throughout this file's lifetime, regardless of which of the
 * two mechanisms documented there produced it — a reader never needs to know
 * which one was used to write it.
 */
export interface RunRegistryEntry {
  format: typeof RUN_REGISTRY_FORMAT;
  run_id: string;
  workspace: string;
  workflow: string;
  /** The OS process id that owns this run. Not identity on its own — see `pid_started_at`. */
  pid: number;
  /**
   * That process's start time, epoch milliseconds. Compared against a fresh
   * probe of the same pid with a tolerance (`pid-probe.ts`); a live pid whose
   * start time does not match is a *different* process that reused the
   * number, i.e. this run is `crashed`, not `running`.
   */
  pid_started_at: number;
  /** ISO-8601 UTC instant the entry was created, at CLI entry. */
  started_at: string;
  /** Absolute path to this run's NDJSON event log. */
  log_path: string;
  /** Absolute path to this run's filtered error log. */
  error_log_path: string;
  status: RunStatus;
  /** ISO-8601 UTC instant the run reached a terminal status. Absent while live. */
  ended_at?: string;
  /** Wall-clock milliseconds from `run.start` to `run.end`. Absent until then. */
  duration_ms?: number;
  /** Step executions that produced a `step.end`. Absent until `run.end`. */
  steps_total?: number;
  /** How many of those ended `outcome: "error"`. Absent until `run.end`. */
  steps_failed?: number;
  /** Present exactly when `status` is `error` or `bootstrap-failed`. */
  error?: RunRegistryErrorInfo;
}
