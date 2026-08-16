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
  SEVERITY,
  type RunEventSink,
} from '../src/events/index.js';

// ---------------------------------------------------------------------------
// Bounded steps — the enforcement half.
//
// Real workflows against the real built default plugin, like `interrupt.test.ts`
// and `events.test.ts`: the contract under test is behavioural, and a mocked
// handler would prove nothing about the actor the bound actually wraps. What is
// being pinned here:
//
//   - a bound that expires ends the **run**, not just the step (a timeout takes
//     `run-actor.ts`'s `err(Error)` exit, never the `doneStep.errorRecord` exit
//     that writes `errors:` bindings and continues);
//   - the `step.end` keeps `outcome: "error"` and gains `timed_out`/
//     `timeout_ms`, so every reader that already keys on `outcome === "error"`
//     — the NDJSON error-log mirror, the CLI's log summary, the terminal
//     renderer's failure block, the OTel span status — still sees it. The
//     error-log assertion in the first test is the regression guard for that
//     decision;
//   - a step with no bound is untouched, down to the two fields being absent
//     rather than `false`;
//   - an interrupt still wins over a bound that has not expired.
//
// `expectSchemaValid` runs over every collected event of every test, which is
// what pins the additive schema change itself: `StepEndEvent` is a
// `StrictObject`, so an unexpected or mis-typed field fails there rather than
// silently riding along in the log.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDir = path.join(__dirname, 'temp-timeout');

/** The plugin every fixture below runs against; a real, built workspace package. */
const DEFAULT_PLUGIN = '@rawbox/rawbox-plugin-default';

beforeAll(async () => {
  await fs.mkdir(sandboxDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(sandboxDir, { recursive: true, force: true });
});

/** Writes `workspace.yaml` plus one workflow file and returns the paths a run needs. */
async function writeWorkspace(
  name: string,
  workflowBody: string,
): Promise<{ workspacePath: string; workflowPath: string; logPath: string; errorLogPath: string }> {
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
    workspacePath,
    workflowPath,
    logPath: path.join(directory, 'run.log'),
    errorLogPath: path.join(directory, 'run.error.log'),
  };
}

/**
 * A one-step `time/sleep` workflow: `sleepMs` is what the handler waits for,
 * `timeoutMs` the bound on the step — omitted entirely when `undefined`, which
 * is how a document spells "deliberately unbounded" once the resolver has run.
 */
function sleepWorkflow(
  workflowName: string,
  sleepMs: number,
  timeoutMs?: number,
): string {
  return [
    'kind: Workflow',
    'formatVersion: "1.0"',
    `name: ${workflowName}`,
    '',
    'plugins:',
    `  "${DEFAULT_PLUGIN}": "*"`,
    '',
    'storage:',
    '  defaultStrategy:',
    '    name: lmdb-kv',
    '    valueSizeMax: 1900',
    '  keys:',
    '    sleep_ms:',
    `      seed: ${sleepMs}`,
    '',
    'steps:',
    '  - label: slow-step',
    `    plugin: "${DEFAULT_PLUGIN}"`,
    '    operation: time/sleep',
    ...(timeoutMs === undefined ? [] : [`    timeoutMs: ${timeoutMs}`]),
    '    inputs:',
    '      ms: sleep_ms',
    '    outputs:',
    '      timestamp: slept_at',
    '',
  ].join('\n');
}

/** The same slow bounded step, followed by a second step that must never start. */
const TWO_STEP_YAML = [
  'kind: Workflow',
  'formatVersion: "1.0"',
  'name: timeout-two-step',
  '',
  'plugins:',
  `  "${DEFAULT_PLUGIN}": "*"`,
  '',
  'storage:',
  '  defaultStrategy:',
  '    name: lmdb-kv',
  '    valueSizeMax: 1900',
  '  keys:',
  '    sleep_ms:',
  '      seed: 8000',
  '    greeting:',
  '      seed: hello',
  '',
  'steps:',
  '  - label: slow-step',
  `    plugin: "${DEFAULT_PLUGIN}"`,
  '    operation: time/sleep',
  '    timeoutMs: 200',
  '    inputs:',
  '      ms: sleep_ms',
  '    outputs:',
  '      timestamp: slept_at',
  '',
  '  - label: echo-step',
  `    plugin: "${DEFAULT_PLUGIN}"`,
  '    operation: value-ops/echo',
  '    inputs:',
  '      value: greeting',
  '    outputs:',
  '      value: echoed',
  '',
].join('\n');

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

