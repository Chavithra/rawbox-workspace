import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yargs from 'yargs';

import { runCommandDefinition } from '../src/commands/workflow/run.js';

// ---------------------------------------------------------------------------
// `workflow run` — how the run-event stream reaches disk and stdout.
//
// Two features share this file because they share one decision (`logs.async`,
// resolved by `@rawbox/runner`'s `resolveLogsConfig`):
//
//   - `--log-async` / `logs.async:` — whether the NDJSON sink buffers.
//   - `--output ndjson` — the same stream on fd 1, through the same writer.
//
// Everything here spawns the built CLI rather than calling
// `runWorkflowCommand` in-process, because both properties are about
// **descriptors**: whether bytes have reached one before the process ends, and
// what lands on fd 1. Neither survives being mocked.
//
// The buffering assertions are timing-based, and deliberately built around a
// signal with no middle state: with the sink opening its descriptor lazily, on
// the first line, the log file *does not exist* until a write actually
// happens. So "buffered" is "the file is still absent while a step is in
// flight", not "the file is shorter than expected".
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rootDir = path.join(__dirname, 'temp-run-log-output-test');
const CLI_ENTRY = path.join(repoRoot, 'packages', 'rawbox-cli', 'dist', 'index.js');

const PLUGIN_PACKAGE = '@rawbox/rawbox-plugin-default';
const PLUGIN_DIR = path.join(repoRoot, 'packages', 'rawbox-plugin-default');

/**
 * How long the fixture's one step sleeps. Long enough that a synchronous sink
 * has unambiguously written `run.start` while the run is still in flight, and
 * that a buffered one has unambiguously not.
 */
const STEP_SLEEP_MS = 4000;

/** How long a short fixture sleeps, where nothing is being timed. */
const QUICK_SLEEP_MS = 1;

interface Scenario {
  directory: string;
  workspacePath: string;
  workflowPath: string;
  logFilePath: string;
  errorLogFilePath: string;
}

function workspaceYaml(name: string, logsBlock: string): string {
  return `${[
    'kind: Workspace',
    `name: ${name}`,
    'workflowPathList:',
    '  - ./workflows/example.workflow.yaml',
    logsBlock,
  ]
    .filter((line) => line.length > 0)
    .join('\n')}\n`;
}

