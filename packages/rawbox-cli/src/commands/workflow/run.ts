import fs from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { Argv } from 'yargs';
import {
  DOCUMENT_KIND,
  OUTCOME,
  PluginDiscoverer,
  STEP_DETAIL_LIST,
  createOtelSink,
  createRunId,
  dedupePathList,
  discoverWorkspace,
  loadAndValidateWorkspace,
  parseConfig,
  resolveLogsConfig,
  resolveTargetFolder,
  resolveWorkspaceTargetFolder,
  runWorkflowInstance,
  setupNpmPackage,
  setupWorkspace,
  validateWorkflowType,
  type RunEventSink,
  type StepDetail,
  type Workflow,
  type Workspace,
  type WorkspaceSource,
} from '@rawbox/runner';
import { getErrorMessage } from '../../utils/error.js';
import { parseSeedFlagList, seedOverrideLayerFromFlags } from '../../utils/seed-flag.js';
import { getProcessStartedAtMs } from '../../runs/pid-probe.js';
import { pruneOptionsFromResolvedLogs, pruneRunsOpportunistically } from '../../runs/prune.js';
import { registryFilePathFor, writeRegistryEntrySync } from '../../runs/registry-io.js';
import { createRunRegistrySink } from '../../runs/registry-sink.js';
import { RUN_REGISTRY_FORMAT, RUN_STATUS, type RunRegistryEntry } from '../../runs/types.js';
import { performAutoSetup } from './auto-setup.js';
// Statically imported on purpose, and safe to be: `telemetry/otel.ts` has no
// static OpenTelemetry import of its own — every SDK package is behind a
// dynamic `import()` inside `startOtelSdk`, so a run that never activates the
// bridge never loads one (rawbox-runner README, "OpenTelemetry").
import { isOtelActive, startOtelSdk, type OtelSession } from '../../telemetry/otel.js';
import {
  OUTPUT_MODE_LIST,
  createTerminalSink,
  resolveDefaultOutputMode,
  type OutputMode,
  type Verbosity,
} from '../../render/terminal-sink.js';

