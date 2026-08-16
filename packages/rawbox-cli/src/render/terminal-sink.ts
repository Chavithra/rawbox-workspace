/**
 * The terminal renderer — the human-facing sink of the run-event stream
 * (OBSERVABILITY.md, "The run-event stream").
 *
 * This is a **pure consumer of `RunEvent`s**: it never reaches into the
 * machine, the resolver, or any runner internal. Everything it prints comes
 * off the envelope and the event fields documented in
 * `@rawbox/runner`'s `events/event-types.ts` — the same contract the NDJSON
 * file sink and (eventually) the OTel bridge consume, so the three can never
 * disagree about what happened during a run.
 *
 * The `--output` shapes share one sink implementation, switched on per-event
 * rather than split into three files, because the switch is the one place a
 * reader needs to see them side by side to trust that `ndjson` truly is "the
 * same NDJSON as the file" and that `quiet` truly is "only the recap and the
 * errors":
 *
 * - `pretty` — a `WORKFLOW` header, one line per step *execution* on its
 *   `step.end` (✔/✘, label, operation, duration), `log` events as indented
 *   lines under the step in flight when they were emitted, and a `RECAP`
 *   line folding in the ok/failed counts, total duration and both log file
 *   paths — the terminal never prints a second summary once the sink has.
 * - `ndjson` (and its older spelling `json` — {@link OUTPUT_MODE.JSON}) —
 *   every event, `JSON.stringify`d, one per stdout line: byte-identical to
 *   what the NDJSON file sink writes, so `rawbox-cli run … | jq …` works
 *   without a second format to learn. This one is not a *rendering* at all,
 *   and on the real path it is not rendered here: the events go to fd 1
 *   through the file sink's own writer — see {@link createTerminalSink}.
 * - `quiet` — only the `RECAP` line and **severity-bearing** events (a failed
 *   step, a `bootstrap.error`, a `warn`/`error`-level `log`): the exit code
 *   and a post-mortem, nothing else. This is exactly `@rawbox/runner`'s
 *   `severity` envelope field (OBSERVABILITY.md, "`severity`") — one gate,
 *   {@link effectiveSeverity}, replaces what used to be a per-kind "does this
 *   look like an error" heuristic repeated at each call site.
 *
 * `-v`/`-vv`/`-vvv` only affect `pretty` — the raw stream carries whatever the
 * file does (that is the point of piping it to `jq`), and `quiet` is
 * deliberately terse regardless of verbosity. What the raw stream carries is
 * therefore set by `logs.steps` / `--log-steps`, not by verbosity: those are
 * different axes, one changing what is **rendered** for a human and the other
 * what the **stream contains** — see {@link TerminalSinkOptions.steps}.
 */

import pc from 'picocolors';
import {
  OUTCOME,
  RUN_EVENT,
  SEVERITY,
  createNdjsonStdoutSink,
  type RunEvent,
  type RunEventSink,
  type RunEventStep,
  type Severity,
  type StepDetail,
} from '@rawbox/runner';

// ---------------------------------------------------------------------------
// `severity` — the single gate `quiet` mode (and, informally, pretty's own
// colouring) uses to decide "is this bad".
// ---------------------------------------------------------------------------

/**
 * An event's alarm classification: the envelope's own `severity` field when
 * present, or — for a stream written before that field existed — the same
 * heuristic this renderer used pre-`severity`, so an **old** NDJSON log
 * (OBSERVABILITY.md, "Versioning"'s additive-only rule) renders in `quiet`
 * exactly as it always did. New streams always carry the field for the kinds
 * that warrant it, so the fallback branch is effectively dead code against a
 * current producer — it exists for backward tolerance, not as a second
 * source of truth to keep in sync with the first.
 */
