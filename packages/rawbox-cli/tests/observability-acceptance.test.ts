import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// The composite observability scenario every release must satisfy, mirroring
// the field case that motivated the work. This file is the reference
// implementation of it:
//
//   "start a multi-workflow workspace, then from a separate terminal —
//   without reading a raw NDJSON file — answer which workflows are live,
//   what each is doing, what every storage key currently holds, and what
//   the last error was; then SIGKILL one run and see it reported as
//   `crashed` rather than silently absent."
//
// This is that scenario, at three workflows (enough to prove the
// multi-workflow join without inflating CI time) and driven as REAL
// `rawbox-cli` child processes — the "separate terminal" is this test,
// spawning the built `dist/index.js` exactly as a human would and reading
// only its stdout, never a workspace's `.rawbox/logs/**/*.ndjson` file
// directly.
//
// Every workflow is the canonical loop idiom
// (packages/rawbox-plugin-default/README.md, "Canonical Loop Pattern"): `time/workflow-throttle` +
// `value-ops/increment` + a control-flow step that jumps back. Two
// (`loop-a`, `loop-fifo`) use `loop-gate` and a small `loop_max`, so they
// halt themselves — stopping two workflows cleanly via `loop-gate` needs
// no external stop command. The third
// (`loop-heartbeat`) uses a bare `jump` with no exit condition, wired behind
// a long `time/sleep` step: it never halts on its own, which is exactly what
// "SIGKILL the remaining process" needs, and the long sleep is what gives
// `run.heartbeat` something to report.
//
// The plugin is installed via one explicit `workspace setup` before any
// workflow is spawned — still good practice, since it means none of the
// three has to wait on auto-setup before this suite's own timing-sensitive
// assertions (the heartbeat window, the loop-gate halt) start running. It is
// no longer a race workaround, though: concurrent auto-setup against one
// target folder is now guarded by an exclusive per-target-folder lock
// (`commands/workflow/setup-lock.ts`/`auto-setup.ts`) — see
// `auto-setup-race.test.ts` for the scenario this fixed, three real
// concurrent `run` processes sharing one *uninstalled* workspace.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const CLI_ENTRY = path.join(repoRoot, 'packages', 'rawbox-cli', 'dist', 'index.js');
const PLUGIN_PACKAGE = '@rawbox/rawbox-plugin-default';
const PLUGIN_DIR = path.join(repoRoot, 'packages', 'rawbox-plugin-default');

const tempDir = path.join(__dirname, 'temp-observability-acceptance');
const workspaceDir = path.join(tempDir, 'obs-ws');
const workspaceFile = path.join(workspaceDir, 'workspace.yaml');
const workflowsDir = path.join(workspaceDir, 'workflows');

const workflowFileA = path.join(workflowsDir, 'loop-a.workflow.yaml');
const workflowFileFifo = path.join(workflowsDir, 'loop-fifo.workflow.yaml');
const workflowFileHeartbeat = path.join(workflowsDir, 'loop-heartbeat.workflow.yaml');

// ---------------------------------------------------------------------------
// Fixture documents
// ---------------------------------------------------------------------------

const WORKSPACE_YAML = `
kind: Workspace
name: obs-acceptance
workflowPathList:
  - ./workflows/loop-a.workflow.yaml
  - ./workflows/loop-fifo.workflow.yaml
  - ./workflows/loop-heartbeat.workflow.yaml
`.trim();

/** throttle + increment + loop-gate, no side keys. Halts itself after 8 iterations (~2.4s). */
const LOOP_A_YAML = `
kind: Workflow
formatVersion: "1.0"
name: loop-a
description: "Acceptance fixture: throttle + increment + loop-gate."

plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"

storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    throttle_ms:
      seed: 300
    loop_counter:
      seed: 0
    loop_max:
      seed: 8
    loop_label:
      seed: throttle-step
    exit_label:
      seed: "__EXIT__"

steps:
  - label: throttle-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: time/workflow-throttle
    inputs:
      ms: throttle_ms
    outputs:
      timestamp: throttle_ts
      throttledMs: throttled_ms
    errors:
      message: throttle_error

  - label: increment-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: value-ops/increment
    inputs:
      value: loop_counter
    outputs:
      value: loop_counter
    errors:
      message: increment_error

  - label: loop-gate-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: control-flow/loop-gate
    inputs:
      counter: loop_counter
      max: loop_max
      loopLabel: loop_label
      exitLabel: exit_label
    errors:
      message: loop_gate_error
`.trim();

