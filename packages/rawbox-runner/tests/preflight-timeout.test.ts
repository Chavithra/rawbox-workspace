import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWorkflowInstance } from '../src/tool/run-workflow.js';
import {
  MemoryRunEventSink,
  OUTCOME,
  RUN_EVENT,
  RunEventValidator,
  type RunEventSink,
} from '../src/events/index.js';

// ---------------------------------------------------------------------------
// The preflight bound — `RunWorkflowOptions.preflightTimeoutMs`.
//
// Preflight imports every step's definition module before step 0 is selected
// (`preloadStepDefinitions`), and a module that blocks at import hangs there.
// That hang is invisible in a way a hung *step* is not: `run.heartbeat` only
// fires while a step is in flight, so the stream stops dead after `run.start` —
// no `step.start`, no `run.end`, nothing to tell it from a slow startup. And a
// step's own `timeoutMs` cannot cover it, because that bound lives inside the
// contract and the contract is unreadable until the module has loaded.
//
// What is pinned here:
//
//   - the bound expires, ends the run, and the diagnostic names **which** step
//     and which definition path the pass was on — the loop is sequential, so
//     that is the module that hung, and it is the whole diagnostic value;
//   - the failure surfaces exactly the way a preload *failure* already does (an
//     error `run.end`, no `bootstrap.error` — preflight-inside-the-machine has
//     never emitted one), plus `timed_out`/`timeout_ms` as the marker that
//     distinguishes "hung at import" from "failed to import";
//   - a fast, healthy load under the default bound is untouched and emits
//     nothing new, down to the two fields being absent rather than `false`;
//   - `preflightTimeoutMs: 0` really disables the bound;
//   - an operator interrupt still wins over a bound that has not expired, and
//     the interrupted `run.end` claims no timeout.
//
// Real workspaces on disk against a real plugin, like `timeout.test.ts`: a
// mocked loader would prove nothing about the `await import()` the bound
// actually wraps. The hanging plugin is a clone of the built default plugin
// with one definition module replaced by a top-level `await` that never
// settles — the contract registry itself still loads, which is what makes this
// the preflight-preload hang rather than a plugin-discovery failure.
//
// `expectSchemaValid` runs over every collected event of every test, which is
// what pins the additive schema change: `RunEndEvent` is a `StrictObject`, so
// an unexpected or mis-typed field fails there rather than riding along.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDir = path.join(__dirname, 'temp-preflight-timeout');

/** Repo root: packages/rawbox-runner/tests -> ../../.. */
const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** The real, built plugin the hanging fixture is cloned from. */
const SOURCE_PLUGIN_DIR = path.join(repoRoot, 'packages', 'rawbox-plugin-default');

/** The pristine plugin, for the runs that must load normally. */
const DEFAULT_PLUGIN = '@rawbox/rawbox-plugin-default';

/** The clone, whose `time/sleep` definition module never finishes evaluating. */
const HANGING_PLUGIN = 'rawbox-plugin-preflight-hang';

/** The definition module replaced with a permanent top-level `await`. */
const HANGING_DEFINITION = './time/sleep.definition.js';