export interface WorkflowRunOptions {
  /** Path to the workspace config file. Auto-discovered from `workflowPath` when omitted. */
  workspace?: string;
  /**
   * Run without a workspace document on disk (rawbox-runner README, "Implicit (workspace-less) workspaces"):
   * synthesizes an in-memory workspace named this value, scoped to just
   * this one workflow, instead of discovering one or requiring
   * `--workspace`. Never written to disk as `workspace.yaml`.
   *
   * State (the LMDB store under `<workflow dir>/.rawbox/data`) is keyed by
   * this name — two scratch runs sharing a name share state, two with
   * different names are isolated. Mutually exclusive with `workspace`.
   */
  workspaceName?: string;
  /**
   * Only meaningful alongside `workspaceName`: deletes that scratch
   * workspace's LMDB environment before running, so the run starts from
   * empty state rather than whatever a same-named run left behind.
   */
  fresh?: boolean;
  /**
   * Path to save the run's NDJSON event log. Defaults to
   * `<resolved target folder>/logs/<workflow name>/<run-id>.ndjson`.
   */
  logFile?: string;
  /**
   * Path to save execution/validation error logs. Defaults to
   * `<resolved target folder>/logs/<workflow name>/<run-id>.error.ndjson`.
   */
  errorLog?: string;
  /**
   * Controls auto-setup on run (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)"):
   *
   * - `undefined` (default) — auto-setup runs only when a declared plugin
   *   does not resolve.
   * - `false` (`--no-setup`) — never auto-setup; a missing plugin then fails
   *   the run exactly as it did before this feature existed.
   * - `true` (`--setup`) — always reinstall, even when every plugin already
   *   resolves.
   */
  setup?: boolean;
  /**
   * Terminal rendering shape (OBSERVABILITY.md, "CLI surfaces"). Defaults to
   * {@link resolveDefaultOutputMode} — `pretty` on a TTY, `json` when piped.
   *
   * `ndjson` (and its older spelling `json`) is not a rendering: it puts the
   * raw run-event stream on fd 1, through the same writer the log files use.
   * The file sinks stay active alongside it — stdout is a fan-out, not a
   * redirect, and `runs show`/`workspace logs` still read the run's own file
   * afterwards.
   */
  output?: OutputMode;
  /**
   * Buffer the NDJSON sinks' writes instead of writing each line before
   * returning — `--log-async`, the CLI half of `logs.async:`
   * (`@rawbox/runner`'s `workspace/logs.ts`). `undefined` (default) defers to
   * the workspace document, then to the built-in `false`.
   *
   * Highest precedence, per `resolveLogsConfig`'s CLI > workspace.yaml >
   * built-in default: the flag beats a `logs.async:` in the document, in both
   * directions (`--log-async` and `--no-log-async`).
   */
  logAsync?: boolean;
  /**
   * How much of a `step.start` / `step.end` the run's **main** NDJSON log
   * keeps — `--log-steps`, the CLI half of `logs.steps:` (`@rawbox/runner`'s
   * `workspace/logs.ts`). `undefined` (default) defers to the workspace
   * document, then to the built-in `full`.
   *
   * Highest precedence, per `resolveLogsConfig`'s CLI > workspace.yaml >
   * built-in default, and the same three values the document accepts:
   * `full` keeps every field, `summary` drops `input`/`output`, `off` drops
   * the two kinds outright. The error log is unaffected by all three, and so
   * is what `-v`/`-vv` render — those read the producer's events, not the
   * file's lines.
   */
  logSteps?: StepDetail;
  /**
   * `-v` repeat count: `0` (default) prints the header/step/recap lines
   * only, `1` adds each step's input/output keys, `2` adds their full
   * values, `3` adds run/seed identity and registry hashes. Ignored outside
   * `pretty` output.
   */
  verbosity?: Verbosity;
  /**
   * Export this run as OpenTelemetry traces, logs and metrics
   * (rawbox-runner README, "Turning it on").
   *
   * - `undefined` (default) — active only when a standard OTLP endpoint env
   *   var (`OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`)
   *   is set, so a machine already configured for OTel needs no flag.
   * - `true` (`--otel`) — always export, defaulting to the OTLP spec's own
   *   `http://localhost:4318` when no endpoint is configured.
   * - `false` (`--no-otel`) — never export, even with the env vars set.
   *
   * See {@link isOtelActive} for the rule and `../../telemetry/otel.ts` for
   * why the SDK is loaded lazily.
   */
  otel?: boolean;
  /**
   * Milliseconds between `run.heartbeat` events while a step is in flight
   * (OBSERVABILITY.md, "`run.heartbeat`"). `undefined` (default) uses
   * `runWorkflowInstance`'s own default, ~10s; `0` disables heartbeats
   * entirely.
   */
  heartbeatMs?: number;
  /**
   * Milliseconds the run waits for preflight to import every step's definition
   * module before giving up. `undefined`
   * (default) uses `runWorkflowInstance`'s own default, 30s; `0` disables the
   * bound entirely.
   *
   * Unlike `--heartbeat`, whose default only changes how *often* a live run
   * reports, this default can end a run: a plugin that blocks at import fails
   * after 30s instead of hanging with `run.start` as its last event forever.
   */
  preflightTimeoutMs?: number;
  /**
   * `--seed key=<json>`, repeatable: replaces the value of a seed the
   * workflow already declares, taking precedence over a workspace
   * `seedOverrides:` block for the same key — `CLI > workspace > workflow`
   * (`@rawbox/runner`'s `workspace/seed-overrides.ts` module doc). Every rule
   * that block obeys applies unchanged: only a key the workflow already
   * seeds, replaced whole, re-validated against the strategy the workflow
   * declares. See `../../utils/seed-flag.ts` for the JSON parsing and its
   * own diagnostic when a value is not valid JSON.
   *
   * Raw flag values, not yet parsed — parsing happens inside
   * {@link runWorkflowCommand} itself, where a malformed value can exit(1)
   * with a named diagnostic before any workspace or workflow I/O happens.
   */
  seed?: string[];
}

/**
 * Shared yargs builder and handler for the `run` command.
 * Used by both `workflow run` and the top-level `run` alias.
 */
