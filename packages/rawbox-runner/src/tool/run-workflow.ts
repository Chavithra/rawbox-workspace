import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createActor } from 'xstate';
import { ok, err, type Result } from 'neverthrow';
import { Compile } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import { ContractRegistryCache } from '@rawbox/plugin/core';

import { createWorkflowMachine } from '../machine/machine-instance.js';
import { loadAndValidateWorkspace } from './setup-workspace.js';
import type { Workspace } from '../workspace/workspace-types.js';
import type { ResolvedWorkflow, Workflow } from '../workflow/workflow-types.js';
import { RAWBOX_LOCK_FILENAME, RawboxLock } from '../workflow/lock-types.js';
import { validateSeedData, validateWorkflowType } from '../workflow/validation.js';
import { collectUnwiredStrategyProblems } from '../workflow/store-support.js';
import { resolveWorkflow } from '../workflow/resolver.js';
import {
  PluginDiscoverer,
  type SkippedPlugin,
} from '../workflow/plugin-discoverer.js';
import { resolveTargetFolder } from '../workspace/workspace-types.js';
import {
  collectLogRotationProblems,
  type ResolvedLogRotate,
} from '../workspace/logs.js';
import {
  applySeedOverrides,
  formatSeedOverridePathProblems,
  seedOverrideLayerFor,
  summarizeAppliedSeedOverrides,
  type SeedOverrideLayer,
} from '../workspace/seed-overrides.js';
import { parseConfig } from '../utils/config.js';
import { getErrorMessage } from '../utils/error.js';
import {
  BOOTSTRAP_STAGE,
  OUTCOME,
  RunEventProducer,
  buildStepDescriptorList,
  createNdjsonFileSink,
  type BootstrapStage,
  type RunEventSink,
  type StepDetail,
} from '../events/index.js';


const lockValidator = Compile(RawboxLock);

/**
 * Collapses a resolution-base list to its distinct absolute paths, preserving
 * order.
 *
 * The target folder defaults to the workspace directory and a run is often
 * launched from one of the two, so the three bases coincide in the common case.
 * Each duplicate would otherwise cost a redundant `createRequire` resolution
 * attempt per plugin and make the list misleading to anyone reading it.
 */
export function dedupePathList(pathList: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of pathList) {
    const absolute = path.resolve(candidate);
    if (seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    result.push(absolute);
  }
  return result;
}


/** Renders a plugin skip list as an indented block, or '' when there are none. */
function formatSkipped(skipped: readonly SkippedPlugin[]): string {
  if (skipped.length === 0) {
    return '';
  }
  return (
    `\n\nPlugins that could not be loaded:\n` +
    skipped.map((s) => `  - '${s.name}': ${s.reason}`).join('\n')
  );
}

/**
 * Reads `rawbox.lock` from the workspace directory when one is present.
 *
 * A missing lock is not an error — it means "resolve whatever is installed".
 * A lock that exists but is unreadable or malformed *is* an error: silently
 * ignoring it would defeat the integrity guarantee it was written to provide.
 */
async function readWorkspaceLock(
  workspaceDir: string,
): Promise<Result<RawboxLock | undefined, string>> {
  const lockPath = path.join(workspaceDir, RAWBOX_LOCK_FILENAME);

  let content: string;
  try {
    content = await fs.readFile(lockPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok(undefined);
    }
    return err(`Failed to read "${lockPath}": ${getErrorMessage(e)}`);
  }

  let lockData: unknown;
  try {
    lockData = parseConfig(content, lockPath);
  } catch (e) {
    return err(`Failed to parse "${lockPath}": ${getErrorMessage(e)}`);
  }

  if (!lockValidator.Check(lockData)) {
    const errorDetails = Array.from(lockValidator.Errors(lockData))
      .map((error: TLocalizedValidationError) => `  - Path: "${error.instancePath}" : ${error.message}`)
      .join('\n');
    return err(
      `Lock file validation failed for "${lockPath}":\n${errorDetails}\n` +
        `Regenerate it with: npx rawbox-cli workflow lock <workflow file>`,
    );
  }

  return ok(lockData);
}

/**
 * Derives the error-log path from the main log path when the caller did not
 * supply one, by inserting `.error` before the extension: `run.ndjson` →
 * `run.error.ndjson`, a path with no extension gets `.error` appended.
 *
 * Extension-agnostic on purpose — the CLI computes both paths explicitly from
 * the run id (OBSERVABILITY.md, "The run-event stream") and never relies on this, so the
 * only callers left are embedders that pass a single log path of their own
 * choosing.
 */
function deriveErrorLogFilePath(logFilePath: string): string {
  const ext = path.extname(logFilePath);
  const base = ext ? logFilePath.slice(0, -ext.length) : logFilePath;
  return `${base}.error${ext}`;
}

/**
 * The run's correlation id: `run_id` on every event, `params.runId` in the
 * machine, and the trace key the OTel bridge maps a run onto.
 *
 * Exported so a caller that needs the id before the run starts — the CLI,
 * to name its default log files after it (OBSERVABILITY.md, "The run-event stream") —
 * can generate it up front and pass it back in via
 * {@link RunWorkflowOptions.runId}, keeping the filename and the events'
 * `run_id` in lockstep by construction.
 */