function effectiveSeverity(event: RunEvent): Severity | undefined {
  // A plain cast rather than an `in`-narrowed check: every current kind that
  // carries `severity` always sets it (`bootstrap.error`'s is even required by
  // the schema), which would let TypeScript "prove" the fallback below dead —
  // true for a *current* producer, false for an old NDJSON line read back in,
  // which is exactly the case this fallback exists for.
  const explicit = (event as { severity?: Severity }).severity;
  if (explicit !== undefined) {
    return explicit;
  }
  if (event.event === RUN_EVENT.BOOTSTRAP_ERROR) {
    return SEVERITY.ERROR;
  }
  if (event.event === RUN_EVENT.STEP_END && event.outcome === OUTCOME.ERROR) {
    return SEVERITY.ERROR;
  }
  if (event.event === RUN_EVENT.LOG && event.level === 'error') {
    return SEVERITY.ERROR;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `--output`
// ---------------------------------------------------------------------------

/** The `--output` shapes (OBSERVABILITY.md, "CLI surfaces"). */
export const OUTPUT_MODE = {
  PRETTY: 'pretty',
  /**
   * The raw run-event stream on stdout, one `JSON.stringify`d event per line —
   * byte-for-byte the NDJSON log file's own lines, so a run under systemd or
   * Docker hands its log stack the stream directly.
   */
  NDJSON: 'ndjson',
  /**
   * The original spelling of {@link OUTPUT_MODE.NDJSON}, and **identical to
   * it** — not a second shape.
   *
   * `json` has always meant "the raw NDJSON stream on stdout" here, never
   * "one JSON document", which is what it means for every *other* command's
   * `--output json` (`runs list`, `store list`, `workspace status`). `ndjson`
   * is the name that says what the stream is, and is what `--help` documents;
   * `json` stays accepted because it is what existing scripts and the
   * piped-stdout default were written against, and breaking them would buy
   * nothing.
   */
  JSON: 'json',
  QUIET: 'quiet',
} as const;

export type OutputMode = (typeof OUTPUT_MODE)[keyof typeof OUTPUT_MODE];

/** Every value `--output` accepts, for yargs' `choices:`. */
export const OUTPUT_MODE_LIST: readonly OutputMode[] = [
  OUTPUT_MODE.PRETTY,
  OUTPUT_MODE.NDJSON,
  OUTPUT_MODE.JSON,
  OUTPUT_MODE.QUIET,
];

/**
 * True for the two spellings of the raw event stream — see
 * {@link OUTPUT_MODE.JSON} for why there are two.
 */
export function isRawStreamMode(mode: OutputMode): boolean {
  return mode === OUTPUT_MODE.NDJSON || mode === OUTPUT_MODE.JSON;
}

/**
 * The default `--output` when the flag is omitted: `pretty` on a TTY,
 * `json` when the process is piped — the same heuristic `npm` and `ansible`
 * use for their own default.
 *
 * Still `json` rather than the newer `ndjson` spelling, because the two are the
 * same shape ({@link OUTPUT_MODE.JSON}) and this value is observable: it is what
 * a caller passing `--output` back through sees, and what the CLI's own tests
 * assert. Renaming the default would be a visible change for no behavioural
 * one.
 *
 * A pure function of the one bit that decides it, rather than reading
 * `process.stdout.isTTY` itself, so the decision is unit-testable without
 * faking a stream (see `tests/terminal-sink.test.ts`).
 */
export function resolveDefaultOutputMode(isStdoutTTY: boolean): 'pretty' | 'json' {
  return isStdoutTTY ? OUTPUT_MODE.PRETTY : OUTPUT_MODE.JSON;
}

// ---------------------------------------------------------------------------
// Verbosity
// ---------------------------------------------------------------------------

/**
 * `-v`/`-vv`/`-vvv`, counted by yargs' `type: 'count'`. Only consulted in
 * `pretty` mode.
 *
 * | Level | Adds |
 * | --- | --- |
 * | `0` | Nothing beyond the header, step lines, logs and recap. |
 * | `1` | Each step's input/output storage-key record — keys, and values short enough to read inline. |
 * | `2` | The same records with every value in full, one single value truncated past ~500 chars. |
 * | `3` | `run.start`'s `format`/`run_id`, `storage.seed`'s counts and keys, and each step's `registry_hash`. |
 */
export type Verbosity = 0 | 1 | 2 | 3;

/** Longest inline value at `-v`: past this, only the key is shown. */
const SHORT_VALUE_MAX = 60;

/** Longest inline value at `-vv`/`-vvv`: past this, the value is ellipsised. */
const FULL_VALUE_MAX = 500;

const ELLIPSIS = '…';

/**
 * One storage-key record (`step.start.input` or `step.end.output`) rendered
 * as `key=value key=value …`, in document order.
 *
 * @param record - The record to render.
 * @param maxValueLen - Values whose rendering is longer than this are
 *   truncated (`-vv`, `FULL_VALUE_MAX`) or dropped to a byte-count
 *   placeholder (`-v`, `SHORT_VALUE_MAX`) — `dropOversized` tells the two
 *   apart, since both share this one formatter.
 * @param dropOversized - `true` at `-v`: an oversized value is replaced
 *   entirely rather than truncated, so "small values" stays true to its
 *   name. `false` at `-vv`/`-vvv`: truncate instead, per
 *   {@link formatValue}.
 */
function formatRecord(
  record: Record<string, unknown>,
  maxValueLen: number,
  dropOversized: boolean,
): string {
  const entries = Object.entries(record);
  if (entries.length === 0) {
    return '(empty)';
  }
  return entries
    .map(([key, value]) => `${key}=${formatValue(value, maxValueLen, dropOversized)}`)
    .join(' ');
}

/** Renders one storage value, truncating or eliding it per {@link formatRecord}. */
function formatValue(value: unknown, maxLen: number, dropOversized: boolean): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) {
    text = String(value);
  }

  if (text.length <= maxLen) {
    return text;
  }
  if (dropOversized) {
    return `<${text.length} bytes>`;
  }
  return `${text.slice(0, maxLen)}${ELLIPSIS}`;
}