export const runCommandDefinition = {
  builder: (yargs: Argv): Argv => {
    return yargs
      .positional('workflow-path', {
        description: 'Path to the workflow configuration file',
        type: 'string',
      })
      .option('workspace', {
        description: 'Path to the workspace context config file (auto-discovered from the workflow path when omitted)',
        type: 'string',
      })
      .option('workspace-name', {
        description:
          'Run without a workspace document on disk: synthesizes an in-memory workspace ' +
          'named <name>, scoped to just this one workflow — its ".rawbox/" lands next to the ' +
          'workflow file rather than anywhere a discovered workspace document would put it. ' +
          'State (the LMDB store) is keyed by this name: reruns with the same name share it, ' +
          'different names are isolated. Requires a value — there is no default; pass the ' +
          "workflow's own name if that is what you want. Mutually exclusive with --workspace.",
        type: 'string',
        requiresArg: true,
      })
      .option('fresh', {
        description:
          "Only valid with --workspace-name: deletes that scratch workspace's LMDB " +
          'environment before running, so the run starts from empty state instead of sharing ' +
          'whatever a previous run under the same name left behind.',
        type: 'boolean',
      })
      .conflicts('workspace', 'workspace-name')
      .implies('fresh', 'workspace-name')
      .option('log-file', {
        description:
          "Path to save the run's NDJSON event log — one typed event per line. Defaults to " +
          '<resolved target folder>/logs/<workflow name>/<run-id>.ndjson',
        type: 'string',
      })
      .option('error-log', {
        alias: 'e',
        description:
          'Path to save separate execution and validation error logs. Defaults to ' +
          '<resolved target folder>/logs/<workflow name>/<run-id>.error.ndjson',
        type: 'string',
      })
      // Defining `setup` as boolean gives yargs both `--setup` and `--no-setup`
      // for free; `argv.setup` is `true`, `false`, or `undefined` when neither
      // flag was passed — the tri-state {@link WorkflowRunOptions.setup} expects.
      .option('setup', {
        description:
          'Whether to auto-install this workflow\'s declared plugins before running. Default: ' +
          'only when one or more do not already resolve. --no-setup skips the install, so a ' +
          'missing plugin fails the run as it always has; --setup forces a reinstall even when ' +
          'everything already resolves.',
        type: 'boolean',
      })
      .option('output', {
        description:
          'Terminal rendering shape. "pretty" narrates the run (header, one line per step, a ' +
          'recap); "ndjson" streams the same NDJSON events the log file receives, one per stdout ' +
          'line, byte for byte, for piping into jq or into a systemd/Docker log stack — the log ' +
          'files are still written; "quiet" prints only the recap and error lines. "json" is ' +
          'accepted as the older spelling of "ndjson" and means exactly the same thing. Defaults ' +
          'to "pretty" on a TTY, "json" when the output is piped.',
        type: 'string',
        choices: OUTPUT_MODE_LIST,
      })
      // Boolean, so yargs gives `--no-log-async` for free and `argv['log-async']`
      // is the tri-state `resolveLogsConfig` expects as its override: `true`,
      // `false`, or `undefined` when neither flag was passed, which defers to
      // the workspace document.
      .option('log-async', {
        description:
          "Buffer the run's NDJSON log writes instead of writing each line before continuing. " +
          'Off by default, deliberately: a run killed mid-workflow is exactly the one whose last ' +
          'lines explain why, and event volume is one line per step rather than per byte of data, ' +
          'so the synchronous cost is not the bottleneck it would be in a request logger. Turn it ' +
          'on only having measured that it is. run.end is made durable in both modes. Overrides ' +
          'the workspace document\'s logs.async:; --no-log-async forces it back off.',
        type: 'boolean',
      })
      // A closed set of three rather than a boolean pair: `choices:` is what
      // makes `--log-steps sumary` a yargs error naming the three legal values
      // instead of a silently-ignored word, matching how the workspace
      // document's own schema refuses it.
      .option('log-steps', {
        description:
          "How much of each step event the run's main NDJSON log keeps. \"full\" (default) " +
          'writes every field; "summary" writes the step, its outcome, duration and error but ' +
          'omits the input/output records; "off" omits step.start and step.end entirely. Step ' +
          'payloads are the bulk of a looping workflow\'s log — they grow with the state the ' +
          'workflow accumulates — so this is the dial for a run whose log outgrows its disk. ' +
          'The error log is never affected: a failed step keeps its full input/output there ' +
          'under all three values, as do -v/-vv on the terminal. Overrides the workspace ' +
          "document's logs.steps:.",
        type: 'string',
        choices: STEP_DETAIL_LIST,
      })
      .option('verbose', {
        alias: 'v',
        description:
          'Repeatable, pretty output only: -v adds each step\'s input/output storage keys and ' +
          'short values, -vv adds the values in full (one oversized value truncated), -vvv adds ' +
          'run/seed identity and registry hashes.',
        type: 'count',
      })
      // Boolean, so yargs gives `--no-otel` for free and `argv.otel` is the
      // tri-state {@link isOtelActive} expects: `true`, `false`, or
      // `undefined` when neither flag was passed.
      .option('otel', {
        description:
          'Export this run as OpenTelemetry traces, logs and metrics over OTLP/HTTP, on top of ' +
          'the NDJSON log. Endpoints, headers and sampling come from the standard ' +
          'OTEL_EXPORTER_OTLP_* environment variables (default http://localhost:4318). Already ' +
          'the default when OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ' +
          'is set; --no-otel opts back out. With the flag off, no OpenTelemetry SDK is loaded ' +
          'at all.',
        type: 'boolean',
      })
      .option('heartbeat', {
        description:
          'Milliseconds between run.heartbeat events while a step is in flight, so a step ' +
          'blocked for minutes is distinguishable from a hung process. Defaults to ~10000ms; ' +
          '--heartbeat 0 disables heartbeats entirely.',
        type: 'number',
      })
      .option('preflight-timeout', {
        description:
          'Milliseconds to wait for preflight to import every step definition before failing ' +
          'the run, so a plugin that blocks at import cannot hang it with no step, no ' +
          'heartbeat and no end event. Defaults to 30000ms; --preflight-timeout 0 disables ' +
          'the bound entirely.',
        type: 'number',
      })
      .option('seed', {
        description:
          'Replace the value of a seed the workflow already declares: --seed key=<json>, ' +
          'repeatable. Takes precedence over a workspace seedOverrides: block for the same ' +
          'key (CLI > workspace > workflow); every other rule that block obeys still applies ' +
          '— only a key the workflow already seeds, replaced whole, re-validated against the ' +
          "workflow's own declared strategy. The value must be JSON, not a bare word: " +
          '--seed sleep_ms=500, --seed name=\'"Ada"\', not --seed name=Ada, which is refused ' +
          'rather than silently stored as the string "Ada". ' +
          'NOT a channel for secrets — the value lands in this shell\'s history like any other ' +
          'argument. A backend connection string that needs one already has a channel: ' +
          'backends: entries interpolate ${ENV_VAR} references from the environment.',
        type: 'array',
        string: true,
      });
  },
  handler: async (argv: Record<string, unknown>): Promise<void> => {
    await runWorkflowCommand(argv['workflow-path'] as string, {
      ...(argv.workspace ? { workspace: argv.workspace as string } : {}),
      ...(argv['workspace-name'] ? { workspaceName: argv['workspace-name'] as string } : {}),
      ...(argv.fresh !== undefined ? { fresh: argv.fresh as boolean } : {}),
      ...(argv['log-file'] ? { logFile: argv['log-file'] as string } : {}),
      ...(argv['error-log'] ? { errorLog: argv['error-log'] as string } : {}),
      ...(argv.setup !== undefined ? { setup: argv.setup as boolean } : {}),
      ...(argv.output ? { output: argv.output as OutputMode } : {}),
      ...(argv['log-async'] !== undefined ? { logAsync: argv['log-async'] as boolean } : {}),
      ...(argv['log-steps'] !== undefined
        ? { logSteps: argv['log-steps'] as StepDetail }
        : {}),
      ...(argv.verbose ? { verbosity: Math.min(argv.verbose as number, 3) as Verbosity } : {}),
      ...(argv.otel !== undefined ? { otel: argv.otel as boolean } : {}),
      ...(argv.heartbeat !== undefined ? { heartbeatMs: argv.heartbeat as number } : {}),
      ...(argv['preflight-timeout'] !== undefined
        ? { preflightTimeoutMs: argv['preflight-timeout'] as number }
        : {}),
      ...(argv.seed ? { seed: argv.seed as string[] } : {}),
    });
  },
};