/** Same loop idiom, plus an `lmdb-fifo` key appended to once per iteration via `value-ops/echo`. */
const LOOP_FIFO_YAML = `
kind: Workflow
formatVersion: "1.0"
name: loop-fifo
description: "Acceptance fixture: throttle + increment + loop-gate, with a FIFO history key."

plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"

storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    history_queue:
      strategy:
        name: lmdb-fifo
        queueSizeMax: 32
        valueSizeMax: 1900
      seed: []
    throttle_ms:
      seed: 300
    loop_counter:
      seed: 0
    loop_max:
      seed: 8
    loop_label:
      seed: throttle-step
    exit_label:
      seed: "__EXIT__"

steps:
  - label: throttle-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: time/workflow-throttle
    inputs:
      ms: throttle_ms
    outputs:
      timestamp: throttle_ts
      throttledMs: throttled_ms
    errors:
      message: throttle_error

  - label: increment-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: value-ops/increment
    inputs:
      value: loop_counter
    outputs:
      value: loop_counter
    errors:
      message: increment_error

  - label: record-history-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: value-ops/echo
    inputs:
      value: loop_counter
    outputs:
      value: history_queue
    errors:
      message: record_history_error

  - label: loop-gate-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: control-flow/loop-gate
    inputs:
      counter: loop_counter
      max: loop_max
      loopLabel: loop_label
      exitLabel: exit_label
    errors:
      message: loop_gate_error
`.trim();

/**
 * throttle + increment + a long `time/sleep` + an unconditional `jump` back
 * to the top — no loop-gate, so this workflow never halts on its own. The
 * long sleep (15s, far longer than this whole test) is what
 * `run.heartbeat`/`workspace status` has something to report on, and the
 * missing exit condition is what makes SIGKILL the only way to stop it.
 */
const LOOP_HEARTBEAT_YAML = `
kind: Workflow
formatVersion: "1.0"
name: loop-heartbeat
description: "Acceptance fixture: throttle + increment + a long sleep + unconditional jump."

plugins:
  "${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"

storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    throttle_ms:
      seed: 200
    loop_counter:
      seed: 0
    sleep_ms:
      seed: 15000
    jump_condition:
      seed: true
    jump_label:
      seed: throttle-step

steps:
  - label: throttle-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: time/workflow-throttle
    inputs:
      ms: throttle_ms
    outputs:
      timestamp: throttle_ts
      throttledMs: throttled_ms
    errors:
      message: throttle_error

  - label: increment-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: value-ops/increment
    inputs:
      value: loop_counter
    outputs:
      value: loop_counter
    errors:
      message: increment_error

  - label: sleep-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: sleep_done_at
    errors:
      message: sleep_error

  - label: jump-step
    plugin: "${PLUGIN_PACKAGE}"
    operation: control-flow/jump
    inputs:
      condition: jump_condition
      label: jump_label
    errors:
      message: jump_error
`.trim();

// ---------------------------------------------------------------------------
// Process/CLI helpers
// ---------------------------------------------------------------------------

interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Runs the real BUILT CLI as a one-shot child process and waits for it to exit. */
function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: tempDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

/** Parses a one-shot `--output json` command's stdout, failing loudly (with stderr) if it isn't JSON. */
function parseJson<T>(result: CliResult): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new Error(
      `expected JSON on stdout, got:\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n(${String(error)})`,
      { cause: error },
    );
  }
}

/** Spawns a real, long-running `rawbox-cli run` child process against the shared workspace. */
function spawnWorkflow(workflowFile: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      CLI_ENTRY,
      'run',
      workflowFile,
      '--workspace',
      workspaceFile,
      '--output',
      'quiet',
      '--heartbeat',
      '300',
      // The plugin is already installed by the explicit `workspace setup`
      // call in `beforeAll`, so this has nothing to do — kept anyway (still
      // good practice) purely to keep these three processes' start times
      // free of any auto-setup lock/pre-check latency, which would otherwise
      // add uncontrolled jitter to this suite's own timing-sensitive
      // assertions. Concurrent auto-setup itself is no longer a race a test
      // needs to work around; see `auto-setup-race.test.ts`.
      '--no-setup',
    ],
    { cwd: tempDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // Drain stdout/stderr so a full pipe buffer can never stall the child —
  // `--output quiet` writes little, but this must never depend on that.
  child.stdout?.resume();
  child.stderr?.resume();
  return child;
}

/** Resolves immediately if `child` has already exited, otherwise waits for its `exit` event. */
function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