export function createRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
}

/**
 * What `runWorkflowInstance` accepts in place of a workspace document path
 * (workspace-less/"scratch" runs, README, "Implicit (workspace-less) workspaces"):
 *
 * - a `string` — the on-disk path-based flow, unchanged: the document is read,
 *   schema-validated and its directory derived from the path, exactly as
 *   before this type existed.
 * - `{ workspace, dir }` — an **already-validated** in-memory `Workspace`,
 *   paired with the directory that stands in for "the workspace directory"
 *   (plugin resolution base, `rawbox.lock` location, default target folder).
 *   Nothing is read from or written to disk on this branch — no
 *   `workspace.yaml` is ever synthesized. The caller (the CLI's scratch-run
 *   support) is responsible for constructing a `Workspace` that already
 *   satisfies the schema.
 */
export type WorkspaceSource = string | { workspace: Workspace; dir: string };

/** Options `runWorkflowInstance` accepts beyond its paths. */
export interface RunWorkflowOptions {
  /**
   * Extra destinations for the run-event stream, registered for the whole run
   * and fanned out to in order.
   *
   * The NDJSON file sink built from the two log paths is always registered
   * first, so a caller adds a terminal renderer or an exporter here without
   * losing the file. Each sink's
   * optional `flush()`/`close()` is awaited once the run's last event has been
   * emitted, before this function returns.
   */
  sinkList?: readonly RunEventSink[];
  /**
   * The run's correlation id (`run_id` on every event). Defaults to
   * {@link createRunId} when omitted.
   *
   * A caller that names its log files after the run — the CLI's default
   * `<run-id>.ndjson` / `<run-id>.error.ndjson` (OBSERVABILITY.md, "The
   * run-event stream") — must generate the id *before* building those paths and pass it
   * here, so the filename and the events inside it never disagree.
   */
  runId?: string;
  /**
   * Milliseconds between `run.heartbeat` events while a step is in flight
   * (OBSERVABILITY.md, "`run.heartbeat`"). Defaults to
   * {@link DEFAULT_HEARTBEAT_MS} (~10s); `0` disables heartbeats entirely.
   * `@rawbox/cli`'s `--heartbeat <ms>` sets this.
   */
  heartbeatMs?: number;
  /**
   * Milliseconds the run will wait for **preflight's definition preload**
   * before giving up. Defaults to
   * {@link DEFAULT_PREFLIGHT_TIMEOUT_MS} (30s); `0` disables the bound
   * entirely. `@rawbox/cli`'s `--preflight-timeout <ms>` sets this.
   *
   * Before any step is selected, the runner imports every step's definition
   * module (`preloadStepDefinitions` in `machine/actors/start-actor.ts`). A
   * module that blocks at import — a top-level `await` that never settles, a
   * socket opened at evaluation — hangs there, and preflight has no step, so it
   * emits no `run.heartbeat` and no `step.start`: the stream simply stops after
   * `run.start`. A step's own `timeoutMs` cannot cover this, because that bound
   * is declared inside the contract and the contract is unreadable until the
   * module has loaded. Hence a runner-level option.
   *
   * **Unlike a step, this defaults to a real bound.** A step blocking for hours
   * can be the product working (a feed waiting for a tick), so "absent means
   * unbounded" is load-bearing there. Module *evaluation* has no such case, so
   * the default here is a generous backstop rather than nothing. See
   * `start-actor.ts`'s module doc for the full argument.
   *
   * An expired bound ends the run the same way any preflight failure does — an
   * error `run.end` carrying the diagnostic, which names the step and the
   * definition path the preload was on — plus `timed_out`/`timeout_ms` on that
   * event, which is what tells "hung at import" from "failed to import".
   */
  preflightTimeoutMs?: number;
  /**
   * Extra seed-override layers, appended **after** the workspace's own —
   * `CLI > workspace > workflow` (`workspace/seed-overrides.ts`'s module doc),
   * so a layer here wins any key the workspace also names. `@rawbox/cli`'s
   * `--seed key=<json>` builds exactly one such layer, from `run.ts`; embedders
   * needing a similar override supply their own the same way. Not selected by
   * workflow path the way the workspace's block is
   * (`seedOverrideLayerFor`): unlike a workspace, which holds many workflows'
   * blocks in one document, a layer supplied here is already scoped to this
   * one call — there is only ever the one workflow this run is for.
   */
  seedOverrideLayerList?: readonly SeedOverrideLayer[];
  /**
   * Graceful-shutdown seam (OBSERVABILITY.md, "Event kinds" and "Lifecycle and crash detection"): abort it to
   * conclude the run cleanly instead of killing the process.
   *
   * On abort while the run is live, no new step execution starts and the run
   * concludes promptly with a `run.end` of `outcome: "interrupted"` as its
   * final event, followed by the normal sink flush/close. A step handler in
   * flight is **not** waited for — its promise is abandoned (no `step.end` is
   * written for it) and `runWorkflowInstance` resolves within a short bounded
   * time ({@link INTERRUPT_GRACE_MS}, ~2s) even against a permanently blocked
   * handler. The result is `ok({ outcome: "interrupted" })` — the run did what
   * it was told; the caller (the CLI) decides the exit code.
   *
   * An abort during preflight does not cancel the preflight stages mid-way:
   * they run to their next boundary exactly as without a signal (a preflight
   * failure still reports `bootstrap.error` as today), and an abort observed
   * by the time preflight completes concludes the run with an interrupted
   * `run.end` — zero steps executed — before the machine ever starts.
   *
   * **One timer can outlive an interrupt.** If the abandoned actor held an
   * armed bound — a **bounded step**'s `timeoutMs`, or the preflight bound of
   * {@link preflightTimeoutMs} when the abort arrived mid-preload — its
   * deadline timer is still armed: the actor's promise is never resumed, so the
   * `finally` that would clear it never runs, and the timer stays pending for
   * the remainder of the bound. It is deliberately not `.unref()`ed — a bound
   * that only fires while something else holds the loop open is not a bound
   * (see `startDeadline`) — so an **embedder's** event loop can be held open
   * for up to that long after `runWorkflowInstance` resolves. Nothing is
   * emitted when it fires; the run has already concluded, and its `run.end`
   * says `interrupted` with no timeout fields, because an operator stop that
   * raced a bound is still an operator stop. `@rawbox/cli` is unaffected: it
   * exits the process rather than returning to an idle loop. An embedder for
   * which this matters should keep its bounds short, or exit rather than idle.
   */
  signal?: AbortSignal;
  /**
   * Buffer the NDJSON file sink's writes instead of writing each line before
   * returning — `logs.async` in the workspace document, `--log-async` on the
   * CLI, both resolved by `resolveLogsConfig` (`workspace/logs.ts`). Defaults
   * to `false`: synchronous, so a run killed mid-workflow keeps the lines that
   * explain why.
   *
   * **Resolved by the caller, not read off the workspace here**, and that is
   * forced rather than chosen: the sink has to exist before the workspace
   * document is loaded, because a `bootstrap.error` at
   * {@link BOOTSTRAP_STAGE.WORKSPACE} — a malformed or missing document — is
   * itself an event this sink must be able to write. So there is no point in
   * this function at which `workspace.logs.async` is known *and* the sink is
   * not yet built. `@rawbox/cli` loads the workspace for its own reasons
   * before calling here (the run-registry entry and the opportunistic prune
   * both need it) and passes the resolved value in; an embedder that wants a
   * document's `logs.async` honoured resolves it the same way.
   *
   * With `true`, the sink implements `flush()`/`close()` and the caller must
   * let them run before any `process.exit()` — see
   * {@link RunWorkflowOptions.sinkList}. This function always awaits them, on
   * every exit path.
   */
  logsAsync?: boolean;
  /**
   * When the NDJSON file sink starts a new segment of this run's log and how
   * many segments it keeps — `logs.rotate:` in the workspace document,
   * resolved by `resolveLogsConfig` (`workspace/logs.ts`).
   *
   * Resolved by the caller for exactly the reason {@link logsAsync} is: the
   * sink must exist before the workspace document has been read, because a
   * `bootstrap.error` about that document is itself an event it has to write.
   *
   * Omitted means the built-in pair, so **a caller that passes nothing still
   * rotates** (`LOG_ROTATE_DEFAULT_MAX_BYTES` * `LOG_ROTATE_DEFAULT_MAX_FILES`
   * = 1 GiB per run). `logFilePath` keeps naming segment 0 either way, so a
   * caller that recorded that path elsewhere — `@rawbox/cli`'s run registry
   * does — needs no second path.
   */
  logsRotate?: ResolvedLogRotate;
  /**
   * How much of a `step.start` / `step.end` the **main** NDJSON log keeps —
   * `logs.steps:` in the workspace document, `--log-steps` on the CLI, both
   * resolved by `resolveLogsConfig` (`workspace/logs.ts`). Omitted means
   * `full`: every field, the bytes this function has always written.
   *
   * Resolved by the caller for exactly the reason {@link logsAsync} and
   * {@link logsRotate} are: the sink must exist before the workspace document
   * has been read, because a `bootstrap.error` about that document is itself
   * an event it has to write.
   *
   * Reaches the file sink's **main route only**. The error log keeps full
   * `input`/`output` on a failed step under every value, and the caller's own
   * sinks ({@link RunWorkflowOptions.sinkList} — the terminal renderer, the
   * OTel bridge) never see this at all: they observe the producer's events,
   * which are unchanged. That is the point of the policy living on a sink
   * route rather than in the producer — see `events/ndjson-file-sink.ts`'s
   * "`logs.steps`" section.
   */
  logsSteps?: StepDetail;
}

