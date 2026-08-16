import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runWorkflowInstance } from '../src/tool/run-workflow.js';
import {
  MemoryRunEventSink,
  RunEventProducer,
  RunEventValidator,
  type RunEvent,
  type StepEndEvent,
  type StepStartEvent,
} from '../src/events/index.js';
import type { RunSnapshotView } from '../src/events/producer.js';

// ---------------------------------------------------------------------------
// The run-event stream, end to end.
//
// These run real workflows against the real built default plugin and assert on
// the events an in-memory sink collected — the same events the NDJSON file, the
// terminal renderer and the OTel bridge consume. Nothing here parses a log file:
// the file is one sink among several, and the *stream* is the contract
// (OBSERVABILITY.md, "The run-event stream", `src/events/event-types.ts`).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sandboxDir = path.join(__dirname, 'temp-events');

/** The plugin every fixture below runs against; a real, built workspace package. */
const DEFAULT_PLUGIN = '@rawbox/rawbox-plugin-default';

/** What one scenario needs to run and be asserted on. */
interface Scenario {
  events: RunEvent[];
  sink: MemoryRunEventSink;
  ok: boolean;
  error: string;
}

/**
 * Writes a workspace plus one workflow, runs it with a collecting sink attached,
 * and returns the events it produced.
 *
 * Every event is checked against `RunEventValidator` on the way out, so a
 * producer that drifts from the schema fails the scenario that produced it
 * rather than some later assertion.
 */
async function runScenario(name: string, workflowBody: string): Promise<Scenario> {
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
    sink,
    ok: result.isOk(),
    error: result.isErr() ? result.error : '',
  };
}

/** `steps:` for a `halt` terminator reading a seeded reason. */
const haltStep = [
  '  - label: halt-step',
  `    plugin: "${DEFAULT_PLUGIN}"`,
  '    operation: control-flow/halt',
  '    inputs:',
  '      reason: halt_reason',
  '',
];

