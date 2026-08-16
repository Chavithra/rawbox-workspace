import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

import { createWorkspace } from '../src/commands/workspace/create.js';
import { runWorkflowCommand } from '../src/commands/workflow/run.js';

// ---------------------------------------------------------------------------
// The cross-cutting acceptance test: `run <workflow.yaml>` works as the ONLY
// workflow command, from a freshly scaffolded workspace with **zero** prior
// `workspace verify`, `workflow verify`, `workspace setup` or
// `workflow lock`.
//
//   npx rawbox-cli workspace create --name my-workspace
//   npx rawbox-cli run workspaces/my-workspace/workflows/launch.workflow.yaml
//
// Everything else in this suite (e2e.test.ts, run.test.ts) exercises pieces
// of the chain individually, several of them deliberately running `verify`
// or `setup` first. This file is the one place that proves the two-command
// path the README's Quick Start now leads with actually works standalone —
// discovery, auto-setup, execution, logging and terminal rendering, all from
// one call to `run`.
//
// **What this does not prove**, for the same reason `e2e.test.ts` documents:
// the scaffolded workflow declares `@rawbox/rawbox-plugin-default`, which
// resolves from this monorepo's own hoisted `node_modules` by walking up
// from the workspace directory, regardless of whether anything was ever
// installed into `.rawbox/`. So the plugin specifier is left exactly as
// `workspace create` always emits it — the published registry range
// (`^0.1.0`), never a `file:` one, even here inside the monorepo — and this
// suite asserts the *run* succeeds with zero prior setup — never that an
// install happened. It cannot: there is nothing here for auto-setup to
// install, so no `node_modules/` assertion appears below.
// ---------------------------------------------------------------------------

/**
 * A run's **segment 0** log file: `<run-id>.ndjson`, and not the error log nor
 * a rotated `<run-id>.N.ndjson`.
 *
 * `endsWith('.ndjson') && !endsWith('.error.ndjson')` was enough while one run
 * meant one file. It stopped being enough when the sink started rotating
 * (`@rawbox/runner`'s `LogRotate`): a run past `rotate.maxBytes` also leaves
 * `<run-id>.1.ndjson`, which that filter matches and which is *not* the path
 * the run registry names. No test here comes near the 128 MiB default, so this
 * is a guard rather than a fix — but it is the kind of ambiguity that surfaces
 * as `expect(logFileList.length).toBe(1)` failing in some unrelated later test
 * that sets a small bound.
 */
