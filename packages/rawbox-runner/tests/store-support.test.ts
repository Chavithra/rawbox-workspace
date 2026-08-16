import { describe, it, expect } from 'vitest';

import { STRATEGY_NAME_LIST } from '@rawbox/store';

import {
  UNWIRED_STRATEGY_NAME_LIST,
  WIRED_STRATEGY_NAME_LIST,
  collectUnwiredStrategyProblems,
} from '../src/workflow/store-support.js';
import type { Workflow } from '../src/workflow/workflow-types.js';

// ---------------------------------------------------------------------------
// A strategy this build can express but cannot run
//
// `BoxStrategy` is the set of strategies a *document* may declare; the set a
// *run* can execute is whatever this binary wires a store for. `redis-kv` is
// the first strategy to sit in the gap between them, and these tests pin the
// two properties that make the gap safe: a run refuses with a named,
// actionable error, and an LMDB-only document is completely unaffected.
// ---------------------------------------------------------------------------

function workflowWith(storage: Workflow['storage']): Workflow {
  return {
    kind: 'Workflow',
    formatVersion: '1.0',
    name: 'store-support-workflow',
    plugins: {},
    storage,
    steps: [],
  } as unknown as Workflow;
}

const LMDB_KV = { name: 'lmdb-kv', valueSizeMax: 1900 } as const;
const REDIS_KV = {
  name: 'redis-kv',
  valueSizeMax: 1900,
  backend: 'main',
} as const;
const REDIS_FIFO = {
  name: 'redis-fifo',
  queueSizeMax: 8,
  valueSizeMax: 1900,
  backend: 'main',
} as const;

describe('the wired/unwired strategy split', () => {
  it('partitions the union with nothing lost and nothing counted twice', () => {
    // The hand-kept list is `WIRED_STRATEGY_NAME_LIST`; the derived one is
    // `UNWIRED_STRATEGY_NAME_LIST`, read off the strategy registry. This is the
    // invariant that makes the hand-kept half safe: every strategy the union
    // admits is on exactly one side.
    expect([...WIRED_STRATEGY_NAME_LIST, ...UNWIRED_STRATEGY_NAME_LIST].sort()).toEqual(
      [...STRATEGY_NAME_LIST].sort(),
    );
    for (const name of WIRED_STRATEGY_NAME_LIST) {
      expect(UNWIRED_STRATEGY_NAME_LIST).not.toContain(name);
    }
  });

  it('names both Redis strategies as unwired and both LMDB ones as wired in this version', () => {
    expect(WIRED_STRATEGY_NAME_LIST).toEqual(['lmdb-kv', 'lmdb-fifo']);
    expect(UNWIRED_STRATEGY_NAME_LIST).toEqual(['redis-kv', 'redis-fifo']);
  });

  it('picked up redis-fifo with no edit to the hand-kept half', () => {
    // The point of deriving the unwired list. `redis-fifo` joined the union as
    // a shape and a descriptor row only — no store implements it yet — and it
    // appeared here because `WIRED_STRATEGY_NAME_LIST` was NOT touched. That is
    // the fail-closed direction: the list that has to be edited by hand is the
    // one whose omission refuses runs, never the one whose omission would let a
    // strategy through to a store that cannot route it.
    expect(WIRED_STRATEGY_NAME_LIST).not.toContain('redis-fifo');
    expect(UNWIRED_STRATEGY_NAME_LIST).toContain('redis-fifo');
  });
});

describe('collectUnwiredStrategyProblems', () => {
  it('reports nothing for an LMDB-only document', () => {
    expect(
      collectUnwiredStrategyProblems(
        workflowWith({
          defaultStrategy: LMDB_KV,
          keys: {
            queue: { strategy: { name: 'lmdb-fifo', queueSizeMax: 8, valueSizeMax: 1900 } },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('names the strategy, the declaration site and what is missing', () => {
    const [problem] = collectUnwiredStrategyProblems(
      workflowWith({
        defaultStrategy: LMDB_KV,
        keys: { cache_entry: { strategy: REDIS_KV } },
      }),
    );

    expect(problem).toContain('Strategy "redis-kv"');
    expect(problem).toContain('storage.keys.cache_entry.strategy');
    expect(problem).toContain('no store implementation wired for it');
    // What the author can do about it — and what they cannot, since there is
    // nothing to write in the document that fixes this.
    expect(problem).toContain('lmdb-kv, lmdb-fifo');
    expect(problem).toContain('the document verifies');
  });

  it('rules out the two readings a terse message would invite', () => {
    const [problem] = collectUnwiredStrategyProblems(
      workflowWith({
        defaultStrategy: LMDB_KV,
        keys: { cache_entry: { strategy: REDIS_KV } },
      }),
    );

    // Not a typo — the strategy is legal, so an author must not go hunting for
    // a misspelling that is not there.
    expect(problem).toContain('This is not a typo');
    // And not a silent fallback. A run that stored these keys in LMDB would put
    // a workflow's data somewhere its author did not ask for.
    expect(problem).toContain('nothing fell back to another strategy');
  });

  it('refuses a redis-fifo declaration, with the same named diagnostic', () => {
    // `redis-fifo` ships as a shape and a descriptor row and nothing else
    // (task #14): a document declaring it is VALID and `workflow verify` says
    // so, but no store enqueues to it yet, so the run must refuse up front
    // rather than reach the first seed write and discover the gap there.
    const [problem] = collectUnwiredStrategyProblems(
      workflowWith({
        defaultStrategy: LMDB_KV,
        keys: { job_queue: { strategy: REDIS_FIFO } },
      }),
    );

    expect(problem).toContain('Strategy "redis-fifo"');
    expect(problem).toContain('storage.keys.job_queue.strategy');
    expect(problem).toContain('no store implementation wired for it');
    expect(problem).toContain('This is not a typo');
    // And above all not a silent fallback to the ring: an author who asked for
    // a Redis list must not get an LMDB queue in a file on this machine.
    expect(problem).toContain('nothing fell back to another strategy');
  });

  it('sweeps `storage.defaultStrategy` too', () => {
    const [problem] = collectUnwiredStrategyProblems(
      workflowWith({ defaultStrategy: REDIS_KV }),
    );

    expect(problem).toContain('storage.defaultStrategy');
  });

  it('reports every offending declaration in one pass', () => {
    // An author converting a document should get the whole fix list at
    // once, not one entry per run.
    const problemList = collectUnwiredStrategyProblems(
      workflowWith({
        defaultStrategy: REDIS_KV,
        keys: {
          a: { strategy: REDIS_KV },
          b: { strategy: LMDB_KV },
          c: { strategy: REDIS_KV },
        },
      }),
    );

    expect(problemList).toHaveLength(3);
    expect(problemList[0]).toContain('storage.defaultStrategy');
    expect(problemList[1]).toContain('storage.keys.a.strategy');
    expect(problemList[2]).toContain('storage.keys.c.strategy');
  });
});