// ---------------------------------------------------------------------------
// Layout — shared between the `pretty` and `quiet` renderers
// ---------------------------------------------------------------------------

/** Target line width the header/recap dot-fill divider aims for. */
const LINE_WIDTH = 80;

/** Fewest dots a divider ever prints, even once the surrounding text is wide. */
const MIN_DOTS = 4;

/**
 * `PREFIX ················ SUFFIX`, dot-filled to {@link LINE_WIDTH} — the
 * shape both the `WORKFLOW` header and the `RECAP` line use. `suffix: ''`
 * omits the trailing " SUFFIX" entirely, which is what the header line does.
 */
function divider(prefix: string, suffix: string): string {
  const used = prefix.length + 1 + (suffix.length > 0 ? 1 + suffix.length : 0);
  const dotsLength = Math.max(MIN_DOTS, LINE_WIDTH - used);
  const dots = pc.dim('·'.repeat(dotsLength));
  return suffix.length > 0 ? `${prefix} ${dots} ${suffix}` : `${prefix} ${dots}`;
}

/** A step's display label — the authored `label:`, falling back to its index. */
function stepLabel(step: RunEventStep): string {
  return step.label ?? `step-${step.index}`;
}

/** `123ms`, right-padded so a column of them lines up. */
function formatDuration(durationMs: number): string {
  return `${durationMs}ms`;
}

/** One `✔ label   operation   123ms` line, coloured by outcome. */
function stepSummaryLine(step: RunEventStep, outcome: string, durationMs: number): string {
  const ok = outcome === OUTCOME.OK;
  const icon = ok ? pc.green('✔') : pc.red('✘');
  const label = stepLabel(step).padEnd(20);
  const operation = step.operation.padEnd(38);
  const duration = formatDuration(durationMs).padStart(8);
  return `  ${icon} ${label} ${operation}${duration}`;
}

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

/** Constructor options for {@link createTerminalSink}. */
export interface TerminalSinkOptions {
  /** Which of the three shapes to render. */
  mode: OutputMode;
  /** `-v` count. Ignored outside `pretty`. Defaults to `0`. */
  verbosity?: Verbosity;
  /**
   * The run's NDJSON log path, printed on the `RECAP` line (`pretty`/`quiet`)
   * so the outro this sink replaces never has to repeat it.
   */
  logFilePath?: string;
  /** The run's filtered error-log path, printed on `RECAP` when the run failed. */
  errorLogFilePath?: string;
  /**
   * Where rendered lines go. Defaults to `process.stdout.write`; tests pass
   * a capturing function instead of spying on the real stream.
   *
   * Supplying one also opts the raw-stream modes ({@link isRawStreamMode}) out
   * of the NDJSON writer they otherwise use — see
   * {@link TerminalSinkOptions.logAsync}.
   */
  write?: (text: string) => void;