beforeAll(async () => {
  await fs.mkdir(sandboxDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(sandboxDir, { recursive: true, force: true });
});

/**
 * Installs the hanging plugin into `<workspaceDir>/node_modules`, where the
 * runner's ordinary `node_modules` walk-up finds it.
 *
 * Only the *definition* module hangs. The contract registry is copied
 * untouched, so plugin discovery, resolution and seed validation all succeed
 * and the run gets as far as the preload — which is the only place the defect
 * under test can occur. Its `typebox`/`neverthrow`/`@rawbox/plugin` imports
 * resolve by walking up into this monorepo's own `node_modules`, exactly as a
 * `file:`-linked plugin's do in the field.
 */
async function installHangingPlugin(workspaceDir: string): Promise<void> {
  const pluginDir = path.join(workspaceDir, 'node_modules', HANGING_PLUGIN);
  await fs.cp(SOURCE_PLUGIN_DIR, pluginDir, {
    recursive: true,
    filter: (source) => {
      const base = path.basename(source);
      return base !== 'node_modules' && base !== 'tsconfig.tsbuildinfo';
    },
  });

  const manifestPath = path.join(pluginDir, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  manifest.name = HANGING_PLUGIN;
  manifest.dependencies = {};
  manifest.devDependencies = {};
  manifest.scripts = {};
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

  // The clone must be loadable, or a failing run would be indistinguishable
  // from the hang this file exists to catch.
  await fs.stat(path.join(pluginDir, 'dist', 'contract-registry.js'));

  await fs.writeFile(
    path.join(pluginDir, 'dist', 'time', 'sleep.definition.js'),
    [
      '// Blocks forever at module evaluation: the exact shape of plugin defect the',
      '// preflight bound exists for. Nothing below this line ever runs.',
      'await new Promise(() => {});',
      'export default {};',
      '',
    ].join('\n'),
    'utf-8',
  );
}

/** Writes `workspace.yaml` plus one workflow file and returns the paths a run needs. */
async function writeWorkspace(
  name: string,
  workflowBody: string,
): Promise<{
  directory: string;
  workspacePath: string;
  workflowPath: string;
  logPath: string;
  errorLogPath: string;
}> {
  const directory = path.join(sandboxDir, name);
  await fs.mkdir(path.join(directory, 'workflows'), { recursive: true });

  const workspacePath = path.join(directory, 'workspace.yaml');
  await fs.writeFile(
    workspacePath,
    [
      'kind: Workspace',
      `name: ${name}`,
      'workflowPathList:',
      '  - workflows/scenario.workflow.yaml',
      '',
    ].join('\n'),
  );

  const workflowPath = path.join(directory, 'workflows', 'scenario.workflow.yaml');
  await fs.writeFile(workflowPath, workflowBody);

  return {
    directory,
    workspacePath,
    workflowPath,
    logPath: path.join(directory, 'run.log'),
    errorLogPath: path.join(directory, 'run.error.log'),
  };
}

/**
 * Two steps against one plugin: an `echo` that loads instantly, then a `sleep`
 * whose module is the one replaced by the hang in the fixture clone.
 *
 * The order is the point. A bound that reported step 0 whatever hung would look
 * right in a one-step workflow and be useless in a real one; here the module
 * that blocks is the *second* one the sequential preload reaches.
 */
function twoStepWorkflow(workflowName: string, plugin: string): string {
  return [
    'kind: Workflow',
    'formatVersion: "1.0"',
    `name: ${workflowName}`,
    '',
    'plugins:',
    `  "${plugin}": "*"`,
    '',
    'storage:',
    '  defaultStrategy:',
    '    name: lmdb-kv',
    '    valueSizeMax: 1900',
    '  keys:',
    '    greeting:',
    '      seed: hello',
    '    sleep_ms:',
    '      seed: 5',
    '',
    'steps:',
    '  - label: echo-step',
    `    plugin: "${plugin}"`,
    '    operation: value-ops/echo',
    '    inputs:',
    '      value: greeting',
    '    outputs:',
    '      value: echoed',
    '',
    '  - label: slow-step',
    `    plugin: "${plugin}"`,
    '    operation: time/sleep',
    '    inputs:',
    '      ms: sleep_ms',
    '    outputs:',
    '      timestamp: slept_at',
    '',
  ].join('\n');
}

/** Polls until `check` returns true, or fails after `timeoutMs`. */
async function waitFor(check: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Every collected event must still satisfy the format's own validator. */
function expectSchemaValid(sink: MemoryRunEventSink): void {
  for (const event of sink.eventList) {
    expect(
      RunEventValidator.Check(event),
      `event does not match the schema: ${JSON.stringify(event)}`,
    ).toBe(true);
  }
}

/** The `event` kind of every line the filtered error log received. */
async function errorLogKinds(errorLogPath: string): Promise<string[]> {
  const content = await fs.readFile(errorLogPath, 'utf-8').catch(() => '');
  return content
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

describe('preflight bound — the bound expires', () => {
  it('ends the run, names the hung step, and marks the run.end as timed out', async () => {
    const { directory, workspacePath, workflowPath, logPath, errorLogPath } =
      await writeWorkspace(
        'preflight-expires',
        twoStepWorkflow('preflight-bounded', HANGING_PLUGIN),
      );
    await installHangingPlugin(directory);

    const sink = new MemoryRunEventSink();
    const startedAtMs = Date.now();
    const result = await runWorkflowInstance(
      workspacePath,
      workflowPath,
      logPath,
      errorLogPath,
      {
        sinkList: [sink],
        preflightTimeoutMs: 700,
        // Comfortably shorter than the bound: the assertion below that no
        // heartbeat was emitted is about preflight having no step to beat for,
        // not about the interval never coming round.
        heartbeatMs: 100,
      },
    );

    // A preflight timeout is a run-terminating failure, reported the way every
    // other preflight failure is: the `err` branch.
    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();

    // The whole diagnostic value: *which* module hung. Step 1, not step 0 —
    // `echo` loaded fine and `sleep` is the one that blocked.
    expect(message).toMatch(/timed out after 700 ms/);
    expect(message).toContain('step 1 "slow-step"');
    expect(message).toContain(HANGING_DEFINITION);
    // "did not finish loading", not "failed to load": the two have different
    // remedies and the sentence has to say which one this is.
    expect(message).toMatch(/did not finish loading/);
    expect(message).toContain('--preflight-timeout');

    expectSchemaValid(sink);

    // No step was ever selected, so there is nothing step-shaped in the stream —
    // which is exactly why `run.end` had to grow the marker.
    expect(sink.ofKind(RUN_EVENT.STEP_START)).toHaveLength(0);
    expect(sink.ofKind(RUN_EVENT.STEP_END)).toHaveLength(0);
    // And nothing beats for a run with no step in flight, however long the hang.
    expect(sink.ofKind(RUN_EVENT.RUN_HEARTBEAT)).toHaveLength(0);
    // Preflight *inside the machine* has never emitted `bootstrap.error` — a
    // preload failure surfaces as an error `run.end` — and a timeout surfaces
    // the same way rather than inventing a second path.
    expect(sink.ofKind(RUN_EVENT.BOOTSTRAP_ERROR)).toHaveLength(0);

    const lastEvent = sink.eventList.at(-1);
    expect(lastEvent).toMatchObject({
      event: RUN_EVENT.RUN_END,
      outcome: OUTCOME.ERROR,
      timed_out: true,
      timeout_ms: 700,
      steps_total: 0,
      steps_failed: 0,
      error: { message: expect.stringMatching(/timed out after 700 ms/) },
    });

    // The bound is a bound: the run concluded on it, not on the hang.
    expect(Date.now() - startedAtMs).toBeLessThan(20_000);

    // `outcome` stays `"error"`, so the filtered error log — written by a
    // structural `outcome === "error"` test — still receives it.
    expect(await errorLogKinds(errorLogPath)).toEqual([RUN_EVENT.RUN_END]);
  }, 40_000);
});

describe('preflight bound — a healthy load', () => {
  it('runs to completion under the default bound and emits nothing new', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'preflight-healthy',
      twoStepWorkflow('preflight-healthy', DEFAULT_PLUGIN),
    );

    const sink = new MemoryRunEventSink();
    // No `preflightTimeoutMs`: the 30s default is in force, and a real preload
    // is orders of magnitude away from it.
    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
      sinkList: [sink],
    });

    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: OUTCOME.OK });

    expectSchemaValid(sink);

    expect(sink.ofKind(RUN_EVENT.STEP_END)).toHaveLength(2);

    const runEnd = sink.ofKind(RUN_EVENT.RUN_END)[0]!;
    expect(runEnd.outcome).toBe(OUTCOME.OK);
    // Absence, not `false`: "not a timeout" has exactly one spelling.
    expect(runEnd).not.toHaveProperty('timed_out');
    expect(runEnd).not.toHaveProperty('timeout_ms');
    for (const stepEnd of sink.ofKind(RUN_EVENT.STEP_END)) {
      expect(stepEnd).not.toHaveProperty('timed_out');
      expect(stepEnd).not.toHaveProperty('timeout_ms');
    }
  }, 40_000);
});

