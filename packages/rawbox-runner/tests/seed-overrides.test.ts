import { describe, it, expect } from 'vitest';
import { Compile } from 'typebox/compile';

import { ContractRegistryCache } from '@rawbox/plugin/core';

import { Workspace } from '../src/workspace/workspace-types.js';
import {
  applySeedOverrides,
  collectSeedOverridePathProblems,
  formatSeedOverridePathProblems,
  seedOverrideLayerFor,
  summarizeAppliedSeedOverrides,
  type SeedOverrideLayer,
} from '../src/workspace/seed-overrides.js';
import { resolveWorkflow } from '../src/workflow/resolver.js';
import { resolveKeyTable } from '../src/workflow/key-table.js';
import {
  checkFifoSeedIsList,
  checkFifoSeedLength,
  checkValueSize,
} from '../src/workflow/validation.js';
import type { Workflow } from '../src/workflow/workflow-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const workspaceValidator = Compile(Workspace);

const KV = { name: 'lmdb-kv', valueSizeMax: 1900 } as const;
const SMALL_KV = { name: 'lmdb-kv', valueSizeMax: 8 } as const;
const FIFO = { name: 'lmdb-fifo', queueSizeMax: 4, valueSizeMax: 1900 } as const;

const WORKFLOW_SOURCE = '/repo/flows/example.workflow.yaml';
const WORKSPACE_SOURCE = '/repo/workspace.yaml';
/** The directory holding the workspace document — the base every path in it resolves against. */
const WORKSPACE_DIR = '/repo';
/** The workflow as `workflowPathList` spells it, and as `seedOverrides:` is keyed by. */
const WORKFLOW_ENTRY = './flows/example.workflow.yaml';
/** The block path every per-key diagnostic is built from — the AUTHORED spelling, quoted. */
const BLOCK_PATH = `seedOverrides["${WORKFLOW_ENTRY}"]`;

/** A minimal, schema-valid workflow carrying `block` as its `storage:`. */
function makeWorkflow(block: Record<string, unknown>, name = 'example'): Workflow {
  return {
    kind: 'Workflow',
    formatVersion: '1.0',
    name,
    plugins: {},
    storage: { defaultStrategy: KV, ...block },
    steps: [],
  } as unknown as Workflow;
}

/**
 * The layer a workspace `seedOverrides:` block supplies for the workflow at
 * {@link WORKFLOW_SOURCE} — selected by that workflow's own path, which is the
 * whole of the keying change.
 */
function layerFor(
  valueRecord: Record<string, unknown>,
  entry = WORKFLOW_ENTRY,
): SeedOverrideLayer {
  const layer = seedOverrideLayerFor({
    seedOverrides: { [entry]: valueRecord },
    workflowPath: WORKFLOW_SOURCE,
    workspaceDir: WORKSPACE_DIR,
    source: WORKSPACE_SOURCE,
  });
  if (layer === undefined) throw new Error('expected a layer');
  return layer;
}

function apply(
  workflow: Workflow,
  valueRecord: Record<string, unknown>,
): ReturnType<typeof applySeedOverrides> {
  return applySeedOverrides({
    workflow,
    workflowSource: WORKFLOW_SOURCE,
    layerList: [layerFor(valueRecord)],
  });
}

function expectMerged(
  workflow: Workflow,
  valueRecord: Record<string, unknown>,
): Workflow {
  const result = apply(workflow, valueRecord);
  if (result.isErr()) throw new Error(`expected ok, got:\n${result.error}`);
  return result.value;
}

function expectRefused(
  workflow: Workflow,
  valueRecord: Record<string, unknown>,
): string {
  const result = apply(workflow, valueRecord);
  if (result.isOk()) {
    throw new Error(`expected err, got:\n${JSON.stringify(result.value, null, 2)}`);
  }
  return result.error;
}

/** The seed each key resolves to after the merge, by key. */
function seedByKey(workflow: Workflow): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const entry of resolveKeyTable(workflow.storage).entryList) {
    if (entry.hasSeed) record[entry.key] = entry.seed;
  }
  return record;
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