beforeAll(async () => {
  await fs.mkdir(sandboxDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(sandboxDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('the run-event stream — a successful two-step run', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    scenario = await runScenario(
      'events-ok',
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: events-ok-workflow',
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
        '      seed: 30',
        '    halt_reason:',
        '      seed: two steps are enough',
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
        ...haltStep,
      ].join('\n'),
    );
  }, 60_000);

  it('runs to completion', () => {
    expect(scenario.ok, scenario.error).toBe(true);
  });

  it('emits exactly one run.start / step pair per step / run.end, in order', () => {
    // The halt step's reason arrives as a `log` event between its own
    // boundary events: the built-in halt operation routes it through the
    // run-event channel like any workflow-authored log line.
    expect(scenario.events.map((event) => event.event)).toEqual([
      'run.start',
      'storage.seed',
      'step.start',
      'step.end',
      'step.start',
      'log',
      'step.end',
      'run.end',
    ]);
  });

  it('opens with run.start carrying `format: 1` and the run identity', () => {
    const [first] = scenario.events;
    expect(first).toMatchObject({
      event: 'run.start',
      format: 1,
      workspace: 'events-ok',
      workflow: 'events-ok-workflow',
    });
    expect((first as { ts: string }).ts).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('stamps one run_id, and the same one, on every event', () => {
    const runId = scenario.events[0]!.run_id;
    expect(runId).toMatch(/^run-/);
    expect(scenario.events.every((event) => event.run_id === runId)).toBe(true);
  });

  it('describes each step with everything a span needs', () => {
    const starts = scenario.events.filter(
      (event): event is StepStartEvent => event.event === 'step.start',
    );

    expect(starts[0]!.step).toEqual({
      index: 0,
      iteration: 0,
      label: 'sleep-step',
      plugin: DEFAULT_PLUGIN,
      operation: 'time/sleep',
      registry_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(starts[1]!.step).toMatchObject({
      index: 1,
      iteration: 0,
      label: 'halt-step',
      operation: 'control-flow/halt',
    });

    // The resolved input record the handler received, so "which value did this
    // step actually read?" is answerable from the log alone.
    expect(starts[0]!.input).toEqual({ ms: 30 });
  });

  it('pairs every step.end with its step.start and times it', () => {
    const ends = scenario.events.filter(
      (event): event is StepEndEvent => event.event === 'step.end',
    );

    expect(ends).toHaveLength(2);
    expect(ends.every((end) => end.outcome === 'ok')).toBe(true);
    expect(ends.every((end) => end.error === undefined)).toBe(true);

    // The sleep step really slept, so its duration is a measurement and not a
    // constant: >= the 30ms it was told to sleep, and far below the timeout.
    expect(ends[0]!.duration_ms).toBeGreaterThanOrEqual(30);
    expect(ends[0]!.duration_ms).toBeLessThan(10_000);
    expect(ends[1]!.duration_ms).toBeGreaterThanOrEqual(0);

    // The handlers' outputs travel with the events.
    expect(typeof ends[0]!.output?.['timestamp']).toBe('number');
    expect(ends[1]!.output).toEqual({ label: '__EXIT__' });
  });

  it('closes with run.end recapping the run', () => {
    const last = scenario.events.at(-1);
    expect(last).toMatchObject({
      event: 'run.end',
      outcome: 'ok',
      steps_total: 2,
      steps_failed: 0,
    });
    expect(last).not.toHaveProperty('error');
    expect((last as { duration_ms: number }).duration_ms).toBeGreaterThanOrEqual(30);
  });

  it('carries no severity anywhere — nothing here warrants an alarm', () => {
    // Neither a fast default-heartbeat run nor a clean step/run outcome ever
    // sets `severity` (OBSERVABILITY.md, "`severity`"): it is reserved for
    // the kinds/outcomes that warrant paging someone.
    for (const event of scenario.events) {
      expect(event).not.toHaveProperty('severity');
    }
  });

  it('summarises the seeding pass in one storage.seed event', () => {
    const [seedEvent] = scenario.events.filter(
      (event) => event.event === 'storage.seed',
    );
    expect(seedEvent).toMatchObject({
      seed_count: 2,
      key_count: 2,
      keys: ['sleep_ms', 'halt_reason'],
    });
  });

  it('flushes and closes every registered sink exactly once', () => {
    expect(scenario.sink.flushCount).toBe(1);
    expect(scenario.sink.closeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe('the run-event stream — a failing step', () => {
  let scenario: Scenario;

  beforeAll(async () => {
    // `assert` fails logically, so the *handler* returns its `errorSchema`
    // record rather than throwing — the shape a `step.end` carries as `error`.
    // The run then fails too, because the second step reads the output the
    // failed step never produced. Both halves are the point: a failed step is
    // not automatically a failed run, and this fixture pins the case where it
    // becomes one.
    scenario = await runScenario(
      'events-step-error',
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: events-error-workflow',
        '',
        'plugins:',
        `  "${DEFAULT_PLUGIN}": "*"`,
        '',
        'storage:',
        '  defaultStrategy:',
        '    name: lmdb-kv',
        '    valueSizeMax: 1900',
        '  keys:',
        '    never:',
        '      seed: false',
        '    failure_message:',
        '      seed: the sky is not green',
        '',
        'steps:',
        '  - label: assert-step',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: value-ops/assert',
        '    inputs:',
        '      condition: never',
        '      message: failure_message',
        '    outputs:',
        '      passed: assert_passed',
        '    errors:',
        '      message: assert_error',
        '',
        '  - label: echo-step',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: value-ops/echo',
        '    inputs:',
        '      value: assert_passed',
        '    outputs:',
        '      value: echoed',
        '',
      ].join('\n'),
    );
  }, 60_000);

  it('fails the run', () => {
    expect(scenario.ok).toBe(false);
  });

  it('reports the step with outcome error and the handler’s error record', () => {
    const ends = scenario.events.filter(
      (event): event is StepEndEvent => event.event === 'step.end',
    );

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      step: { index: 0, label: 'assert-step' },
      outcome: 'error',
      error: { message: 'the sky is not green' },
      severity: 'error',
    });
    // A failed step produced no output, so the field is absent rather than null.
    expect(ends[0]).not.toHaveProperty('output');
    expect(ends[0]!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('closes with run.end outcome error, counting the failure', () => {
    const last = scenario.events.at(-1);
    expect(last).toMatchObject({
      event: 'run.end',
      outcome: 'error',
      steps_total: 1,
      steps_failed: 1,
      severity: 'error',
    });
    expect((last as { error: { message: string } }).error.message).toBeTruthy();
  });

  it('mirrors only the failure events into the error log', async () => {
    const errorLog = await fs.readFile(
      path.join(sandboxDir, 'events-step-error', 'run.error.log'),
      'utf-8',
    );
    const mirrored = errorLog
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as RunEvent);

    // Same schema, filtered view — never a third format.
    expect(mirrored.map((event) => event.event)).toEqual(['step.end', 'run.end']);
    expect(mirrored.every((event) => RunEventValidator.Check(event))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('the run-event stream — a bootstrap failure', () => {
  it('emits bootstrap.error and nothing else when the document is not a workflow', async () => {
    const scenario = await runScenario(
      'events-bootstrap',
      ['name: not-a-workflow', 'steps: []', ''].join('\n'),
    );

    expect(scenario.ok).toBe(false);
    expect(scenario.events.map((event) => event.event)).toEqual(['bootstrap.error']);

    const [event] = scenario.events;
    expect(event).toMatchObject({ event: 'bootstrap.error', stage: 'workflow', severity: 'error' });
    expect((event as { message: string }).message).toContain(
      'is not a Rawbox workflow document',
    );

    // A run that never learned what it was running has no `run.start` to be the
    // first line and no `run.end` to be the last: the bootstrap event is the
    // whole stream, and it carries no workflow name because naming it is exactly
    // what failed.
    expect(event).not.toHaveProperty('workflow');
    expect(event!.run_id).toMatch(/^run-/);
  }, 60_000);

  it('names the stage that failed when the workspace document is missing', async () => {
    const sink = new MemoryRunEventSink();
    const missing = path.join(sandboxDir, 'nowhere', 'workspace.yaml');

    const result = await runWorkflowInstance(
      missing,
      path.join(sandboxDir, 'nowhere', 'any.workflow.yaml'),
      path.join(sandboxDir, 'nowhere-run.log'),
      path.join(sandboxDir, 'nowhere-run.error.log'),
      { sinkList: [sink] },
    );

    expect(result.isErr()).toBe(true);
    expect(sink.ofKind('bootstrap.error').map((event) => event.stage)).toEqual([
      'workspace',
    ]);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe('the run-event stream — loop iterations', () => {
  it('distinguishes repeated executions of one step by `iteration`', async () => {
    const scenario = await runScenario(
      'events-loop',
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: events-loop-workflow',
        '',
        'plugins:',
        `  "${DEFAULT_PLUGIN}": "*"`,
        '',
        'storage:',
        '  defaultStrategy:',
        '    name: lmdb-kv',
        '    valueSizeMax: 1900',
        '  keys:',
        '    counter:',
        '      seed: 0',
        '    loop_max:',
        '      seed: 2',
        '    loop_label:',
        '      seed: inc-step',
        '    exit_label:',
        '      seed: halt-step',
        '    halt_reason:',
        '      seed: loop drained',
        '',
        'steps:',
        '  - label: inc-step',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: value-ops/increment',
        '    inputs:',
        '      value: counter',
        '    outputs:',
        '      value: counter',
        '',
        '  - label: gate-step',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: control-flow/loop-gate',
        '    inputs:',
        '      counter: counter',
        '      max: loop_max',
        '      loopLabel: loop_label',
        '      exitLabel: exit_label',
        '',
        ...haltStep,
      ].join('\n'),
    );

    expect(scenario.ok, scenario.error).toBe(true);

    const ends = scenario.events.filter(
      (event): event is StepEndEvent => event.event === 'step.end',
    );

    // `inc-step` ran twice under one label; `(index, iteration)` is what tells
    // the two span-worthy executions apart (README, "The mapping").
    const increments = ends.filter((end) => end.step.index === 0);
    expect(increments.map((end) => end.step.iteration)).toEqual([0, 1]);
    expect(increments.map((end) => end.output?.['value'])).toEqual([1, 2]);

    // …and the gate too, so the counter is not the only thing that looped.
    expect(
      ends.filter((end) => end.step.index === 1).map((end) => end.step.iteration),
    ).toEqual([0, 1]);

    // Every start has exactly one end with the same identity.
    const identity = (step: { index: number; iteration: number }) =>
      `${step.index}/${step.iteration}`;
    const startIdentities = scenario.events
      .filter((event): event is StepStartEvent => event.event === 'step.start')
      .map((event) => identity(event.step));
    expect(startIdentities).toEqual(ends.map((end) => identity(end.step)));
    expect(new Set(startIdentities).size).toBe(startIdentities.length);
  }, 60_000);
});

// ---------------------------------------------------------------------------

describe('the run-event stream — workflow-authored log lines', () => {
  it('routes the built-in observability/log operation into the same stream', async () => {
    const scenario = await runScenario(
      'events-log',
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: events-log-workflow',
        '',
        'plugins:',
        `  "${DEFAULT_PLUGIN}": "*"`,
        '',
        'storage:',
        '  defaultStrategy:',
        '    name: lmdb-kv',
        '    valueSizeMax: 1900',
        '  keys:',
        '    log_level:',
        '      seed: warn',
        '    log_message:',
        '      seed: a line the workflow author asked for',
        '    log_data:',
        '      seed:',
        '        attempt: 3',
        '    halt_reason:',
        '      seed: logged',
        '',
        'steps:',
        '  - label: log-step',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: observability/log',
        '    inputs:',
        '      level: log_level',
        '      message: log_message',
        '      data: log_data',
        '    outputs:',
        '      timestamp: logged_at',
        '',
        ...haltStep,
      ].join('\n'),
    );

    expect(scenario.ok, scenario.error).toBe(true);

    // The halt step contributes its own `log` event (its reason), so scope the
    // assertion to the log-step's events.
    const logEvents = scenario.events.filter(
      (event) => event.event === 'log' && event.step?.label === 'log-step',
    );
    expect(logEvents).toHaveLength(1);
    expect(logEvents[0]).toMatchObject({
      event: 'log',
      level: 'warn',
      message: 'a line the workflow author asked for',
      data: { attempt: 3 },
      // Correlated to the step that was executing, so the OTel bridge can attach
      // the log record to that step's span without tracking state itself.
      step: { index: 0, iteration: 0, label: 'log-step' },
      workflow: 'events-log-workflow',
      // Projected from `level`: `warn` -> `"warn"` (OBSERVABILITY.md, "`severity`").
      severity: 'warn',
    });

    // The halt step's own `log` event is `info`-level (unset `level` input
    // falls back to it) and therefore carries no `severity` at all.
    const haltLog = scenario.events.find(
      (event) => event.event === 'log' && event.step?.label === 'halt-step',
    );
    expect(haltLog).not.toHaveProperty('severity');

    // It shares the envelope with the runner's own events — same run, same file,
    // same reader.
    expect(logEvents[0]!.run_id).toBe(scenario.events[0]!.run_id);

    // And it lands between the step's own boundary events, not appended at the end.
    const kinds = scenario.events.map((event) => event.event);
    expect(kinds.indexOf('log')).toBeGreaterThan(kinds.indexOf('step.start'));
    expect(kinds.indexOf('log')).toBeLessThan(kinds.indexOf('step.end'));
  }, 60_000);

  it('leaves no channel installed once the run is over', async () => {
    // The channel is ambient, so a run that failed to uninstall it would make
    // the *next* process-wide `observability/log` call write into a dead sink.
    const { getRunEventChannel } = await import('@rawbox/plugin/core');
    expect(getRunEventChannel()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// `step.progress` — opt-in mid-step progress (OBSERVABILITY.md,
// "Event kinds"). Driven directly against `RunEventProducer`, the same technique
// `heartbeat.test.ts` uses: an operation reaching `emitRunEvent` is exactly
// what's being exercised here, and a hand-built snapshot is what puts a step
// "in flight" without needing a real built-in operation that calls it.
// ---------------------------------------------------------------------------

/** A snapshot where the machine has just entered `running.running` for `index`. */
function runningSnapshot(index: number): RunSnapshotView {
  return {
    value: { running: 'running' },
    context: { execution: { todoStep: { index }, doneStep: null } },
  } as unknown as RunSnapshotView;
}

/** A snapshot where the machine has just left `running.running`, reporting `doneStep`. */
function doneSnapshot(index: number): RunSnapshotView {
  return {
    value: 'stopping',
    context: { execution: { todoStep: null, doneStep: { index, outputRecord: {} } } },
  } as unknown as RunSnapshotView;
}

describe('the run-event stream — step.progress (opt-in mid-step progress)', () => {
  it('lands between step.start and step.end, correlated to the step in flight', async () => {
    const { emitRunEvent } = await import('@rawbox/plugin');

    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-progress-1', sinkList: [sink] });
    producer.setStepDescriptorList([
      { index: 0, label: 'long-step', plugin: DEFAULT_PLUGIN, operation: 'time/sleep', registry_hash: 'hash-abc' },
    ]);
    producer.start('ws-progress', 'wf-progress');
    producer.installLogChannel();

    try {
      producer.observe(runningSnapshot(0));
      const routed = emitRunEvent({
        event: 'step.progress',
        message: 'halfway there',
        data: { processed: 5, total: 10 },
      });
      expect(routed).toBe(true);
      producer.observe(doneSnapshot(0));
      producer.end('ok');
    } finally {
      producer.uninstallLogChannel();
    }

    expect(sink.eventList.map((event) => event.event)).toEqual([
      'run.start',
      'step.start',
      'step.progress',
      'step.end',
      'run.end',
    ]);

    const progress = sink.ofKind('step.progress')[0]!;
    expect(RunEventValidator.Check(progress)).toBe(true);
    expect(progress).toMatchObject({
      event: 'step.progress',
      message: 'halfway there',
      data: { processed: 5, total: 10 },
      step: { index: 0, iteration: 0, label: 'long-step' },
      workflow: 'wf-progress',
    });
    // Progress is informational by construction — never an alarm.
    expect(progress).not.toHaveProperty('severity');
  });

  it('accepts data with no message, since progress may have nothing to say in words', async () => {
    const { emitRunEvent } = await import('@rawbox/plugin');

    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-progress-2', sinkList: [sink] });
    producer.start('ws-progress', 'wf-progress');
    producer.installLogChannel();

    try {
      producer.observe(runningSnapshot(0));
      emitRunEvent({ event: 'step.progress', data: { processed: 4200 } });
      producer.observe(doneSnapshot(0));
      producer.end('ok');
    } finally {
      producer.uninstallLogChannel();
    }

    const progress = sink.ofKind('step.progress')[0]!;
    expect(progress).not.toHaveProperty('message');
    expect(progress.data).toEqual({ processed: 4200 });
    expect(RunEventValidator.Check(progress)).toBe(true);
  });

  it('drops a malformed payload — a non-string message — rather than writing it', async () => {
    const { emitRunEvent } = await import('@rawbox/plugin');

    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-progress-3', sinkList: [sink] });
    producer.start('ws-progress', 'wf-progress');
    producer.installLogChannel();

    try {
      producer.observe(runningSnapshot(0));
      emitRunEvent({ event: 'step.progress', message: 12345 as unknown as string });
      producer.observe(doneSnapshot(0));
      producer.end('ok');
    } finally {
      producer.uninstallLogChannel();
    }

    expect(sink.ofKind('step.progress')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// `log.rotate` — driven directly against `RunEventProducer.logRotate`, the
// same technique the `step.progress` block above uses: the NDJSON sink's own
// call into this method is exercised separately, in
// `ndjson-rotation.test.ts`; here it is the producer's envelope-stamping and
// `severity` projection under test.
// ---------------------------------------------------------------------------

describe('the run-event stream — log.rotate', () => {
  it('names the sealed and live segments, with no deleted_segment or severity when nothing was retired', () => {
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-rotate-1', sinkList: [sink] });
    producer.start('ws-rotate', 'wf-rotate');

    producer.logRotate({
      sealedSegment: 0,
      liveSegment: 1,
      deletedSegment: undefined,
      maxBytes: 134_217_728,
      maxFiles: 8,
    });
    producer.end('ok');

    const rotate = sink.ofKind('log.rotate')[0]!;
    expect(RunEventValidator.Check(rotate)).toBe(true);
    expect(rotate).toMatchObject({
      event: 'log.rotate',
      sealed_segment: 0,
      live_segment: 1,
      max_bytes: 134_217_728,
      max_files: 8,
      workspace: 'ws-rotate',
      workflow: 'wf-rotate',
    });
    expect(rotate).not.toHaveProperty('deleted_segment');
    expect(rotate).not.toHaveProperty('severity');
  });

  it('carries deleted_segment and severity "warn" when a segment was retired', () => {
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-rotate-2', sinkList: [sink] });
    producer.start('ws-rotate', 'wf-rotate');

    producer.logRotate({
      sealedSegment: 4,
      liveSegment: 5,
      deletedSegment: 1,
      maxBytes: 2000,
      maxFiles: 4,
    });
    producer.end('ok');

    const rotate = sink.ofKind('log.rotate')[0]!;
    expect(RunEventValidator.Check(rotate)).toBe(true);
    expect(rotate).toMatchObject({
      event: 'log.rotate',
      sealed_segment: 4,
      live_segment: 5,
      deleted_segment: 1,
      severity: 'warn',
    });
  });

  it('emits none for a run that never rotates', () => {
    const sink = new MemoryRunEventSink();
    const producer = new RunEventProducer({ runId: 'run-rotate-3', sinkList: [sink] });
    producer.start('ws-rotate', 'wf-rotate');
    producer.end('ok');

    expect(sink.ofKind('log.rotate')).toHaveLength(0);
  });
});
