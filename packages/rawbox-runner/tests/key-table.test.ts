import { describe, it, expect } from 'vitest';
import { Compile } from 'typebox/compile';
import { budgetForStorage, WriteBoxLocation } from '@rawbox/store';

import { Storage, type Workflow } from '../src/workflow/workflow-types.js';
import {
  boxStorageFor,
  resolveKeyOwnerMap,
  resolveKeyTable,
} from '../src/workflow/key-table.js';
import {
  collectBoundStorageKeys,
  collectRemovedStorageBlockProblems,
  collectStorageBindingList,
  validateStorageKeyTable,
  validateStorageOwnership,
  validateStorageSizes,
  validateWorkflowType,
} from '../src/workflow/validation.js';

const storageValidator = Compile(Storage);

const KV = { name: 'lmdb-kv' as const, valueSizeMax: 1900 };
const FIFO = {
  name: 'lmdb-fifo' as const,
  queueSizeMax: 1024,
  valueSizeMax: 1900,
};

/** A `storage:` block, typed as the schema-valid input `resolveKeyTable` takes. */
function storage(block: Record<string, unknown>): Storage {
  return { defaultStrategy: KV, ...block } as unknown as Storage;
}

/** A minimal document carrying `block` as its `storage:`, with `steps`. */
function workflowWithSteps(
  block: Record<string, unknown>,
  steps: readonly unknown[],
): unknown {
  return {
    kind: 'Workflow',
    formatVersion: '1.0',
    name: 'example',
    plugins: { '@rawbox/rawbox-plugin-default': '^1.0.0' },
    storage: { defaultStrategy: KV, ...block },
    steps,
  };
}

