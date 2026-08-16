import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as p from '@clack/prompts';
import YAML from 'yaml';

import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import {
  budgetForStorage,
  measureValueSize,
  type BoxStorage,
  type BoxStrategy,
  type StorageBudget,
} from '@rawbox/store';
import { setupWorkspace, runWorkflowInstance, type RunEvent } from '@rawbox/runner';

import { createWorkspace } from '../src/commands/workspace/create.js';
import { verifyWorkflow } from '../src/commands/workflow/verify.js';
import { verifyWorkspace } from '../src/commands/workspace/verify.js';
import { lockWorkflow } from '../src/commands/workflow/lock.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const tempDir = path.join(__dirname, 'temp-e2e');
const originalCwd = process.cwd();

// ---------------------------------------------------------------------------
// The whole chain, end to end: scaffold -> setup -> lock -> verify -> run.
//
// This is the first point at which the whole chain is exercised together, so a
// failure here is an integration defect until proven otherwise, not a test bug.
//
// One honest limitation, stated because a reader would otherwise assume this
// file proves more than it does:
//
// **This file cannot prove the run consumed what `setup` installed.** The
// scaffolded workflow declares `@rawbox/rawbox-plugin-default`, which resolves
// from this monorepo's own hoisted `node_modules` by walking up from the
// workspace directory — so it would resolve whether or not the target folder
// were on the resolution path at all. The setup assertions here therefore check
// setup's *output* directly, and this case deliberately passes a target folder
// that the workspace does not declare, leaving the two unconnected.
//
// The connection between them is the subject of its own file:
// `packages/rawbox-runner/tests/target-folder.test.ts` builds a plugin package
// that exists nowhere but the target folder, and runs it from an unrelated cwd.
// That is the acceptance case for `targetFolder:`; do not try to reproduce it
// here with the default plugin, because it cannot fail.
//
// What this file proves is everything else: that a scaffolded document
// locks, verifies, executes, and persists its outputs, and that a tampered lock
// stops the run.
// ---------------------------------------------------------------------------

/** The plugin package a scaffolded workspace declares. */
const PLUGIN_PACKAGE = '@rawbox/rawbox-plugin-default';

/** Where the real built plugin lives, for a `file:` specifier npm can install. */
const PLUGIN_DIR = path.join(repoRoot, 'packages', 'rawbox-plugin-default');

/**
 * `storage.defaultStrategy` the scaffolder emits — needed to read boxes back.
 * Must track `workspace/create.ts`'s template: it is the shipped default, 1900.
 */
const KV_STRATEGY = { name: 'lmdb-kv' as const, valueSizeMax: 1900 };

const WORKSPACE_NAME = 'e2e-ws';
const WORKFLOW_NAME = 'launch';

const workspaceDir = path.join(tempDir, WORKSPACE_NAME);
const workspaceFile = path.join(workspaceDir, 'workspace.yaml');
const workflowFile = path.join(
  workspaceDir,
  'workflows',
  'launch.workflow.yaml',
);
const targetDir = path.join(tempDir, 'target');
const lockFile = path.join(workspaceDir, 'rawbox.lock');

/** Contents of the scaffolded workflow, captured before anything reads it. */
let scaffoldedWorkflow: string;

// --- reporting harness (same shape as verify.test.ts) ----------------------

let messageList: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureLog(): any {
  return vi.fn((...args: unknown[]) => {
    messageList.push(args.map(String).join(' '));
  });
}

