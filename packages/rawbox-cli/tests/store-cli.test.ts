import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as p from '@clack/prompts';
import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import type { BoxLocation, BoxStrategy } from '@rawbox/store';

import { storeListCommand } from '../src/commands/store/list.js';
import { storeGetCommand } from '../src/commands/store/get.js';

// ---------------------------------------------------------------------------
// `store list`/`store get`, over a fixture built with the real @rawbox/store
// write API — the same write path a running workflow uses — never a
// hand-rolled copy of the on-disk layout. The suite reads exclusively
// through the commands under test, which read exclusively through
// `BoxObserverLmdb` (never `BoxStoreLmdb`), matching the store task's
// non-negotiable constraint.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-store-cli-test');

const KV: BoxStrategy = { name: 'lmdb-kv', valueSizeMax: 1900 };
const FIFO: BoxStrategy = { name: 'lmdb-fifo', queueSizeMax: 4, valueSizeMax: 1900 };

let logSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'info').mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(rootDir, { recursive: true, force: true });
});

function loggedText(): string {
  const joined = logSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
  // eslint-disable-next-line no-control-regex
  return joined.replace(/\x1b\[[0-9;]*m/g, '');
}

const WORKFLOW_DOC = `
kind: Workflow
formatVersion: "1.0"
name: example
plugins:
  "@rawbox/plugin-fixture": "^0.0.1"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    declared_kv:
      strategy:
        name: lmdb-kv
        valueSizeMax: 500
    wrapped_queue:
      strategy:
        name: lmdb-fifo
        queueSizeMax: 4
        valueSizeMax: 1900
    sleep_ms:
      seed: 1
    halt_reason:
      seed: fixture
steps:
  - label: sleep-step
    plugin: "@rawbox/plugin-fixture"
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: bound_kv
    errors:
      message: sleep_error
  - label: done
    plugin: "@rawbox/plugin-fixture"
    operation: control-flow/halt
    inputs:
      reason: halt_reason
    errors:
      message: halt_error
`.trim();

interface Fixture {
  workspaceDir: string;
  workspacePath: string;
  workspaceName: string;
}

/**
 * Writes a workspace document, a workflow document declaring some of the
 * keys used below, and the LMDB state itself — a plain kv key, a plain fifo,
 * a fifo wrapped past its ring boundary, a key bound only by a step (no
 * `strategies` entry), and an orphan key the document never mentions at all.
 */
async function makeFixture(name: string): Promise<Fixture> {
  const workspaceDir = path.join(rootDir, name);
  const workflowDir = path.join(workspaceDir, 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.writeFile(path.join(workflowDir, 'example.workflow.yaml'), WORKFLOW_DOC, 'utf-8');

  const workspacePath = path.join(workspaceDir, 'workspace.yaml');
  await fs.writeFile(
    workspacePath,
    `kind: Workspace\nname: ${name}\nworkflowPathList:\n  - ./workflows/example.workflow.yaml\n`,
    'utf-8',
  );

  const dataUrl = pathToFileURL(`${path.join(workspaceDir, '.rawbox', 'data')}/`);
  const store = BoxStoreLmdb.create(name, dataUrl);

  const put = (key: string, content: unknown, strategy: BoxStrategy): void => {
    const location: BoxLocation = { workspace: name, workflow: 'example', key, strategy };
    const result = store.putSync({ content, location });
    expect(result.isOk(), JSON.stringify(result)).toBe(true);
  };

  put('declared_kv', { level: 7 }, KV);
  put('bound_kv', 'written-by-a-step-output', KV);
  put('orphan_kv', 'nobody-declares-me', KV);

  put('plain_queue', 'p1', FIFO);
  put('plain_queue', 'p2', FIFO);

  // Wrap `wrapped_queue`'s ring: fill, drain twice, refill so the live
  // window straddles index 0 — the case a naive sorted-key read gets wrong.
  const wrappedLocation: BoxLocation = {
    workspace: name,
    workflow: 'example',
    key: 'wrapped_queue',
    strategy: FIFO,
  };
  put('wrapped_queue', 'w1', FIFO);
  put('wrapped_queue', 'w2', FIFO);
  put('wrapped_queue', 'w3', FIFO);
  expect(store.getSync(wrappedLocation)._unsafeUnwrap()).toBe('w1');
  expect(store.getSync(wrappedLocation)._unsafeUnwrap()).toBe('w2');
  put('wrapped_queue', 'w4', FIFO);
  put('wrapped_queue', 'w5', FIFO);

  await store.dbiCache.env.close();

  return { workspaceDir, workspacePath, workspaceName: name };
}

describe('store list', () => {
  it('classifies declared, bound and undeclared keys, and both fifo/kv strategies (text)', async () => {
    const fixture = await makeFixture('list-classify');

    await storeListCommand(fixture.workspaceDir, { cwd: rootDir });

    expect(exitSpy).not.toHaveBeenCalled();
    const text = loggedText();
    expect(text).toContain('declared_kv');
    expect(text).toContain('declared');
    expect(text).toContain('bound_kv');
    expect(text).toContain('bound');
    expect(text).toContain('orphan_kv');
    expect(text).toContain('undeclared');
    expect(text).toContain('wrapped_queue');
    expect(text).toContain('lmdb-fifo');
  });

  it('renders declared-vs-actual with the declared valueSizeMax and queueSizeMax joined per key (json)', async () => {
    const fixture = await makeFixture('list-json');

    await storeListCommand(fixture.workspaceDir, { cwd: rootDir, output: 'json' });

    const rows = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{
      key: string;
      workflow: string;
      strategy: string;
      valueSizeBytes: number;
      fifo?: { depth: number; capacity?: number };
      declared?: { source: string; valueSizeMax: number; queueSizeMax?: number };
    }>;

    const declaredKv = rows.find((row) => row.key === 'declared_kv')!;
    expect(declaredKv.declared).toEqual({ source: 'declared', valueSizeMax: 500 });

    const boundKv = rows.find((row) => row.key === 'bound_kv')!;
    expect(boundKv.declared).toEqual({ source: 'bound', valueSizeMax: 1900 });

    const orphanKv = rows.find((row) => row.key === 'orphan_kv')!;
    expect(orphanKv.declared).toBeUndefined();

    const wrapped = rows.find((row) => row.key === 'wrapped_queue')!;
    expect(wrapped.strategy).toBe('lmdb-fifo');
    expect(wrapped.fifo?.depth).toBe(3);
    // queueSizeMax 4 -> capacity 3 (one slot always kept free).
    expect(wrapped.fifo?.capacity).toBe(3);
    expect(wrapped.declared).toEqual({ source: 'declared', valueSizeMax: 1900, queueSizeMax: 4 });

    const plainQueue = rows.find((row) => row.key === 'plain_queue')!;
    expect(plainQueue.declared).toBeUndefined();
    expect(plainQueue.fifo?.depth).toBe(2);
    // No declaration for this key -> no capacity can be derived (would be a
    // fabricated number, not a joined one).
    expect(plainQueue.fifo?.capacity).toBeUndefined();
  });

  it('filters to one workflow with --workflow', async () => {
    const fixture = await makeFixture('list-filter');

    await storeListCommand(fixture.workspaceDir, {
      cwd: rootDir,
      output: 'json',
      workflow: 'no-such-workflow',
    });

    const rows = JSON.parse(logSpy.mock.calls[0]![0] as string) as unknown[];
    expect(rows).toEqual([]);
  });

  it('reports a friendly empty state and exits 0 for a workspace with no data yet', async () => {
    const emptyWsDir = path.join(rootDir, 'never-run');
    await fs.mkdir(emptyWsDir, { recursive: true });
    await fs.writeFile(
      path.join(emptyWsDir, 'workspace.yaml'),
      'kind: Workspace\nname: never-run\nworkflowPathList: []\n',
      'utf-8',
    );

    await storeListCommand(emptyWsDir, { cwd: rootDir, output: 'json' });

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toEqual([]);
  });

  it('rejects a traversal attempt in the workspace argument', async () => {
    await storeListCommand('a/b', { cwd: rootDir });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('store get', () => {
  it('prints a kv value', async () => {
    const fixture = await makeFixture('get-kv');

    await storeGetCommand(fixture.workspaceDir, 'example', 'declared_kv', {
      cwd: rootDir,
      output: 'json',
    });

    expect(exitSpy).not.toHaveBeenCalled();
    const [result] = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{ value: unknown }>;
    expect(result!.value).toEqual({ level: 7 });
  });

  it('prints a fifo\'s elements oldest-first via peekAll, including across a ring wrap', async () => {
    const fixture = await makeFixture('get-fifo-wrap');

    await storeGetCommand(fixture.workspaceDir, 'example', 'wrapped_queue', {
      cwd: rootDir,
      output: 'json',
    });

    const [result] = JSON.parse(logSpy.mock.calls[0]![0] as string) as Array<{
      depth: number;
      elements: unknown[];
    }>;
    expect(result!.depth).toBe(3);
    expect(result!.elements).toEqual(['w3', 'w4', 'w5']);
  });

  it('leaves a fifo\'s depth unchanged after `get` — the destructive-read regression', async () => {
    const fixture = await makeFixture('get-fifo-no-dequeue');

    // Baseline depth, read directly off the store before the CLI touches it.
    const dataUrl = pathToFileURL(`${path.join(fixture.workspaceDir, '.rawbox', 'data')}/`);
    const beforeStore = BoxStoreLmdb.create(fixture.workspaceName, dataUrl);
    const location: BoxLocation = {
      workspace: fixture.workspaceName,
      workflow: 'example',
      key: 'plain_queue',
      strategy: FIFO,
    };
    const depthBefore = beforeStore.depthSync(location)._unsafeUnwrap();
    await beforeStore.dbiCache.env.close();

    await storeGetCommand(fixture.workspaceDir, 'example', 'plain_queue', { cwd: rootDir });
    await storeGetCommand(fixture.workspaceDir, 'example', 'plain_queue', { cwd: rootDir });
    await storeGetCommand(fixture.workspaceDir, 'example', 'plain_queue', {
      cwd: rootDir,
      output: 'json',
    });

    const afterStore = BoxStoreLmdb.create(fixture.workspaceName, dataUrl);
    const depthAfter = afterStore.depthSync(location)._unsafeUnwrap();
    const elementsAfter = afterStore.peekAllSync(location)._unsafeUnwrap();
    await afterStore.dbiCache.env.close();

    expect(depthAfter).toEqual(depthBefore);
    expect(elementsAfter).toEqual(['p1', 'p2']);

    // And the CLI reported the same, unconsumed elements every single time.
    const lastCall = logSpy.mock.calls[logSpy.mock.calls.length - 1]!;
    const [lastResult] = JSON.parse(lastCall[0] as string) as Array<{
      elements: unknown[];
    }>;
    expect(lastResult!.elements).toEqual(['p1', 'p2']);
  });

  it('exits non-zero with a clean message for a missing key', async () => {
    const fixture = await makeFixture('get-missing-key');

    await storeGetCommand(fixture.workspaceDir, 'example', 'does-not-exist', { cwd: rootDir });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits non-zero for a workspace with no data yet, unlike `list`', async () => {
    const emptyWsDir = path.join(rootDir, 'never-run-get');
    await fs.mkdir(emptyWsDir, { recursive: true });
    await fs.writeFile(
      path.join(emptyWsDir, 'workspace.yaml'),
      'kind: Workspace\nname: never-run-get\nworkflowPathList: []\n',
      'utf-8',
    );

    await storeGetCommand(emptyWsDir, 'example', 'whatever', { cwd: rootDir });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('rejects a traversal attempt in the workspace argument', async () => {
    await storeGetCommand('../x', 'example', 'k', { cwd: rootDir });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
