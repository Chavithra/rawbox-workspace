import { describe, it, expect } from 'vitest';

import { STRATEGY_NAME_LIST } from '@rawbox/store';

import {
  UNWIRED_STRATEGY_NAME_LIST,
  WIRED_STRATEGY_NAME_LIST,
  collectUnwiredStrategyProblems,
} from '../../src/workflow/store-support.js';
import type { Workflow } from '../../src/workflow/workflow-types.js';

// ---------------------------------------------------------------------------
// Wired vs unwired strategy partition
//
// `BoxStrategy` is the set of strategies a *document* may declare; the set a
// *run* can execute is whatever this binary wires a store for. All shipped
// strategies (`lmdb-kv` and `lmdb-fifo`) are wired in this build, so
// `UNWIRED_STRATEGY_NAME_LIST` is empty and `collectUnwiredStrategyProblems`
// returns `[]` for LMDB workflows.
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
const LMDB_FIFO = {
  name: 'lmdb-fifo',
  queueSizeMax: 8,
  valueSizeMax: 1900,
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

  it('wires LMDB and PostgreSQL strategies and leaves the unwired list empty', () => {
    expect(WIRED_STRATEGY_NAME_LIST).toEqual([
      'lmdb-kv',
      'lmdb-fifo',
      'pg-kv',
      'pg-fifo',
    ]);
    expect(UNWIRED_STRATEGY_NAME_LIST).toEqual([]);
  });
});

describe('collectUnwiredStrategyProblems', () => {
  it('reports nothing for an LMDB-only document', () => {
    expect(
      collectUnwiredStrategyProblems(
        workflowWith({
          defaultStrategy: LMDB_KV,
          keys: {
            queue: { strategy: LMDB_FIFO },
          },
        }),
      ),
    ).toEqual([]);

    expect(
      collectUnwiredStrategyProblems(
        workflowWith({
          defaultStrategy: LMDB_FIFO,
          keys: {
            cell: { strategy: LMDB_KV },
          },
        }),
      ),
    ).toEqual([]);
  });
});