beforeEach(() => {
  messageList = [];
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation(captureLog());
  vi.spyOn(p.log, 'warn').mockImplementation(captureLog());
  vi.spyOn(p.log, 'info').mockImplementation(captureLog());
  vi.spyOn(p.log, 'step').mockImplementation(captureLog());
  vi.spyOn(p.log, 'success').mockImplementation(captureLog());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function reported(): string {
  return messageList.join('\n').replace(/\[[0-9;]*m/g, '');
}

function expectPassed(): void {
  expect(exitSpy, reported()).not.toHaveBeenCalled();
}

/** Parses a run log — NDJSON, one typed run event per line. */
function readRunEvents(logContent: string): RunEvent[] {
  return logContent
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as RunEvent);
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  await fs.mkdir(tempDir, { recursive: true });

  process.chdir(tempDir);
  await createWorkspace({ name: WORKSPACE_NAME });
  process.chdir(originalCwd);

  // The scaffolder always emits the published registry range (`^0.1.0`), even
  // when run inside this monorepo — but this test needs `npm install` to
  // actually resolve the plugin without contacting the (irrelevant here)
  // Verdaccio registry it is published to, so it rewrites the specifier to an
  // absolute `file:` one pointing at the real built plugin. That is not what
  // the scaffold emits by default; it is this test standing in for a
  // registry install.
  //
  // Nothing else in the generated document is touched.
  const generated = await fs.readFile(workflowFile, 'utf-8');
  scaffoldedWorkflow = generated.replace(
    `"${PLUGIN_PACKAGE}": "^0.1.0"`,
    `"${PLUGIN_PACKAGE}": "file:${PLUGIN_DIR}"`,
  );
  expect(
    scaffoldedWorkflow,
    'scaffolded specifier was not in the expected form',
  ).not.toBe(generated);
  await fs.writeFile(workflowFile, scaffoldedWorkflow, 'utf-8');
}, 120_000);

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('e2e — scaffold', () => {
  it('produces a workflow declaring the plugin its steps use', async () => {
    const parsed = YAML.parse(scaffoldedWorkflow);

    expect(parsed.kind).toBe('Workflow');
    expect(parsed.formatVersion).toBe('1.0');
    expect(parsed.name).toBe(WORKFLOW_NAME);
    for (const step of parsed.steps) {
      expect(Object.keys(parsed.plugins)).toContain(step.plugin);
    }
  });
});

describe('e2e — setup', () => {
  it('installs the declared plugin into the target folder', async () => {
    const result = await setupWorkspace(workspaceFile, targetDir);
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);

    const generatedPackageJson = JSON.parse(
      await fs.readFile(path.join(targetDir, 'package.json'), 'utf-8'),
    );

    // npm resolves a relative `file:` specifier against the generated
    // package.json, not the workflow that declared it, so setup must hand npm
    // an absolute path. This one is already absolute and must survive
    // untouched.
    expect(generatedPackageJson.dependencies[PLUGIN_PACKAGE]).toBe(
      `file:${PLUGIN_DIR}`,
    );

    // And npm actually installed it, rather than setup merely writing a manifest.
    const installed = path.join(targetDir, 'node_modules', PLUGIN_PACKAGE);
    expect(await fs.stat(installed)).toBeDefined();
  }, 300_000);
});

describe('e2e — lock', () => {
  it('writes rawbox.lock without modifying the workflow file', async () => {
    await lockWorkflow(workflowFile);
    expectPassed();

    const lock = YAML.parse(await fs.readFile(lockFile, 'utf-8'));
    expect(lock.version).toBe('1');

    const entry = lock.plugins[PLUGIN_PACKAGE];
    expect(entry, 'no lock entry for the declared plugin').toBeDefined();
    expect(entry.resolved).toMatch(/^\d+\.\d+\.\d+/);
    expect(entry.registryHash).toMatch(/^[0-9a-f]{64}$/);

    // The whole point of a separate lock file: a registry hash is a property
    // of a *package*, not of a workflow, so it does not belong in a workflow.
    // Keeping it out means the authored file stays pure `name: range`
    // permanently — locking never rewrites a document an assistant has just
    // produced, and re-reading it never surfaces a shape its author did not
    // write.
    expect(await fs.readFile(workflowFile, 'utf-8')).toBe(scaffoldedWorkflow);
  }, 120_000);
});

describe('e2e — verify', () => {
  it('verifies the workspace', async () => {
    process.chdir(workspaceDir);
    await verifyWorkspace('./workspace.yaml');
    process.chdir(originalCwd);

    expectPassed();
  }, 60_000);

  it('verifies the workflow against the lock just written', async () => {
    // Runs after the lock test, so this also covers the lock-agreement path
    // rather than only the unlocked one.
    process.chdir(workspaceDir);
    await verifyWorkflow('./workflows/launch.workflow.yaml');
    process.chdir(originalCwd);

    expectPassed();
    expect(reported()).toContain('Auto-discovered workspace');
  }, 60_000);
});