  /**
   * Only consulted for the raw-stream modes, and only when
   * {@link TerminalSinkOptions.write} is omitted: whether the fd-1 writer
   * buffers, matching what the file sink was built with (`--log-async` /
   * `logs.async`, `@rawbox/runner`'s `resolveLogsConfig`). Defaults to `false`.
   */
  logAsync?: boolean;

  /**
   * Only consulted for the raw-stream modes, and only when
   * {@link TerminalSinkOptions.write} is omitted: the step-detail policy the
   * file sink was built with (`--log-steps` / `logs.steps`, resolved by
   * `resolveLogsConfig` alongside {@link TerminalSinkOptions.logAsync}).
   * Defaults to `full`.
   *
   * It is passed for the same reason `logAsync` is, and the reason is the one
   * recorded above the `createNdjsonStdoutSink` call below: these modes are
   * handed to the file sink's own writer precisely so that **byte-identity
   * with the file stops being a claim two call sites have to keep true**. A
   * run written with `logs.steps: summary` whose fd-1 stream still carried
   * full `input`/`output` would break exactly that, and break it in the case
   * the mode exists for — `--output ndjson` piped into a log stack, where the
   * operator asked for less volume and would silently keep paying for it.
   *
   * Note this is *not* the same axis as `-v`/`-vv`, which stay pretty-only:
   * those change what is **rendered** for a human, this changes what the
   * **stream** contains. A raw-stream mode has no rendering to change.
   */
  steps?: StepDetail;
}

/**
 * Node's default reaction to writing past a closed pipe (`rawbox-cli run …
 * --output json | head -2`, the exact use case this mode exists for) is to
 * throw from the `Writable`'s `'error'` event and crash the process with a
 * raw `EPIPE` stack — long after `head` has already gotten what it wanted.
 * The standard fix for a stdout-writing CLI is one swallowing listener,
 * installed at most once per process regardless of how many sinks
 * {@link createTerminalSink} builds (tests among them, which would otherwise
 * accumulate one per run and trip Node's max-listener warning).
 */
let epipeGuardInstalled = false;
/**
 * Exported so any other command writing complete lines to `process.stdout`
 * — `workspace status`/`workspace logs` among them — can install the same
 * one-time guard rather than growing a second copy of it.
 */
export function ensureEpipeGuard(): void {
  if (epipeGuardInstalled) {
    return;
  }
  epipeGuardInstalled = true;
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exitCode = 0;
      return;
    }
    throw error;
  });
}

/**
 * Builds the terminal sink: consumes the {@link RunEvent} stream and renders
 * it per {@link TerminalSinkOptions.mode}, writing complete lines (each
 * ending `\n`) to {@link TerminalSinkOptions.write}.
 *
 * Registered alongside the always-on NDJSON file sink via
 * `runWorkflowInstance`'s `options.sinkList` — this sink never touches a
 * file itself, only the two paths it is told about, purely for the `RECAP`
 * line's sake.
 */