/**
 * The value inside an ok `Result` from {@link runWorkflowInstance}: how the
 * run concluded. `ok` for a run that ran to completion, `interrupted` for a
 * graceful operator stop ({@link RunWorkflowOptions.signal}). A failed run is
 * the `err` branch, as it always was.
 */
export interface RunConclusion {
  outcome: typeof OUTCOME.OK | typeof OUTCOME.INTERRUPTED;
}

/**
 * Upper bound on how long an aborted run may take to conclude after the abort,
 * even with a step handler permanently blocked (a websocket that never ticks).
 * Stopping the machine is synchronous in practice, so this is a backstop, not
 * the expected path.
 */
export const INTERRUPT_GRACE_MS = 2000;

/**
 * Loads a workspace and a workflow file, resolves the workflow into the runtime
 * model, initializes a MachineInstance, and executes the workflow — emitting the
 * typed run-event stream (`../events/`) throughout.
 *
 * The order here is load-bearing. The authoring model and the runtime model
 * are different schemas, so the file is validated
 * as `Workflow` and only the *resolved* result reaches the machine. Resolution
 * needs the contract registries in hand — `plugin:` becomes a
 * `contractRegistryHash` — so plugins are loaded *before* resolution.
 *
 * Observability is a stream, not a side effect: every stage below reports
 * through one {@link RunEventProducer}, whose events reach the NDJSON files via
 * a sink like any other consumer. The two log paths remain explicit
 * parameters of this function — this is the low-level seam. The optional
 * flags defaulting into `.rawbox/logs/<workflow name>/<run-id>.ndjson`
 * (OBSERVABILITY.md, "The run-event stream") are a CLI-layer concern: the CLI generates
 * the run id up front with {@link createRunId}, builds the default paths from
 * it, and passes the same id back in via {@link RunWorkflowOptions.runId} so
 * the filenames and the events inside them agree.
 *
 * @param workspaceSource - Path to the workspace document, or an
 *   already-validated in-memory workspace paired with its directory — see
 *   {@link WorkspaceSource}.
 * @param workflowPath - Path to the workflow document.
 * @param logFilePath - Where the full NDJSON event log is appended.
 * @param errorLogFilePath - Where failure events are mirrored. Derived from
 *   `logFilePath` when omitted.
 * @param options - See {@link RunWorkflowOptions}.
 */