/**
 * Runs a workflow from nothing more than a workflow path: the workspace
 * context is auto-discovered (see `discoverWorkspace`, shared with
 * `workflow verify`) unless `--workspace` overrides it, and the log
 * destinations default under the resolved workspace target folder unless
 * `--log-file`/`--error-log` override them.
 *
 * `--workspace-name` opts out of both discovery and disk entirely — a
 * workspace-less "scratch" run (rawbox-runner README, "Implicit (workspace-less) workspaces"): the
 * workspace is synthesized in memory, scoped to this one workflow, and never
 * written to disk. A workflow with no discoverable workspace and no
 * `--workspace-name` is a hard error: `runWorkflowInstance` needs a workspace
 * to resolve plugins and scope storage.
 */
export async function runWorkflowCommand(
  workflowPath: string,
  options: WorkflowRunOptions = {},
): Promise<void> {
  const absoluteWorkflowPath = path.resolve(process.cwd(), workflowPath);

  // -- 0. --seed key=<json> ---------------------------------------------------
  // Parsed before anything else: it needs no workspace, no workflow document
  // and no plugin — it is pure argv, so a malformed value fails immediately,
  // named, rather than surfacing later as a bootstrap error attributed to a
  // workspace or workflow document that had nothing wrong with it.
  const seedFlagResult = parseSeedFlagList(options.seed ?? []);
  if (seedFlagResult.isErr()) {
    p.log.error(pc.red(seedFlagResult.error));
    process.exit(1);
    return;
  }
  const cliSeedOverrideLayer = seedOverrideLayerFromFlags(seedFlagResult.value);

  // -- 1. Load and schema-check the workflow ---------------------------------
  // Needed up front (rather than left to `runWorkflowInstance`) for its
  // `name`, which the default log path is keyed by.
  let workflow: Workflow;
  try {
    const content = await fs.readFile(absoluteWorkflowPath, 'utf-8');
    const document = parseConfig(content, absoluteWorkflowPath);

    const typeResult = validateWorkflowType(document, workflowPath);
    if (typeResult.isErr()) {
      p.log.error(pc.red(typeResult.error.message));
      process.exit(1);
      return;
    }
    workflow = document as Workflow;
  } catch (error) {
    p.log.error(
      pc.red(`Failed to load workflow "${workflowPath}": ${getErrorMessage(error)}`),
    );
    process.exit(1);
    return;
  }

  // -- 2. Workspace context ---------------------------------------------------
  // Three shapes, mutually exclusive by construction (yargs' `.conflicts`
  // enforces `--workspace`/`--workspace-name` at the CLI layer):
  //   - `scratchWorkspace`/`scratchWorkspaceDir` set: `--workspace-name` was
  //     passed. No document is read or written; `runWorkflowInstance` takes
  //     the in-memory pair directly (rawbox-runner README, "The `WorkspaceSource` seam").
  //   - `workspaceFile` set, `scratchWorkspace` unset: an on-disk document,
  //     either `--workspace` or discovery.
  let workspaceFile: string | undefined =
    options.workspace !== undefined
      ? path.resolve(process.cwd(), options.workspace)
      : undefined;
  let scratchWorkspace: Workspace | undefined;
  let scratchWorkspaceDir: string | undefined;

  if (options.workspaceName !== undefined) {
    // The workflow's own directory stands in for "the workspace directory":
    // plugin resolution base, `rawbox.lock` location (almost always absent
    // here), and — since no `targetFolder:` is ever set on a synthesized
    // workspace — the base `resolveTargetFolder` resolves `.rawbox/` under.
    // That is what lands `.rawbox/` next to the workflow file rather than
    // anywhere a discovered workspace document would have put it.
    scratchWorkspaceDir = path.dirname(absoluteWorkflowPath);
    scratchWorkspace = {
      kind: DOCUMENT_KIND.WORKSPACE,
      name: options.workspaceName,
      workflowPathList: [absoluteWorkflowPath],
    };

    p.log.info(
      `state persisted under workspace ${pc.green(`"${options.workspaceName}"`)} — reruns ` +
        `with the same name share it.`,
    );
  } else if (!workspaceFile) {
    const discovery = await discoverWorkspace(absoluteWorkflowPath);

    if (discovery.ambiguousList) {
      p.log.error(
        pc.red(
          `Several workspace documents were found in one directory:\n` +
            discovery.ambiguousList.map((file) => `  - ${file}`).join('\n') +
            `\nPass the one to run against explicitly: --workspace <file>`,
        ),
      );
      process.exit(1);
      return;
    }

    if (discovery.file) {
      workspaceFile = discovery.file;
      p.log.info(
        `Auto-discovered workspace ${pc.green(workspaceFile)} (kind: ${DOCUMENT_KIND.WORKSPACE}).`,
      );
    } else {
      p.log.error(
        pc.red(
          `Could not locate a workspace document for "${workflowPath}". Running a workflow ` +
            `needs a workspace context to resolve plugins and scope storage. Directories searched:\n` +
            discovery.searchedList.map((directory) => `  - ${directory}`).join('\n') +
            `\nPass it explicitly: npx rawbox-cli workflow run ${workflowPath} --workspace <workspace file>\n` +
            `Or run without a workspace document at all: npx rawbox-cli workflow run ${workflowPath} ` +
            `--workspace-name <name>`,
        ),
      );
      process.exit(1);
      return;
    }
  }

  const resolvedTargetFolder = scratchWorkspace
    ? resolveTargetFolder(scratchWorkspaceDir!, scratchWorkspace)
    : await resolveWorkspaceTargetFolder(workspaceFile!);

  // -- 2b. --fresh: wipe a prior scratch run's state -------------------------
  // Only reachable alongside `--workspace-name` (yargs' `.implies` enforces
  // it). `BoxStoreLmdb.create` opens its LMDB environment at
  // `<rootDirectoryUrl>/<workspace.name>/` (`LmdbEnvCache.getOrCreateEnv`),
  // and `runWorkflowInstance` passes `<resolved target folder>/data` as that
  // root — so the environment this scratch workspace's runs share lives at
  // exactly `<resolved target folder>/data/<name>/`. Deleting that one
  // subdirectory (rather than the whole `data/` folder) leaves any other
  // scratch name's state under the same target folder untouched. Done before
  // the store is ever opened, so there is nothing to close first.
  if (options.fresh && scratchWorkspace) {
    const scratchDataDir = path.join(resolvedTargetFolder, 'data', scratchWorkspace.name);
    await fs.rm(scratchDataDir, { recursive: true, force: true });
  }

  // -- 3. Auto-setup ----------------------------------------------------------
  // Collapses `workspace setup` into `run` itself — auto-setup on run
  // (rawbox-cli README, "Execute Workflow (`run` / `workflow run`)"): before ever attempting the run, check whether
  // every plugin this workflow declares resolves from the same bases
  // `runWorkflowInstance` resolves from, and if not, install into the
  // resolved target folder first. `--no-setup` (`options.setup === false`)
  // opts back out entirely — a missing plugin then fails inside
  // `runWorkflowInstance` exactly as it always has. `--setup`
  // (`options.setup === true`) forces a reinstall unconditionally, even when
  // everything already resolves.
  //
  // Made mutually exclusive per target folder by `performAutoSetup`
  // (`auto-setup.ts`): several `run` processes against one workspace,
  // started concurrently — the documented multi-workflow pattern — no
  // longer race each other's `npm install` into the shared target folder. A
  // process that only needed what a concurrent winner already installed
  // ('joined-existing-install') never installs anything itself.
  if (options.setup !== false) {
    const forceSetup = options.setup === true;
    const declaredPlugins = Object.keys(workflow.plugins);
    const resolveDir = scratchWorkspace ? scratchWorkspaceDir! : path.dirname(workspaceFile!);
    const resolveBases = dedupePathList([resolvedTargetFolder, resolveDir, process.cwd()]);
    const findUnresolved = (): string[] =>
      PluginDiscoverer.findUnresolvedPlugins(declaredPlugins, { resolveFrom: resolveBases });

    const outcome = await performAutoSetup(resolvedTargetFolder, forceSetup, {
      findUnresolved,
      install: async () => {
        const unresolvedPlugins = findUnresolved();
        p.log.info(
          forceSetup
            ? `--setup passed: reinstalling this workspace's plugins into ${pc.cyan(resolvedTargetFolder)}...`
            : `Auto-setup: plugin${unresolvedPlugins.length === 1 ? '' : 's'} not yet installed ` +
                `(${unresolvedPlugins.join(', ')}) — installing into ${pc.cyan(resolvedTargetFolder)}...`,
        );

        // `setupWorkspace` re-reads and merges every workflow a *disk*
        // workspace document lists — meaningless here, since a scratch
        // workspace is never written to disk and by construction lists
        // exactly this one workflow. `setupNpmPackage` is `setupWorkspace`'s
        // own install step, called directly with this workflow's `plugins:`
        // map instead of a merge of several.
        const setupResult = scratchWorkspace
          ? (await setupNpmPackage(resolvedTargetFolder, workflow.plugins, scratchWorkspaceDir!)).map(
              () => resolvedTargetFolder,
            )
          : await setupWorkspace(workspaceFile!, resolvedTargetFolder);
        return setupResult.isOk()
          ? { ok: true, targetFolder: setupResult.value }
          : { ok: false, error: setupResult.error };
      },
      logger: {
        info: (message) => p.log.info(message),
        warn: (message) => p.log.warn(pc.yellow(message)),
      },
    });

    switch (outcome.kind) {
      case 'installed':
        p.log.info(`Auto-setup complete — plugins installed into ${pc.cyan(outcome.targetFolder)}.`);
        break;
      case 'joined-existing-install':
        p.log.info(
          `Auto-setup: another concurrent run already installed this workspace's plugins into ` +
            `${pc.cyan(resolvedTargetFolder)} — proceeding without installing again.`,
        );
        break;
      case 'failed':
        p.log.error(pc.red(`Auto-setup failed: ${outcome.message}`));
        process.exit(1);
        return;
      case 'not-needed':
        break;
    }
  }

  // -- 4. Run id and log paths ---------------------------------------------
  // The run's correlation id is generated here — before the sink/files exist
  // — so the default log filenames can be keyed by it. Passed back into
  // `runWorkflowInstance` via `options.runId` so the id inside every event
  // and the id in the filename are the same value, not two independent
  // generations of it (OBSERVABILITY.md, "The run-event stream").
  //
  // The default lands under the workspace's resolved target folder — the
  // same `.rawbox/` a workspace's installed plugins and LMDB data live in
  // — one directory per workflow name, so concurrent workflows in the same
  // workspace never collide.
  const runId = createRunId();
  const logDir = path.join(resolvedTargetFolder, 'logs', workflow.name);
  const defaultLogFile = path.join(logDir, `${runId}.ndjson`);
  const defaultErrorLogFile = path.join(logDir, `${runId}.error.ndjson`);

  const logFilePath = options.logFile
    ? path.resolve(process.cwd(), options.logFile)
    : defaultLogFile;
  const errorLogFilePath = options.errorLog
    ? path.resolve(process.cwd(), options.errorLog)
    : defaultErrorLogFile;

  // -- 4b. Run registry: opportunistic prune, then the `bootstrapping` entry -
  // (OBSERVABILITY.md, "Lifecycle and crash detection".) Written here — after the run has an id
  // and its log paths, but *before* `runWorkflowInstance` is called — so a run
  // that dies in `runWorkflowInstance`'s own preflight (an invalid document
  // past this CLI's own quick check, a lock mismatch, an unresolvable plugin)
  // is visible as `bootstrapping` rather than silently absent. Every field the
  // entry needs is already in hand by this point, which is what keeps this
  // cheap: no extra I/O beyond one more workspace-document read for its name.
  //
  // The workspace document is loaded here — ahead of the prune call below —
  // rather than only for its name, so the opportunistic pass can read this
  // very workspace's own `logs.prune:` instead of a project-wide file. A
  // scratch (`--workspace-name`) run already holds its in-memory `Workspace`
  // and needs no load at all; it declares no `logs:`, so `resolveLogsConfig`
  // below falls straight to the built-in default for it, exactly as it did
  // before this workspace ever had a `logs:` block to declare.
  let loadedWorkspace: Workspace | undefined;
  let registryWorkspaceName: string;
  if (scratchWorkspace) {
    loadedWorkspace = scratchWorkspace;
    registryWorkspaceName = scratchWorkspace.name;
  } else {
    const workspaceLoad = await loadAndValidateWorkspace(workspaceFile!);
    // Falls back to the file's basename — and to no workspace at all for the
    // prune bounds below — on a load failure that only shows up here.
    // `resolvedTargetFolder` above already degraded the same way
    // (`resolveWorkspaceTargetFolder`) rather than failing the run at this
    // point; `runWorkflowInstance`'s own preflight is what actually reports
    // the error, via a `bootstrap.error` this entry's sink then observes.
    loadedWorkspace = workspaceLoad.isOk() ? workspaceLoad.value : undefined;
    registryWorkspaceName = workspaceLoad.isOk()
      ? workspaceLoad.value.name
      : path.basename(workspaceFile!, path.extname(workspaceFile!));
  }

  // `logs:`, resolved once for this run — CLI override, then the workspace
  // document, then the built-in default, per field (`resolveLogsConfig`).
  // `--log-async` and `--log-steps` are `workflow run`'s two overrides: it has
  // no `--keep`/`--older-than`/`--max-bytes` flags of its own, so `prune`
  // below comes from `logs.prune:` and the built-in default alone
  // (`resolveLogsConfig`'s other two levels), as does `rotate`.
  //
  // The override object is built unconditionally, with each field spread in
  // only when its flag was actually passed: `resolveLogsConfig` resolves per
  // field, so an override with no fields set resolves identically to no
  // override at all — and one flag present must not make the other look set
  // to `undefined`, which under `exactOptionalPropertyTypes` is a different
  // thing from absent.
  const resolvedLogs = resolveLogsConfig({
    workspace: loadedWorkspace,
    override: {
      ...(options.logAsync !== undefined ? { async: options.logAsync } : {}),
      ...(options.logSteps !== undefined ? { steps: options.logSteps } : {}),
    },
  });

  // The prune runs first and is entirely best-effort/silent — see
  // `pruneRunsOpportunistically` — so a broken workspace document or an
  // unwritable `runs/` directory can never affect the run it piggybacks on.
  await pruneRunsOpportunistically(
    resolvedTargetFolder,
    pruneOptionsFromResolvedLogs(resolvedLogs.prune),
  );

  const registryFilePath = registryFilePathFor(resolvedTargetFolder, runId);
  const registryEntry: RunRegistryEntry = {
    format: RUN_REGISTRY_FORMAT,
    run_id: runId,
    workspace: registryWorkspaceName,
    workflow: workflow.name,
    pid: process.pid,
    pid_started_at: getProcessStartedAtMs(process.pid) ?? Date.now(),
    started_at: new Date().toISOString(),
    log_path: logFilePath,
    error_log_path: errorLogFilePath,
    status: RUN_STATUS.BOOTSTRAPPING,
  };
  writeRegistryEntrySync(registryFilePath, registryEntry);

  // -- 5. Execute, narrated by the terminal sink -----------------------------
  // Replaces the old spinner + one-line success outro: the sink is just
  // another `RunEventSink`, so it sees exactly what the NDJSON file does and
  // renders a `WORKFLOW` header, one line per step execution, and a `RECAP`
  // that folds in the log paths the outro used to repeat — so a successful
  // run needs nothing printed here at all.
  // `--output` defaults per {@link resolveDefaultOutputMode} — pretty on a
  // TTY, NDJSON-to-stdout when piped; `-v`/`-vv`/`-vvv` only affect the
  // pretty render. A failure path still gets one line of its own below,
  // routed through clack rather than the sink's stdout.
  const outputMode = options.output ?? resolveDefaultOutputMode(process.stdout.isTTY === true);
  const verbosity = options.verbosity ?? 0;
  const terminalSink = createTerminalSink({
    mode: outputMode,
    verbosity,
    logFilePath,
    errorLogFilePath,
    // Both are consulted only by the raw-stream modes, which write to fd 1
    // through the same writer the log files use. They are passed for the same
    // reason: that writer exists so byte-identity with the file is one writer's
    // property rather than a claim two call sites have to keep true, and a
    // stream that ignored either flag would break it — `--output ndjson`
    // piped into a log stack is exactly the case where an operator who asked
    // for less volume must actually get it.
    logAsync: resolvedLogs.async,
    steps: resolvedLogs.steps,
  });

  const workspaceSource: WorkspaceSource = scratchWorkspace
    ? { workspace: scratchWorkspace, dir: scratchWorkspaceDir! }
    : workspaceFile!;

  // -- 5b. Optional OpenTelemetry bridge -------------------------------------
  // A third sink alongside the file and the terminal (rawbox-runner README,
  // "OpenTelemetry"), and the only one that is conditional. The order matters: the
  // SDK must be started *before* `createOtelSink` reads the API globals for a
  // meter, and shut down *after* the run so the exporters flush what the run
  // produced. When inactive, `../../telemetry/otel.ts` is never imported, so
  // no SDK package is loaded, resolved or parsed.
  const sinkList: RunEventSink[] = [terminalSink, createRunRegistrySink(registryFilePath)];
  let otelSession: OtelSession | undefined;

  if (isOtelActive(options.otel)) {
    try {
      otelSession = await startOtelSdk((message) => p.log.warn(message));
      sinkList.push(createOtelSink());
    } catch (error) {
      // Telemetry is an observer of the run, never a precondition for it: a
      // broken exporter config must not stop a workflow from executing.
      p.log.warn(
        pc.yellow(
          `OpenTelemetry export could not be started, continuing without it: ${getErrorMessage(error)}`,
        ),
      );
    }
  }

  // -- 5c. Graceful shutdown on SIGTERM/SIGINT -------------------------------
  // (OBSERVABILITY.md, "Event kinds" and "Lifecycle and crash detection".) A long-looping workflow is stopped
  // exactly this way, so an operator stop must leave an honest record: the
  // first signal aborts the run's controller — the runner then starts no new
  // step, writes `run.end` with `outcome: "interrupted"` as the final event,
  // and flushes/closes every sink (registry included, which lands the entry
  // on the terminal `interrupted` status). A second signal means the operator
  // is done waiting: exit immediately, leaving the entry non-terminal — the
  // same truncated record a SIGKILL leaves, classified `crashed` at read
  // time. Both listeners are removed once the run concludes, so nothing
  // leaks across the rest of the process lifetime.
  //
  // ## `process.exit` and the buffered sink (`--log-async`)
  //
  // A buffered NDJSON sink has the problem the OTel shutdown below already
  // has a comment about — an exit drops what has not landed yet. Every
  // `process.exit` in this command was audited against it:
  //
  // - The six before the run exists (bad `--seed`, unloadable/invalid
  //   workflow, ambiguous or missing workspace, failed auto-setup) are all
  //   above §4: no run id, no log paths, no sink, nothing buffered.
  // - The two after `runWorkflowInstance` returns (`result.isErr()` and the
  //   interrupted exit) are both downstream of that function's own
  //   unconditional `finally { await producer.close() }`, which flushes then
  //   closes **every** sink — the file sink, the fd-1 raw stream, the
  //   registry — before it resolves. Nothing is pending by the time either
  //   line runs.
  // - The second-signal force quit immediately below is deliberately
  //   immediate and leaves a truncated record; that is the documented meaning
  //   of the repeat signal, so it gets no flush.
  //
  // `run.end` is additionally flushed synchronously by the sink itself the
  // moment it is written, in both modes (`ndjson-file-sink.ts`), so the one
  // event whose absence changes how a run is read does not depend on any of
  // the above being got right.
  const abortController = new AbortController();
  let interruptSignal: NodeJS.Signals | undefined;
  const exitCodeFor = (sig: NodeJS.Signals): number => (sig === 'SIGINT' ? 130 : 143);
  const onShutdownSignal = (sig: NodeJS.Signals): void => {
    if (interruptSignal !== undefined) {
      process.exit(exitCodeFor(sig));
    }
    interruptSignal = sig;
    // One informational line, on stderr so no `--output` mode's stdout stream
    // is polluted; dimmed like the renderer's other incidental lines.
    process.stderr.write(
      pc.dim(`\nreceived ${sig} — writing run.end and flushing logs (repeat to force quit)\n`),
    );
    abortController.abort();
  };
  process.on('SIGTERM', onShutdownSignal);
  process.on('SIGINT', onShutdownSignal);

  const result = await runWorkflowInstance(
    workspaceSource,
    absoluteWorkflowPath,
    logFilePath,
    errorLogFilePath,
    {
      runId,
      sinkList,
      signal: abortController.signal,
      logsAsync: resolvedLogs.async,
      // The same resolution the prune bounds above came from — CLI flag, then
      // `logs.rotate:`, then the built-in pair — so a workspace that states a
      // segment size gets it, and one that states nothing still rotates.
      logsRotate: resolvedLogs.rotate,
      // From the same resolution again — `--log-steps`, then `logs.steps:`,
      // then the built-in `full`. It reaches the file sink's main route only:
      // `terminalSink` above and the OTel sink below observe the producer's
      // events, so `-v`/`-vv` and every span keep their input/output whatever
      // this says.
      logsSteps: resolvedLogs.steps,
      ...(options.heartbeatMs !== undefined ? { heartbeatMs: options.heartbeatMs } : {}),
      ...(options.preflightTimeoutMs !== undefined
        ? { preflightTimeoutMs: options.preflightTimeoutMs }
        : {}),
      ...(cliSeedOverrideLayer ? { seedOverrideLayerList: [cliSeedOverrideLayer] } : {}),
    },
  ).finally(() => {
    process.removeListener('SIGTERM', onShutdownSignal);
    process.removeListener('SIGINT', onShutdownSignal);
  });

  // Flushes the batch processors before the process can exit. Awaited on the
  // success and the failure path alike — a failed run is exactly the one whose
  // trace you want to have arrived — and before the `process.exit(1)` below,
  // which would otherwise drop the buffered spans on the floor.
  if (otelSession) {
    await otelSession.shutdown();
  }

  if (result.isErr()) {
    // The sink already rendered the failure in full (its `bootstrap.error`
    // or failed-`step.end` handling covers every mode, including `json` and
    // `quiet`) — this is a second, `@clack/prompts`-routed line purely so a
    // human scanning the terminal's own message stream (as opposed to
    // stdout, where `--output json`/`quiet` sends the event stream) still
    // sees why the run failed.
    p.log.error(pc.red(`Error executing workflow: ${result.error}`));
    process.exit(1);
    return;
  }

  if (result.value.outcome === OUTCOME.INTERRUPTED) {
    // Everything is flushed (sinks closed inside `runWorkflowInstance`, OTel
    // above); the abandoned step handler, though, may still hold the event
    // loop open (a pending sleep timer, an open socket), so a hard exit is
    // the only way to actually stop. 128+signum, the shell convention for
    // "terminated by signal N" — 143 for SIGTERM, 130 for SIGINT.
    process.exit(interruptSignal !== undefined ? exitCodeFor(interruptSignal) : 143);
  }
}