function workspace(block: Record<string, unknown>): unknown {
  return {
    kind: 'Workspace',
    name: 'demo',
    workflowPathList: [WORKFLOW_ENTRY],
    ...block,
  };
}

describe('seedOverrides — schema', () => {
  it('accepts a path-keyed block of arbitrary seed values', () => {
    expect(
      workspaceValidator.Check(
        workspace({
          seedOverrides: {
            [WORKFLOW_ENTRY]: { sleep_ms: 500, queue_items: ['a', 'b'], flag: null },
          },
        }),
      ),
    ).toBe(true);
  });

  it('accepts a workspace that declares none', () => {
    expect(workspaceValidator.Check(workspace({}))).toBe(true);
  });

  it('rejects a flat key -> value map, which would hit every workflow', () => {
    expect(workspaceValidator.Check(workspace({ seedOverrides: { sleep_ms: 500 } }))).toBe(
      false,
    );
  });

  it('keeps Workspace closed — a widened field name is still refused', () => {
    expect(
      workspaceValidator.Check(
        workspace({ overrides: { [WORKFLOW_ENTRY]: { sleep_ms: 1 } } }),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 1 — may only replace a seed the workflow already declares
// ---------------------------------------------------------------------------

describe('applySeedOverrides — replacing a declared seed', () => {
  it('replaces the value in the keys: entry, leaving the authored document alone', () => {
    const workflow = makeWorkflow({ keys: { sleep_ms: { seed: 2000 } } });

    const merged = expectMerged(workflow, { sleep_ms: 500 });

    expect(seedByKey(merged)).toEqual({ sleep_ms: 500 });
    expect(merged.storage.keys?.sleep_ms?.seed).toBe(500);
    // The authored document is untouched.
    expect(seedByKey(workflow)).toEqual({ sleep_ms: 2000 });
    // `declaredAt` still names the field the author wrote, so every later
    // diagnostic points at something the document contains.
    expect(
      resolveKeyTable(merged.storage).byKey.get('sleep_ms')?.declaredAt.seed,
    ).toBe('storage.keys.sleep_ms.seed');
  });

  it('leaves a strategy: and a workflow: beside the seed intact', () => {
    // The substitution is of one field, not of the entry: an entry that also
    // declares how the key stores must not lose that in the merge.
    const workflow = makeWorkflow({
      keys: { queue_items: { strategy: FIFO, seed: ['a'] } },
    });

    const merged = expectMerged(workflow, { queue_items: ['b', 'c'] });

    expect(merged.storage.keys?.queue_items).toEqual({
      strategy: FIFO,
      seed: ['b', 'c'],
    });
  });

  it('replaces whole and never deep-merges', () => {
    const workflow = makeWorkflow({ keys: { config: { seed: { a: 0, b: 2 } } } });

    const merged = expectMerged(workflow, { config: { a: 1 } });

    expect(seedByKey(merged)).toEqual({ config: { a: 1 } });
  });

  it('replaces a seed whose value is null, and can replace one with null', () => {
    const workflow = makeWorkflow({ keys: { flag: { seed: null } } });

    expect(seedByKey(expectMerged(workflow, { flag: 1 }))).toEqual({ flag: 1 });
    expect(
      seedByKey(expectMerged(makeWorkflow({ keys: { flag: { seed: 1 } } }), { flag: null })),
    ).toEqual({ flag: null });
  });

  it('returns the very same object when no layer supplies anything', () => {
    const workflow = makeWorkflow({ keys: { sleep_ms: { seed: 2000 } } });

    const result = applySeedOverrides({
      workflow,
      workflowSource: WORKFLOW_SOURCE,
      layerList: [],
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(workflow);
  });

  it('lets a later layer replace an earlier one, key by key', () => {
    const workflow = makeWorkflow({ keys: { sleep_ms: { seed: 2000 }, retries: { seed: 1 } } });

    const result = applySeedOverrides({
      workflow,
      workflowSource: WORKFLOW_SOURCE,
      layerList: [
        layerFor({ sleep_ms: 500, retries: 2 }),
        { ...layerFor({ sleep_ms: 10 }), blockPath: 'seed', source: '<cli>' },
      ],
    });

    expect(seedByKey(result._unsafeUnwrap())).toEqual({ sleep_ms: 10, retries: 2 });
  });
});

describe('summarizeAppliedSeedOverrides', () => {
  it('reports no key when the layer list is empty', () => {
    expect(summarizeAppliedSeedOverrides([])).toEqual([]);
  });

  it("reports each key with its layer's source when only one layer names it", () => {
    const workflow = makeWorkflow({ keys: { sleep_ms: { seed: 2000 }, retries: { seed: 1 } } });
    const layerList = [layerFor({ sleep_ms: 500, retries: 2 })];

    // Same precondition every call site relies on: only call this once
    // `applySeedOverrides` has returned `ok` for the exact same `layerList`.
    expect(
      applySeedOverrides({ workflow, workflowSource: WORKFLOW_SOURCE, layerList }).isOk(),
    ).toBe(true);

    expect(summarizeAppliedSeedOverrides(layerList)).toEqual(
      expect.arrayContaining([
        { key: 'sleep_ms', source: WORKSPACE_SOURCE },
        { key: 'retries', source: WORKSPACE_SOURCE },
      ]),
    );
  });

  it('reports the later (CLI-style) layer as the source for a key both layers name — the same precedence applySeedOverrides applies', () => {
    const workflow = makeWorkflow({ keys: { sleep_ms: { seed: 2000 }, retries: { seed: 1 } } });
    const cliLayer: SeedOverrideLayer = {
      ...layerFor({ sleep_ms: 10 }),
      blockPath: '--seed',
      source: 'the --seed flag',
    };
    const layerList = [layerFor({ sleep_ms: 500, retries: 2 }), cliLayer];

    const result = applySeedOverrides({
      workflow,
      workflowSource: WORKFLOW_SOURCE,
      layerList,
    });
    expect(result.isOk()).toBe(true);
    // The merge itself picked the CLI layer's value for `sleep_ms`…
    expect(seedByKey(result._unsafeUnwrap())).toEqual({ sleep_ms: 10, retries: 2 });

    // …and the summary attributes that exact key to that exact layer, not to
    // the workspace layer that also named it. One reduction, used by both —
    // see `reduceOverrideLayers`'s own doc for why the two can never disagree.
    expect(summarizeAppliedSeedOverrides(layerList)).toEqual(
      expect.arrayContaining([
        { key: 'sleep_ms', source: 'the --seed flag' },
        { key: 'retries', source: WORKSPACE_SOURCE },
      ]),
    );
  });
});

describe('applySeedOverrides — a key the workflow does not seed', () => {
  it('refuses an override on a declared but unseeded key', () => {
    const workflow = makeWorkflow({ keys: { counter: { strategy: KV } } });

    const error = expectRefused(workflow, { counter: 7 });

    expect(error).toContain(
      'Seed override for storage key "counter" has nothing to replace: workflow ' +
        '"example" declares that key but does not seed it.',
    );
    expect(error).toContain(`${BLOCK_PATH}.counter`);
    expect(error).toContain(WORKSPACE_SOURCE);
    expect(error).toContain(WORKFLOW_SOURCE);
    expect(error).toContain('storage.keys.counter');
    // The reason, not merely the refusal.
    expect(error).toContain('RESET that key on every run');
  });

  it('offers the seed: field inside the entry the key is already declared in', () => {
    // The remedy stays inside the block the author has open, whether the entry
    // states a strategy or nothing at all.
    expect(
      expectRefused(makeWorkflow({ keys: { counter: { strategy: KV } } }), { counter: 7 }),
    ).toContain('Set storage.keys.counter.seed to the value');
    expect(
      expectRefused(makeWorkflow({ keys: { counter: {} } }), { counter: 7 }),
    ).toContain('Set storage.keys.counter.seed to the value');
  });

  it('refuses an override on a key declared nowhere', () => {
    const workflow = makeWorkflow({ keys: { sleep_ms: { seed: 2000 } } });

    const error = expectRefused(workflow, { typo_ms: 500 });

    expect(error).toContain(
      'Seed override for storage key "typo_ms" has nothing to replace: workflow ' +
        '"example" does not declare that key at all.',
    );
    expect(error).toContain('the key appears nowhere in storage:');
    // The keys that could have been meant.
    expect(error).toContain('Keys that workflow seeds: "sleep_ms".');
  });

  it('says so when the workflow seeds nothing at all', () => {
    const error = expectRefused(makeWorkflow({}), { sleep_ms: 500 });

    expect(error).toContain('seeds no key at all');
  });

  it('refuses an override on a key another workflow owns, twice over', () => {
    const workflow = makeWorkflow({
      keys: { shared_state: { workflow: 'other-flow' } },
    });

    const error = expectRefused(workflow, { shared_state: 1 });

    expect(error).toContain(
      'Seed override for storage key "shared_state" cannot be applied: workflow ' +
        '"example" declares that key to belong to workflow "other-flow".',
    );
    expect(error).toContain('storage.keys.shared_state.workflow');
    expect(error).toContain('refused twice over');
    expect(error).toContain('not seedable at all');
    // Where it CAN be overridden. The owner is named, but its block path is
    // deliberately described rather than rendered: this document names a
    // sibling by NAME while the workspace keys blocks by PATH, and this
    // function holds only the workflow document.
    expect(error).toContain(
      'under the workspace\'s seedOverrides: block for workflow "other-flow"',
    );
    expect(error).toContain("that workflow's path in workflowPathList");
    expect(error).toContain('"shared_state"');
  });

  it('reports every offending key in one pass', () => {
    const workflow = makeWorkflow({ keys: { sleep_ms: { seed: 2000 } } });

    const error = expectRefused(workflow, { alpha: 1, beta: 2 });

    expect(error).toContain('"alpha"');
    expect(error).toContain('"beta"');
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — re-validated against the workflow's declared strategy, through the
// very checks the workflow's own seed goes through
// ---------------------------------------------------------------------------

describe('applySeedOverrides — re-validation against the declared strategy', () => {
  it('refuses a non-list override on a list-expanding key, with the shared sentence', () => {
    const workflow = makeWorkflow({
      keys: { queue_items: { strategy: FIFO, seed: ['a'] } },
    });

    const error = expectRefused(workflow, { queue_items: 'a' });

    // Byte-identical to what the workflow's own seed would produce, differing
    // only in the subject — which names the override.
    expect(error).toContain(
      checkFifoSeedIsList({
        value: 'a',
        strategy: FIFO,
        subject: `${BLOCK_PATH}.queue_items`,
        strategyLabel: 'storage.keys.queue_items.strategy',
      })!,
    );
    expect(error).toContain('That value is a seed override written in');
    expect(error).toContain(WORKSPACE_SOURCE);
    expect(error).toContain(WORKFLOW_SOURCE);
  });

  it('refuses an override that exceeds the queue capacity, with the shared sentence', () => {
    const workflow = makeWorkflow({
      keys: { queue_items: { strategy: FIFO, seed: ['a'] } },
    });

    const tooMany = ['a', 'b', 'c', 'd'];
    const error = expectRefused(workflow, { queue_items: tooMany });

    expect(error).toContain(
      checkFifoSeedLength({
        entryList: tooMany,
        strategy: FIFO,
        subject: `${BLOCK_PATH}.queue_items`,
        strategyLabel: 'storage.keys.queue_items.strategy',
      })!,
    );
  });

  it('refuses an over-large element of a list override, naming the element', () => {
    const smallFifo = { name: 'lmdb-fifo', queueSizeMax: 8, valueSizeMax: 8 } as const;
    const workflow = makeWorkflow({
      keys: { queue_items: { strategy: smallFifo, seed: ['a'] } },
    });

    const error = expectRefused(workflow, { queue_items: ['a', 'x'.repeat(64)] });

    expect(error).toContain(
      checkValueSize({
        value: 'x'.repeat(64),
        strategy: smallFifo,
        subject: `${BLOCK_PATH}.queue_items[1]`,
        strategyLabel: 'storage.keys.queue_items.strategy',
        note:
          `Each element of an lmdb-fifo seed becomes one queue entry, ` +
          `so valueSizeMax bounds the element rather than the whole list.`,
      })!,
    );
  });

  it('refuses an over-large cell override, with the shared sentence', () => {
    const workflow = makeWorkflow({
      keys: { blob: { strategy: SMALL_KV, seed: 'ok' } },
    });

    const error = expectRefused(workflow, { blob: 'x'.repeat(64) });

    expect(error).toContain(
      checkValueSize({
        value: 'x'.repeat(64),
        strategy: SMALL_KV,
        subject: `${BLOCK_PATH}.blob`,
        strategyLabel: 'storage.keys.blob.strategy',
      })!,
    );
  });

  it('checks against the strategy the WORKFLOW declares, which no override can change', () => {
    // The key's strategy comes from `keys:`, not from `defaultStrategy`, and the
    // list rule follows it.
    const workflow = makeWorkflow({
      keys: { queue_items: { strategy: FIFO, seed: ['a'] } },
    });

    const error = expectRefused(workflow, { queue_items: 5 });

    expect(error).toContain('storage.keys.queue_items.strategy');
    expect(error).toContain('MUST be a list');
  });
});

// ---------------------------------------------------------------------------
// The merged view is what the resolver expands
// ---------------------------------------------------------------------------

describe('applySeedOverrides — end to end through resolveWorkflow', () => {
  it('produces the overridden Seed rather than the authored one', () => {
    const workflow = makeWorkflow({ keys: { sleep_ms: { seed: 2000 } } });
    const merged = expectMerged(workflow, { sleep_ms: 500 });

    const resolved = resolveWorkflow(merged, new ContractRegistryCache(), {});

    expect(resolved._unsafeUnwrap().seedData).toEqual([
      { key: 'sleep_ms', strategy: KV, value: 500 },
    ]);
  });

  it('expands a FIFO override into one Seed per element', () => {
    const workflow = makeWorkflow({
      keys: { queue_items: { strategy: FIFO, seed: ['a'] } },
    });
    const merged = expectMerged(workflow, { queue_items: ['x', 'y', 'z'] });

    const resolved = resolveWorkflow(merged, new ContractRegistryCache(), {});

    expect(resolved._unsafeUnwrap().seedData).toEqual([
      { key: 'queue_items', strategy: FIFO, value: 'x' },
      { key: 'queue_items', strategy: FIFO, value: 'y' },
      { key: 'queue_items', strategy: FIFO, value: 'z' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Selecting a workflow's block, and naming one that is not here
// ---------------------------------------------------------------------------

describe('seedOverrideLayerFor', () => {
  it("selects only the block whose path resolves to the workflow's own", () => {
    const seedOverrides = {
      [WORKFLOW_ENTRY]: { sleep_ms: 500 },
      './flows/other.workflow.yaml': { sleep_ms: 1 },
    };

    expect(
      seedOverrideLayerFor({
        seedOverrides,
        workflowPath: WORKFLOW_SOURCE,
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      })?.valueRecord,
    ).toEqual({ sleep_ms: 500 });

    expect(
      seedOverrideLayerFor({
        seedOverrides,
        workflowPath: '/repo/flows/absent.workflow.yaml',
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      }),
    ).toBeUndefined();
  });

  // The point of normalising: a path has many spellings for one file, and
  // matching the authored string would trade a name mismatch for a spelling
  // mismatch — the same silent wrong seed, differently spelt.
  it.each([
    ['./flows/example.workflow.yaml'],
    ['flows/example.workflow.yaml'],
    ['flows/./example.workflow.yaml'],
    ['flows/nested/../example.workflow.yaml'],
    ['/repo/flows/example.workflow.yaml'],
  ])('matches the workflow however the block spells its path: %s', (spelling) => {
    const layer = seedOverrideLayerFor({
      seedOverrides: { [spelling]: { sleep_ms: 500 } },
      workflowPath: WORKFLOW_SOURCE,
      workspaceDir: WORKSPACE_DIR,
      source: WORKSPACE_SOURCE,
    });

    expect(layer?.valueRecord).toEqual({ sleep_ms: 500 });
    // …and the block path quotes the spelling the AUTHOR wrote, so the field
    // named in a diagnostic is one the document literally contains.
    expect(layer?.blockPath).toBe(`seedOverrides["${spelling}"]`);
  });

  it('resolves the workflow path too, so a relative one selects the same block', () => {
    expect(
      seedOverrideLayerFor({
        seedOverrides: { [WORKFLOW_ENTRY]: { sleep_ms: 500 } },
        workflowPath: '/repo/flows/../flows/example.workflow.yaml',
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      })?.valueRecord,
    ).toEqual({ sleep_ms: 500 });
  });

  it('supplies nothing when there is no workspace document to resolve against', () => {
    // `--workspace-name`: an in-memory workspace with no path base. It already
    // produced no layer, and still does.
    expect(
      seedOverrideLayerFor({
        seedOverrides: { [WORKFLOW_ENTRY]: { sleep_ms: 500 } },
        workflowPath: WORKFLOW_SOURCE,
        workspaceDir: undefined,
        source: '<in-memory workspace "scratch">',
      }),
    ).toBeUndefined();
  });

  it('supplies nothing for a block that is not a map — the schema reports that', () => {
    expect(
      seedOverrideLayerFor({
        seedOverrides: { [WORKFLOW_ENTRY]: 5 },
        workflowPath: WORKFLOW_SOURCE,
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      }),
    ).toBeUndefined();
    expect(
      seedOverrideLayerFor({
        seedOverrides: 'nonsense',
        workflowPath: WORKFLOW_SOURCE,
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      }),
    ).toBeUndefined();
  });
});

describe('collectSeedOverridePathProblems', () => {
  it('refuses a block whose path this workspace does not list', () => {
    const [problem, ...rest] = collectSeedOverridePathProblems({
      seedOverrides: { './flows/my-flwo.yaml': { sleep_ms: 500 } },
      workflowPathList: ['./flows/my-flow.yaml', 'flows/other-flow.yaml'],
      workspaceDir: WORKSPACE_DIR,
      source: WORKSPACE_SOURCE,
    });

    expect(rest).toHaveLength(0);
    // The authored spelling…
    expect(problem).toContain(
      'Seed overrides are declared for workflow path "./flows/my-flwo.yaml", ' +
        'which this workspace does not list.',
    );
    expect(problem).toContain(
      'Declared at seedOverrides["./flows/my-flwo.yaml"] in "/repo/workspace.yaml", ' +
        'resolving to "/repo/flows/my-flwo.yaml".',
    );
    // …and the resolved paths that DO exist, each beside how it was written.
    expect(problem).toContain(
      'workflowPathList holds: "./flows/my-flow.yaml" → "/repo/flows/my-flow.yaml", ' +
        '"flows/other-flow.yaml" → "/repo/flows/other-flow.yaml".',
    );
    expect(problem).toContain('keyed by workflow PATH');
    // The asymmetry, stated where the mistake is made.
    expect(problem).toContain('storage.keys.<key>.workflow names a sibling by NAME');
    expect(problem).toContain('refused rather than ignored');
  });

  // The case the whole normalisation exists for: an author who wrote
  // `flows/a.yaml` against a list holding `./flows/a.yaml` MATCHES, and must
  // never be told otherwise.
  it.each([
    ['./flows/example.workflow.yaml'],
    ['flows/example.workflow.yaml'],
    ['flows/./example.workflow.yaml'],
    ['/repo/flows/example.workflow.yaml'],
  ])('accepts an equivalent spelling of a listed path: %s', (spelling) => {
    expect(
      collectSeedOverridePathProblems({
        seedOverrides: { [spelling]: { a: 1 } },
        workflowPathList: ['./flows/example.workflow.yaml'],
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      }),
    ).toEqual([]);
  });

  it('refuses two spellings of one path, which would silently drop a block', () => {
    const [problem, ...rest] = collectSeedOverridePathProblems({
      seedOverrides: {
        './flows/example.workflow.yaml': { a: 1 },
        'flows/example.workflow.yaml': { b: 2 },
      },
      workflowPathList: [WORKFLOW_ENTRY],
      workspaceDir: WORKSPACE_DIR,
      source: WORKSPACE_SOURCE,
    });

    expect(rest).toHaveLength(0);
    expect(problem).toContain(
      'Seed overrides are declared twice for one workflow: ' +
        '"./flows/example.workflow.yaml" and "flows/example.workflow.yaml" are two ' +
        'spellings of one path.',
    );
    expect(problem).toContain('resolve to "/repo/flows/example.workflow.yaml"');
    expect(problem).toContain('Merge the two blocks into one.');
  });

  it('says so when the workspace lists no workflow at all', () => {
    expect(
      collectSeedOverridePathProblems({
        seedOverrides: { './flows/my-flow.yaml': { a: 1 } },
        workflowPathList: [],
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      })[0],
    ).toContain("workflowPathList is empty");
  });

  it('reports nothing for a workspace that declares no block', () => {
    expect(
      collectSeedOverridePathProblems({
        seedOverrides: undefined,
        workflowPathList: [WORKFLOW_ENTRY],
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      }),
    ).toEqual([]);
  });

  it('reports nothing when there is no workspace document to resolve against', () => {
    expect(
      collectSeedOverridePathProblems({
        seedOverrides: { [WORKFLOW_ENTRY]: { a: 1 } },
        workflowPathList: [WORKFLOW_ENTRY],
        workspaceDir: undefined,
        source: '<in-memory workspace "scratch">',
      }),
    ).toEqual([]);
  });

  it('reads a non-array workflowPathList defensively — the schema reports that', () => {
    // `workflow verify` holds a workspace document it has deliberately not
    // validated, so this must not throw.
    expect(
      collectSeedOverridePathProblems({
        seedOverrides: { './flows/a.yaml': { a: 1 } },
        workflowPathList: 'nonsense',
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      })[0],
    ).toContain('workflowPathList is empty');
  });

  it('reports every offending key in one pass, in document order', () => {
    const problemList = collectSeedOverridePathProblems({
      seedOverrides: { './a.yaml': { a: 1 }, './b.yaml': { b: 2 } },
      workflowPathList: [WORKFLOW_ENTRY],
      workspaceDir: WORKSPACE_DIR,
      source: WORKSPACE_SOURCE,
    });

    expect(problemList).toHaveLength(2);
    expect(problemList[0]).toContain('"./a.yaml"');
    expect(problemList[1]).toContain('"./b.yaml"');
  });
});

describe('formatSeedOverridePathProblems', () => {
  it('is undefined when nothing is wrong', () => {
    expect(
      formatSeedOverridePathProblems({
        seedOverrides: { [WORKFLOW_ENTRY]: { a: 1 } },
        workflowPathList: [WORKFLOW_ENTRY],
        workspaceDir: WORKSPACE_DIR,
        source: WORKSPACE_SOURCE,
      }),
    ).toBeUndefined();
  });

  it('gathers every problem under one heading naming the document at fault', () => {
    const message = formatSeedOverridePathProblems({
      seedOverrides: { './a.yaml': { a: 1 }, './b.yaml': { b: 2 } },
      workflowPathList: [WORKFLOW_ENTRY],
      workspaceDir: WORKSPACE_DIR,
      source: WORKSPACE_SOURCE,
    });

    expect(message).toContain(
      `Seed override validation failed for workspace "${WORKSPACE_SOURCE}":`,
    );
    expect(message).toContain('  - Seed overrides are declared for workflow path "./a.yaml"');
    expect(message).toContain('  - Seed overrides are declared for workflow path "./b.yaml"');
  });
});