function isSegmentZeroLogFile(entry: string): boolean {
  return entry.endsWith('.ndjson') && !/\.(?:error|\d+)\.ndjson$/.test(entry);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = path.join(__dirname, 'temp-acceptance');
const originalCwd = process.cwd();

const WORKSPACE_NAME = 'acceptance-ws';
const WORKFLOW_NAME = 'launch';

const workspaceDir = path.join(tempDir, WORKSPACE_NAME);
const workspaceFile = path.join(workspaceDir, 'workspace.yaml');
const workflowFile = path.join(
  workspaceDir,
  'workflows',
  'launch.workflow.yaml',
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureLog(sink: string[]): any {
  return vi.fn((...args: unknown[]) => {
    sink.push(args.map(String).join(' '));
  });
}

/** Strips ANSI colour codes, the way every other test in this suite reads captured text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Parses every non-empty line of an NDJSON log as JSON, failing loudly on a bad line. */
function readEvents(content: string): Array<Record<string, unknown>> {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  process.chdir(tempDir);
  await createWorkspace({ name: WORKSPACE_NAME });
  process.chdir(originalCwd);
}, 60_000);

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('acceptance — scaffold', () => {
  it('produces a runnable workflow declaring the plugin its steps use', async () => {
    // Sanity check that the fixture the rest of this suite runs against is
    // the real scaffold output, not a hand-rolled stand-in for it.
    const content = await fs.readFile(workflowFile, 'utf-8');
    expect(content).toContain('kind: Workflow');
    expect(content).toContain(`name: ${WORKFLOW_NAME}`);
    expect(content).toContain('@rawbox/rawbox-plugin-default');
  });
});

describe('acceptance — run <workflow.yaml> as the ONLY workflow command', () => {
  const messageList: string[] = [];
  const stdoutChunkList: string[] = [];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    vi.spyOn(p.log, 'error').mockImplementation(captureLog(messageList));
    vi.spyOn(p.log, 'warn').mockImplementation(captureLog(messageList));
    vi.spyOn(p.log, 'info').mockImplementation(captureLog(messageList));
    vi.spyOn(p.log, 'step').mockImplementation(captureLog(messageList));
    vi.spyOn(p.log, 'success').mockImplementation(captureLog(messageList));
    // The terminal sink's default `write` is `process.stdout.write` (no hook
    // for a capturing function reaches this far through `WorkflowRunOptions`),
    // so it is spied directly rather than injected — the technique
    // `terminal-sink.test.ts` avoids needing only because it builds the sink
    // itself with an explicit `write:`.
    vi.spyOn(process.stdout, 'write').mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stdoutChunkList.push(String(chunk));
      return true;
    }) as never);

    // `output: 'pretty'` is the one option passed beyond the bare workflow
    // path: it forces the human-narrated renderer regardless of whether this
    // process's stdout is a TTY (it never is, under vitest), which is what
    // lets this same call also stand as the "recap-style output present in
    // pretty mode" assertion below. Everything else — workspace discovery,
    // auto-setup, log destinations — is left to default exactly as a bare
    // `rawbox-cli run workflows/example.workflow.yaml` would leave it: no
    // `--workspace`, no `--log-file`, no prior `workspace setup`/`workflow
    // verify`/`workflow lock` call anywhere in this file.
    await runWorkflowCommand(workflowFile, { output: 'pretty' });
  }, 60_000);

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('exits successfully', () => {
    expect(exitSpy, stripAnsi(messageList.join('\n'))).not.toHaveBeenCalled();
  });

  it('auto-discovers the workspace, with no --workspace passed', () => {
    const text = stripAnsi(messageList.join('\n'));
    expect(text).toContain('Auto-discovered workspace');
    expect(text).toContain(workspaceFile);
  });

  it('creates .rawbox/ next to workspace.yaml, containing logs/', async () => {
    const rawboxDir = path.join(workspaceDir, '.rawbox');
    const rawboxStat = await fs.stat(rawboxDir);
    expect(rawboxStat.isDirectory()).toBe(true);

    const logsDir = path.join(rawboxDir, 'logs', WORKFLOW_NAME);
    const logsStat = await fs.stat(logsDir);
    expect(logsStat.isDirectory()).toBe(true);

    // No assertion on `node_modules/` here, deliberately — see the file
    // header. The declared plugin resolves from this monorepo's own hoisted
    // `node_modules`, so nothing here needed installing and auto-setup never
    // ran; asserting its absence would be just as meaningless as asserting
    // its presence; asserting nothing is the honest option.
  });

  it('prints recap-style output in pretty mode', () => {
    const text = stripAnsi(stdoutChunkList.join(''));
    expect(text).toContain(`WORKFLOW ${WORKFLOW_NAME}`);
    expect(text).toContain(WORKSPACE_NAME);
    expect(text).toContain('✔');
    expect(text).toContain('RECAP');
    // The countdown runs its five steps once per tick (5 × 5), and the fifth
    // branch finally reaches the `liftoff` halt: 26 ok step executions.
    expect(text).toMatch(/ok=26 failed=0 skipped=0/);
    expect(text).toContain('.rawbox');
  });

  it('narrates the countdown: five T-minus ticks, then liftoff', () => {
    const text = stripAnsi(stdoutChunkList.join(''));
    // The workflow's own `observability/log` lines land in the same pretty
    // stream as the runner's step lines — one tick per pass.
    expect(text.match(/\[info\] T-minus/g)?.length).toBe(5);
    expect(text).toContain('🚀 Liftoff!');
  });

  it('writes an NDJSON log whose first line is run.start (format 1) and last is run.end (outcome ok)', async () => {
    const logDir = path.join(workspaceDir, '.rawbox', 'logs', WORKFLOW_NAME);
    const entryList = await fs.readdir(logDir);
    const logFileList = entryList.filter(isSegmentZeroLogFile);
    expect(logFileList.length).toBe(1);

    const logContent = await fs.readFile(
      path.join(logDir, logFileList[0]!),
      'utf-8',
    );

    // Every line parses as JSON — a malformed line fails `readEvents` itself
    // (via `JSON.parse`) rather than being silently skipped.
    const eventList = readEvents(logContent);
    expect(eventList.length).toBeGreaterThan(0);

    expect(eventList[0]).toMatchObject({
      event: 'run.start',
      format: 1,
      workspace: WORKSPACE_NAME,
      workflow: WORKFLOW_NAME,
    });
    expect(eventList.at(-1)).toMatchObject({
      event: 'run.end',
      outcome: 'ok',
    });

    // Every event of the run shares one correlation id.
    const runId = (eventList[0] as { run_id: string }).run_id;
    expect(runId).toMatch(/^run-/);
    expect(eventList.every((event) => event['run_id'] === runId)).toBe(true);
  });
});