/** Polls `check` until it returns a defined value, or throws after `timeoutMs`. */
async function waitFor<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await check();
    if (last !== undefined) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms (last observed: ${JSON.stringify(last)})`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------

interface RegistryRow {
  run_id: string;
  workflow: string;
  pid: number;
  displayStatus: string;
}

async function runsListJson(): Promise<RegistryRow[]> {
  return parseJson<RegistryRow[]>(await runCli(['runs', 'list', workspaceFile, '--output', 'json']));
}

let childA: ChildProcess;
let childFifo: ChildProcess;
let childHeartbeat: ChildProcess;

describe('observability acceptance — a multi-workflow workspace inspected from outside', () => {
  beforeAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(workflowsDir, { recursive: true });

    await fs.writeFile(workspaceFile, WORKSPACE_YAML, 'utf-8');
    await fs.writeFile(workflowFileA, LOOP_A_YAML, 'utf-8');
    await fs.writeFile(workflowFileFifo, LOOP_FIFO_YAML, 'utf-8');
    await fs.writeFile(workflowFileHeartbeat, LOOP_HEARTBEAT_YAML, 'utf-8');

    // Sanity: this whole file drives the real BUILT artifact, not in-process
    // command functions — `npm run build:all` must have run first.
    await expect(fs.stat(CLI_ENTRY)).resolves.toBeDefined();

    // Install the plugin exactly once, before any workflow starts, so three
    // concurrently-starting run processes never race auto-setup against the
    // one target folder they share (see the file header).
    const setupResult = await runCli(['workspace', 'setup', workspaceFile]);
    expect(setupResult.code, setupResult.stderr).toBe(0);

    childA = spawnWorkflow(workflowFileA);
    childFifo = spawnWorkflow(workflowFileFifo);
    childHeartbeat = spawnWorkflow(workflowFileHeartbeat);
  }, 60_000);

  afterAll(async () => {
    for (const child of [childA, childFifo, childHeartbeat]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------

  describe('1. `runs list` shows all three running, with verified pids', () => {
    let rows: RegistryRow[];

    beforeAll(async () => {
      rows = await waitFor(async () => {
        const list = await runsListJson();
        return list.filter((row) => row.displayStatus === 'running').length === 3 ? list : undefined;
      }, 10_000);
    }, 15_000);

    it('reports exactly three runs, all "running"', () => {
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.displayStatus === 'running')).toBe(true);
    });

    it('each entry\'s pid is the real spawned child process, not a placeholder', () => {
      const byWorkflow = Object.fromEntries(rows.map((row) => [row.workflow, row]));
      expect(byWorkflow['loop-a']?.pid).toBe(childA.pid);
      expect(byWorkflow['loop-fifo']?.pid).toBe(childFifo.pid);
      expect(byWorkflow['loop-heartbeat']?.pid).toBe(childHeartbeat.pid);
    });
  });

  // -------------------------------------------------------------------------

  describe('2. `workspace status --output json` answers what each workflow is doing', () => {
    it('reports the sleeping workflow "in sleep-step for <duration>", via the heartbeat', async () => {
      interface StatusWorkflow {
        workflowName: string;
        latestRun?: {
          displayStatus: string;
          heartbeat?: { stepLabel: string; inFlightMs: number };
        };
      }
      interface StatusSnapshot {
        workflowList: StatusWorkflow[];
      }

      const heartbeatRun = await waitFor(async () => {
        const snapshot = parseJson<StatusSnapshot>(
          await runCli(['workspace', 'status', workspaceDir, '--output', 'json']),
        );
        const workflow = snapshot.workflowList.find((entry) => entry.workflowName === 'loop-heartbeat');
        return workflow?.latestRun?.heartbeat !== undefined ? workflow.latestRun : undefined;
      }, 10_000);

      expect(heartbeatRun.displayStatus).toBe('running');
      expect(heartbeatRun.heartbeat?.stepLabel).toBe('sleep-step');
      expect(heartbeatRun.heartbeat?.inFlightMs).toBeGreaterThan(0);

      // And the same information, in the text render a human would actually read.
      const textResult = await runCli(['workspace', 'status', workspaceDir]);
      expect(textResult.stdout).toContain('in sleep-step for');
    });
  });

  // -------------------------------------------------------------------------

  describe('3. loop-a and loop-fifo halt cleanly via loop-gate (no stop command needed)', () => {
    let finishedRows: RegistryRow[];

    beforeAll(async () => {
      finishedRows = await waitFor(async () => {
        const list = await runsListJson();
        const relevant = list.filter((row) => row.workflow === 'loop-a' || row.workflow === 'loop-fifo');
        return relevant.length === 2 && relevant.every((row) => row.displayStatus === 'ok')
          ? relevant
          : undefined;
      }, 20_000);

      // The registry reaches "ok" at `run.end`, just before the process's own
      // event loop drains — wait for the OS-level exit too, not only the file.
      await Promise.all([waitForExit(childA), waitForExit(childFifo)]);
    }, 30_000);

    it('both runs reached "ok"', () => {
      expect(finishedRows.every((row) => row.displayStatus === 'ok')).toBe(true);
    });

    it('both processes exited cleanly (code 0) — a real halt via loop-gate\'s exitLabel, not a kill', () => {
      expect(childA.exitCode).toBe(0);
      expect(childFifo.exitCode).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Store checks run against the two now-finished workflows, deliberately —
  // reading a workflow no longer writing is what lets the FIFO
  // depth-unchanged assertion below be unambiguous (a depth change could
  // otherwise be the workflow's own next enqueue racing the read, not a
  // regression in `store get`'s non-destructiveness).
  // -------------------------------------------------------------------------

  describe('4. `store list`/`store get` — keys, a kv read, and a non-destructive FIFO peek', () => {
    interface StoreRow {
      key: string;
      workflow: string;
      strategy: string;
      fifo?: { depth: number; capacity?: number };
    }

    it('`store list --output json` shows keys from both workflows, including the FIFO', async () => {
      const rows = parseJson<StoreRow[]>(
        await runCli(['store', 'list', workspaceDir, '--output', 'json']),
      );

      expect(rows.some((row) => row.key === 'loop_counter' && row.workflow === 'loop-a')).toBe(true);
      const fifoRow = rows.find((row) => row.key === 'history_queue' && row.workflow === 'loop-fifo');
      expect(fifoRow?.strategy).toBe('lmdb-fifo');
      // 8 iterations, well inside the 31-entry capacity (queueSizeMax 32) — no wrap.
      expect(fifoRow?.fifo?.depth).toBe(8);
    });

    it('`store get` reads a kv value', async () => {
      const [result] = parseJson<Array<{ value: unknown }>>(
        await runCli(['store', 'get', workspaceDir, 'loop-a', 'loop_counter', '--output', 'json']),
      );
      expect(result?.value).toBe(8);
    });

    it('`store get` peeks the FIFO oldest-first, leaving its depth unchanged across repeated reads', async () => {
      const before = parseJson<StoreRow[]>(
        await runCli(['store', 'list', workspaceDir, '--workflow', 'loop-fifo', '--output', 'json']),
      );
      const depthBefore = before.find((row) => row.key === 'history_queue')?.fifo?.depth;
      expect(depthBefore).toBe(8);

      let lastElements: unknown[] | undefined;
      for (let i = 0; i < 3; i++) {
        const [result] = parseJson<Array<{ elements?: unknown[] }>>(
          await runCli(['store', 'get', workspaceDir, 'loop-fifo', 'history_queue', '--output', 'json']),
        );
        lastElements = result?.elements;
      }

      // `increment-step` runs before `record-history-step` each iteration, so
      // the queue holds 1..8 (never the seeded 0) — oldest (index 0) first.
      expect(lastElements).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

      const after = parseJson<StoreRow[]>(
        await runCli(['store', 'list', workspaceDir, '--workflow', 'loop-fifo', '--output', 'json']),
      );
      const depthAfter = after.find((row) => row.key === 'history_queue')?.fifo?.depth;
      expect(depthAfter).toBe(depthBefore);
    });
  });

  // -------------------------------------------------------------------------

  describe('5. `workspace logs --run <id1> <id2> --output json` merges the two finished runs', () => {
    interface MergedLine {
      run_id: string;
      event: string;
      ts: string;
    }

    let mergedLines: MergedLine[];
    let runIdA: string;
    let runIdFifo: string;

    beforeAll(async () => {
      const list = await runsListJson();
      runIdA = list.find((row) => row.workflow === 'loop-a')!.run_id;
      runIdFifo = list.find((row) => row.workflow === 'loop-fifo')!.run_id;

      const result = await runCli([
        'workspace',
        'logs',
        workspaceDir,
        '--run',
        runIdA,
        '--run',
        runIdFifo,
        '--output',
        'json',
      ]);
      expect(result.code, result.stderr).toBe(0);

      mergedLines = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as MergedLine);
    }, 20_000);

    it('includes events from both finished runs, each starting and ending', () => {
      const forRun = (runId: string): string[] =>
        mergedLines.filter((line) => line.run_id === runId).map((line) => line.event);

      expect(forRun(runIdA)).toContain('run.start');
      expect(forRun(runIdA)).toContain('run.end');
      expect(forRun(runIdFifo)).toContain('run.start');
      expect(forRun(runIdFifo)).toContain('run.end');
    });

    it('is sorted in non-decreasing GLOBAL timestamp order across both runs', () => {
      expect(mergedLines.length).toBeGreaterThan(0);
      const tsMsList = mergedLines.map((line) => Date.parse(line.ts));
      for (let i = 1; i < tsMsList.length; i++) {
        expect(tsMsList[i]).toBeGreaterThanOrEqual(tsMsList[i - 1]!);
      }
    });
  });

  // -------------------------------------------------------------------------

  describe('6. SIGKILL the remaining process — `runs list` reports it "crashed"', () => {
    beforeAll(async () => {
      expect(childHeartbeat.exitCode, 'loop-heartbeat should still be alive right before the kill').toBe(
        null,
      );
      childHeartbeat.kill('SIGKILL');
      const code = await waitForExit(childHeartbeat);
      expect(code).toBeNull();
      expect(childHeartbeat.signalCode).toBe('SIGKILL');
    }, 10_000);

    it('is neither "running" nor absent — `runs list` reports it "crashed"', async () => {
      const entry = await waitFor(async () => {
        const list = await runsListJson();
        const row = list.find((r) => r.workflow === 'loop-heartbeat');
        return row !== undefined && row.displayStatus === 'crashed' ? row : undefined;
      }, 10_000);

      expect(entry).toBeDefined();
      expect(entry.displayStatus).toBe('crashed');
      expect(entry.displayStatus).not.toBe('running');
    });
  });

  // -------------------------------------------------------------------------

  describe('7. SIGTERM a fresh run — graceful shutdown, registry "interrupted", exit 143', () => {
    // The counterpart to block 6, and the other half of the graceful-shutdown
    // vs. crash obligation: SIGTERM (the way an operator or a supervisor
    // actually stops a run-forever workflow) produces the terminal
    // `interrupted` status — an honest record, deliberately distinguishable
    // from the `crashed` a SIGKILL leaves. A fresh loop-heartbeat run is
    // spawned for it: the previous one was SIGKILLed in block 6, and both
    // rows stay visible side by side, `crashed` next to `interrupted`.
    let childInterrupt: ChildProcess;
    let interruptedRow: RegistryRow;

    beforeAll(async () => {
      childInterrupt = spawnWorkflow(workflowFileHeartbeat);

      // Wait until the new run is genuinely live (its pid verified by the
      // registry's own liveness rule) before stopping it — the point is to
      // interrupt a *running* workflow, not a bootstrapping one.
      interruptedRow = await waitFor(async () => {
        const list = await runsListJson();
        return list.find(
          (r) =>
            r.workflow === 'loop-heartbeat' &&
            r.pid === childInterrupt.pid &&
            r.displayStatus === 'running',
        );
      }, 30_000);

      childInterrupt.kill('SIGTERM');
    }, 60_000);

    afterAll(() => {
      if (childInterrupt && childInterrupt.exitCode === null && childInterrupt.signalCode === null) {
        childInterrupt.kill('SIGKILL');
      }
    });

    it('the process exits by itself with code 143 (128+SIGTERM) — a handled signal, not a kill', async () => {
      const code = await waitForExit(childInterrupt);
      expect(code).toBe(143);
      // Exited, not terminated: the signal was caught and turned into a
      // graceful conclusion, so no signalCode is set.
      expect(childInterrupt.signalCode).toBeNull();
    }, 15_000);

    it('`runs list` reports the run "interrupted" — terminal, never "crashed"', async () => {
      const row = await waitFor(async () => {
        const list = await runsListJson();
        const found = list.find((r) => r.run_id === interruptedRow.run_id);
        return found !== undefined && found.displayStatus !== 'running' ? found : undefined;
      }, 10_000);

      expect(row.displayStatus).toBe('interrupted');
    });

    it('the SIGKILLed run of block 6 still reads "crashed" beside it — the two stay distinguishable', async () => {
      const list = await runsListJson();
      const statuses = list
        .filter((r) => r.workflow === 'loop-heartbeat')
        .map((r) => r.displayStatus)
        .sort();
      expect(statuses).toEqual(['crashed', 'interrupted']);
    });
  });
});