/** A minimal document carrying `block` as its `storage:`. */
function workflow(block: Record<string, unknown>): unknown {
  return workflowWithSteps(block, []);
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

describe('storage.keys — schema', () => {
  it('accepts an entry declaring both facts', () => {
    expect(
      storageValidator.Check(
        storage({ keys: { queue_items: { strategy: FIFO, seed: ['a'] } } }),
      ),
    ).toBe(true);
  });

  it('accepts an entry declaring only a strategy, or only a seed', () => {
    expect(
      storageValidator.Check(storage({ keys: { q: { strategy: FIFO } } })),
    ).toBe(true);
    expect(
      storageValidator.Check(storage({ keys: { sleep_ms: { seed: 500 } } })),
    ).toBe(true);
  });

  it('accepts an entry declaring neither — it declares the key', () => {
    expect(storageValidator.Check(storage({ keys: { scratch: {} } }))).toBe(true);
  });

  it('accepts arbitrary seed data, including null', () => {
    for (const seed of [null, 0, '', false, [], { name: 'lmdb-kv' }]) {
      expect(storageValidator.Check(storage({ keys: { k: { seed } } }))).toBe(
        true,
      );
    }
  });

  it('rejects an unrecognised field on an entry — StrictObject', () => {
    expect(
      storageValidator.Check(storage({ keys: { k: { stratergy: KV } } })),
    ).toBe(false);
  });

  it('rejects a bare strategy block written where the entry goes', () => {
    // The mistake the `strategy:` wrapper exists to make visible: `keys:` takes
    // an entry, not a strategy.
    expect(storageValidator.Check(storage({ keys: { q: FIFO } }))).toBe(false);
  });

  it('rejects the removed strategies: and seed: blocks — Storage is closed', () => {
    // Both were top-level maps beside `keys:`. `Storage` is a `StrictObject`,
    // so what used to be the format is now an unknown property — which is why
    // the removed-form diagnostics below run ahead of the schema.
    expect(
      storageValidator.Check(storage({ strategies: { q: FIFO } })),
    ).toBe(false);
    expect(storageValidator.Check(storage({ seed: { sleep_ms: 500 } }))).toBe(false);
    // Nor is there a third top-level map to smuggle a per-key fact into.
    expect(
      storageValidator.Check(storage({ owners: { shared_state: 'other-flow' } })),
    ).toBe(false);
    // And no room on a strategy block either — `BoxStrategy` is closed too.
    expect(
      storageValidator.Check(
        storage({ keys: { shared_state: { strategy: { ...KV, workflow: 'o' } } } }),
      ),
    ).toBe(false);
  });

  it('leaves defaultStrategy alone — it is not a shorthand for anything', () => {
    expect(storageValidator.Check(storage({}))).toBe(true);
    expect(storageValidator.Check({ keys: {} } as unknown as Storage)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The normaliser
// ---------------------------------------------------------------------------

describe('resolveKeyTable — one entry per key', () => {
  it('resolves keys:, naming the keys: paths', () => {
    const table = resolveKeyTable(
      storage({
        keys: {
          sleep_ms: { seed: 500 },
          queue_items: { strategy: FIFO, seed: ['a', 'b', 'c'] },
        },
      }),
    );

    expect(table.entryList.map((entry) => entry.key)).toEqual([
      'sleep_ms',
      'queue_items',
    ]);

    expect(table.byKey.get('queue_items')).toMatchObject({
      strategy: FIFO,
      hasSeed: true,
      seed: ['a', 'b', 'c'],
      declaredAt: {
        key: 'storage.keys.queue_items',
        strategy: 'storage.keys.queue_items.strategy',
        seed: 'storage.keys.queue_items.seed',
      },
    });

    expect(table.byKey.get('sleep_ms')).toMatchObject({
      strategy: KV,
      declaredAt: {
        key: 'storage.keys.sleep_ms',
        strategy: 'storage.defaultStrategy',
        seed: 'storage.keys.sleep_ms.seed',
      },
    });
  });

  it('applies keys[key].strategy ?? defaultStrategy', () => {
    const table = resolveKeyTable(
      storage({ keys: { q: { strategy: FIFO }, plain: { seed: 1 } } }),
    );

    expect(table.byKey.get('q')?.strategy).toEqual(FIFO);
    expect(table.byKey.get('q')?.declaredAt.strategy).toBe(
      'storage.keys.q.strategy',
    );
    // A key that declares no strategy is told about the block that chose one
    // for it, which is a field the author can go and edit.
    expect(table.byKey.get('plain')?.strategy).toEqual(KV);
    expect(table.byKey.get('plain')?.declaredAt.strategy).toBe(
      'storage.defaultStrategy',
    );
  });

  it('declares a key with an entry that states nothing', () => {
    const table = resolveKeyTable(storage({ keys: { scratch: {} } }));

    expect(table.byKey.get('scratch')).toEqual({
      key: 'scratch',
      strategy: KV,
      hasSeed: false,
      declaredAt: {
        key: 'storage.keys.scratch',
        strategy: 'storage.defaultStrategy',
        seed: undefined,
      },
    });
  });

  it('distinguishes "seeded with a falsy value" from "not seeded"', () => {
    const table = resolveKeyTable(
      storage({
        keys: {
          seeded_null: { seed: null },
          seeded_zero: { seed: 0 },
          declared_only: { strategy: FIFO },
        },
      }),
    );

    expect(table.byKey.get('seeded_null')?.hasSeed).toBe(true);
    expect(table.byKey.get('seeded_null')?.seed).toBeNull();
    expect(table.byKey.get('seeded_zero')?.hasSeed).toBe(true);
    expect(table.byKey.get('seeded_zero')?.seed).toBe(0);

    const declaredOnly = table.byKey.get('declared_only')!;
    expect(declaredOnly.hasSeed).toBe(false);
    // Not merely undefined: the property is absent, which is what
    // `exactOptionalPropertyTypes` makes a checkable difference.
    expect('seed' in declaredOnly).toBe(false);
    expect(declaredOnly.declaredAt.seed).toBeUndefined();
  });

  it('is empty for a block that declares no key', () => {
    const table = resolveKeyTable(storage({}));

    expect(table.entryList).toEqual([]);
    expect(table.byKey.size).toBe(0);
  });

  it('sweeps keys: in document order', () => {
    // The order is a diagnostic's determinism, and it is also the order the
    // budget's per-key report and the resolver's seed list come back in.
    const table = resolveKeyTable(
      storage({ keys: { third: {}, first: { seed: 1 }, second: { strategy: FIFO } } }),
    );

    expect(table.entryList.map((entry) => entry.key)).toEqual([
      'third',
      'first',
      'second',
    ]);
  });

  it('quotes a key that would not survive dot notation', () => {
    const table = resolveKeyTable(storage({ keys: { 'a.b': { seed: 1 } } }));

    expect(table.byKey.get('a.b')?.declaredAt).toEqual({
      key: 'storage.keys["a.b"]',
      strategy: 'storage.defaultStrategy',
      seed: 'storage.keys["a.b"].seed',
    });
  });
});

// ---------------------------------------------------------------------------
// The removed storage.strategies / storage.seed blocks
//
// `Storage` is closed, so the schema already rejects either — as "must not have
// additional properties", which names the field and says nothing about it
// having existed, having been removed, or having a replacement. `formatVersion`
// did not move for the removal, so these diagnostics are the whole of what an
// author holding an older example gets. They run ahead of the schema for that
// reason, and each prints the author's own keys and values as the `keys:` block
// that replaces theirs.
// ---------------------------------------------------------------------------

describe('storage.strategies and storage.seed — the removed-form diagnostics', () => {
  function problemFor(block: Record<string, unknown>): string {
    const result = validateWorkflowType(workflow(block), 'flow.yaml');
    expect(result.isErr()).toBe(true);
    return result._unsafeUnwrapErr().message;
  }

  it('runs BEFORE the schema — the message is the migration, not "unknown property"', () => {
    const message = problemFor({ seed: { sleep_ms: 500 } });

    expect(message).toContain('Storage validation failed in flow.yaml');
    expect(message).not.toContain('must not have additional properties');
  });

  it('names storage.strategies, says it was removed, and prints the keys: entry', () => {
    const message = problemFor({
      strategies: { queue_items: FIFO },
    });

    expect(message).toContain(
      'storage.strategies has been removed from the workflow format',
    );
    expect(message).toContain(
      "A key's strategy is declared on the key itself, in a storage.keys entry",
    );
    // The author's own key, with the author's own strategy block, as a snippet
    // the fix can be copied out of.
    expect(message).toContain(
      'Write it as a storage.keys entry:\n' +
        '      storage:\n' +
        '        keys:\n' +
        '          queue_items:\n' +
        '            strategy: {"name":"lmdb-fifo","queueSizeMax":1024,"valueSizeMax":1900}',
    );
  });

  it('names storage.seed, says it was removed, and prints the keys: entries', () => {
    const message = problemFor({ seed: { sleep_ms: 500, queue_items: ['a', 'b'] } });

    expect(message).toContain(
      'storage.seed has been removed from the workflow format',
    );
    expect(message).toContain(
      "A key's initial value is declared on the key itself, in a storage.keys entry",
    );
    expect(message).toContain(
      'Write them as storage.keys entries:\n' +
        '      storage:\n' +
        '        keys:\n' +
        '          sleep_ms:\n' +
        '            seed: 500\n' +
        '          queue_items:\n' +
        '            seed: ["a","b"]',
    );
  });

  it('says defaultStrategy is unaffected — it is not one of the removed forms', () => {
    // The likeliest over-correction: an author reading "two blocks are gone"
    // deleting the third one too.
    expect(problemFor({ seed: { sleep_ms: 500 } })).toContain(
      'storage.defaultStrategy is unaffected',
    );
  });

  it('reports both blocks in one pass, and says a shared key is ONE entry', () => {
    const message = problemFor({
      strategies: { queue_items: FIFO },
      seed: { queue_items: ['a'] },
    });

    expect(message).toContain('storage.strategies has been removed');
    expect(message).toContain('storage.seed has been removed');
    // Without this the two snippets read as two mappings under one key, which
    // is not a document.
    expect(message).toContain(
      '"queue_items" is also named in storage.seed: one key is one storage.keys ' +
        'entry, so put both fields in the one entry rather than writing it twice.',
    );
    expect(message).toContain('"queue_items" is also named in storage.strategies');
    expect(message.split('\n  - ')).toHaveLength(3);
  });

  it('quotes a key that would not survive a bare YAML mapping key', () => {
    expect(problemFor({ seed: { 'odd key': 1 } })).toContain('"odd key":\n');
  });

  it('reports a malformed block too — it is still a field the format lacks', () => {
    const message = problemFor({ strategies: 'nonsense' });

    expect(message).toContain('storage.strategies has been removed');
    expect(message).toContain('Move each key into storage.keys as a strategy: field.');
  });

  it('is silent on a document that declares neither', () => {
    expect(
      collectRemovedStorageBlockProblems(workflow({ keys: { q: { seed: 1 } } })),
    ).toEqual([]);
    // And tolerates a document that never reached the schema, like every other
    // pre-schema sweep.
    expect(collectRemovedStorageBlockProblems(undefined)).toEqual([]);
    expect(collectRemovedStorageBlockProblems({ storage: 'nonsense' })).toEqual([]);
  });
});

describe('validateStorageKeyTable — an entry read on its own', () => {
  it('accepts a document using only keys:', () => {
    expect(
      validateStorageKeyTable(
        workflow({ keys: { q: { strategy: FIFO, seed: ['a'] } } }) as Workflow,
      ).isOk(),
    ).toBe(true);
  });

  it('returns Ok on a document that never reached the schema', () => {
    expect(validateStorageKeyTable({} as Workflow).isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

describe('validateWorkflowType — keys: end to end', () => {
  it('accepts a document written in the keys: idiom', () => {
    const result = validateWorkflowType(
      workflow({
        keys: {
          sleep_ms: { seed: 500 },
          queue_items: { strategy: FIFO, seed: ['a', 'b', 'c'] },
          scratch: {},
        },
      }),
      'flow.yaml',
    );

    expect(result.isOk()).toBe(true);
  });

  it('names a stray strategy field inside a keys: entry', () => {
    // `BoxStrategy` is a union, so without the sweep reaching into `keys:` this
    // would come back as a branch dump naming neither the field nor the
    // strategy it belongs to.
    const result = validateWorkflowType(
      workflow({
        keys: { q: { strategy: { ...KV, queueSizeMax: 4 } } },
      }),
      'flow.yaml',
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('storage.keys.q.strategy sets "queueSizeMax"');
    expect(message).toContain('Did you mean name: lmdb-fifo?');
  });

  it('names a stray strategy field even though the sweep no longer reads strategies:', () => {
    // `collectStrategyBlockList` used to sweep `storage.strategies` as well.
    // Dropping that half must not cost the `keys:` half, which is the one the
    // format still has.
    const result = validateWorkflowType(
      workflow({
        keys: { a: { strategy: { ...KV, queueSizeMax: 4 } }, b: { strategy: FIFO } },
      }),
      'flow.yaml',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      'storage.keys.a.strategy sets "queueSizeMax"',
    );
  });
});

// ---------------------------------------------------------------------------
// Ownership on the key table
//
// `storage.keys.<key>.workflow` says whose box a key is. It is the third fact
// a `storage:` block states about a key, and the only one with a single idiom.
//
// The rule this block exists to pin is the write boundary: **a key declaring
// `workflow:` MUST NOT appear in any step's `outputs:` or `errors:`.** It has
// two enforcement layers that must both hold — `WriteBoxLocation` structurally
// incapable of naming a workflow, and a verify-time refusal that names the key,
// the declaration and the binding — so both are asserted here, the structural
// one first because the other is only the *diagnostic* for a thing the model
// already cannot express.
// ---------------------------------------------------------------------------

const writeLocationValidator = Compile(WriteBoxLocation);

/** A step that binds `key` in `role`, for the boundary cases below. */
function stepBinding(role: string, ref: unknown): Record<string, unknown> {
  return {
    label: 'worker',
    plugin: '@rawbox/rawbox-plugin-default',
    operation: 'time/sleep',
    [role]: { field: ref },
  };
}

describe('storage.keys.workflow — the write boundary', () => {
  it('WriteBoxLocation still has no workflow field — the boundary is structural', () => {
    // The half of the rule that survives a bypassed verifier: even if every
    // check below were removed, the resolved model has nowhere to say that a
    // write goes to another workflow. Moving the *declaration* onto the key
    // table changed where the rule is checked, not what can be expressed.
    expect(writeLocationValidator.Check({ key: 'k', strategy: KV })).toBe(true);
    expect(
      writeLocationValidator.Check({ key: 'k', strategy: KV, workflow: 'other-flow' }),
    ).toBe(false);
  });

  it('rejects an outputs: binding on a key another workflow owns, naming all three sites', () => {
    const result = validateWorkflowType(
      workflowWithSteps(
        { keys: { shared_state: { workflow: 'other-flow' } } },
        [stepBinding('outputs', 'shared_state')],
      ),
      'flow.yaml',
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;

    // The key, the declaration site, and the binding that tried to write it.
    expect(message).toContain('storage key "shared_state"');
    expect(message).toContain('storage.keys.shared_state.workflow');
    expect(message).toContain('steps[0].outputs.field (step "worker")');
    expect(message).toContain('A step may only write into its own workflow');
    // The remedy names both ways out, and does not pick one.
    expect(message).toContain('Either drop storage.keys.shared_state.workflow');
    expect(message).toContain('reading it here with an inputs: binding');
  });

  it('rejects an errors: binding on a foreign key too — errors are writes', () => {
    const result = validateStorageOwnership(
      workflowWithSteps(
        { keys: { shared_state: { workflow: 'other-flow' } } },
        [stepBinding('errors', { key: 'shared_state' })],
      ) as Workflow,
      'flow.yaml',
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      'steps[0].errors.field (step "worker") names storage key "shared_state" in errors:',
    );
  });

  it('accepts an inputs: binding on a foreign key — reading is the whole point', () => {
    const result = validateWorkflowType(
      workflowWithSteps(
        { keys: { shared_state: { workflow: 'other-flow' }, sleep_ms: { seed: 1 } } },
        [stepBinding('inputs', 'shared_state')],
      ),
      'flow.yaml',
    );

    expect(result.isOk()).toBe(true);
  });

  it('reports every offending binding in one pass', () => {
    const result = validateStorageOwnership(
      workflowWithSteps({ keys: { a: { workflow: 'other-flow' } } }, [
        stepBinding('outputs', 'a'),
        stepBinding('errors', 'a'),
      ]) as Workflow,
    );

    expect(result._unsafeUnwrapErr().message.split('\n  - ')).toHaveLength(3);
  });
});

describe('storage.keys.workflow — the binding long form still exists, and must agree', () => {
  it('rejects a binding naming a different owner from the key table', () => {
    const result = validateWorkflowType(
      workflowWithSteps({ keys: { shared: { workflow: 'flow-a' } } }, [
        stepBinding('inputs', { key: 'shared', workflow: 'flow-b' }),
      ]),
      'flow.yaml',
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;

    expect(message).toContain('reads storage key "shared" from workflow "flow-b"');
    expect(message).toContain(
      'storage.keys.shared.workflow declares that key to belong to workflow "flow-a"',
    );
    // Never a precedence rule: neither side is declared the winner.
    expect(message).toContain('A key belongs to one workflow');
    expect(message).toContain('Say it once');
  });

  it('accepts a binding that agrees — a restatement is not a conflict', () => {
    const result = validateWorkflowType(
      workflowWithSteps(
        { keys: { shared: { workflow: 'flow-a' }, sleep_ms: { seed: 1 } } },
        [stepBinding('inputs', { key: 'shared', workflow: 'flow-a' })],
      ),
      'flow.yaml',
    );

    expect(result.isOk()).toBe(true);
  });

  it('leaves a binding-only cross-workflow read untouched — the key table says nothing', () => {
    // The form that predates the key table, and the one thing the key table
    // cannot express: two bindings reading the same key *name* from two
    // different workflows are two different boxes.
    const result = validateWorkflowType(
      workflowWithSteps({ keys: { sleep_ms: { seed: 1 } } }, [
        stepBinding('inputs', { key: 'metrics', workflow: 'flow-a' }),
        stepBinding('inputs', { key: 'metrics', workflow: 'flow-b' }),
      ]),
      'flow.yaml',
    );

    expect(result.isOk()).toBe(true);
  });
});

describe('storage.keys.workflow — an entry that contradicts itself', () => {
  it('rejects workflow: beside seed:, saying why seeding cannot reach another store', () => {
    const result = validateWorkflowType(
      workflow({ keys: { shared: { workflow: 'other-flow', seed: 42 } } }),
      'flow.yaml',
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;

    expect(message).toContain(
      'Storage key "shared" is seeded at storage.keys.shared.seed',
    );
    expect(message).toContain('A seed is a write');
    expect(message).toContain(
      'there is no form of it that can put a value into another workflow\'s box',
    );
    expect(message).toContain('Say one of the two things');
  });

  it('rejects a key naming its own workflow rather than treating it as a no-op', () => {
    const result = validateWorkflowType(
      workflow({ keys: { mine: { workflow: 'example' } } }),
      'flow.yaml',
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;

    expect(message).toContain(
      'Storage key "mine" declares storage.keys.mine.workflow: "example", which is this workflow\'s own name',
    );
    expect(message).toContain('Delete storage.keys.mine.workflow');
  });

  it('accepts an entry stating only workflow: — it declares the key and its owner', () => {
    // The one entry shape that states a fact and nothing measurable: no
    // strategy, no seed, and still a real declaration.
    const result = validateStorageKeyTable(
      workflow({ keys: { shared: { workflow: 'other-flow' } } }) as Workflow,
    );

    expect(result.isOk()).toBe(true);
    const entry = resolveKeyTable(
      storage({ keys: { shared: { workflow: 'other-flow' } } }),
    ).byKey.get('shared')!;
    expect(entry.hasSeed).toBe(false);
    expect(entry.strategy).toEqual(KV);
    expect(entry.declaredAt.workflow).toBe('storage.keys.shared.workflow');
  });
});

describe('storage.keys.workflow — the schema and the table', () => {
  it('accepts workflow: on an entry, and rejects an empty name', () => {
    expect(
      storageValidator.Check(storage({ keys: { k: { workflow: 'other-flow' } } })),
    ).toBe(true);
    // An empty name is treated as absent by `buildBoxRecord`, which would
    // silently make another workflow's box this one's.
    expect(storageValidator.Check(storage({ keys: { k: { workflow: '' } } }))).toBe(
      false,
    );
  });

  it('resolves the owner and its declaration site onto the entry', () => {
    const table = resolveKeyTable(
      storage({ keys: { shared: { strategy: FIFO, workflow: 'other-flow' } } }),
    );

    const entry = table.byKey.get('shared')!;
    expect(entry.workflow).toBe('other-flow');
    expect(entry.declaredAt.workflow).toBe('storage.keys.shared.workflow');
    // Absence is the whole of "this workflow's": no companion boolean.
    expect(
      resolveKeyTable(storage({ keys: { mine: {} } })).byKey.get('mine'),
    ).not.toHaveProperty('workflow');
  });

  it('reads ownership from a document that never reached the schema', () => {
    // `resolveKeyOwnerMap` feeds the binding sweeps, which run ahead of the
    // schema — so a malformed block is *not an ownership declaration*, never a
    // throw.
    expect(resolveKeyOwnerMap(undefined).size).toBe(0);
    expect(resolveKeyOwnerMap({ keys: 'nonsense' }).size).toBe(0);
    expect(resolveKeyOwnerMap({ keys: { k: { workflow: 7 } } }).size).toBe(0);
    expect(resolveKeyOwnerMap({ keys: { k: { workflow: '' } } }).size).toBe(0);
    expect(
      resolveKeyOwnerMap({ keys: { 'odd key': { workflow: 'o' } } }).get('odd key'),
    ).toEqual({ workflow: 'o', declaredAt: 'storage.keys["odd key"].workflow' });
  });
});

describe('storage.keys.workflow — the three rules that used to walk bindings', () => {
  const FOREIGN = {
    keys: {
      shared: { strategy: KV, workflow: 'other-flow' },
      sleep_ms: { seed: 500 },
    },
  };

  const readsShared = [stepBinding('inputs', 'shared')];

  it('the read-set view: a BARE binding on a foreign key is a cross-workflow read', () => {
    // The case the old per-binding form could not express at all: nothing
    // about `inputs: { field: shared }` marks it, so before ownership moved to
    // the key table this binding was indistinguishable from a local read.
    const document = workflowWithSteps(FOREIGN, readsShared);

    const [binding] = collectStorageBindingList(document);
    expect(binding).toMatchObject({
      key: 'shared',
      bindingWorkflow: undefined,
      keyWorkflow: 'other-flow',
      owningWorkflow: 'other-flow',
      crossWorkflow: true,
    });

    expect(collectBoundStorageKeys(document)).toEqual([]);
  });

  it('the budget: a foreign key is not charged to this workflow, bound or not', () => {
    const withForeign = budgetForStorage({
      ...boxStorageFor(storage(FOREIGN)),
      boundKeyList: collectBoundStorageKeys(workflowWithSteps(FOREIGN, readsShared)),
    });
    const withoutIt = budgetForStorage({
      ...boxStorageFor(storage({ keys: { sleep_ms: { seed: 500 } } })),
      boundKeyList: [],
    });

    expect(withForeign.keyBudgetList).toEqual(withoutIt.keyBudgetList);
    expect(withForeign.dataBytesMax).toBe(withoutIt.dataBytesMax);
  });

  it('the unwritten-read exemption: a foreign key needs no seed and no writer here', () => {
    expect(
      validateStorageSizes(workflowWithSteps(FOREIGN, readsShared) as Workflow).isOk(),
    ).toBe(true);

    // And the mirror: drop the ownership and the same document is rejected,
    // so the exemption is doing the work rather than the key being ignored.
    const localised = {
      keys: { shared: { strategy: KV }, sleep_ms: { seed: 500 } },
    };
    expect(
      validateStorageSizes(workflowWithSteps(localised, readsShared) as Workflow).isErr(),
    ).toBe(true);
  });

  it('the unwritten-read remedy now offers the key table as well as the binding', () => {
    const message = validateStorageSizes(
      workflowWithSteps({ keys: { sleep_ms: { seed: 500 } } }, readsShared) as Workflow,
    )._unsafeUnwrapErr().message;

    expect(message).toContain('set storage.keys.shared.workflow to that workflow\'s name');
    expect(message).toContain('{ key: shared, workflow: <workflow name> }');
  });

  it('the co-transactional rule: a foreign redis key is not this workflow\'s store split', () => {
    // Another workflow's box lives in another workflow's store by definition,
    // and is not part of this workflow's transaction — so an LMDB workflow may
    // read a Redis box someone else owns.
    const result = validateWorkflowType(
      workflowWithSteps(
        {
          keys: {
            cache_entry: {
              strategy: { name: 'redis-kv', valueSizeMax: 1900, backend: 'main' },
              workflow: 'other-flow',
            },
            sleep_ms: { seed: 500 },
          },
        },
        [stepBinding('inputs', 'cache_entry')],
      ),
      'flow.yaml',
    );

    expect(result.isOk()).toBe(true);

    // The same strategy declared as *this* workflow's key is still a split.
    const owned = validateWorkflowType(
      workflow({
        keys: {
          cache_entry: {
            strategy: { name: 'redis-kv', valueSizeMax: 1900, backend: 'main' },
          },
          sleep_ms: { seed: 500 },
        },
      }),
      'flow.yaml',
    );
    expect(owned.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Every reader reads the table
//
// A previous task added `storage.keys` and `resolveKeyTable` but migrated no
// reader — every per-key rule still consulted the `storage.strategies` /
// `storage.seed` shorthand directly, so a `keys:` declaration was silently
// invisible to all of them. The shorthand is now gone, which means those
// readers have no second block left to fall back to: a reader that stopped
// consulting the table would see *nothing*, not the wrong half. That makes
// this block sharper than when it was written as an equivalence, and every
// case below is stated as a behaviour rather than as an agreement between two
// spellings of one document.
// ---------------------------------------------------------------------------

describe('every reader reads the key table', () => {
  const KEY_BLOCK = {
    keys: {
      queue_items: { strategy: FIFO, seed: ['a', 'b', 'c'] },
      sleep_ms: { seed: 500 },
    },
  };

  it('the budget: boxStorageFor is what carries keys: across the store boundary', () => {
    // THE landmine. `budgetForStorage` takes `BoxStorage` — `{ defaultStrategy,
    // strategies?, seed?, boundKeyList? }` — structurally, and every field past
    // the first is optional, so spreading an authoring `storage:` block
    // straight into it still TYPE-CHECKS and silently charges nothing at all.
    // `boxStorageFor` is the only thing between the two shapes.
    const viaSeam = budgetForStorage(boxStorageFor(storage(KEY_BLOCK)));

    expect(viaSeam.keyBudgetList.map((keyBudget) => keyBudget.key)).toEqual([
      'queue_items',
      'sleep_ms',
    ]);
    // The FIFO's 999-slot arithmetic actually running, not an empty budget.
    expect(viaSeam.dataBytesMax).toBeGreaterThan(0);

    const raw = budgetForStorage(storage(KEY_BLOCK) as never);
    expect(raw.keyBudgetList).toEqual([]);
    expect(raw.dataBytesMax).toBe(0);
  });

  it('the budget: a bound key is counted once, alongside the declared keys', () => {
    const boundSteps = [
      {
        label: 'reader',
        plugin: '@rawbox/rawbox-plugin-default',
        operation: 'time/sleep',
        inputs: { ms: 'sleep_ms' },
        outputs: { timestamp: 'bound_only_key' },
      },
    ];

    const document = workflowWithSteps(KEY_BLOCK, boundSteps) as Workflow;
    const budget = budgetForStorage({
      ...boxStorageFor(document.storage),
      boundKeyList: collectBoundStorageKeys(document),
    });

    expect(
      budget.keyBudgetList.map((keyBudget) => [keyBudget.key, keyBudget.source]),
    ).toEqual([
      ['queue_items', 'declared'],
      ['sleep_ms', 'declared'],
      ['bound_only_key', 'bound'],
    ]);
  });

  it('the size rules: an over-limit seed is reported against the keys: paths', () => {
    const result = validateStorageSizes(
      workflow({
        keys: {
          ticker: {
            strategy: { name: 'lmdb-kv', valueSizeMax: 100 },
            seed: 'x'.repeat(200),
          },
        },
      }) as Workflow,
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('storage.keys.ticker.seed');
    expect(message).toContain('storage.keys.ticker.strategy');
    expect(message).toContain('valueSizeMax of 100');
  });

  it('the size rules: a malformed FIFO seed is reported against the keys: paths', () => {
    const result = validateStorageSizes(
      workflow({
        keys: { queue_items: { strategy: FIFO, seed: 'not-a-list' } },
      }) as Workflow,
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('storage.keys.queue_items.seed is a string');
    expect(message).toContain('MUST be a list');
  });

  it('a FIFO seed IS expanded — each element is checked, not the list whole', () => {
    // `descriptorFor(strategy).seedExpandsList` fires off `entry.strategy`,
    // which is only correct once the entry's own `strategy:` reaches the check
    // rather than `defaultStrategy` silently standing in. An over-limit
    // *element* is caught, which is only possible once the list is walked.
    const result = validateStorageSizes(
      workflow({
        keys: {
          q: {
            strategy: { name: 'lmdb-fifo', queueSizeMax: 8, valueSizeMax: 100 },
            seed: ['ok', 'x'.repeat(200)],
          },
        },
      }) as Workflow,
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('storage.keys.q.seed[1]');
    expect(message).toContain('valueSizeMax of 100');
  });

  it('the unwritten-read rule: a seeded key read by an input is NOT reported', () => {
    const readsSleepMs = [
      {
        label: 'reader',
        plugin: '@rawbox/rawbox-plugin-default',
        operation: 'time/sleep',
        inputs: { ms: 'sleep_ms' },
      },
    ];

    expect(
      validateStorageSizes(
        workflowWithSteps({ keys: { sleep_ms: { seed: 500 } } }, readsSleepMs) as Workflow,
      ).isOk(),
    ).toBe(true);
  });

  it('the unwritten-read rule: a declared-but-unseeded key IS reported', () => {
    // The mirror case: an entry that names a strategy but no seed does not
    // supply the key — declaring a box says how it stores, not that anything
    // ever puts something in it.
    const readsCell = [
      {
        label: 'reader',
        plugin: '@rawbox/rawbox-plugin-default',
        operation: 'time/sleep',
        inputs: { ms: 'cell' },
      },
    ];

    const result = validateStorageSizes(
      workflowWithSteps({ keys: { cell: { strategy: KV } } }, readsCell) as Workflow,
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('reads storage key "cell"');
    expect(message).toContain('no storage.keys entry seeds it');
    // The remedy points at the entry the key is already declared under.
    expect(message).toContain('seed it — set storage.keys.cell.seed');
  });

  it('the unwritten-read remedy names the keys: entry for an undeclared key too', () => {
    const readsGhost = [
      {
        label: 'reader',
        plugin: '@rawbox/rawbox-plugin-default',
        operation: 'time/sleep',
        inputs: { ms: 'ghost' },
      },
    ];

    expect(
      validateStorageSizes(workflowWithSteps({}, readsGhost) as Workflow)
        ._unsafeUnwrapErr()
        .message,
    ).toContain('seed it — set storage.keys.ghost.seed');
  });

  it('the co-transactional rule: a redis-* strategy under keys: IS caught', () => {
    // `collectStoreParticipantList` reaches every declared strategy through the
    // table; a reader that stopped consulting it would find no participant at
    // all and this document would verify clean, then fail on the first
    // step-to-step hand-off at run time.
    const result = validateWorkflowType(
      workflow({
        keys: {
          cache_entry: {
            strategy: { name: 'redis-kv', valueSizeMax: 1900, backend: 'main' },
          },
          sleep_ms: { seed: 500 },
        },
      }),
      'flow.yaml',
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('are in different stores');
    expect(message).toContain('storage key "cache_entry"');
    expect(message).toContain('declared at storage.keys.cache_entry.strategy');
    expect(message).toContain('the Redis server named by backend: "main"');
  });
});