function workflowYaml(name: string, sleepMs: number): string {
  return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    sleep_ms:
      seed: ${sleepMs}
    halt_reason:
      seed: log output test
steps:
  - label: sleep-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: sleep_done_at
    errors:
      message: sleep_error
  - label: done
    plugin: "${PLUGIN_PACKAGE}"
    operation: control-flow/halt
    inputs:
      reason: halt_reason
    errors:
      message: halt_error
`.trim();
}

/** Builds an isolated workspace + workflow, with explicit log paths. */
async function makeScenario(
  name: string,
  options: { logsBlock?: string; sleepMs?: number } = {},
): Promise<Scenario> {
  const directory = path.join(rootDir, name);
  const workflowDir = path.join(directory, 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });

  const workspacePath = path.join(directory, 'workspace.yaml');
  const workflowPath = path.join(workflowDir, 'example.workflow.yaml');

  await fs.writeFile(workspacePath, workspaceYaml(name, options.logsBlock ?? ''), 'utf-8');
  await fs.writeFile(
    workflowPath,
    workflowYaml(name, options.sleepMs ?? QUICK_SLEEP_MS),
    'utf-8',
  );

  return {
    directory,
    workspacePath,
    workflowPath,
    logFilePath: path.join(directory, 'run.ndjson'),
    errorLogFilePath: path.join(directory, 'run.error.ndjson'),
  };
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /**
   * How many **bytes** the log file held at {@link SAMPLE_AT_MS} after the
   * spawn — one instant, deliberately, rather than "at any point before the
   * process exited": the run writes its whole buffered stream a few
   * milliseconds before the process actually goes away, so a continuous poll
   * sees content in *both* modes and proves nothing.
   *
   * Bytes rather than existence, because the sink opens its descriptor on the
   * first line it is *handed*, which creates the file — a buffered sink
   * therefore has an empty file on disk, not no file, while it holds the
   * lines back.
   */
  logBytesAtSample: number;
  /**
   * Whether the child was still running at that instant. Guards the
   * assertion above from degenerating into "the run finished early": if this
   * is `false`, the sample says nothing and the test should fail on it.
   */
  runningAtSample: boolean;
}

/**
 * When the mid-run sample is taken. Comfortably after CLI startup and
 * `run.start`, and comfortably before {@link STEP_SLEEP_MS} elapses.
 */
const SAMPLE_AT_MS = 1500;

/** Spawns the built CLI on a scenario, sampling the log file mid-run. */
function runCli(scenario: Scenario, extraArgs: string[]): Promise<RunResult> {
  const args = [
    CLI_ENTRY,
    'run',
    scenario.workflowPath,
    '--workspace',
    scenario.workspacePath,
    '--log-file',
    scenario.logFilePath,
    '--error-log',
    scenario.errorLogFilePath,
    ...extraArgs,
  ];

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: scenario.directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let logBytesAtSample = 0;
    let runningAtSample = false;
    let running = true;

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    const sample = setTimeout(() => {
      runningAtSample = running;
      logBytesAtSample = fsSync.existsSync(scenario.logFilePath)
        ? fsSync.statSync(scenario.logFilePath).size
        : 0;
    }, SAMPLE_AT_MS);

    child.on('error', (error) => {
      running = false;
      clearTimeout(sample);
      reject(error);
    });
    child.on('close', (code) => {
      running = false;
      clearTimeout(sample);
      resolve({ stdout, stderr, code, logBytesAtSample, runningAtSample });
    });
  });
}

/** The `event` field of every line of an NDJSON file. */
function eventKinds(filePath: string): string[] {
  const text = fsSync.readFileSync(filePath, 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { event: string }).event);
}

beforeAll(async () => {
  await fs.mkdir(rootDir, { recursive: true });
  // The CLI is spawned from `dist/`, which `npm run build:all` produces before
  // `npm run test:all`. Fail loudly rather than mysteriously if it is missing.
  await expect(fs.stat(CLI_ENTRY)).resolves.toBeDefined();
});

afterAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `--log-async` / `logs.async:`
// ---------------------------------------------------------------------------

describe('workflow run — --log-async and logs.async:', () => {
  it(
    'is synchronous when nothing configures it: the log exists while the run is still going',
    { timeout: 60_000 },
    async () => {
      const scenario = await makeScenario('sync-default', { sleepMs: STEP_SLEEP_MS });
      const result = await runCli(scenario, ['--output', 'quiet']);

      expect(result.code, result.stderr).toBe(0);
      expect(result.runningAtSample, 'the sample must land while the step is in flight').toBe(true);
      expect(result.logBytesAtSample).toBeGreaterThan(0);
      expect(eventKinds(scenario.logFilePath)).toContain('run.end');
    },
  );

  it(
    '`logs.async: true` in the workspace document buffers instead',
    { timeout: 60_000 },
    async () => {
      const scenario = await makeScenario('async-document', {
        sleepMs: STEP_SLEEP_MS,
        logsBlock: 'logs:\n  async: true',
      });
      const result = await runCli(scenario, ['--output', 'quiet']);

      expect(result.code, result.stderr).toBe(0);
      expect(result.runningAtSample, 'the sample must land while the step is in flight').toBe(true);
      expect(result.logBytesAtSample).toBe(0);
      // Buffered, but not lost: a run that ends normally has its complete
      // stream on disk, `run.end` included.
      const kinds = eventKinds(scenario.logFilePath);
      expect(kinds[0]).toBe('run.start');
      expect(kinds).toContain('step.start');
      expect(kinds).toContain('step.end');
      expect(kinds[kinds.length - 1]).toBe('run.end');
    },
  );

  it('`--log-async` selects it with no document saying anything', { timeout: 60_000 }, async () => {
    const scenario = await makeScenario('async-flag', { sleepMs: STEP_SLEEP_MS });
    const result = await runCli(scenario, ['--output', 'quiet', '--log-async']);

    expect(result.code, result.stderr).toBe(0);
    expect(result.runningAtSample, 'the sample must land while the step is in flight').toBe(true);
    expect(result.logBytesAtSample).toBe(0);
    expect(eventKinds(scenario.logFilePath)).toContain('run.end');
  });

  it(
    'the flag beats the document: --no-log-async overrides `logs.async: true`',
    { timeout: 60_000 },
    async () => {
      // CLI > workspace.yaml > built-in default (`resolveLogsConfig`), in both
      // directions — not just "the flag can turn it on".
      const scenario = await makeScenario('flag-beats-document', {
        sleepMs: STEP_SLEEP_MS,
        logsBlock: 'logs:\n  async: true',
      });
      const result = await runCli(scenario, ['--output', 'quiet', '--no-log-async']);

      expect(result.code, result.stderr).toBe(0);
      expect(result.runningAtSample, 'the sample must land while the step is in flight').toBe(true);
      expect(result.logBytesAtSample).toBeGreaterThan(0);
      expect(eventKinds(scenario.logFilePath)).toContain('run.end');
    },
  );
});

// ---------------------------------------------------------------------------
// `--output ndjson`
// ---------------------------------------------------------------------------

describe('workflow run — --output ndjson', () => {
  it('puts the stream on stdout, line for line with the log file', { timeout: 60_000 }, async () => {
    const scenario = await makeScenario('output-ndjson');
    const result = await runCli(scenario, ['--output', 'ndjson']);

    expect(result.code, result.stderr).toBe(0);

    const fileText = fsSync.readFileSync(scenario.logFilePath, 'utf-8');
    // stdout carries the event stream and nothing else — every other line the
    // CLI prints goes through clack/stderr, which is what makes this pipeable.
    expect(result.stdout).toBe(fileText);
    expect(eventKinds(scenario.logFilePath)).toContain('run.end');
  });

  it('keeps the file sinks alive alongside it — stdout is a fan-out', { timeout: 60_000 }, async () => {
    const scenario = await makeScenario('output-ndjson-files');
    const result = await runCli(scenario, ['--output', 'ndjson']);

    expect(result.code, result.stderr).toBe(0);
    expect(fsSync.existsSync(scenario.logFilePath)).toBe(true);
    // A clean run still leaves no error log, exactly as without the flag.
    expect(fsSync.existsSync(scenario.errorLogFilePath)).toBe(false);
  });

  it('`json` is the same shape under its older spelling', { timeout: 60_000 }, async () => {
    const scenario = await makeScenario('output-json-alias');
    const result = await runCli(scenario, ['--output', 'json']);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(fsSync.readFileSync(scenario.logFilePath, 'utf-8'));
  });

  it('still lands the complete stream on stdout with --log-async', { timeout: 60_000 }, async () => {
    // The buffered fd-1 destination is flushed by the sink's `close()` hook,
    // which `runWorkflowInstance` awaits before returning — and therefore
    // before any `process.exit()` this command reaches.
    const scenario = await makeScenario('output-ndjson-async');
    const result = await runCli(scenario, ['--output', 'ndjson', '--log-async']);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(fsSync.readFileSync(scenario.logFilePath, 'utf-8'));
    const kinds = result.stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { event: string }).event);
    expect(kinds[kinds.length - 1]).toBe('run.end');
  });
});

// ---------------------------------------------------------------------------
// yargs wiring
// ---------------------------------------------------------------------------

describe('workflow run — --log-async yargs wiring', () => {
  async function parse(args: string[]): Promise<Record<string, unknown>> {
    let seen: Record<string, unknown> = {};
    const parser = yargs(args)
      .exitProcess(false)
      .command('run <workflow-path>', 'run', runCommandDefinition.builder, async (argv) => {
        seen = argv as unknown as Record<string, unknown>;
      });
    await parser.parseAsync();
    return seen;
  }

  it('is a tri-state: --log-async, --no-log-async, or absent', async () => {
    expect((await parse(['run', 'wf.yaml', '--log-async']))['log-async']).toBe(true);
    expect((await parse(['run', 'wf.yaml', '--no-log-async']))['log-async']).toBe(false);
    // Absent means "defer to the workspace document", not "false" — which is
    // what lets `logs.async: true` be honoured at all.
    expect((await parse(['run', 'wf.yaml']))['log-async']).toBeUndefined();
  });

  it('accepts ndjson as an --output choice alongside the existing three', async () => {
    expect((await parse(['run', 'wf.yaml', '--output', 'ndjson']))['output']).toBe('ndjson');
    expect((await parse(['run', 'wf.yaml', '--output', 'json']))['output']).toBe('json');
    expect((await parse(['run', 'wf.yaml', '--output', 'pretty']))['output']).toBe('pretty');
    expect((await parse(['run', 'wf.yaml', '--output', 'quiet']))['output']).toBe('quiet');
  });
});