export function createTerminalSink(options: TerminalSinkOptions): RunEventSink {
  const mode = options.mode;
  const verbosity = options.verbosity ?? 0;
  if (options.write === undefined) {
    ensureEpipeGuard();
  }
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  // The raw-stream modes do not *render* anything — they are the run-event
  // stream itself, on fd 1 — so on the real path they are handed straight to
  // the same writer the NDJSON log files use
  // (`@rawbox/runner`'s `createNdjsonStdoutSink`), rather than being
  // re-`JSON.stringify`d through `process.stdout.write` here. Two reasons, and
  // the second is the load-bearing one:
  //
  // 1. Byte-identity with the file stops being a claim two call sites have to
  //    keep true and becomes one writer producing both.
  // 2. `process.stdout.write` is **asynchronous when fd 1 is a pipe** — the
  //    exact case this mode exists for (`… --output ndjson | …`) — so a
  //    `process.exit()` could drop the tail of the stream. A synchronous
  //    destination cannot.
  //
  // A caller supplying its own `write` (every test in this file) keeps the
  // in-process rendering below instead, which is what makes the shape
  // assertable without a real descriptor.
  const rawStreamSink =
    isRawStreamMode(mode) && options.write === undefined
      ? createNdjsonStdoutSink({
          async: options.logAsync ?? false,
          ...(options.steps !== undefined ? { steps: options.steps } : {}),
        })
      : undefined;
  const logFilePath = options.logFilePath;
  const errorLogFilePath = options.errorLogFilePath;

  const println = (line: string): void => write(`${line}\n`);

  // The input record of the step currently in flight, keyed by
  // `${index}:${iteration}` — the same triple that identifies a `step.start`/
  // `step.end` pair (event-types.ts, "Span pairing and loop iterations") —
  // so `-v`/`-vv` can print it beside the matching `step.end`'s output rather
  // than immediately, keeping the step's own summary line first.
  const pendingInputByKey = new Map<string, Record<string, unknown> | undefined>();
  const stepKey = (step: RunEventStep): string => `${step.index}:${step.iteration}`;

  // Whether `run.start` has been seen. Only the two earliest preflight stages
  // — loading the workspace document and the workflow document — fail before
  // the run knows its own identity; every later stage (`lock`, `resolve`,
  // `seed-validation`, `store`, `seed`) fails *after* `run.start`, so its
  // `bootstrap.error` is followed by a `run.end` after all (`RunEventProducer
  // .end` is a no-op only when `run.start` was never emitted — not "whenever
  // a bootstrap error happened"). Tracked so `printBootstrapError` prints the
  // log paths itself only when no `RECAP` is coming to do it instead.
  let sawRunStart = false;
  // Whether a `bootstrap.error` has already printed its (often long,
  // multi-line) diagnostic this run — so `run.end`'s own `error.message`,
  // which is the identical string `failBootstrap` handed to both events,
  // is not printed a second time right underneath it.
  let sawBootstrapError = false;

  /** Prints the `in:`/`out:` detail lines `-v`/`-vv` add under a step. */
  function printStepDetail(kind: 'in' | 'out', record: Record<string, unknown> | undefined): void {
    if (verbosity < 1 || record === undefined) {
      return;
    }
    const maxLen = verbosity >= 2 ? FULL_VALUE_MAX : SHORT_VALUE_MAX;
    const dropOversized = verbosity < 2;
    println(pc.dim(`      ${kind}: ${formatRecord(record, maxLen, dropOversized)}`));
  }

  /** The `bootstrap.error` block: shown in every mode but `json`. */
  function printBootstrapError(event: Extract<RunEvent, { event: 'bootstrap.error' }>): void {
    const lines = event.message.split('\n');
    println(pc.red(`✘ bootstrap error (${event.stage}): ${lines[0]}`));
    for (const line of lines.slice(1)) {
      println(pc.red(`    ${line}`));
    }
    // A `workspace`/`workflow`-stage failure is the one case with no
    // `run.end` coming (identity was never established, so the stream ends
    // right here) — the log paths are surfaced now, or never. Every later
    // stage's failure is followed by a `run.end`, whose own `RECAP` prints
    // them instead; printing twice here would be exactly the duplication
    // task item 4 asks this renderer to avoid.
    if (!sawRunStart) {
      printLogPaths(true);
    }
  }

  /** The `logs:`/`errors:` lines folded into the recap (task item 4). */
  function printLogPaths(includeErrorLog: boolean): void {
    if (logFilePath !== undefined) {
      println(pc.dim(`  logs: ${logFilePath}`));
    }
    if (includeErrorLog && errorLogFilePath !== undefined) {
      println(pc.dim(`  errors: ${errorLogFilePath}`));
    }
  }

  return {
    // Present only when this sink owns an fd-1 destination; the producer
    // awaits both once after the run's last event (`sink.ts`), which is what
    // makes the tail of an `--log-async` stream durable before any
    // `process.exit()`.
    ...(rawStreamSink
      ? {
          flush: () => rawStreamSink.flush?.() ?? Promise.resolve(),
          close: () => rawStreamSink.close?.() ?? Promise.resolve(),
        }
      : {}),

    emit(event: RunEvent): void {
      if (rawStreamSink) {
        rawStreamSink.emit(event);
        return;
      }

      if (isRawStreamMode(mode)) {
        // Byte-identical to the NDJSON file sink's own line
        // (`ndjson-file-sink.ts`): the same `JSON.stringify`, no pretty
        // printing, so `rawbox-cli run … --output ndjson | jq …` reads exactly
        // what the log file holds. Reached only when the caller supplied its
        // own `write` — otherwise `rawStreamSink` above has already handled it
        // through the file sink's own writer.
        println(JSON.stringify(event));
        return;
      }

      switch (event.event) {
        case RUN_EVENT.RUN_START: {
          sawRunStart = true;
          if (mode === OUTPUT_MODE.QUIET) {
            return;
          }
          println('');
          println(pc.bold(divider(`WORKFLOW ${event.workflow} (workspace ${event.workspace})`, '')));
          if (verbosity >= 3) {
            println(pc.dim(`  run_id=${event.run_id} format=${event.format}`));
          }
          return;
        }

        case RUN_EVENT.STORAGE_SEED: {
          if (mode !== OUTPUT_MODE.PRETTY || verbosity < 3) {
            return;
          }
          println(
            pc.dim(
              `  seed: ${event.key_count} key(s), ${event.seed_count} write(s) in ${event.duration_ms}ms — ${event.keys.join(', ')}`,
            ),
          );
          return;
        }

        case RUN_EVENT.SEED_OVERRIDE_APPLIED: {
          // Unlike `storage.seed` (gated to `-vvv`), this prints at every
          // verbosity `pretty` has: the whole point is that a CLI `--seed`
          // override has no file and no diff anywhere else, so the terminal a
          // human is watching is one of only two places it is visible at all
          // (the NDJSON line — always written — is the other). `quiet`
          // excludes it for the same reason it excludes `run.start`: neither
          // is severity-bearing.
          if (mode !== OUTPUT_MODE.PRETTY) {
            return;
          }
          for (const override of event.overrides) {
            println(pc.dim(`  seed override: ${override.key} ← ${override.source}`));
          }
          return;
        }

        case RUN_EVENT.STEP_START: {
          pendingInputByKey.set(stepKey(event.step), event.input);
          if (mode === OUTPUT_MODE.PRETTY && verbosity >= 3) {
            println(pc.dim(`      registry=${event.step.registry_hash}`));
          }
          return;
        }

        case RUN_EVENT.LOG: {
          if (mode === OUTPUT_MODE.QUIET) {
            if (effectiveSeverity(event) === undefined) {
              return;
            }
            println(pc.red(`  ✘ log: ${event.message}`));
            return;
          }
          const tag = levelTag(event.level);
          const dataSuffix =
            verbosity >= 2 && event.data !== undefined
              ? ` ${formatValue(event.data, FULL_VALUE_MAX, false)}`
              : '';
          println(`    ${tag} ${event.message}${dataSuffix}`);
          return;
        }

        case RUN_EVENT.STEP_END: {
          const input = pendingInputByKey.get(stepKey(event.step));
          pendingInputByKey.delete(stepKey(event.step));
          const isError = event.outcome === OUTCOME.ERROR;

          if (mode === OUTPUT_MODE.QUIET) {
            if (effectiveSeverity(event) === undefined) {
              return;
            }
            println(stepSummaryLine(event.step, event.outcome, event.duration_ms));
            const message = errorMessageOf(event.error);
            if (message !== undefined) {
              println(pc.red(`      error: ${message}`));
            }
            return;
          }

          println(stepSummaryLine(event.step, event.outcome, event.duration_ms));
          if (isError) {
            const message = errorMessageOf(event.error);
            if (message !== undefined) {
              println(pc.red(`      error: ${message}`));
            }
          }
          printStepDetail('in', input);
          printStepDetail('out', event.output);
          return;
        }

        case RUN_EVENT.BOOTSTRAP_ERROR: {
          sawBootstrapError = true;
          printBootstrapError(event);
          return;
        }

        case RUN_EVENT.RUN_HEARTBEAT: {
          // Never severity-bearing (event-types.ts), so `quiet` never shows
          // it; `pretty` prints an ephemeral, dimmed line so a human watching
          // a long step live sees it is still alive rather than hung.
          if (mode !== OUTPUT_MODE.PRETTY) {
            return;
          }
          println(
            pc.dim(
              `    … still running ${stepLabel(event.step)} (${formatDuration(event.in_flight_ms)})`,
            ),
          );
          return;
        }

        case RUN_EVENT.STEP_PROGRESS: {
          // Also never severity-bearing — same quiet exclusion as the heartbeat.
          if (mode === OUTPUT_MODE.QUIET) {
            return;
          }
          const dataSuffix =
            verbosity >= 2 && event.data !== undefined
              ? ` ${formatValue(event.data, FULL_VALUE_MAX, false)}`
              : '';
          println(pc.dim(`    … ${event.message ?? '(progress)'}${dataSuffix}`));
          return;
        }

        case RUN_EVENT.LOG_ROTATE: {
          // A routine roll that discarded nothing is not worth a line every
          // `maxBytes` — a human watching a long run does not need to hear
          // about every 128 MiB. One that *deleted* a segment is exactly the
          // "history was dropped" fact this kind exists to surface, so it
          // prints in every mode, `quiet` included: `severity` is set on the
          // event precisely when `deleted_segment` is, so gating on it here
          // is the same "one gate" `effectiveSeverity` uses elsewhere.
          if (event.severity === undefined) {
            return;
          }
          println(
            pc.yellow(
              `  ⚠ log rotated: segment ${event.sealed_segment} sealed, segment ${event.live_segment} now live — ` +
                `segment ${event.deleted_segment} deleted to honour maxFiles=${event.max_files}`,
            ),
          );
          return;
        }

        case RUN_EVENT.RUN_END: {
          const okCount = event.steps_total - event.steps_failed;
          // An interrupted run is neither "ok" nor "failed": the recap says so
          // in words, coloured yellow — the palette's transitional shade, not
          // an alarm red — and the interrupted `run.end` carries no severity,
          // so `quiet` mode surfaces exactly this recap line and nothing else
          // for it (OBSERVABILITY.md, "`severity`" and "CLI surfaces").
          const interrupted = event.outcome === OUTCOME.INTERRUPTED;
          const stats =
            `${interrupted ? 'interrupted  ' : ''}` +
            `ok=${okCount} failed=${event.steps_failed} skipped=0  ${event.duration_ms}ms`;
          println('');
          const coloured =
            event.outcome === OUTCOME.OK ? pc.green : interrupted ? pc.yellow : pc.red;
          println(coloured(divider('RECAP', stats)));
          if (event.outcome === OUTCOME.ERROR && event.error?.message !== undefined && !sawBootstrapError) {
            println(pc.red(`  error: ${event.error.message}`));
          }
          printLogPaths(event.steps_failed > 0 || event.outcome === OUTCOME.ERROR);
          return;
        }
      }
    },
  };
}

/** A short, coloured tag for a `log` event's level. */
function levelTag(level: string): string {
  switch (level) {
    case 'error':
      return pc.red(`[${level}]`);
    case 'warn':
      return pc.yellow(`[${level}]`);
    default:
      return pc.dim(`[${level}]`);
  }
}

/**
 * The human message out of a `step.end` error record — the shape a
 * contract's `errorSchema` describes, so `message` is a convention, not a
 * guarantee. Falls back to the whole record, rendered, when it is absent.
 */
function errorMessageOf(errorRecord: Record<string, unknown> | undefined): string | undefined {
  if (errorRecord === undefined) {
    return undefined;
  }
  const message = errorRecord['message'];
  if (typeof message === 'string') {
    return message;
  }
  return formatValue(errorRecord, FULL_VALUE_MAX, false);
}