describe('preflight bound — disabled with 0', () => {
  it('waits indefinitely, and only an interrupt concludes the run', async () => {
    const { directory, workspacePath, workflowPath, logPath, errorLogPath } =
      await writeWorkspace(
        'preflight-disabled',
        twoStepWorkflow('preflight-disabled', HANGING_PLUGIN),
      );
    await installHangingPlugin(directory);

    const sink = new MemoryRunEventSink();
    const controller = new AbortController();

    const runPromise = runWorkflowInstance(
      workspacePath,
      workflowPath,
      logPath,
      errorLogPath,
      {
        sinkList: [sink],
        // The operator who would rather hang than risk a false positive.
        preflightTimeoutMs: 0,
        signal: controller.signal,
      },
    );

    await waitFor(() => sink.eventList.some((event) => event.event === RUN_EVENT.RUN_START));
    // Far longer than the bound the *previous* test proved fires at 700 ms, and
    // longer than any default could plausibly be misread as: still nothing.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(sink.ofKind(RUN_EVENT.RUN_END)).toHaveLength(0);

    // Nothing else would ever end this run.
    controller.abort();
    const result = await runPromise;

    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: OUTCOME.INTERRUPTED });

    expectSchemaValid(sink);
    expect(sink.eventList.at(-1)).toMatchObject({
      event: RUN_EVENT.RUN_END,
      outcome: OUTCOME.INTERRUPTED,
      steps_total: 0,
    });
  }, 40_000);
});

