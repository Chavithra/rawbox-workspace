import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWorkflowInstance } from '../src/tool/run-workflow.js';
import {
  MemoryRunEventSink,
  RunEventValidator,
  type RunEndEvent,
  type RunEvent,
  type StepEndEvent,
} from '../src/events/index.js';

// ---------------------------------------------------------------------------
// `control-flow/halt` with `fail: true` — the one author-level way to end a run
// as a **failure** (FORMAT.md, "`steps`").
//
// The distinction these cases exist to pin: a handler returning `err(...)` is a
// *handled* step failure — the step's `errors:` bindings are written and the
// workflow continues (`events.test.ts`). A failing halt is the opposite: the
// step itself succeeds, and the **run** ends `outcome: "error"` with the
// author's reason as its message, which is what makes a supervised run stop
// hot-looping on a refusal instead of restarting on an exit code of 0.
//
// Same conventions as `events.test.ts`: a real workspace on disk, the real
// built default plugin, a `MemoryRunEventSink`, and every event checked against
// the schema on the way out.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDir = path.join(__dirname, 'temp-halt-failure');

const DEFAULT_PLUGIN = '@rawbox/rawbox-plugin-default';

interface Scenario {
  events: RunEvent[];
  ok: boolean;
  error: string;
}

/**
 * Writes a workspace plus one workflow whose only step is a `halt`, runs it,
 * and returns the events it produced.
 *
 * @param seedBody - The `storage.keys` entries feeding the halt step.
 * @param haltInputBody - The halt step's `inputs:` lines.
 */
async function runHaltScenario(
  name: string,
  seedBody: readonly string[],
  haltInputBody: readonly string[],
): Promise<Scenario> {
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
  await fs.writeFile(
    workflowPath,
    [
      'kind: Workflow',
      'formatVersion: "1.0"',
      `name: ${name}-workflow`,
      '',
      'plugins:',
      `  "${DEFAULT_PLUGIN}": "*"`,
      '',
      'storage:',
      '  defaultStrategy:',
      '    name: lmdb-kv',
      '    valueSizeMax: 1900',
      '  keys:',
      ...seedBody,
      '',
      'steps:',
      '  - label: refuse-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: control-flow/halt',
      '    inputs:',
      ...haltInputBody,
      '',
      // Never reached on the failing path — that is the point of the last case
      // in this file.
      '  - label: never-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: time/sleep',
      '    inputs:',
      '      ms: sleep_ms',
      '    outputs:',
      '      timestamp: slept_at',
      '',
    ].join('\n'),
  );

  const sink = new MemoryRunEventSink();
  const result = await runWorkflowInstance(
    workspacePath,
    workflowPath,
    path.join(directory, 'run.log'),
    path.join(directory, 'run.error.log'),
    { sinkList: [sink] },
  );

  for (const event of sink.eventList) {
    expect(
      RunEventValidator.Check(event),
      `event does not match the schema: ${JSON.stringify(event)}`,
    ).toBe(true);
  }

  return {
    events: sink.eventList,
    ok: result.isOk(),
    error: result.isErr() ? result.error : '',
  };
}

const stepEndList = (scenario: Scenario): StepEndEvent[] =>
  scenario.events.filter(
    (event): event is StepEndEvent => event.event === 'step.end',
  );

const runEnd = (scenario: Scenario): RunEndEvent =>
  scenario.events.at(-1) as RunEndEvent;