describe('e2e — run', () => {
  const logFile = path.join(tempDir, 'run-logs.txt');
  const errorLogFile = path.join(tempDir, 'run-errors.txt');

  beforeAll(async () => {
    process.chdir(workspaceDir);
    const result = await runWorkflowInstance(
      workspaceFile,
      workflowFile,
      logFile,
      errorLogFile,
    );
    process.chdir(originalCwd);

    // A run that bails out before executing returns `err`: otherwise a
    // preflight failure is indistinguishable from success.
    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
  }, 120_000);

  it('drives the machine to completion', async () => {
    // The log is NDJSON run events (OBSERVABILITY.md, "The run-event stream"): the first
    // line declares the format, the last one summarises the run.
    const events = readRunEvents(await fs.readFile(logFile, 'utf-8'));

    expect(events.at(0)).toMatchObject({
      event: 'run.start',
      format: 1,
      workspace: WORKSPACE_NAME,
      workflow: WORKFLOW_NAME,
    });
    expect(events.at(-1)).toMatchObject({
      event: 'run.end',
      outcome: 'ok',
      steps_failed: 0,
    });

    // Every event of the run carries the same correlation id — what the OTel
    // bridge maps onto one trace (rawbox-runner README, "The Run-Event Stream").
    const runId = (events[0] as { run_id: string }).run_id;
    expect(runId).toMatch(/^run-/);
    expect(events.every((event) => event.run_id === runId)).toBe(true);
  });

  it('executes the whole countdown, including the control-flow terminator', async () => {
    const stepEnds = readRunEvents(await fs.readFile(logFile, 'utf-8')).filter(
      (event) => event.event === 'step.end',
    );

    // Five countdown passes over steps 0-4 (tick, sleep, count down, compare,
    // branch), and on the fifth pass the branch finally sends execution to the
    // `liftoff` halt at index 5 — 26 step executions in all. `__EXIT__` is the
    // label halt returns, so its presence is evidence the control-flow contract
    // ran and was honoured rather than the run simply falling off the end.
    expect(stepEnds.map((event) => event.step.index)).toEqual([
      ...Array.from({ length: 5 }, () => [0, 1, 2, 3, 4]).flat(),
      5,
    ]);
    expect(stepEnds.every((event) => event.outcome === 'ok')).toBe(true);
    expect(stepEnds.at(-1)?.output?.label).toBe('__EXIT__');

    // The branch chose `tick` four times, then `liftoff` — the loop was
    // steered by the control-flow contract, not by the list simply repeating.
    const branchLabels = stepEnds
      .filter((event) => event.step.index === 4)
      .map((event) => event.output?.label);
    expect(branchLabels).toEqual(['tick', 'tick', 'tick', 'tick', 'liftoff']);

    // A step's identity carries what a span needs: the package and operation
    // path from the authored document, plus the iteration that distinguishes
    // repeated executions of one step. The tick step ran five times,
    // so its iterations count up.
    expect(stepEnds[0]?.step).toMatchObject({
      index: 0,
      iteration: 0,
      plugin: PLUGIN_PACKAGE,
    });
    expect(
      stepEnds
        .filter((event) => event.step.index === 0)
        .map((event) => event.step.iteration),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it('logs the countdown: T-minus data 5 -> 1', async () => {
    // The `observability/log` step binds `data:` to the `t_minus` key, so the
    // run's own event stream carries the countdown — one `log` event per tick,
    // reading 5, 4, 3, 2, 1 as the increment step (step: -1) walks it down.
    const logEvents = readRunEvents(await fs.readFile(logFile, 'utf-8'))
      .filter(
        (event): event is Extract<RunEvent, { event: 'log' }> =>
          event.event === 'log',
      )
      .filter((event) => event.message === 'T-minus');
    expect(logEvents.map((event) => event.data)).toEqual([5, 4, 3, 2, 1]);
  });

  it('passes a seeded constant through to the handler', async () => {
    // The scaffolded `halt` step reads its `reason` from the `liftoff_reason`
    // key seeded in the document. That is the whole of how a constant reaches a
    // handler now that `{ value: … }` is gone: a handler's inputs are built
    // from storage reads, so seeing the authored string arrive as the step's
    // input is the end-to-end proof that a seed is a complete substitute for
    // the literal it replaced. `step.start` carries the resolved input record,
    // so the authored string is observable as the value the handler received.
    const stepStarts = readRunEvents(await fs.readFile(logFile, 'utf-8')).filter(
      (event) => event.event === 'step.start',
    );
    expect(stepStarts.map((event) => event.input?.reason)).toContain(
      '🚀 Liftoff!',
    );
  });

  it('persists its outputs to the box store', async () => {
    // The assertion the whole chain exists for. This workspace declares no
    // `targetFolder:`, so `resolveTargetFolder`'s default —
    // `<workspace directory>/.rawbox` — is where the runner puts the LMDB
    // environment (rawbox-cli README, "Workspace Initialization (`workspace setup`)").
    const store = BoxStoreLmdb.create(
      WORKSPACE_NAME,
      pathToFileURL(path.join(workspaceDir, '.rawbox', 'data')),
    );
    const read = (key: string) =>
      store.getSync({
        key,
        workflow: WORKFLOW_NAME,
        workspace: WORKSPACE_NAME,
        strategy: KV_STRATEGY,
      });

    // The seed the document declared.
    const seeded = read('tick_ms');
    expect(seeded.isOk(), seeded.isErr() ? seeded.error : '').toBe(true);
    expect(seeded._unsafeUnwrap()).toBe(500);

    // And the value the step produced — not present before the run.
    const produced = read('tick_at');
    expect(produced.isOk(), produced.isErr() ? produced.error : '').toBe(true);
    expect(typeof produced._unsafeUnwrap()).toBe('number');
    expect(produced._unsafeUnwrap()).toBeGreaterThan(0);

    // `t_minus` is deliberately both seeded (5) and written by the increment
    // step: within the run the writes win, so 0 is what persists — and the
    // seed puts it back to 5 when the next run starts, which is why a seeded
    // key must never be used for state meant to accumulate across runs.
    const counted = read('t_minus');
    expect(counted.isOk(), counted.isErr() ? counted.error : '').toBe(true);
    expect(counted._unsafeUnwrap()).toBe(0);
  });

  it('writes no runner error', async () => {
    // The error log is a filtered view of the same stream: every `bootstrap.error`
    // and every `outcome: "error"` event, and nothing else. A clean run leaves it
    // empty rather than merely free of some string.
    const errorLog = await fs
      .readFile(errorLogFile, 'utf-8')
      .catch(() => '');
    expect(readRunEvents(errorLog)).toEqual([]);
  });
});

describe('e2e — lock integrity on the run path', () => {
  it('refuses to run when rawbox.lock disagrees with what is installed', async () => {
    const original = await fs.readFile(lockFile, 'utf-8');
    const lock = YAML.parse(original);
    lock.plugins[PLUGIN_PACKAGE].registryHash = 'f'.repeat(64);
    await fs.writeFile(lockFile, YAML.stringify(lock), 'utf-8');

    try {
      process.chdir(workspaceDir);
      const result = await runWorkflowInstance(
        workspaceFile,
        workflowFile,
        path.join(tempDir, 'mismatch-logs.txt'),
        path.join(tempDir, 'mismatch-errors.txt'),
      );
      process.chdir(originalCwd);

      // A present-and-mismatched lock is a hard error, because every step
      // referencing the package is bound to a registry that no longer exists.
      // A run that proceeded here would silently execute different code than
      // was locked.
      expect(result.isErr()).toBe(true);
      const message = result.isErr() ? result.error : '';
      expect(message).toContain(PLUGIN_PACKAGE);
    } finally {
      await fs.writeFile(lockFile, original, 'utf-8');
      process.chdir(originalCwd);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The storage budget, end to end.
//
// What these prove, and what they deliberately do not:
//
// **Nothing refuses a write here, and nothing is meant to.** The budget is a
// provisioning figure: a workflow that stays inside its own declaration must
// fit inside the volume `recommendedVolumeBytes` says to give it. These tests
// validate that claim against a real fill — that the budget formula, its
// headroom factor and its fixed overhead term really do cover the worst case —
// and nothing else. There is no enforcement to test: the store consults no
// budget, and a ceiling on the process is the container runtime's to apply.
// (Not that LMDB could have provided one anyway: lmdb-js vendors a patched
// `mdb.c` whose `mdb_page_alloc` auto-resizes the map whenever the next page
// would run past `mapSize`.)
//
// **The instrument matters.** `db.getBinary()` decompresses transparently, so
// it reports *packed* bytes and can never observe on-disk size — 200 values of
// 5009 packed bytes each report 5009 apiece while `data.mdb` holds the lot in
// 69,632 bytes. Footprint here is read from `getStats()` and from `stat
// data.mdb`, never from a value's own length.
//
// The fills below use **incompressible** random bytes: the worst case the
// budget must cover, and the only case that tests the bound. The last describe
// repeats a fill with highly compressible bytes and records how loose the bound
// gets when compression does its job — which is also the tripwire for a change
// that silently turns compression off.
// ---------------------------------------------------------------------------

/** `env.getStats()` / `db.getStats()` are typed `{}` by lmdb-js; reach in structurally. */
interface StatsCarrier {
  getStats(): {
    pageSize: number;
    lastPageNumber: number;
    treeLeafPageCount: number;
    treeBranchPageCount: number;
    overflowPages: number;
    entryCount: number;
  };
}

const BUDGET_WORKSPACE = 'budget-ws';
const BUDGET_WORKFLOW = 'budget-wf';

/**
 * Content whose **packed** size is exactly `packedSize`, so a fill really does
 * sit at the declared `valueSizeMax` rather than just under it. `measureValueSize`
 * is the same measurement `putSync` applies, so agreement here is not a
 * coincidence to be maintained.
 */
function payloadOfPackedSize(
  packedSize: number,
  kind: 'incompressible' | 'compressible',
): Buffer {
  for (let length = Math.max(0, packedSize - 6); length <= packedSize; length++) {
    const candidate =
      kind === 'incompressible'
        ? crypto.randomBytes(length)
        : Buffer.alloc(length, 0x61);

    if (measureValueSize(candidate)._unsafeUnwrap() === packedSize) {
      return candidate;
    }
  }

  throw new Error(`no ${kind} payload packs to exactly ${packedSize} bytes`);
}

interface FillResult {
  readonly budget: StorageBudget;
  readonly writeCount: number;
  readonly rejectedAt: number | undefined;
  readonly rejection: string | undefined;
  /** High-water mark, `(lastPageNumber + 1) × pageSize`. */
  readonly usedBytes: number;
  /** `stat data.mdb`. */
  readonly fileBytes: number;
  readonly leafPages: number;
  readonly branchPages: number;
  readonly overflowPages: number;
  readonly entryCount: number;
}

/**
 * Declares a `storage:` block, opens an environment under the budget that block
 * computes, and writes every declared slot exactly once — a workflow doing the
 * most its own declaration permits. Returns what the filesystem and `getStats()`
 * say afterwards.
 */
async function fillToBudget(options: {
  readonly label: string;
  readonly keyCount: number;
  readonly valueSizeMax: number;
  readonly kind: 'incompressible' | 'compressible';
  readonly queueSizeMax?: number;
}): Promise<FillResult> {
  const { label, keyCount, valueSizeMax, kind, queueSizeMax } = options;

  const dataDir = path.join(tempDir, 'budget', label);
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(dataDir, { recursive: true });

  const strategy: BoxStrategy =
    queueSizeMax === undefined
      ? { name: 'lmdb-kv', valueSizeMax }
      : { name: 'lmdb-fifo', valueSizeMax, queueSizeMax };

  const strategies: Record<string, BoxStrategy> = {};
  for (let i = 0; i < keyCount; i++) {
    strategies[`key${i}`] = strategy;
  }

  const storage: BoxStorage = { defaultStrategy: strategy, strategies };
  const budget = budgetForStorage(storage);

  const store = BoxStoreLmdb.create(BUDGET_WORKSPACE, pathToFileURL(`${dataDir}/`));

  const content = payloadOfPackedSize(valueSizeMax, kind);
  // One write per declared slot: `lmdb-kv` is one entry, `lmdb-fifo` is the
  // `queueSizeMax - 1` slots the budget charges for (one is reserved).
  const writesPerKey = queueSizeMax === undefined ? 1 : queueSizeMax - 1;

  let writeCount = 0;
  let rejectedAt: number | undefined;
  let rejection: string | undefined;

  outer: for (let i = 0; i < keyCount; i++) {
    for (let slot = 0; slot < writesPerKey; slot++) {
      const result = store.putSync({
        content,
        location: {
          key: `key${i}`,
          workflow: BUDGET_WORKFLOW,
          workspace: BUDGET_WORKSPACE,
          strategy,
        },
      });

      if (result.isErr()) {
        rejectedAt = writeCount;
        rejection = result.error;
        break outer;
      }

      writeCount++;
    }
  }

  const envStats = (store.dbiCache.env as unknown as StatsCarrier).getStats();
  const dbiStats = (
    store.dbiCache.getOrCreateDbi(BUDGET_WORKFLOW)._unsafeUnwrap() as unknown as StatsCarrier
  ).getStats();

  const usedBytes = (envStats.lastPageNumber + 1) * envStats.pageSize;
  const fileBytes = fsSync.statSync(
    path.join(dataDir, BUDGET_WORKSPACE, 'data.mdb'),
  ).size;

  await store.dbiCache.env.close();
  await fs.rm(dataDir, { recursive: true, force: true });

  return {
    budget,
    writeCount,
    rejectedAt,
    rejection,
    usedBytes,
    fileBytes,
    leafPages: dbiStats.treeLeafPageCount,
    branchPages: dbiStats.treeBranchPageCount,
    overflowPages: dbiStats.overflowPages,
    entryCount: dbiStats.entryCount,
  };
}

/** The assertions every fill must satisfy, incompressible or not. */
function expectFillWithinBudget(result: FillResult, expectedWrites: number): void {
  // A workflow that stays inside its own declaration writes everything it
  // declared. Nothing should refuse it — and since nothing enforces the budget
  // any more, a rejection here means a real storage failure.
  expect(
    result.rejectedAt,
    `write refused after ${result.writeCount} of ${expectedWrites} writes: ${result.rejection ?? ''}`,
  ).toBeUndefined();
  expect(result.writeCount).toBe(expectedWrites);

  // The environment's high-water mark is `stat data.mdb` to the byte, so
  // either instrument answers the question.
  expect(result.usedBytes).toBe(result.fileBytes);

  // The claim the recommendation makes: a volume of this size holds the fill.
  // This is the assertion that fails when the budget is under-provisioned.
  expect(result.fileBytes).toBeLessThanOrEqual(
    result.budget.recommendedVolumeBytes,
  );

  // Page accounting is consistent with the file: the dbi's own pages are a
  // subset of the environment's.
  const dbiPages = result.leafPages + result.branchPages + result.overflowPages;
  expect(dbiPages * 4096).toBeLessThanOrEqual(result.fileBytes);
}

/**
 * The assertions about the **page model itself**, separate from the padded
 * figure it feeds.
 *
 * `expectFillWithinBudget` above only says the recommendation is big enough,
 * which a large enough constant would also satisfy. These say the model is
 * *right*: that the pages it counts are the pages LMDB allocates.
 *
 * @param maxOverProvision the recommendation, as a multiple of the real file.
 */
function expectPageModelHolds(
  result: FillResult,
  maxOverProvision: number,
): void {
  // What the model actually models: leaf pages and overflow pages. It does not
  // model branch pages or the freelist — those are what the 1.15 residual
  // covers — so it is allowed to come in slightly under the measured count, and
  // 2% is the whole of that allowance. A coefficient that drifted (LEAF_FILL,
  // the value framing) shows up here first, and shows up as a real
  // under-estimate rather than as a budget that merely got looser.
  const modelledPages = result.leafPages + result.overflowPages;
  expect(result.budget.pageCountMax).toBeGreaterThanOrEqual(
    Math.floor(modelledPages * 0.98),
  );

  // And it is not simply a large number: the recommendation stays close to the
  // fill. The model's worst is ~2.04×, at `valueSizeMax: 992`.
  expect(result.budget.recommendedVolumeBytes / result.fileBytes).toBeLessThan(
    maxOverProvision,
  );
}

describe('e2e — T14: a budgeted fill of incompressible values stays inside its budget', () => {
  it('at valueSizeMax 1334 — the measured worst case for the budget formula', async () => {
    // 1334 is where the flat byte sum is furthest from reality: only two nodes
    // of this size fit a 4096-byte page and LMDB's pages settle at ~1.1 of
    // them after splitting, so the real footprint is ~2.8× `dataBytesMax`.
    // It is where the page model earns its keep: it *counts* those two nodes
    // to a page, so it needs no multiplier to see them.
    const result = await fillToBudget({
      label: 't14-worst-case',
      keyCount: 2000,
      valueSizeMax: 1334,
      kind: 'incompressible',
    });

    expectFillWithinBudget(result, 2000);
    // The model over-provisions this fill by ~1.13.
    expectPageModelHolds(result, 1.25);

    // The excess over `dataBytesMax` is real and large — this is why the two
    // figures must stay distinct.
    expect(result.fileBytes).toBeGreaterThan(result.budget.dataBytesMax * 2);

    // Hand-derivable: `key0`..`key1999` are 4-7 bytes, so the widest node is
    // 2 + 8 + even(7) + even(1334 + 18) = 1370, floor(4080 / 1370) = 2 nodes to
    // a page, and 2000 / (2 * 0.55) = 1818.18 -> 1819 pages.
    expect(result.budget.pageCountMax).toBe(1819);

    console.info(
      `T14 [1334]: dataBytesMax=${result.budget.dataBytesMax} ` +
        `file=${result.fileBytes} recommendedVolumeBytes=${result.budget.recommendedVolumeBytes} ` +
        `ratio=${(result.fileBytes / result.budget.dataBytesMax).toFixed(3)} ` +
        `leaf=${result.leafPages} branch=${result.branchPages} overflow=${result.overflowPages}`,
    );
  }, 120_000);

  it('at valueSizeMax 2022 — the old default, now correctly charged as overflow', async () => {
    const result = await fillToBudget({
      label: 't14-inpage-ceiling',
      keyCount: 1500,
      valueSizeMax: 2022,
      kind: 'incompressible',
    });

    expectFillWithinBudget(result, 1500);

    // The in-page test is
    // `keyBytes + valueSizeMax <= LMDB_INPAGE_KEY_PLUS_VALUE_MAX (2013)`, and
    // these keys are `key0`..`key1499` at 4-7 bytes, so every sum is at least
    // 2026 and every entry is charged the overflow branch: overhead(k) + 8 +
    // one 4096-byte page.
    //
    // The assertion guards the thing that matters: that LMDB really does put a
    // 2022-byte value on its own page. If it ever fails, LMDB or lmdb-js has
    // changed such that 2022 fits in a leaf page, and
    // `LMDB_INPAGE_KEY_PLUS_VALUE_MAX` needs re-measuring — not this test
    // working around it.
    expect(result.overflowPages).toBeGreaterThanOrEqual(1500);

    // The page model's overflow branch, hand-derived. Overflow pages first:
    // ceil((16 + 2022 + 18) / 4096) = 1 page per entry = 1500. Then the leaf
    // nodes that survive holding a page id, 2 + 8 + even(k) + 8 bytes, by key
    // length across `key0`..`key1499`:
    //
    //   k = 4 (10 keys)   node 22, floor(4080/22) = 185, 10 / (185 * 0.55)
    //                                                             =  0.09828
    //   k = 5,6 (990)     node 24, floor(4080/24) = 170, 990 / (170 * 0.55)
    //                                                             = 10.58824
    //   k = 7 (500)       node 26, floor(4080/26) = 156, 500 / (156 * 0.55)
    //                                                             =  5.82751
    //                                                               --------
    //                                              total leaf share  16.51402
    //
    //   pageCountMax = ceil(1500 + 16.51402) = 1517
    expect(result.budget.pageCountMax).toBe(1517);
    expectPageModelHolds(result, 1.25);

    console.info(
      `T14 [2022]: dataBytesMax=${result.budget.dataBytesMax} ` +
        `file=${result.fileBytes} recommendedVolumeBytes=${result.budget.recommendedVolumeBytes} ` +
        `ratio=${(result.fileBytes / result.budget.dataBytesMax).toFixed(3)} ` +
        `overflowPages=${result.overflowPages}`,
    );
  }, 120_000);

  it('for an lmdb-fifo key filled to queueSizeMax - 1', async () => {
    // The FIFO branch of the budget: `queueSizeMax - 1` data slots plus the two
    // cursor entries. Filling the ring to capacity is the peak the formula
    // charges for.
    //
    // Kept at 2022 deliberately, and note what the *derived* key does to it:
    // `fifo:key0:data:` is 15 bytes and `digits(499)` is 3, so the key LMDB
    // weighs is 18 bytes and the sum is 2040 — past 2013, so every slot is
    // charged an overflow page. The declared key is only 4 bytes; a test that
    // used it would have called this in-page and been wrong.
    const result = await fillToBudget({
      label: 't14-fifo',
      keyCount: 2,
      valueSizeMax: 2022,
      kind: 'incompressible',
      queueSizeMax: 500,
    });

    expectFillWithinBudget(result, 2 * 499);

    // The budget charges 499 data slots plus `head` and `tail` per key = 1002.
    // The live count is 1000: `putStatic` writes the data key and `head`, and
    // `tail` is only materialised by the first dequeue. The formula is an
    // upper bound, which is what a provisioning figure needs — so this is
    // `<=`, and the gap is exactly the two unwritten cursors.
    expect(result.entryCount).toBeLessThanOrEqual(result.budget.entryCount);
    expect(result.entryCount).toBe(result.budget.entryCount - 2);

    // The page model on the FIFO branch, per key: 499 slots × 1 overflow page
    // = 499, plus their leaf nodes at 2 + 8 + even(18) + 8 = 36 bytes,
    // floor(4080 / 36) = 113 to a page, 499 / (113 * 0.55) = 8.0290 pages,
    // plus the two cursors — `fifo:key0:head` is 14 bytes, node
    // 2 + 8 + even(14) + even(9 + 18) = 2 + 8 + 14 + 28 = 52, floor(4080/52)
    // = 78 to a page, 2 / (78 * 0.55) = 0.0466. Two such keys:
    //   2 * (499 + 8.0290 + 0.0466) = 1014.1513 -> ceil = 1015
    expect(result.budget.pageCountMax).toBe(1015);
    expectPageModelHolds(result, 1.25);

    console.info(
      `T14 [fifo]: dataBytesMax=${result.budget.dataBytesMax} ` +
        `file=${result.fileBytes} recommendedVolumeBytes=${result.budget.recommendedVolumeBytes} ` +
        `pageCountMax=${result.budget.pageCountMax} ` +
        `ratio=${(result.fileBytes / result.budget.dataBytesMax).toFixed(3)}`,
    );
  }, 120_000);

  // -------------------------------------------------------------------------
  // The two fills that test the shape of the model, not just its size
  //
  // The three cases above are all *teeth*: page-packing cliffs where any figure
  // that passes has to be large, so they cannot tell a crude multiplier from
  // the page model. The two below can.
  // -------------------------------------------------------------------------

  it('at valueSizeMax 992 — the model\'s loosest point, and the multiplier\'s tightest', async () => {
    // 992 is where the page model is furthest from the truth in the *safe*
    // direction: three nodes of 1010 aligned bytes fit a 4080-byte page and
    // LMDB packs them denser than 0.55, so the model counts 1213 pages against
    // 671 really allocated. That 1.94 pre-residual gap is the widest of the 14
    // fills the coefficients were fitted against, and it is what sets the
    // ~2.2× ceiling on how much the model can over-provision.
    const result = await fillToBudget({
      label: 't16-loosest',
      keyCount: 2000,
      valueSizeMax: 992,
      kind: 'incompressible',
    });

    expectFillWithinBudget(result, 2000);
    // 2.2 is the documented ceiling on the model's over-provisioning. If this
    // ever fails, the model has lost its worst-case guarantee, not merely
    // drifted.
    expectPageModelHolds(result, 2.2);

    console.info(
      `T16 [992]: dataBytesMax=${result.budget.dataBytesMax} ` +
        `file=${result.fileBytes} recommendedVolumeBytes=${result.budget.recommendedVolumeBytes} ` +
        `pageCountMax=${result.budget.pageCountMax} ` +
        `leaf=${result.leafPages} branch=${result.branchPages} ` +
        `overProvision=${(result.budget.recommendedVolumeBytes / result.fileBytes).toFixed(3)}`,
    );
  }, 120_000);

  it('at valueSizeMax 16 — 2000 tiny keys share pages, and the model must not round per key', async () => {
    // **The case that fails if leaf shares are rounded up per key.** Read as
    // `Σ pagesForKey(...)` with `pagesForKey` returning whole pages, each of
    // these 2000 `lmdb-kv` keys is charged a 4096-byte page of its own — 2000
    // pages, 8.2 MB, against a fill that really occupies 180,224 bytes. A leaf
    // page belongs to the dbi, not to a key, so the shares accumulate and round
    // once:
    //
    //   node       = 2 + 8 + even(7) + even(16 + 18) = 52
    //   nodes/page = floor(4080 / 52) = 78
    //   share      = 1 / (78 * 0.55) = 0.023310 for a 7-byte key
    //
    // Shorter keys pack denser — 4-byte keys make a 48-byte node, 85 to a page
    // — so the exact total is 10/46.75 + 990/44.55 + 1000/42.9 = 45.7467,
    // which rounds to 46 pages, not 2000.
    const result = await fillToBudget({
      label: 't16-shared-leaves',
      keyCount: 2000,
      valueSizeMax: 16,
      kind: 'incompressible',
    });

    expectFillWithinBudget(result, 2000);

    expect(result.budget.pageCountMax).toBe(46);
    // Per-key rounding would give 2000. This is the tripwire on the reading.
    expect(result.budget.pageCountMax).toBeLessThan(100);
    // And the pages it counts really do cover the leaves LMDB allocated.
    expect(result.budget.pageCountMax).toBeGreaterThanOrEqual(result.leafPages);

    console.info(
      `T16 [16]: dataBytesMax=${result.budget.dataBytesMax} ` +
        `file=${result.fileBytes} recommendedVolumeBytes=${result.budget.recommendedVolumeBytes} ` +
        `pageCountMax=${result.budget.pageCountMax} leaf=${result.leafPages}`,
    );
  }, 120_000);

  it('lets a workflow write past its declared budget — the budget is reported, not enforced', async () => {
    // Writing far more than was declared — 400 keys' worth of traffic against
    // a 4-key declaration — must go through untouched. The declared budget
    // sizes a container; the container is what stops a runaway workflow, not
    // the store. An application-level ceiling would have a hole a container's
    // does not — it binds only writes made through this store, leaving a second
    // process or a raw `lmdb.open()` on the same directory unbounded. If this
    // ever starts failing, enforcement has crept back in.
    const dataDir = path.join(tempDir, 'budget', 't14-overrun');
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.mkdir(dataDir, { recursive: true });

    const strategy: BoxStrategy = { name: 'lmdb-kv', valueSizeMax: 2022 };
    const budget = budgetForStorage({
      defaultStrategy: strategy,
      strategies: { key0: strategy, key1: strategy, key2: strategy, key3: strategy },
    });

    const store = BoxStoreLmdb.create(BUDGET_WORKSPACE, pathToFileURL(`${dataDir}/`));

    const content = payloadOfPackedSize(2022, 'incompressible');
    let lastError = '';
    let writes = 0;

    for (let i = 0; i < 400; i++) {
      const result = store.putSync({
        content,
        location: {
          key: `overrun${i}`,
          workflow: BUDGET_WORKFLOW,
          workspace: BUDGET_WORKSPACE,
          strategy,
        },
      });

      if (result.isErr()) {
        lastError = result.error;
        break;
      }

      writes++;
    }

    const fileBytes = fsSync.statSync(
      path.join(dataDir, BUDGET_WORKSPACE, 'data.mdb'),
    ).size;

    await store.dbiCache.env.close();
    await fs.rm(dataDir, { recursive: true, force: true });

    expect(lastError).toBe('');
    expect(writes).toBe(400);
    // And the overrun was real, not a workload that happened to fit: the file
    // is past the figure the declaration recommends provisioning for.
    expect(fileBytes).toBeGreaterThan(budget.recommendedVolumeBytes);
  }, 120_000);
});

describe('e2e — T14b: the same fill with compressible values', () => {
  it('records how loose the bound gets when compression works', async () => {
    const incompressible = await fillToBudget({
      label: 't14b-incompressible',
      keyCount: 1500,
      valueSizeMax: 2022,
      kind: 'incompressible',
    });
    const compressible = await fillToBudget({
      label: 't14b-compressible',
      keyCount: 1500,
      valueSizeMax: 2022,
      kind: 'compressible',
    });

    expectFillWithinBudget(compressible, 1500);

    // Identical declarations, so identical budgets — the bound does not know
    // what the bytes look like, which is the whole point of declaring it.
    expect(compressible.budget.dataBytesMax).toBe(incompressible.budget.dataBytesMax);
    expect(compressible.budget.recommendedVolumeBytes).toBe(
      incompressible.budget.recommendedVolumeBytes,
    );

    // **The regression tripwire.** With compression on, a 2022-byte run of one
    // repeated byte collapses to nothing and 1500 of them share a handful of
    // leaf pages instead of taking 1500 dedicated overflow pages. If a future
    // change drops `compression: true` from `LmdbDbiCache.dbiOptions`, this
    // fill lands on the incompressible numbers and the ratio jumps by ~50×.
    expect(compressible.overflowPages).toBe(0);
    expect(compressible.fileBytes).toBeLessThan(incompressible.fileBytes / 10);
    expect(compressible.fileBytes).toBeLessThan(
      compressible.budget.dataBytesMax / 4,
    );

    const looseness = incompressible.fileBytes / compressible.fileBytes;
    console.info(
      `T14b [2022 × 1500]: dataBytesMax=${compressible.budget.dataBytesMax} ` +
        `incompressible file=${incompressible.fileBytes} ` +
        `(${(incompressible.fileBytes / incompressible.budget.dataBytesMax).toFixed(3)}× dataBytesMax) ` +
        `compressible file=${compressible.fileBytes} ` +
        `(${(compressible.fileBytes / compressible.budget.dataBytesMax).toFixed(4)}× dataBytesMax); ` +
        `the budget is ${looseness.toFixed(1)}× looser in the good case`,
    );
  }, 180_000);
});