describe('preflight bound — an interrupt arriving first', () => {
  it('concludes as interrupted, and claims no timeout', async () => {
    const { directory, workspacePath, workflowPath, logPath, errorLogPath } =
      await writeWorkspace(
        'preflight-interrupt-wins',
        twoStepWorkflow('preflight-interrupted', HANGING_PLUGIN),
      );
    await installHangingPlugin(directory);

    const sink = new MemoryRunEventSink();
    const controller = new AbortController();
    // A bound comfortably longer than the abort will take to arrive: both
    // mechanisms abandon the hung preload, and the one that fires first must be
    // the one that describes the run. Kept to a few seconds rather than the
    // default's 30 because the abandoned timer stays armed and refed for the
    // remainder of the bound — the documented cost of an interrupt landing on
    // an armed deadline (`RunWorkflowOptions.signal`).
    const boundMs = 3000;

    const abortOnStart: RunEventSink = {
      emit(event): void {
        if (event.event === RUN_EVENT.RUN_START) {
          // After the machine is under way, so the abort lands during preflight
          // rather than at the pre-machine check.
          setTimeout(() => controller.abort(), 250);
        }
      },
    };

    const startedAtMs = Date.now();
    const result = await runWorkflowInstance(
      workspacePath,
      workflowPath,
      logPath,
      errorLogPath,
      {
        sinkList: [sink, abortOnStart],
        preflightTimeoutMs: boundMs,
        signal: controller.signal,
      },
    );

    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: OUTCOME.INTERRUPTED });
    expect(Date.now() - startedAtMs).toBeLessThan(boundMs);

    expectSchemaValid(sink);

    // An operator stop is intent, not an alarm: no `severity`, no `error`, and
    // no timeout claim even though the bound is still armed as this runs (see
    // `RunWorkflowOptions.signal`).
    const runEnd = sink.eventList.at(-1)!;
    expect(runEnd).toMatchObject({
      event: RUN_EVENT.RUN_END,
      outcome: OUTCOME.INTERRUPTED,
      steps_total: 0,
      steps_failed: 0,
    });
    expect(runEnd).not.toHaveProperty('timed_out');
    expect(runEnd).not.toHaveProperty('timeout_ms');
    expect(runEnd).not.toHaveProperty('severity');
    expect(await errorLogKinds(errorLogPath)).toEqual([]);
  }, 40_000);
});