beforeAll(async () => {
  await fs.mkdir(sandboxDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(sandboxDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('control-flow/halt with fail: true', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await runHaltScenario(
      'halt-fail',
      [
        '    sleep_ms:',
        '      seed: 1',
        '    halt_fail:',
        '      seed: true',
        '    halt_reason:',
        '      seed: there is no grid_state, but the symbol is ACTIVE',
      ],
      ['      reason: halt_reason', '      fail: halt_fail'],
    );
  }, 60_000);

  it('fails the run', () => {
    expect(scenario.ok).toBe(false);
    expect(scenario.error).toContain(
      'there is no grid_state, but the symbol is ACTIVE',
    );
  });

  it('closes with run.end outcome error carrying the reason as its message', () => {
    const end = runEnd(scenario);
    expect(end).toMatchObject({
      event: 'run.end',
      outcome: 'error',
      severity: 'error',
      error: { message: 'there is no grid_state, but the symbol is ACTIVE' },
    });
    // A deliberate failure is not a bound expiring: nothing here claims one.
    expect(end).not.toHaveProperty('timed_out');
    expect(end).not.toHaveProperty('timeout_ms');
  });

  it('reports the halt step itself as ok — the step succeeded, the run did not', () => {
    const ends = stepEndList(scenario);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      step: { index: 0, label: 'refuse-step' },
      outcome: 'ok',
      output: { label: '__FAIL__' },
    });
    expect(ends[0]).not.toHaveProperty('error');
    expect(runEnd(scenario)).toMatchObject({ steps_total: 1, steps_failed: 0 });
  });

  it('starts no step after the failing halt', () => {
    // Neither a `step.start` nor a fabricated `step.end` for the step that was
    // next in the list: the machine stops instead of selecting it.
    expect(scenario.events.map((event) => event.event)).toEqual([
      'run.start',
      'storage.seed',
      'step.start',
      'log',
      'step.end',
      'run.end',
    ]);
  });

  it('routes the reason as an error-level log line under the step', () => {
    const [logEvent] = scenario.events.filter((event) => event.event === 'log');
    expect(logEvent).toMatchObject({
      event: 'log',
      level: 'error',
      severity: 'error',
      message: 'Workflow failed: there is no grid_state, but the symbol is ACTIVE',
      step: { index: 0, label: 'refuse-step' },
    });
  });

  it('mirrors the failure into the error log', async () => {
    const errorLog = await fs.readFile(
      path.join(sandboxDir, 'halt-fail', 'run.error.log'),
      'utf-8',
    );
    const mirrored = errorLog
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as RunEvent);

    // The step ended `ok`, so the only failure-shaped event of this run is its
    // `run.end` (`ndjson-file-sink.ts` filters on `outcome === "error"`).
    expect(mirrored.map((event) => event.event)).toEqual(['run.end']);
  });
});

// ---------------------------------------------------------------------------

describe('control-flow/halt with fail: true and no reason', () => {
  it('ends the run as a failure with a default message naming the step', async () => {
    const scenario = await runHaltScenario(
      'halt-fail-no-reason',
      ['    sleep_ms:', '      seed: 1', '    halt_fail:', '      seed: true'],
      ['      fail: halt_fail'],
    );

    expect(scenario.ok).toBe(false);
    expect(runEnd(scenario)).toMatchObject({
      event: 'run.end',
      outcome: 'error',
      error: {
        message:
          'Step 0 "refuse-step" ended the run as a failure (__FAIL__ with no reason given).',
      },
    });

    // `reason` is optional on both halves: the handler emits no log line
    // without one, and the output record carries only the label.
    expect(scenario.events.some((event) => event.event === 'log')).toBe(false);
    expect(stepEndList(scenario)[0]).toMatchObject({
      outcome: 'ok',
      output: { label: '__FAIL__' },
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe('control-flow/halt without fail', () => {
  it('still ends the run cleanly — halting successfully is the default', async () => {
    const scenario = await runHaltScenario(
      'halt-ok',
      [
        '    sleep_ms:',
        '      seed: 1',
        '    halt_reason:',
        '      seed: two steps are enough',
      ],
      ['      reason: halt_reason'],
    );

    expect(scenario.ok, scenario.error).toBe(true);
    expect(runEnd(scenario)).toMatchObject({
      event: 'run.end',
      outcome: 'ok',
      steps_total: 1,
      steps_failed: 0,
    });
    expect(runEnd(scenario)).not.toHaveProperty('error');

    // The success path's output record is unchanged: the bare label, with the
    // reason travelling as a log line and nothing else.
    expect(stepEndList(scenario)[0]!.output).toEqual({ label: '__EXIT__' });
    const [logEvent] = scenario.events.filter((event) => event.event === 'log');
    expect(logEvent).toMatchObject({
      level: 'info',
      message: 'Workflow halted: two steps are enough',
    });
    expect(logEvent).not.toHaveProperty('severity');
  }, 60_000);

  it('ends the run cleanly with an explicit fail: false', async () => {
    const scenario = await runHaltScenario(
      'halt-fail-false',
      ['    sleep_ms:', '      seed: 1', '    halt_fail:', '      seed: false'],
      ['      fail: halt_fail'],
    );

    expect(scenario.ok, scenario.error).toBe(true);
    expect(runEnd(scenario)).toMatchObject({ outcome: 'ok' });
    expect(stepEndList(scenario)[0]!.output).toEqual({ label: '__EXIT__' });
  }, 60_000);
});
