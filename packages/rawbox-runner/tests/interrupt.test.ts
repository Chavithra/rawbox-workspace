import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  INTERRUPT_GRACE_MS,
  runWorkflowInstance,
} from '../src/tool/run-workflow.js';
import {
  MemoryRunEventSink,
  OUTCOME,
  RUN_EVENT,
  RunEventValidator,
  type RunEventSink,
} from '../src/events/index.js';

// ---------------------------------------------------------------------------
// Graceful shutdown — `RunWorkflowOptions.signal`
// (OBSERVABILITY.md, "Event kinds" and "Lifecycle and crash detection").
//
// Real workflows against the real built default plugin, like `events.test.ts`:
// the contract under test is behavioural — after an abort no new step starts,
// the stream's final event is a `run.end` with `outcome: "interrupted"` (no
// `severity`, no `error`), the sinks are flushed and closed, and the whole
// conclusion happens within the documented grace bound even with a step
// handler blocked mid-flight.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDir = path.join(__dirname, 'temp-interrupt');

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

/** An echo step reading the seeded `greeting` key. */
function echoStep(index: number): string[] {
  return [
    `  - label: echo-${index}`,
    `    plugin: "${DEFAULT_PLUGIN}"`,
    '    operation: value-ops/echo',
    '    inputs:',
    '      value: greeting',
    '    outputs:',
    `      value: out_${index}`,
    '',
  ];
}

/** Three echo steps then a halt — enough steps that "no step after the abort" is observable. */
const MULTI_STEP_YAML = [
  'kind: Workflow',
  'formatVersion: "1.0"',
  'name: interrupt-multi-step',
  '',
  'plugins:',
  `  "${DEFAULT_PLUGIN}": "*"`,
  '',
  'storage:',
  '  defaultStrategy:',
  '    name: lmdb-kv',
  '    valueSizeMax: 1900',
  '  keys:',
  '    greeting:',
  '      seed: hello',
  '    halt_reason:',
  '      seed: end of workflow',
  '',
  'steps:',
  ...echoStep(0),
  ...echoStep(1),
  '  - label: halt-step',
  `    plugin: "${DEFAULT_PLUGIN}"`,
  '    operation: control-flow/halt',
  '    inputs:',
  '      reason: halt_reason',
  '',
].join('\n');

/** A long `time/sleep` first, so an abort always lands with the handler in flight. */
const SLEEPING_YAML = [
  'kind: Workflow',
  'formatVersion: "1.0"',
  'name: interrupt-sleeping',
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
  '    halt_reason:',
  '      seed: never reached',
  '',
  'steps:',
  '  - label: sleep-step',
  `    plugin: "${DEFAULT_PLUGIN}"`,
  '    operation: time/sleep',
  '    inputs:',
  '      ms: sleep_ms',
  '    outputs:',
  '      timestamp: slept_at',
  '',
  '  - label: halt-step',
  `    plugin: "${DEFAULT_PLUGIN}"`,
  '    operation: control-flow/halt',
  '    inputs:',
  '      reason: halt_reason',
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

describe('graceful shutdown — abort between steps', () => {
  it('starts no new step, ends the stream with an interrupted run.end, and flushes the sinks', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'between-steps',
      MULTI_STEP_YAML,
    );

    const sink = new MemoryRunEventSink();
    const controller = new AbortController();
    // Aborts the instant step 0 reports — deterministically *between* steps:
    // the machine has not yet selected step 1 when this fires.
    const abortOnFirstStepEnd: RunEventSink = {
      emit(event): void {
        if (event.event === RUN_EVENT.STEP_END && event.step.index === 0) {
          controller.abort();
        }
      },
    };

    const result = await runWorkflowInstance(
      workspacePath,
      workflowPath,
      logPath,
      errorLogPath,
      { sinkList: [sink, abortOnFirstStepEnd], signal: controller.signal },
    );

    // The run did what it was told: an ok Result, carrying the outcome.
    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: OUTCOME.INTERRUPTED });

    expectSchemaValid(sink);

    // No step execution began after the abort: step 0 is the only one started.
    const stepStarts = sink.ofKind(RUN_EVENT.STEP_START);
    expect(stepStarts.map((event) => event.step.index)).toEqual([0]);

    // The final event is the interrupted run.end — counting the one execution
    // that actually reported, carrying neither severity nor error.
    const lastEvent = sink.eventList.at(-1);
    expect(lastEvent).toMatchObject({
      event: RUN_EVENT.RUN_END,
      outcome: OUTCOME.INTERRUPTED,
      steps_total: 1,
      steps_failed: 0,
    });
    expect(lastEvent).not.toHaveProperty('severity');
    expect(lastEvent).not.toHaveProperty('error');

    // The normal end-of-run sink lifecycle ran: flush once, then close once.
    expect(sink.flushCount).toBe(1);
    expect(sink.closeCount).toBe(1);

    // Not an alarm: the filtered error log holds nothing for this run.
    const errorLogContent = await fs.readFile(errorLogPath, 'utf-8').catch(() => '');
    expect(errorLogContent.trim()).toBe('');
  }, 30_000);
});

describe('graceful shutdown — abort with a step handler in flight', () => {
  it('abandons the blocked handler and resolves within the grace bound', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'in-flight',
      SLEEPING_YAML,
    );

    const sink = new MemoryRunEventSink();
    const controller = new AbortController();

    const runPromise = runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
      sinkList: [sink],
      signal: controller.signal,
    });

    // Wait until the sleep handler is genuinely in flight, then abort.
    await waitFor(() => sink.eventList.some((event) => event.event === RUN_EVENT.STEP_START));
    const abortedAtMs = Date.now();
    controller.abort();

    const result = await runPromise;
    // The whole point: a handler blocked for 8s more does not hold the run
    // hostage — conclusion is prompt, bounded by the documented grace window.
    expect(Date.now() - abortedAtMs).toBeLessThan(INTERRUPT_GRACE_MS);

    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: OUTCOME.INTERRUPTED });

    expectSchemaValid(sink);

    // The abandoned step gets no step.end — a fabricated error would be a
    // false alarm; its step.start followed by the interrupted run.end is the
    // honest record (event-types.ts, `OUTCOME`).
    expect(sink.ofKind(RUN_EVENT.STEP_END)).toHaveLength(0);
    expect(sink.eventList.at(-1)).toMatchObject({
      event: RUN_EVENT.RUN_END,
      outcome: OUTCOME.INTERRUPTED,
      steps_total: 0,
      steps_failed: 0,
    });

    expect(sink.flushCount).toBe(1);
    expect(sink.closeCount).toBe(1);
  }, 30_000);
});

describe('graceful shutdown — signal already aborted before the machine starts', () => {
  it('concludes right after preflight with an interrupted run.end and zero steps', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'pre-aborted',
      MULTI_STEP_YAML,
    );

    const sink = new MemoryRunEventSink();
    const controller = new AbortController();
    controller.abort();

    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
      sinkList: [sink],
      signal: controller.signal,
    });

    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ outcome: OUTCOME.INTERRUPTED });

    expectSchemaValid(sink);

    // Preflight ran (the run has an identity, so `run.start` was emitted) but
    // the machine never started: no step events at all.
    expect(sink.ofKind(RUN_EVENT.STEP_START)).toHaveLength(0);
    expect(sink.eventList.at(-1)).toMatchObject({
      event: RUN_EVENT.RUN_END,
      outcome: OUTCOME.INTERRUPTED,
      steps_total: 0,
      steps_failed: 0,
    });
  }, 30_000);
});
