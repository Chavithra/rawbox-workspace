import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflowInstance } from '../../src/tool/run-workflow.js';
import { PluginDiscoverer } from '../../src/workflow/plugin-discoverer.js';
import type { RunEvent, StepEndEvent } from '../../src/events/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, 'temp-run-test');

/** The plugin every fixture below runs against; a real, built workspace package. */
const DEFAULT_PLUGIN = '@rawbox/rawbox-plugin-default';

describe('runWorkflowInstance error logging', () => {
  beforeAll(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should write early bootstrap errors to the separate error log file', async () => {
    const invalidWorkspacePath = path.join(tempDir, 'non-existent-workspace.yaml');
    const workflowPath = path.join(tempDir, 'any-workflow.yaml');
    const logFilePath = path.join(tempDir, 'run.log');
    const errorLogFilePath = path.join(tempDir, 'errors.log');

    // Run workflow with non-existent workspace configuration (causes early bootstrap error)
    const result = await runWorkflowInstance(invalidWorkspacePath, workflowPath, logFilePath, errorLogFilePath);
    expect(result.isErr()).toBe(true);

    const errorLogExists = await fs.access(errorLogFilePath).then(() => true).catch(() => false);
    expect(errorLogExists).toBe(true);

    const errorLogContent = await fs.readFile(errorLogFilePath, 'utf-8');
    // The error log is a filtered view of the same NDJSON schema, never a third
    // format: one `bootstrap.error` event, naming the stage that failed.
    const [bootstrapEvent] = readEvents(errorLogContent);
    expect(bootstrapEvent).toMatchObject({
      event: 'bootstrap.error',
      stage: 'workspace',
    });
    expect((bootstrapEvent as { message: string }).message).toContain('ENOENT');

    // Identity is what the workspace stage establishes, so an event raised
    // *by* that stage has none to report — and there is no `run.start` either.
    expect(bootstrapEvent).not.toHaveProperty('workspace');
    expect(readEvents(errorLogContent).map((event) => event.event)).not.toContain('run.start');
  });

  it('should auto-derive error log file path if not provided', async () => {
    const invalidWorkspacePath = path.join(tempDir, 'non-existent-workspace-derived.yaml');
    const workflowPath = path.join(tempDir, 'any-workflow.yaml');
    const logFilePath = path.join(tempDir, 'run-derived.log');
    const expectedDerivedErrorLogPath = path.join(tempDir, 'run-derived.error.log');

    const result = await runWorkflowInstance(invalidWorkspacePath, workflowPath, logFilePath);
    expect(result.isErr()).toBe(true);

    const derivedErrorLogExists = await fs.access(expectedDerivedErrorLogPath).then(() => true).catch(() => false);
    expect(derivedErrorLogExists).toBe(true);

    const errorLogContent = await fs.readFile(expectedDerivedErrorLogPath, 'utf-8');
    expect(readEvents(errorLogContent).map((event) => event.event)).toContain(
      'bootstrap.error',
    );
  });

  it('derives the error log path from any extension, not just .log', async () => {
    const invalidWorkspacePath = path.join(tempDir, 'non-existent-workspace-ndjson.yaml');
    const workflowPath = path.join(tempDir, 'any-workflow.yaml');
    const logFilePath = path.join(tempDir, 'run-derived.ndjson');
    const expectedDerivedErrorLogPath = path.join(tempDir, 'run-derived.error.ndjson');

    const result = await runWorkflowInstance(invalidWorkspacePath, workflowPath, logFilePath);
    expect(result.isErr()).toBe(true);

    const derivedErrorLogExists = await fs
      .access(expectedDerivedErrorLogPath)
      .then(() => true)
      .catch(() => false);
    expect(derivedErrorLogExists).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: a workflow file on disk → resolver → XState machine that *executes*
// ---------------------------------------------------------------------------

const e2eDir = path.join(__dirname, 'temp-run-e2e');

/** Writes `workspace.yaml` plus a workflow file and returns their paths. */
async function writeWorkspace(
  name: string,
  workflowFileName: string,
  workflowBody: string,
  /** Extra lines appended to the workspace document, e.g. a `seedOverrides:` block. */
  workspaceExtraLineList: readonly string[] = [],
): Promise<{ workspacePath: string; workflowPath: string; logPath: string; errorLogPath: string }> {
  const dir = path.join(e2eDir, name);
  await fs.mkdir(path.join(dir, 'workflows'), { recursive: true });

  const workspacePath = path.join(dir, 'workspace.yaml');
  await fs.writeFile(
    workspacePath,
    [
      'kind: Workspace',
      `name: ${name}`,
      'workflowPathList:',
      `  - workflows/${workflowFileName}`,
      ...workspaceExtraLineList,
      '',
    ].join('\n'),
  );

  const workflowPath = path.join(dir, 'workflows', workflowFileName);
  await fs.writeFile(workflowPath, workflowBody);

  return {
    workspacePath,
    workflowPath,
    logPath: path.join(dir, 'run.log'),
    errorLogPath: path.join(dir, 'run.error.log'),
  };
}

/** Parses an NDJSON log file into the typed run-event stream it holds. */
function readEvents(logContent: string): RunEvent[] {
  return logContent
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as RunEvent);
}

/** Every `step.end` of a log, in order. */
function readStepEnds(logContent: string): StepEndEvent[] {
  return readEvents(logContent).filter(
    (event): event is StepEndEvent => event.event === 'step.end',
  );
}

describe('runWorkflowInstance (end to end)', () => {
  beforeAll(async () => {
    await fs.mkdir(e2eDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(e2eDir, { recursive: true, force: true });
  });

  it('runs a workflow file through the machine and executes its steps', async () => {
    // `echo` is a real operation contract and `halt` a real control-flow
    // contract, both from the built default plugin — so reaching the end
    // requires the whole chain to work: schema validation, plugin load,
    // plugin: → contractRegistryHash, operation: → definitionPath, shorthand
    // and long-form storage resolution, seeding, and every machine actor.
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: e2e-workflow',
      'description: Drives the entry point end to end.',
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
      '      seed: hello-from-e2e',
      '    halt_reason:',
      '      seed: end of e2e workflow',
      '',
      'steps:',
      '  - label: echo-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: greeting',
      '    outputs:',
      '      value: echoed',
      '    errors:',
      '      message: echo_error',
      '',
      '  - label: halt-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: control-flow/halt',
      '    inputs:',
      '      reason: halt_reason',
      '    errors:',
      '      message: halt_error',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-ok',
      'e2e.workflow.yaml',
      workflowBody,
    );

    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath);

    const logContent = await fs.readFile(logPath, 'utf-8');
    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);

    // The log is the typed event stream, not state dumps: the machine's own
    // vocabulary is deliberately absent from it (`events/event-types.ts`).
    const events = readEvents(logContent);
    // The final halt step reports its reason as a `log` event between its own
    // step.start/step.end pair.
    expect(events.map((event) => event.event)).toEqual([
      'run.start',
      'storage.seed',
      'step.start',
      'step.end',
      'step.start',
      'log',
      'step.end',
      'run.end',
    ]);
    expect(events.at(0)).toMatchObject({ event: 'run.start', format: 1 });
    expect(events.at(-1)).toMatchObject({
      event: 'run.end',
      outcome: 'ok',
      steps_total: 2,
      steps_failed: 0,
    });

    const stepEnds = readStepEnds(logContent);

    // The echo handler actually produced a value from the seeded storage key.
    expect(stepEnds[0]).toMatchObject({
      step: { index: 0, label: 'echo-step', operation: 'value-ops/echo' },
      outcome: 'ok',
      output: { value: 'hello-from-e2e' },
    });

    // The control-flow step ran too, returning the reserved exit label.
    expect(stepEnds[1]).toMatchObject({
      step: { index: 1, label: 'halt-step' },
      outcome: 'ok',
      output: { label: '__EXIT__' },
    });
  }, 30_000);

  // -- A seeded jump target steers execution --------------------------------
  //
  // A branch's `thenLabel`/`elseLabel` used to be `{ value: … }` literals, which
  // the resolver desugared into keys it synthesised. They are now ordinary
  // seeded keys, and nothing short of a real run proves that a *label read out
  // of LMDB* still steers the machine: the seeding loop, the sync-db actor's
  // `getSync`, the branch handler and the runner's label lookup all have to
  // agree. The skipped step is the observable: if the jump did not happen it
  // would run, because steps otherwise execute in order.

  it('jumps to a step whose label came from a seeded storage key', async () => {
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: seeded-jump-workflow',
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
      '      seed: hello-from-e2e',
      '    take_branch:',
      '      seed: true',
      '    then_label:',
      '      seed: after-branch',
      '    else_label:',
      '      seed: skipped-step',
      '    halt_reason:',
      '      seed: jumped over the skipped step',
      '',
      'steps:',
      '  - label: branch-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: control-flow/branch',
      '    inputs:',
      '      condition: take_branch',
      '      thenLabel: then_label',
      '      elseLabel: else_label',
      '',
      '  - label: skipped-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: greeting',
      '    outputs:',
      '      value: skipped_ran',
      '',
      '  - label: after-branch',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: control-flow/halt',
      '    inputs:',
      '      reason: halt_reason',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-seeded-jump',
      'seeded-jump.workflow.yaml',
      workflowBody,
    );

    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath);

    const logContent = await fs.readFile(logPath, 'utf-8');
    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);

    const stepEnds = readStepEnds(logContent);

    // The branch returned the label it read out of `then_label`, not a constant
    // baked into the document.
    expect(
      stepEnds.filter((end) => end.step.index === 0).map((end) => end.output?.['label']),
    ).toContain('after-branch');

    // …and the machine honoured it: step 1 never ran, step 2 did.
    expect(stepEnds.some((end) => end.step.index === 1)).toBe(false);
    expect(stepEnds.some((end) => end.step.index === 2)).toBe(true);
  }, 30_000);

  // -- A seeded queue dequeues in order -------------------------------------
  // pins the mandatory-list rule: seeding is a write, and a write to a queue
  // enqueues
  //
  // The rule under test is that `queue_items: [a, b, c]` on an `lmdb-fifo` key
  // seeds *three* entries, not one entry holding the list. Nothing short of a
  // real run proves it: the resolver's expansion, the seeding loop's
  // one-`putSync`-per-`Seed`, and the store's ring all have to agree, and
  // `echo` returning the value it read is what makes each dequeue observable.

  /** A workflow that seeds `[a, b, c]` and drains it with `echoCount` steps. */
  function fifoSeedWorkflowBody(name: string, echoCount: number): string {
    const echoSteps = Array.from({ length: echoCount }, (_, index) => [
      `  - label: take-${index}`,
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: queue_items',
      '    outputs:',
      `      value: taken_${index}`,
      '',
    ]).flat();

    return [
      'kind: Workflow',
      'formatVersion: "1.0"',
      `name: ${name}`,
      '',
      'plugins:',
      `  "${DEFAULT_PLUGIN}": "*"`,
      '',
      'storage:',
      '  defaultStrategy:',
      '    name: lmdb-kv',
      '    valueSizeMax: 1900',
      '  keys:',
      '    queue_items:',
      '      strategy:',
      '        name: lmdb-fifo',
      '        queueSizeMax: 1000',
      '        valueSizeMax: 1900',
      '      seed: [a, b, c]',
      '    halt_reason:',
      '      seed: queue drained',
      '',
      'steps:',
      ...echoSteps,
      '  - label: halt-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: control-flow/halt',
      '    inputs:',
      '      reason: halt_reason',
      '',
    ].join('\n');
  }

  it('seeds a FIFO queue with one entry per element, dequeued in order', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-fifo-seed',
      'fifo.workflow.yaml',
      fifoSeedWorkflowBody('fifo-seed-workflow', 3),
    );

    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath);

    const logContent = await fs.readFile(logPath, 'utf-8');
    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);

    const stepEnds = readStepEnds(logContent);
    const valueAtStep = (index: number): unknown =>
      stepEnds
        .filter((end) => end.step.index === index)
        .map((end) => end.output?.['value'])
        .at(-1);

    // The one `storage.seed` event reports the expansion rather than hiding it:
    // four writes across two keys, because the three-element FIFO seed became
    // three `Seed`s (see `StorageSeedEvent`).
    expect(readEvents(logContent).find((event) => event.event === 'storage.seed')).toMatchObject({
      seed_count: 4,
      key_count: 2,
      keys: ['queue_items', 'halt_reason'],
    });

    // Three reads, three distinct values, in the order they were seeded — so
    // the seed was three queue entries, not one entry holding ['a','b','c'].
    expect(valueAtStep(0)).toBe('a');
    expect(valueAtStep(1)).toBe('b');
    expect(valueAtStep(2)).toBe('c');
  }, 30_000);

  it('reports the queue empty on a fourth read of a three-element seed', async () => {
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-fifo-seed-drained',
      'fifo-drained.workflow.yaml',
      fifoSeedWorkflowBody('fifo-drained-workflow', 4),
    );

    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath);

    // Exactly three entries went in, so the fourth dequeue has nothing to
    // return. Under the old reading it would have returned the whole list on
    // the *first* read and been empty on the second.
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('Queue empty');
  }, 30_000);

  it('rejects a file with no `kind:` and says what was expected', async () => {
    const bodyWithoutKind = [
      'name: legacy',
      'pluginPathList: []',
      'stepList: []',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-no-kind',
      'legacy.workflow.yaml',
      bodyWithoutKind,
    );

    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();
    expect(message).toContain('is not a Rawbox workflow document');
    expect(message).toContain('no "kind:" field');
    expect(message).toContain('kind: Workflow');
    // The offending path is named, not a placeholder.
    expect(message).toContain('legacy.workflow.yaml');

    const errorLogContent = await fs.readFile(errorLogPath, 'utf-8');
    expect(readEvents(errorLogContent)[0]).toMatchObject({
      event: 'bootstrap.error',
      stage: 'workflow',
    });
  });

  it('reports a declared plugin whose registry could not be loaded', async () => {
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: missing-plugin',
      '',
      'plugins:',
      '  "@rawbox/rawbox-plugin-nope": "*"',
      '',
      'storage:',
      '  defaultStrategy:',
      '    name: lmdb-kv',
      '    valueSizeMax: 1900',
      // Seeded because a key an `inputs:` binding reads must be written by
      // something — otherwise the document is rejected before resolution,
      // which is not what this test is about.
      '  keys:',
      '    anything:',
      '      seed: 1',
      '',
      'steps:',
      '  - label: nope',
      '    plugin: "@rawbox/rawbox-plugin-nope"',
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: anything',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-missing-plugin',
      'missing.workflow.yaml',
      workflowBody,
    );

    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();
    // The resolver's plugin/registry-mapping diagnostic...
    expect(message).toContain('no contract registry');
    // ...plus the import failure that explains it, attached by the entry point.
    expect(message).toContain('Plugins that could not be loaded');
    expect(message).toContain('@rawbox/rawbox-plugin-nope');
    // Never the "stale map" error: the map and the cache are built in one pass.
    expect(message).not.toContain('stale map');
  });

  it('fails the run when rawbox.lock disagrees with the installed registry', async () => {
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: locked-workflow',
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
      '',
      'steps:',
      '  - label: echo-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: greeting',
      '    outputs:',
      '      value: echoed',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-lock',
      'locked.workflow.yaml',
      workflowBody,
    );

    await fs.writeFile(
      path.join(path.dirname(workspacePath), 'rawbox.lock'),
      JSON.stringify(
        {
          version: '1',
          plugins: {
            [DEFAULT_PLUGIN]: { resolved: '0.0.1', registryHash: 'a'.repeat(64) },
          },
        },
        null,
        2,
      ),
    );

    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('rawbox.lock mismatch');
  });

  // -------------------------------------------------------------------------
  // An LMDB environment that cannot be opened
  //
  // The document is fine and every strategy is wired; what fails is this
  // machine — the data path is a file, the directory is unwritable, lmdb
  // reports a corrupt or locked map. `BoxStoreLmdb.create` answers with an
  // `Err`, and the runner must report it as the same `store` stage as an
  // unwired strategy rather than let it escape as an exception.
  // -------------------------------------------------------------------------

  it('reports an LMDB environment that cannot be opened as a store-stage bootstrap error', async () => {
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: unopenable-store-workflow',
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
      '',
      'steps:',
      '  - label: echo-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: greeting',
      '    outputs:',
      '      value: echoed',
      '',
    ].join('\n');

    const workspaceName = 'e2e-unopenable-store';
    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      workspaceName,
      'unopenable.workflow.yaml',
      workflowBody,
    );

    // A regular file where the store needs a directory. The environment for
    // workspace `<name>` lives at `<workspace dir>/.rawbox/data/<name>/`, so a
    // file at `.rawbox/data` makes lmdb's `open()` fail with ENOTDIR on the
    // way in — the realistic failure, not a falsy return.
    const dataDirPath = path.join(path.dirname(workspacePath), '.rawbox', 'data');
    await fs.mkdir(path.dirname(dataDirPath), { recursive: true });
    await fs.writeFile(dataDirPath, 'not a directory\n');

    const result = await runWorkflowInstance(
      workspacePath,
      workflowPath,
      logPath,
      errorLogPath,
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();

    // Which workspace, where, and lmdb's reason — never a stack trace.
    expect(message).toContain(`'${workspaceName}'`);
    expect(message).toContain(path.join(dataDirPath, workspaceName));
    expect(message).toContain('ENOTDIR');

    // The same stage as an unwired strategy: the document resolved, and what
    // is wrong is this machine.
    const errorLogContent = await fs.readFile(errorLogPath, 'utf-8');
    const bootstrapEventList = readEvents(errorLogContent).filter(
      (event) => event.event === 'bootstrap.error',
    );
    expect(bootstrapEventList).toHaveLength(1);
    expect(bootstrapEventList[0]).toMatchObject({ stage: 'store' });

    // No step ever ran.
    expect(readStepEnds(await fs.readFile(logPath, 'utf-8'))).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The backstop: an unexpected throw inside the run is still an `Err`
  //
  // `runWorkflowInstance` is declared `Promise<Result<…>>` and documented as
  // needing only `isErr()`; the CLI awaits it with no `catch`. Plugin loading
  // is the one stage that runs third-party code across an `import()`, so it
  // stands in here for whatever a plugin's module might do that the loader
  // did not foresee.
  // -------------------------------------------------------------------------

  it('answers an unexpected throw inside the run with an Err, never a rejection', async () => {
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: throwing-workflow',
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
      '',
      'steps:',
      '  - label: echo-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: greeting',
      '    outputs:',
      '      value: echoed',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-unexpected-throw',
      'throwing.workflow.yaml',
      workflowBody,
    );

    const spy = vi
      .spyOn(PluginDiscoverer, 'loadPlugins')
      .mockRejectedValueOnce(new Error('registry exploded on import'));

    try {
      const result = await runWorkflowInstance(
        workspacePath,
        workflowPath,
        logPath,
        errorLogPath,
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toContain('registry exploded on import');
    } finally {
      spy.mockRestore();
    }

    // The sinks were closed and the stream ended with the failure rather than
    // left open: no `run.end` at all only if the run never started, never one
    // that says anything but `error`.
    const eventList = readEvents(await fs.readFile(logPath, 'utf-8'));
    const runEndList = eventList.filter((event) => event.event === 'run.end');
    for (const runEnd of runEndList) {
      expect(runEnd).toMatchObject({ outcome: 'error' });
    }
    expect(readStepEnds(await fs.readFile(logPath, 'utf-8'))).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The workspace's `seedOverrides:` reach the store
  //
  // The merge happens once, on the authored document, before resolution — so
  // the only thing that proves it reached the *run* is a step reading the
  // overridden value out of LMDB. Nothing short of a real run covers the whole
  // chain: workspace load, merge, seed expansion, the seeding transaction and
  // the sync-db actor's read.
  // -------------------------------------------------------------------------

  it('runs with the seed value the workspace overrides, not the workflow default', async () => {
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: override-workflow',
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
      '      seed: from-the-workflow',
      '',
      'steps:',
      '  - label: echo-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: greeting',
      '    outputs:',
      '      value: echoed',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-seed-override',
      'override.workflow.yaml',
      workflowBody,
      // Keyed by the workflow's PATH, and deliberately spelt `./workflows/…`
      // where `workflowPathList` above says `workflows/…`: the two are one
      // workflow, and the match is on the resolved path rather than on the
      // authored string. If normalisation ever regressed, this run would be
      // refused as naming a workflow the workspace does not list.
      [
        'seedOverrides:',
        '  ./workflows/override.workflow.yaml:',
        '    greeting: from-the-workspace',
      ],
    );

    const result = await runWorkflowInstance(
      workspacePath,
      workflowPath,
      logPath,
      errorLogPath,
    );

    expect(result.isOk(), `run failed: ${result.isErr() ? result.error : ''}`).toBe(true);

    const stepEnds = readStepEnds(await fs.readFile(logPath, 'utf-8'));
    expect(stepEnds[0]).toMatchObject({
      outcome: 'ok',
      output: { value: 'from-the-workspace' },
    });
  }, 30_000);

  it('refuses the run when an override names a key the workflow does not seed', async () => {
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: bad-override-workflow',
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
      '      seed: from-the-workflow',
      '',
      'steps:',
      '  - label: echo-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: greeting',
      '    outputs:',
      '      value: echoed',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-seed-override-bad',
      'bad-override.workflow.yaml',
      workflowBody,
      [
        'seedOverrides:',
        '  workflows/bad-override.workflow.yaml:',
        '    echoed: reset-me',
      ],
    );

    const result = await runWorkflowInstance(
      workspacePath,
      workflowPath,
      logPath,
      errorLogPath,
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();
    expect(message).toContain('Seed override for storage key "echoed"');
    expect(message).toContain('RESET that key on every run');
    // Both documents named, and the override named as the cause.
    expect(message).toContain(
      'seedOverrides["workflows/bad-override.workflow.yaml"].echoed',
    );
    expect(message).toContain('workspace.yaml');
    expect(message).toContain('bad-override.workflow.yaml');

    // Refused before the run had an identity: the merge is part of establishing
    // what this run is, so there is a `bootstrap.error` and no `run.start`.
    const eventList = readEvents(await fs.readFile(logPath, 'utf-8'));
    expect(eventList.map((event) => event.event)).not.toContain('run.start');
    // `seed-override`, not `workspace`: the workspace document itself loaded
    // and validated fine — what failed is the *replacement* it asked for
    // (`BOOTSTRAP_STAGE.SEED_OVERRIDE`'s own doc, `event-types.ts`), which is
    // also the tag a `--seed`-only failure with no workspace block involved
    // gets, so this run's own `bootstrap.error` does not misname a document
    // that had nothing to do with it.
    expect(eventList.filter((event) => event.event === 'bootstrap.error')).toMatchObject(
      [{ stage: 'seed-override' }],
    );

    // And nothing was written: no LMDB environment was ever opened.
    const dataDirExists = await fs
      .access(path.join(path.dirname(workspacePath), '.rawbox', 'data'))
      .then(() => true)
      .catch(() => false);
    expect(dataDirExists).toBe(false);
  }, 30_000);

  // -------------------------------------------------------------------------
  // The bug this keying change removes, at the entry point that had it
  //
  // Keyed by NAME, a run could not tell a misspelt block from a sibling
  // workflow's perfectly good one — so it applied nothing, said nothing, and
  // seeded the workflow's own value. Only `workspace verify` ever caught it.
  // Keyed by PATH, `workflowPathList` in the document already in hand answers
  // the question, so `run` refuses.
  // -------------------------------------------------------------------------

  it('refuses the run when a seedOverrides: block names a path the workspace does not list', async () => {
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: typo-override-workflow',
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
      '      seed: from-the-workflow',
      '',
      'steps:',
      '  - label: echo-step',
      `    plugin: "${DEFAULT_PLUGIN}"`,
      '    operation: value-ops/echo',
      '    inputs:',
      '      value: greeting',
      '    outputs:',
      '      value: echoed',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-seed-override-unlisted',
      'typo-override.workflow.yaml',
      workflowBody,
      // One character out. Under name keying this ran to completion with
      // `from-the-workflow`.
      [
        'seedOverrides:',
        '  workflows/typo-overide.workflow.yaml:',
        '    greeting: from-the-workspace',
      ],
    );

    const result = await runWorkflowInstance(
      workspacePath,
      workflowPath,
      logPath,
      errorLogPath,
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();
    expect(message).toContain(
      'Seed overrides are declared for workflow path ' +
        '"workflows/typo-overide.workflow.yaml", which this workspace does not list.',
    );
    // The authored spelling, what it resolved to, and what IS listed.
    expect(message).toContain('seedOverrides["workflows/typo-overide.workflow.yaml"]');
    expect(message).toContain('typo-overide.workflow.yaml"');
    expect(message).toContain('workflowPathList holds: "workflows/typo-override.workflow.yaml"');
    expect(message).toContain('keyed by workflow PATH');

    // Refused before the run had an identity, tagged as a seed-override
    // failure like every other one.
    const eventList = readEvents(await fs.readFile(logPath, 'utf-8'));
    expect(eventList.map((event) => event.event)).not.toContain('run.start');
    expect(eventList.filter((event) => event.event === 'bootstrap.error')).toMatchObject(
      [{ stage: 'seed-override' }],
    );
  }, 30_000);

  // -------------------------------------------------------------------------
  // `logs.rotate` is not half-configured — the run path's copy of the same
  // check `workflow verify` and `workspace verify` run
  // (`collectLogRotationProblems`, `@rawbox/runner`'s `workspace/logs.ts`).
  // -------------------------------------------------------------------------

  it('refuses the run when the workspace declares a half-configured logs.rotate', async () => {
    const workflowBody = [
      'kind: Workflow',
      'formatVersion: "1.0"',
      'name: log-rotate-workflow',
      '',
      'plugins:',
      `  "${DEFAULT_PLUGIN}": "*"`,
      '',
      'storage:',
      '  defaultStrategy:',
      '    name: lmdb-kv',
      '    valueSizeMax: 1900',
      '',
      'steps: []',
      '',
    ].join('\n');

    const { workspacePath, workflowPath, logPath, errorLogPath } = await writeWorkspace(
      'e2e-log-rotate-bad',
      'log-rotate.workflow.yaml',
      workflowBody,
      ['logs:', '  rotate:', '    maxBytes: 134217728'],
    );

    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();
    expect(message).toContain('Log rotation is half-configured');
    expect(message).toContain('logs.rotate.maxBytes');
    expect(message).toContain('logs.rotate.maxFiles');

    // Refused before the run had an identity: no `run.start`, and tagged
    // `workspace` — this is entirely about the workspace document, unlike a
    // `seed-override` failure, which may involve no document at all
    // (`--seed` alone).
    const eventList = readEvents(await fs.readFile(logPath, 'utf-8'));
    expect(eventList.map((event) => event.event)).not.toContain('run.start');
    expect(eventList.filter((event) => event.event === 'bootstrap.error')).toMatchObject([
      { stage: 'workspace' },
    ]);

    // And nothing was written: no LMDB environment was ever opened.
    const dataDirExists = await fs
      .access(path.join(path.dirname(workspacePath), '.rawbox', 'data'))
      .then(() => true)
      .catch(() => false);
    expect(dataDirExists).toBe(false);
  }, 30_000);
});