describe('bounded step — the bound expires', () => {
  it('ends the run, and reports the step.end as a timed-out error', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'bound-expires',
      sleepWorkflow('timeout-bounded', 8000, 200),
    );

    const sink = new MemoryRunEventSink();
    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
      sinkList: [sink],
      // Comfortably longer than the bound, so the heartbeat assertion below is
      // about the bound stopping the step and not about the interval being
      // slow to come round.
      heartbeatMs: 1000,
    });

    // A timeout is a run-terminating failure: the `err` branch, not an ok
    // Result carrying a failed step.
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatch(/timed out/);

    expectSchemaValid(sink);

    // The step ran once and reported once — no retry, no second execution.
    expect(sink.ofKind(RUN_EVENT.STEP_START)).toHaveLength(1);
    const stepEndList = sink.ofKind(RUN_EVENT.STEP_END);
    expect(stepEndList).toHaveLength(1);

    const stepEnd = stepEndList[0]!;
    expect(stepEnd).toMatchObject({
      outcome: OUTCOME.ERROR,
      timed_out: true,
      timeout_ms: 200,
      severity: SEVERITY.ERROR,
      error: { message: expect.stringMatching(/timed out/) },
    });
    // The handler never returned, so there is no output record to carry — and
    // an empty one would claim it produced something.
    expect(stepEnd).not.toHaveProperty('output');
    // Measured from `step.start`, which precedes the actor call the bound is
    // armed in, so it can never be shorter than the bound it reports.
    expect(stepEnd.duration_ms).toBeGreaterThanOrEqual(200);

    // A bound shorter than the heartbeat interval means the step is simply
    // gone before the first tick — silence here is the timer being stopped by
    // `emitStepEnd`, not a tick that happened to be missed.
    expect(sink.ofKind(RUN_EVENT.RUN_HEARTBEAT)).toHaveLength(0);

    const lastEvent = sink.eventList.at(-1);
    expect(lastEvent).toMatchObject({
      event: RUN_EVENT.RUN_END,
      outcome: OUTCOME.ERROR,
      steps_total: 1,
      steps_failed: 1,
    });

    // The regression guard for keeping `outcome: "error"` (event-types.ts): the
    // filtered error log is written by a structural `outcome === "error"` test,
    // so a hypothetical `outcome: "timeout"` would empty this list — and with
    // it the CLI's failure counts, the terminal failure block and the OTel span
    // status, all of which key on the same value.
    expect(await errorLogKinds(errorLogPath)).toEqual([
      RUN_EVENT.STEP_END,
      RUN_EVENT.RUN_END,
    ]);
  }, 30_000);

  it('keeps every heartbeat it does emit strictly inside the bound', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'bound-heartbeats',
      sleepWorkflow('timeout-heartbeats', 8000, 700),
    );

    const sink = new MemoryRunEventSink();
    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
      sinkList: [sink],
      heartbeatMs: 200,
    });

    expect(result.isErr()).toBe(true);
    expectSchemaValid(sink);

    const heartbeatList = sink.ofKind(RUN_EVENT.RUN_HEARTBEAT);
    expect(heartbeatList.length).toBeGreaterThan(0);
    // `emitStepEnd` stops the timer before it emits, so the last heartbeat of a
    // timed-out step is always one that fired *while the step was still
    // waiting*. A heartbeat at or past the bound would mean the stream claimed
    // the step was alive after the runner had already given up on it.
    for (const heartbeat of heartbeatList) {
      expect(heartbeat.in_flight_ms).toBeLessThan(700);
    }
  }, 30_000);
});

describe('unbounded step — untouched by the enforcement path', () => {
  it('runs to completion, and its step.end carries neither timeout field', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'no-bound',
      sleepWorkflow('timeout-unbounded', 300),
    );

    const sink = new MemoryRunEventSink();
    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
      sinkList: [sink],
    });

    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: OUTCOME.OK });

    expectSchemaValid(sink);

    const stepEnd = sink.ofKind(RUN_EVENT.STEP_END)[0]!;
    expect(stepEnd.outcome).toBe(OUTCOME.OK);
    // Absence, not `false`: "not a timeout" has exactly one spelling
    // (event-types.ts, {@link StepEndEvent}).
    expect(stepEnd).not.toHaveProperty('timed_out');
    expect(stepEnd).not.toHaveProperty('timeout_ms');
  }, 30_000);
});

describe('bounded step — the rest of the workflow', () => {
  it('runs no further step after a timeout', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'no-step-after',
      TWO_STEP_YAML,
    );

    const sink = new MemoryRunEventSink();
    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
      sinkList: [sink],
    });

    expect(result.isErr()).toBe(true);
    expectSchemaValid(sink);

    // The whole reason a timeout takes the `err(Error)` exit rather than the
    // `errors:`-writing one: step 1 is never selected. Were it reported as a
    // handler-declared logical failure, the machine would carry on here.
    expect(sink.ofKind(RUN_EVENT.STEP_START).map((event) => event.step.index)).toEqual([0]);
    expect(sink.ofKind(RUN_EVENT.STEP_END).map((event) => event.step.index)).toEqual([0]);
  }, 30_000);
});

describe('bounded step — an interrupt arriving first', () => {
  it('still concludes as interrupted, with no step.end for the abandoned step', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'interrupt-wins',
      // A bound far longer than the abort will take to arrive: the two
      // mechanisms both abandon an in-flight handler, and the one that fires
      // first must be the one that describes the run.
      sleepWorkflow('timeout-interrupted', 8000, 5000),
    );

    const sink = new MemoryRunEventSink();
    const controller = new AbortController();
    const abortWatcher: RunEventSink = {
      emit(event): void {
        if (event.event === RUN_EVENT.STEP_START) {
          controller.abort();
        }
      },
    };

    const runPromise = runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
      sinkList: [sink, abortWatcher],
      signal: controller.signal,
    });

    await waitFor(() => sink.eventList.some((event) => event.event === RUN_EVENT.STEP_START));
    const result = await runPromise;

    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: OUTCOME.INTERRUPTED });

    expectSchemaValid(sink);

    // An operator stop is intent, not an alarm: the abandoned step gets no
    // `step.end` at all — including no timed-out one, even though its bound is
    // still armed as this assertion runs (see `RunWorkflowOptions.signal`).
    expect(sink.ofKind(RUN_EVENT.STEP_END)).toHaveLength(0);
    expect(sink.eventList.at(-1)).toMatchObject({
      event: RUN_EVENT.RUN_END,
      outcome: OUTCOME.INTERRUPTED,
      steps_total: 0,
      steps_failed: 0,
    });
    expect(await errorLogKinds(errorLogPath)).toEqual([]);
  }, 30_000);
});