export async function runWorkflowInstance(
  workspaceSource: WorkspaceSource,
  workflowPath: string,
  logFilePath: string,
  errorLogFilePath?: string,
  options?: RunWorkflowOptions,
): Promise<Result<RunConclusion, string>> {
  // Path-based flow stays byte-equivalent: resolved to an absolute path here,
  // exactly as before this type grew a second shape. The in-memory shape only
  // needs its `dir` resolved the same way, so a caller passing a relative one
  // behaves like every other path this module accepts.
  const resolvedWorkspaceSource: WorkspaceSource =
    typeof workspaceSource === 'string'
      ? path.resolve(workspaceSource)
      : { workspace: workspaceSource.workspace, dir: path.resolve(workspaceSource.dir) };
  const absoluteWorkflowPath = path.resolve(workflowPath);
  const absoluteLogFilePath = path.resolve(logFilePath);
  const absoluteErrorLogFilePath = path.resolve(
    errorLogFilePath ?? deriveErrorLogFilePath(logFilePath),
  );

  // A forward reference: the sink is built *inside* the `RunEventProducer`
  // constructor call below, but `onSegmentRotate` is only ever invoked later,
  // during an actual roll — well after `producer` is assigned. A property on
  // a `const` holder, rather than a `let`, so the closure captures a stable
  // binding and reads whatever it holds at call time. See `producer.ts`'s
  // `logRotate` for what the callback does once it runs.
  const producerHolder: { producer?: RunEventProducer } = {};
  const producer = new RunEventProducer({
    runId: options?.runId ?? createRunId(),
    sinkList: [
      createNdjsonFileSink(absoluteLogFilePath, absoluteErrorLogFilePath, {
        async: options?.logsAsync ?? false,
        ...(options?.logsRotate !== undefined ? { rotate: options.logsRotate } : {}),
        // Spread rather than defaulted here, exactly as `rotate` is: the sink
        // owns the built-in `full`, so a caller that passes nothing gets it
        // from one place instead of two that can drift.
        ...(options?.logsSteps !== undefined ? { steps: options.logsSteps } : {}),
        onSegmentRotate: (info) => producerHolder.producer?.logRotate(info),
      }),
      ...(options?.sinkList ?? []),
    ],
    ...(options?.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
  });
  producerHolder.producer = producer;

  try {
    return await executeWorkflowRun(
      producer,
      resolvedWorkspaceSource,
      absoluteWorkflowPath,
      options?.signal,
      options?.preflightTimeoutMs,
      options?.seedOverrideLayerList ?? [],
    );
  } finally {
    // Unconditional: a throw anywhere above still leaves the log files complete
    // and every sink shut down.
    await producer.close();
  }
}

/**
 * Emits a `bootstrap.error`, terminates the stream, and returns the diagnostic
 * to the caller unchanged.
 *
 * `end` is a no-op until `run.start` has been emitted, so a failure in the two
 * stages that establish the run's identity terminates the stream with the
 * bootstrap event alone — there is no `run.end` for a run that never started.
 */
function failBootstrap(
  producer: RunEventProducer,
  stage: BootstrapStage,
  message: string,
): Result<never, string> {
  producer.bootstrapError(stage, message);
  producer.end(OUTCOME.ERROR, { message });
  return err(message);
}

/**
 * The run itself, with every exit routed through `producer`.
 *
 * Split out of {@link runWorkflowInstance} purely so that its many early
 * returns are covered by one `finally` that closes the sinks.
 */
async function executeWorkflowRun(
  producer: RunEventProducer,
  workspaceSource: WorkspaceSource,
  absoluteWorkflowPath: string,
  signal?: AbortSignal,
  preflightTimeoutMs?: number,
  extraSeedOverrideLayerList: readonly SeedOverrideLayer[] = [],
): Promise<Result<RunConclusion, string>> {
  // 1. Load and validate workspace — or, for a workspace-less scratch run
  // (README, "Implicit (workspace-less) workspaces"), accept the caller's
  // already-validated in-memory `Workspace` and skip disk I/O entirely. Both
  // branches produce the same two locals every step below reads, so nothing
  // past this point needs to know which one ran.
  let workspace: Workspace;
  let workspaceDir: string;
  // How the workspace is named in a diagnostic that has to point at it. A
  // scratch run has no document to name, and saying so beats quoting a path
  // that does not exist — see `WorkspaceSource`: nothing is read from or
  // written to disk on that branch, and no `workspace.yaml` is ever
  // synthesized.
  let workspaceLabel: string;
  if (typeof workspaceSource === 'string') {
    const workspaceResult = await loadAndValidateWorkspace(workspaceSource);
    if (workspaceResult.isErr()) {
      return failBootstrap(producer, BOOTSTRAP_STAGE.WORKSPACE, workspaceResult.error);
    }
    workspace = workspaceResult.value;
    workspaceDir = path.dirname(workspaceSource);
    workspaceLabel = workspaceSource;
  } else {
    workspace = workspaceSource.workspace;
    workspaceDir = workspaceSource.dir;
    workspaceLabel = `<in-memory workspace "${workspace.name}">`;
  }

  // 1b. `logs.rotate` is not half-configured.
  //
  // The one cross-field check on `logs:` a schema cannot express — see
  // `workspace/logs.ts`'s `collectLogRotationProblems`. Run here, right after
  // the workspace document is in hand and before anything reads
  // `workspace.logs`, so a half-configured rotate bound fails the run the same
  // way `workflow verify` and `workspace verify` refuse it, rather than being
  // silently resolved away by `resolveLogsConfig`. `BOOTSTRAP_STAGE.WORKSPACE`
  // — unlike the seed-override checks below, this problem is entirely about
  // the workspace document; no `--seed`/CLI layer is involved.
  const logRotationProblemList = collectLogRotationProblems({
    logs: workspace.logs,
    source: workspaceLabel,
  });
  if (logRotationProblemList.length > 0) {
    return failBootstrap(
      producer,
      BOOTSTRAP_STAGE.WORKSPACE,
      `Log rotation validation failed for workspace "${workspaceLabel}":\n` +
        logRotationProblemList.map((problem) => `  - ${problem}`).join('\n'),
    );
  }

  // 2. Load and validate the workflow *document* (authoring model)
  let authoredWorkflow: Workflow;
  try {
    const content = await fs.readFile(absoluteWorkflowPath, 'utf-8');
    const workflowData = parseConfig(content, absoluteWorkflowPath);

    // A file with no `kind:` is rejected here, by name, as not being a Rawbox
    // workflow document at all.
    const typeResult = validateWorkflowType(workflowData, absoluteWorkflowPath);
    if (typeResult.isErr()) {
      return failBootstrap(
        producer,
        BOOTSTRAP_STAGE.WORKFLOW,
        `Workflow validation failed for "${absoluteWorkflowPath}":\n${typeResult.error.message}`,
      );
    }
    authoredWorkflow = workflowData as Workflow;
  } catch (e) {
    return failBootstrap(
      producer,
      BOOTSTRAP_STAGE.WORKFLOW,
      `Failed to load or validate workflow at "${absoluteWorkflowPath}": ${getErrorMessage(e)}`,
    );
  }

  // 2b. The workspace's seed overrides, merged in — ONE call, and the only
  // place the workflow document's seeds are replaced.
  //
  // Everything below this line reads `authoredWorkflow` and must therefore read
  // the **merged** document, not the authored one: `resolveWorkflow` expands
  // seeds into the writes step 7's loop performs, and `validateSeedData` checks
  // each of those against the consuming step's `inputSchema`. Merging anywhere
  // later would type-check a value this run is not going to write, or write one
  // nothing checked.
  //
  // `layerList` is the precedence order, lowest first. The workspace supplies
  // the first layer; `extraSeedOverrideLayerList` — `@rawbox/cli`'s `--seed`,
  // via `RunWorkflowOptions.seedOverrideLayerList` — is appended after it, which
  // is the whole of `CLI > workspace > workflow`: no rule, diagnostic or other
  // call site moves. Kept as a local so step 3 can report exactly what this call
  // applied without re-deriving it.
  //
  // Placed after the workflow document is validated (an override is checked
  // against a key table, which needs a schema-valid `storage:`) and before
  // `run.start`, because a document whose overrides do not apply has not
  // established a run to report against — the same reason stages 1 and 2 are
  // the ones whose failures precede it.
  //
  // **The outer keys are checked here, and this is the entry point that used to
  // check nothing.** A `seedOverrides:` block is keyed by workflow path, so
  // "does this block name a workflow this workspace lists" is answerable from
  // `workflowPathList` in the document already in hand — no other workflow
  // document required. Before path keying, a run could not tell a misspelt
  // block from a sibling workflow's perfectly good one, so it applied what
  // matched, said nothing, and seeded the workflow's own value; only
  // `workspace verify` ever caught the typo. See `seed-overrides.ts`'s module
  // note.
  //
  // `workspaceDir` is the path base in both branches: for an in-memory
  // workspace it is the directory that stands in for the workspace directory
  // (`WorkspaceSource`), the same base its `workflowPathList` and
  // `targetFolder:` resolve against — so a scratch run declaring no block still
  // gets no layer and no problems, and an embedder that does declare one is
  // checked rather than silently ignored.
  const overridePathProblem = formatSeedOverridePathProblems({
    seedOverrides: workspace.seedOverrides,
    workflowPathList: workspace.workflowPathList,
    workspaceDir,
    source: workspaceLabel,
  });
  if (overridePathProblem !== undefined) {
    return failBootstrap(
      producer,
      BOOTSTRAP_STAGE.SEED_OVERRIDE,
      overridePathProblem,
    );
  }

  const seedOverrideLayerList: SeedOverrideLayer[] = [
    seedOverrideLayerFor({
      seedOverrides: workspace.seedOverrides,
      workflowPath: absoluteWorkflowPath,
      workspaceDir,
      source: workspaceLabel,
    }),
  ]
    .filter((layer): layer is SeedOverrideLayer => layer !== undefined)
    .concat(extraSeedOverrideLayerList);

  const overrideResult = applySeedOverrides({
    workflow: authoredWorkflow,
    workflowSource: absoluteWorkflowPath,
    layerList: seedOverrideLayerList,
  });
  if (overrideResult.isErr()) {
    // `SEED_OVERRIDE`, not `WORKSPACE`: the failing layer may be the CLI's
    // `--seed`, which has nothing to do with the workspace document at all —
    // see `BOOTSTRAP_STAGE.SEED_OVERRIDE`'s own doc (`event-types.ts`).
    return failBootstrap(
      producer,
      BOOTSTRAP_STAGE.SEED_OVERRIDE,
      overrideResult.error,
    );
  }
  authoredWorkflow = overrideResult.value;

  // Every key any layer applied, and which layer supplied it — safe to read
  // straight off `seedOverrideLayerList` now that `applySeedOverrides` above
  // returned `ok` for it (`summarizeAppliedSeedOverrides`'s own doc says why).
  // Computed here, alongside the merge it describes, and reported once the run
  // has an identity to attach it to (step 3, immediately below).
  const appliedSeedOverrideList = summarizeAppliedSeedOverrides(seedOverrideLayerList);

  // 3. The run has an identity — open the stream.
  //
  // Stages 1 and 2 are what *establish* that identity, which is why they are the
  // only ones whose failures precede `run.start`.
  producer.start(workspace.name, authoredWorkflow.name);

  // 3b. Echo every applied override into the stream, right away.
  //
  // The CLI layer is the least reviewable override there is: no file, no diff,
  // nothing in `rawbox.lock`. This is what keeps a run's behaviour
  // reconstructible from its own artifacts anyway — `producer.seedOverrideApplied`
  // is a no-op when `appliedSeedOverrideList` is empty, so a run overriding
  // nothing produces a stream identical to one from before `--seed` existed.
  producer.seedOverrideApplied(appliedSeedOverrideList);

  // 4. Load the declared plugins — cache and hash map in a single pass
  //
  // `loadPlugins` writes each entry of `registryHashByPlugin` from the very
  // `addContractRegistry` call that inserted the registry, so the map and the
  // cache are produced together and cannot disagree. That is what makes the
  // resolver's "stale map" diagnostic unreachable from this path.
  //
  // Resolution bases, in order: the workspace's *target folder* — where
  // `workspace setup` installed the declared plugins — then the workspace
  // directory (a `node_modules` next to `workspace.yaml` or anywhere above it),
  // then the process cwd. Node's own resolution, relative to this module,
  // remains the last resort.
  //
  // The target folder leads because it is the only base that is authoritative:
  // it is where setup put the packages this very workflow declared. A plugin
  // installed *only* into a separate target folder is otherwise unresolvable
  // from any cwd but that folder. The default target is
  // `<workspaceDir>/.rawbox`, so a workspace that never declares `targetFolder:`
  // still resolves and installs to the same place.
  const resolvedTargetFolder = resolveTargetFolder(workspaceDir, workspace);

  const contractRegistryCache = new ContractRegistryCache();
  const pluginLoad = await PluginDiscoverer.loadPlugins(
    Object.keys(authoredWorkflow.plugins),
    contractRegistryCache,
    {
      resolveFrom: dedupePathList([
        resolvedTargetFolder,
        workspaceDir,
        process.cwd(),
      ]),
    },
  );

  // 5. Read the workspace lock, when present
  const lockResult = await readWorkspaceLock(workspaceDir);
  if (lockResult.isErr()) {
    return failBootstrap(producer, BOOTSTRAP_STAGE.LOCK, lockResult.error);
  }

  // 6. Resolve the authoring document into the runtime model
  const resolveResult = resolveWorkflow(
    authoredWorkflow,
    contractRegistryCache,
    pluginLoad.registryHashByPlugin,
    lockResult.value,
  );
  if (resolveResult.isErr()) {
    // A resolution failure is very often a load failure one level down, so the
    // import errors are attached rather than left in a place nobody looks.
    return failBootstrap(
      producer,
      BOOTSTRAP_STAGE.RESOLVE,
      `${resolveResult.error}${formatSkipped(pluginLoad.skipped)}`,
    );
  }
  const workflow: ResolvedWorkflow = resolveResult.value;

  // Every `step.*` event's identity comes from this table: `plugin`/`operation`
  // exist only in the authoring document, the registry hash only in the resolved
  // one, so the two are zipped once here rather than re-derived per event.
  producer.setStepDescriptorList(
    buildStepDescriptorList(authoredWorkflow, workflow),
  );

  // 7. Validate seed data before database initialization/seeding
  const seedValidation = validateSeedData(workflow, contractRegistryCache);
  if (seedValidation.isErr()) {
    return failBootstrap(
      producer,
      BOOTSTRAP_STAGE.SEED_VALIDATION,
      `Seed Validation Failed: ${seedValidation.error.message}`,
    );
  }

  // 7b. A strategy this build can express but cannot run
  //
  // `BoxStrategy` is the set of strategies a *document* may declare; the set a
  // *run* can execute is whatever this binary wires a store for, and the two
  // are allowed to diverge while a strategy's shape lands ahead of its store
  // (`workflow/store-support.ts` has the full argument). The document is valid
  // and `workflow verify` passes it — so the refusal belongs here, on the run
  // path, and it belongs **before** the two lines below.
  //
  // Before, specifically, because the next two statements open an LMDB
  // environment and then write every seed into it. Discovering the gap at the
  // first `put` instead would leave a created environment and, for a document
  // mixing wired and unwired strategies, a partially seeded store behind a run
  // that was never going to work. This check reads the authored document and
  // nothing else, so it can run while there is still nothing to leave behind.
  const unwiredProblemList = collectUnwiredStrategyProblems(authoredWorkflow);
  if (unwiredProblemList.length > 0) {
    return failBootstrap(
      producer,
      BOOTSTRAP_STAGE.STORE,
      unwiredProblemList.join('\n'),
    );
  }

  // The LMDB data directory lives under the resolved target folder — the same
  // `.rawbox/` a workspace's installed plugins land in by default — not beside
  // `workspace.yaml` directly. No legacy fallback: an existing
  // `<workspaceDir>/data` from an older checkout is simply not consulted.
  const dbDirUrl = pathToFileURL(path.join(resolvedTargetFolder, 'data'));
  const boxStoreLmdb = BoxStoreLmdb.create(workspace.name, dbDirUrl);

  // Seed the database if seedData is present.
  //
  // One `putSync` per `Seed`, with no strategy special case: the resolver has
  // already expanded each `lmdb-fifo` seed into one `Seed` per list element, so
  // `put` here means "overwrite" on `lmdb-kv` and "enqueue one entry" on
  // `lmdb-fifo` — exactly what it means everywhere else.
  // The list order is the enqueue order.
  //
  // The whole pass reports as a single `storage.seed` event: it is one
  // transaction, so per-seed events would advertise a granularity it does not
  // have (see `StorageSeedEvent`).
  const seedList = workflow.seedData;
  if (seedList && seedList.length > 0) {
    const seedStartedAtMs = Date.now();
    // Awaited at the boundary only. The callback stays synchronous —
    // `putSync`, not `put` — because `BoxStoreLmdb.transaction` runs it inside
    // `transactionSync`; see that method's doc comment for why an `await`
    // inside would commit an empty transaction and pin an MVCC snapshot. The
    // `await` here is what lets a future async store back this same loop.
    const seedResult = await boxStoreLmdb.transaction((boxStore) => {
      for (const seed of seedList) {
        const putRes = boxStore.putSync({
          content: seed.value,
          location: {
            key: seed.key,
            workflow: workflow.name,
            workspace: workspace.name,
            strategy: seed.strategy,
          },
        });
        if (putRes.isErr()) {
          return err(`Failed to write seed data for key "${seed.key}": ${putRes.error}`);
        }
      }
      return ok(undefined);
    });

    if (seedResult.isErr()) {
      return failBootstrap(
        producer,
        BOOTSTRAP_STAGE.SEED,
        `Database Seeding Failed: ${seedResult.error}`,
      );
    }

    producer.storageSeed(seedList, Date.now() - seedStartedAtMs);
  }


  // 8. Setup XState machine input
  //
  // An abort that arrived during preflight is honoured here, at the boundary
  // between "getting ready" and "executing": the preflight stages above were
  // not cancelled mid-way (see {@link RunWorkflowOptions.signal}), but the
  // machine — and therefore any step — never starts. The run concludes with
  // an interrupted `run.end` reporting zero step executions.
  if (signal?.aborted) {
    producer.end(OUTCOME.INTERRUPTED);
    return ok({ outcome: OUTCOME.INTERRUPTED });
  }

  const machine = createWorkflowMachine(
    boxStoreLmdb,
    contractRegistryCache,
    preflightTimeoutMs,
  );
  const input = {
    params: {
      runId: producer.runId,
      workflow,
      workspace: workspace.name,
    },
    execution: {
      todoStep: { index: 0 },
      doneStep: null,
    },
    boxStoreLmdb,
  };

  const actor = createActor(machine, { input });

  // 9. Derive `step.start`/`step.end` from the machine's transitions.
  //
  // Subscribed before the completion watcher below so the producer sees every
  // snapshot, including the initial one `start()` emits.
  actor.subscribe({
    next(state) {
      producer.observe(state);
    },
  });

  // Workflow-authored `observability/log` lines join the same stream for the
  // duration of the run, and only for that duration.
  producer.installLogChannel();

  // 10. Execute machine and return promise result
  //
  // The abort seam (OBSERVABILITY.md, "Event kinds"): the machine already has a
  // `STOP` event whose transition — from anywhere inside `running` — lands in
  // the final `stopping` state, stopping whatever actor is invoked without
  // waiting for it. That is exactly the graceful-shutdown contract: no new
  // step is selected, an in-flight handler's promise is abandoned (XState
  // discards a stopped actor's result), and the machine reaches `done`
  // synchronously, so the run concludes promptly. The producer is told first
  // (`markInterrupted`) so the stop's own transition abandons the in-flight
  // step instead of fabricating an error `step.end` for it. The grace timer
  // is a pure backstop bounding the wait even if the machine somehow failed
  // to conclude.
  let interruptRequested = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      actor.subscribe({
        next(state) {
          if (state.status === 'done') {
            resolve();
          }
        },
        error(e) {
          reject(e);
        },
      });

      if (signal) {
        onAbort = (): void => {
          if (interruptRequested) {
            return;
          }
          interruptRequested = true;
          producer.markInterrupted();
          if (actor.getSnapshot().status === 'active') {
            actor.send({ type: 'STOP' });
          }
          graceTimer = setTimeout(resolve, INTERRUPT_GRACE_MS);
          graceTimer.unref();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      actor.start();

      // `addEventListener` on an already-aborted signal never fires, so an
      // abort that slipped in between the step 8 check and the wiring above is
      // picked up here by hand.
      if (signal?.aborted) {
        onAbort?.();
      }
    });

    if (interruptRequested) {
      // Backstop path only: if the grace timer, not the machine's own `done`,
      // resolved the wait, stop the actor so nothing of it outlives the run.
      if (actor.getSnapshot().status === 'active') {
        actor.stop();
      }
      // The final event, with the step counts of the executions that actually
      // reported; no `severity`, no `error` — an operator stop is intent, not
      // an alarm (OBSERVABILITY.md, "`severity`").
      producer.end(OUTCOME.INTERRUPTED);
      return ok({ outcome: OUTCOME.INTERRUPTED });
    }

    // The preflight actor reports failures as a `Result`, not a rejection, so a
    // machine that stopped on a bootstrap error still resolves the promise
    // above. The context error is the only signal that the run did not succeed.
    const runError = actor.getSnapshot().context.error;
    if (runError) {
      // `timeoutMs` rides the machine's error whenever a runner bound is what
      // ended the run — a bounded step's, or preflight's. Passing it through
      // puts `timed_out`/`timeout_ms` on the `run.end`, which for a **preflight**
      // timeout is the only event that can carry it: no step ever started, so
      // there is no `step.end` to mark. See `machine-types.ts`'s `error` doc for
      // why the field travels beside the message rather than inside it.
      producer.end(
        OUTCOME.ERROR,
        {
          message: runError.message,
          ...(runError.stack ? { stack: runError.stack } : {}),
        },
        runError.timeoutMs,
      );
      return err(`Workflow execution failed: ${runError.message}`);
    }

    producer.end(OUTCOME.OK);
    return ok({ outcome: OUTCOME.OK });
  } catch (e) {
    producer.end(OUTCOME.ERROR, { message: getErrorMessage(e) });
    return err(`Workflow execution failed: ${getErrorMessage(e)}`);
  } finally {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
    }
    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
    producer.uninstallLogChannel();
  }
}
