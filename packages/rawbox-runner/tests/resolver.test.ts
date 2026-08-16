import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';

import { ContractRegistryCache, setupContractRegistry } from '@rawbox/plugin/core';
import type { Contract, ContractRegistry } from '@rawbox/plugin/core';

import { resolveWorkflow } from '../src/workflow/resolver.js';
import type { ResolvedWorkflow, Workflow } from '../src/workflow/workflow-types.js';
import type { RawboxLock } from '../src/workflow/lock-types.js';

// ---------------------------------------------------------------------------
// Fixtures
//
// `plugin:` → registry hash is supplied by the caller, so
// `contractRegistryPath` no longer participates in resolution at all — it is
// set here only because `setupContractRegistry` records one. The hash is
// content-derived (`computeHash` covers the sorted contractRecord), so it is
// stable across cache instances.
// ---------------------------------------------------------------------------

const DEFAULT_PLUGIN = '@rawbox/rawbox-plugin-default';
const KRAKEN_PLUGIN = '@acme/rawbox-plugin-kraken';

const KV = { name: 'lmdb-kv', valueSizeMax: 1900 } as const;
const FIFO = { name: 'lmdb-fifo', queueSizeMax: 1000, valueSizeMax: 1900 } as const;

const defaultPluginContracts = {
  './time/sleep.definition.js': {
    type: 'operation',
    description: 'Pauses execution',
    inputSchema: Type.Object({ ms: Type.Number({ minimum: 0 }) }),
    outputSchema: Type.Object({ timestamp: Type.Number() }),
    errorSchema: Type.Object({ message: Type.String() }),
    version: '1.0.0',
  },
  './control-flow/branch.definition.js': {
    type: 'control-flow',
    description: 'Branches on a condition',
    inputSchema: Type.Object({
      condition: Type.Boolean(),
      thenLabel: Type.String(),
      elseLabel: Type.String(),
    }),
    errorSchema: Type.Object({ message: Type.String() }),
    version: '1.0.0',
  },
};

// The only realisation of `@acme/rawbox-plugin-kraken` anywhere in this
// monorepo — the package itself is referenced by the shipped fixtures but is
// not installed, so this mock *is* the `queue/drain` contract as far as any
// test is concerned.
//
// `item` is a single string, not an array of them. A `get` on an `lmdb-fifo`
// key dequeues one entry (`BoxStoreLmdbFifo.getStatic`), so a FIFO-fed input
// receives one entry per pass; the fixture loops back through `check-ready`,
// draining one per iteration. The array form typed the *old* seed reading,
// where `queue_items: [a, b, c]` was stored as one entry holding the list
// rather than as three entries.
const krakenPluginContracts = {
  './queue/drain.definition.js': {
    type: 'operation',
    description: 'Drains a queue, one entry per pass',
    inputSchema: Type.Object({
      item: Type.String(),
      prev: Type.Optional(Type.Unknown()),
    }),
    outputSchema: Type.Object({ drained: Type.Number() }),
    errorSchema: Type.Object({ message: Type.String() }),
    version: '1.0.0',
  },
};

function makeRegistry(
  contractRecord: Record<string, unknown>,
  contractRegistryPath = '/irrelevant/dist/contract-registry.js',
): ContractRegistry<Contract> {
  return setupContractRegistry({
    contractRecord: contractRecord as Record<string, Contract>,
    contractRegistryPath,
  }) as ContractRegistry<Contract>;
}

function hashOf(registry: ContractRegistry<Contract>): string {
  return ContractRegistryCache.computeHash(registry);
}

const DEFAULT_REGISTRY = makeRegistry(defaultPluginContracts);
const KRAKEN_REGISTRY = makeRegistry(krakenPluginContracts);
const DEFAULT_HASH = hashOf(DEFAULT_REGISTRY);
const KRAKEN_HASH = hashOf(KRAKEN_REGISTRY);

/** The map the runner builds from `PluginDiscoverer` + `addContractRegistry`. */
const DEFAULT_MAP: Readonly<Record<string, string>> = {
  [DEFAULT_PLUGIN]: DEFAULT_HASH,
};
const KRAKEN_MAP: Readonly<Record<string, string>> = {
  [KRAKEN_PLUGIN]: KRAKEN_HASH,
};
const BOTH_MAP: Readonly<Record<string, string>> = { ...DEFAULT_MAP, ...KRAKEN_MAP };

function makeCache(
  registries: ContractRegistry<Contract>[] = [DEFAULT_REGISTRY],
): ContractRegistryCache {
  const cache = new ContractRegistryCache();
  for (const registry of registries) cache.addContractRegistry(registry);
  return cache;
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    kind: 'Workflow',
    formatVersion: '1.0',
    name: 'example',
    plugins: { [DEFAULT_PLUGIN]: '^1.0.0' },
    storage: { defaultStrategy: KV },
    steps: [],
    ...overrides,
  } as Workflow;
}

/** Unwraps an expected-ok result, failing loudly with the diagnostic if not. */
function expectOk<T>(result: { isOk(): boolean; isErr(): boolean; value?: T; error?: string }): T {
  if (result.isErr()) throw new Error(`expected ok, got:\n${result.error}`);
  return result.value as T;
}

/** Unwraps an expected-err result. */
function expectErr(result: { isErr(): boolean; error?: string; value?: unknown }): string {
  if (!result.isErr()) {
    throw new Error(`expected err, got:\n${JSON.stringify(result.value, null, 2)}`);
  }
  return result.error as string;
}

const sleepStep = {
  label: 'sleep-step',
  plugin: DEFAULT_PLUGIN,
  operation: 'time/sleep',
  inputs: { ms: 'sleep_ms' },
  outputs: { timestamp: 'sleep_done_at' },
  errors: { message: 'sleep_error' },
};

// ---------------------------------------------------------------------------

describe('resolveWorkflow — step addressing', () => {
  it('resolves plugin: to the supplied hash and operation: to a definitionPath', () => {
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.stepList).toHaveLength(1);
    expect(resolved.stepList[0]!.definitionLocation).toEqual({
      contractRegistryHash: DEFAULT_HASH,
      definitionPath: './time/sleep.definition.js',
    });
    expect(resolved.name).toBe('example');
    expect(resolved.pluginPathList).toEqual([DEFAULT_PLUGIN]);
    expect(resolved.stepList[0]!.label).toBe('sleep-step');
  });

  it('resolves a nested control-flow operation path', () => {
    const workflow = makeWorkflow({
      steps: [
        {
          label: 'check-ready',
          plugin: DEFAULT_PLUGIN,
          operation: 'control-flow/branch',
          inputs: {
            condition: 'is_ready',
            thenLabel: 'then_label',
            elseLabel: 'else_label',
          },
          errors: { message: 'branch_error' },
        },
      ] as Workflow['steps'],
    });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.stepList[0]!.definitionLocation.definitionPath).toBe(
      './control-flow/branch.definition.js',
    );
  });

  it('resolves regardless of the registry path, which no longer participates', () => {
    // The whole point of supplying the hash map: a symlinked package (npm
    // workspace or a `file:` specifier) reports a path with no `node_modules`
    // segment and no scope.
    const registry = makeRegistry(
      defaultPluginContracts,
      '/repo/packages/rawbox-plugin-default/dist/contract-registry.js',
    );
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });

    const resolved = expectOk(
      resolveWorkflow(workflow, makeCache([registry]), { [DEFAULT_PLUGIN]: hashOf(registry) }),
    );

    expect(resolved.stepList[0]!.definitionLocation.contractRegistryHash).toBe(DEFAULT_HASH);
  });

  it('keeps two plugins apart', () => {
    const workflow = makeWorkflow({
      plugins: { [DEFAULT_PLUGIN]: '^1.0.0', [KRAKEN_PLUGIN]: 'file:../kraken' },
      storage: { defaultStrategy: KV, keys: { queue_items: { strategy: FIFO } } },
      steps: [
        sleepStep,
        {
          label: 'drain-step',
          plugin: KRAKEN_PLUGIN,
          operation: 'queue/drain',
          inputs: { item: 'queue_items' },
          outputs: { drained: 'drained_count' },
          errors: { message: 'drain_error' },
        },
      ] as Workflow['steps'],
    });

    const resolved = expectOk(
      resolveWorkflow(workflow, makeCache([DEFAULT_REGISTRY, KRAKEN_REGISTRY]), BOTH_MAP),
    );

    expect(resolved.stepList[0]!.definitionLocation.contractRegistryHash).toBe(DEFAULT_HASH);
    expect(resolved.stepList[1]!.definitionLocation.contractRegistryHash).toBe(KRAKEN_HASH);
    expect(resolved.pluginPathList).toEqual([DEFAULT_PLUGIN, KRAKEN_PLUGIN]);
  });
});

describe('resolveWorkflow — storage bindings', () => {
  it('expands shorthand refs with the default strategy', () => {
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.stepList[0]!.storageLocation).toEqual({
      input: { ms: { key: 'sleep_ms', strategy: KV } },
      output: { timestamp: { key: 'sleep_done_at', strategy: KV } },
      error: { message: { key: 'sleep_error', strategy: KV } },
    });
  });

  it('expands the long form, and never puts a strategy on the location itself', () => {
    const workflow = makeWorkflow({
      steps: [
        {
          ...sleepStep,
          inputs: { ms: { key: 'sleep_ms' } },
          outputs: { timestamp: { key: 'sleep_done_at' } },
          errors: { message: { key: 'sleep_error' } },
        },
      ] as Workflow['steps'],
    });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.stepList[0]!.storageLocation.input['ms']).toEqual({
      key: 'sleep_ms',
      strategy: KV,
    });
    expect(resolved.stepList[0]!.storageLocation.output['timestamp']).toEqual({
      key: 'sleep_done_at',
      strategy: KV,
    });
  });

  it('carries `workflow:` through on a cross-workflow read, and only there', () => {
    const workflow = makeWorkflow({
      plugins: { [KRAKEN_PLUGIN]: 'file:../kraken' },
      steps: [
        {
          label: 'drain-step',
          plugin: KRAKEN_PLUGIN,
          operation: 'queue/drain',
          inputs: {
            item: 'queue_items',
            prev: { key: 'upstream_result', workflow: 'upstream-workflow' },
          },
          outputs: { drained: 'drained_count' },
        },
      ] as Workflow['steps'],
    });

    const resolved = expectOk(
      resolveWorkflow(workflow, makeCache([KRAKEN_REGISTRY]), KRAKEN_MAP),
    );
    const input = resolved.stepList[0]!.storageLocation.input;

    expect(input['prev']).toEqual({
      key: 'upstream_result',
      strategy: KV,
      workflow: 'upstream-workflow',
    });
    // A same-workflow read omits the field entirely rather than setting it to
    // undefined — `sync-db-actor` falls back to the running workflow's name.
    expect(input['item']).toEqual({ key: 'queue_items', strategy: KV });
    expect('workflow' in input['item']!).toBe(false);
  });

  it('takes a FIFO strategy from the keys: entry that declares it', () => {
    const workflow = makeWorkflow({
      plugins: { [KRAKEN_PLUGIN]: 'file:../kraken' },
      storage: {
        defaultStrategy: KV,
        keys: {
          queue_items: { strategy: FIFO, seed: ['a', 'b', 'c'] },
          other: { seed: 1 },
        },
      },
      steps: [
        {
          label: 'drain-step',
          plugin: KRAKEN_PLUGIN,
          operation: 'queue/drain',
          inputs: { item: 'queue_items' },
          outputs: { drained: 'drained_count' },
        },
      ] as Workflow['steps'],
    });

    const resolved = expectOk(
      resolveWorkflow(workflow, makeCache([KRAKEN_REGISTRY]), KRAKEN_MAP),
    );

    // One lookup serves both the step location and the seed.
    expect(resolved.stepList[0]!.storageLocation.input['item']).toEqual({
      key: 'queue_items',
      strategy: FIFO,
    });
    expect(resolved.stepList[0]!.storageLocation.output['drained']).toEqual({
      key: 'drained_count',
      strategy: KV,
    });
    // The FIFO seed is expanded: one `Seed` per element, in enqueue order,
    // then the kv seed in document order.
    expect(resolved.seedData).toEqual([
      { key: 'queue_items', strategy: FIFO, value: 'a' },
      { key: 'queue_items', strategy: FIFO, value: 'b' },
      { key: 'queue_items', strategy: FIFO, value: 'c' },
      { key: 'other', strategy: KV, value: 1 },
    ]);
  });

  it('omits seedData entirely when nothing is seeded', () => {
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });
    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));
    expect(resolved.seedData).toBeUndefined();
  });

  it('reads a key\'s owner off the key table, so a SHORTHAND input crosses too', () => {
    // Ownership declared once, on the box, reaches a binding that says nothing
    // about it — which is the whole point of moving it there.
    const workflow = makeWorkflow({
      storage: {
        defaultStrategy: KV,
        keys: {
          upstream_result: { workflow: 'upstream-workflow' },
          sleep_ms: { seed: 1 },
        },
      },
      steps: [
        { ...sleepStep, inputs: { ms: 'sleep_ms', prev: 'upstream_result' } },
      ] as Workflow['steps'],
    });

    const input = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP))
      .stepList[0]!.storageLocation.input;

    expect(input['prev']).toEqual({
      key: 'upstream_result',
      strategy: KV,
      workflow: 'upstream-workflow',
    });
    expect('workflow' in input['ms']!).toBe(false);
  });

  it('refuses to resolve a write to a key the table says is another workflow\'s', () => {
    // Defensive, exactly like the `{ value: … }` and FIFO-seed checks: every
    // entry point verifies first, but this function is exported and pure, and
    // an unchecked foreign write would resolve into an ordinary *local*
    // `WriteBoxLocation` — a second box of the same name, silently.
    const workflow = makeWorkflow({
      storage: {
        defaultStrategy: KV,
        keys: {
          sleep_done_at: { workflow: 'other-flow' },
          sleep_ms: { seed: 1 },
        },
      },
      steps: [sleepStep] as Workflow['steps'],
    });

    const message = expectErr(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(message).toContain(
      'steps[0].outputs.timestamp (step "sleep-step") names storage key "sleep_done_at" in outputs:',
    );
    expect(message).toContain('storage.keys.sleep_done_at.workflow');
  });
});

// ---------------------------------------------------------------------------
// The mandatory-list rule for `lmdb-fifo` seeds
// pins the mandatory-list rule: seeding is a write, and a write to a queue
// enqueues
//
// The strategy already decides what every operation on a key means — `put`
// overwrites on kv and enqueues on fifo, `get` reads on kv and dequeues on
// fifo. Seeding now follows the same rule: an `lmdb-fifo` seed MUST be a list,
// and each element becomes one queue entry.
// ---------------------------------------------------------------------------

describe('resolveWorkflow — lmdb-fifo seeds expand to one entry per element', () => {
  function fifoSeedWorkflow(value: unknown): Workflow {
    return makeWorkflow({
      storage: {
        defaultStrategy: KV,
        keys: { q: { strategy: FIFO, seed: value } },
      },
      steps: [sleepStep] as Workflow['steps'],
    });
  }

  function seedsFor(value: unknown) {
    return expectOk(resolveWorkflow(fifoSeedWorkflow(value), makeCache(), DEFAULT_MAP))
      .seedData;
  }

  it('[a, b, c] becomes three entries, in enqueue order', () => {
    expect(seedsFor(['a', 'b', 'c'])).toEqual([
      { key: 'q', strategy: FIFO, value: 'a' },
      { key: 'q', strategy: FIFO, value: 'b' },
      { key: 'q', strategy: FIFO, value: 'c' },
    ]);
  });

  it('[[a, b, c]] becomes exactly one entry whose value is the list', () => {
    // Nesting is what makes the mandatory list free of cost: every value stays
    // expressible, so no reserved wrapper is needed to say "one entry".
    expect(seedsFor([['a', 'b', 'c']])).toEqual([
      { key: 'q', strategy: FIFO, value: ['a', 'b', 'c'] },
    ]);
  });

  it('[] seeds an empty queue — no writes at all', () => {
    expect(seedsFor([])).toBeUndefined();
  });

  it('[] seeds an empty queue even alongside another seeded key', () => {
    const workflow = makeWorkflow({
      storage: {
        defaultStrategy: KV,
        keys: { q: { strategy: FIFO, seed: [] }, ms: { seed: 500 } },
      },
      steps: [sleepStep] as Workflow['steps'],
    });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.seedData).toEqual([{ key: 'ms', strategy: KV, value: 500 }]);
  });

  it('a nested list nests: [[a], [b]] is two entries, each holding a list', () => {
    expect(seedsFor([['a'], ['b']])).toEqual([
      { key: 'q', strategy: FIFO, value: ['a'] },
      { key: 'q', strategy: FIFO, value: ['b'] },
    ]);
  });

  it('rejects a non-list FIFO seed, naming the key, its strategy and the fix', () => {
    const message = expectErr(resolveWorkflow(fifoSeedWorkflow(5), makeCache(), DEFAULT_MAP));

    expect(message).toContain('storage.keys.q.seed');
    expect(message).toContain('is a number');
    expect(message).toContain('lmdb-fifo');
    expect(message).toContain('storage.keys.q.strategy');
    expect(message).toContain('MUST be a list');
    // The value that would be right, not just the one that is wrong.
    expect(message).toContain('Write [5]');
    expect(message).toContain('[] to seed an empty queue');
  });

  it('rejects a map, a string and null just as firmly as a number', () => {
    for (const [value, kind] of [
      [{ a: 1 }, 'a map'],
      ['abc', 'a string'],
      [null, 'null'],
      [true, 'a boolean'],
    ] as const) {
      const message = expectErr(
        resolveWorkflow(fifoSeedWorkflow(value), makeCache(), DEFAULT_MAP),
      );
      expect(message).toContain(`storage.keys.q.seed is ${kind}`);
    }
  });

  it('leaves an lmdb-kv seed alone — the rule is a property of the strategy', () => {
    const workflow = makeWorkflow({
      storage: { defaultStrategy: KV, keys: { q: { seed: ['a', 'b', 'c'] } } },
      steps: [sleepStep] as Workflow['steps'],
    });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.seedData).toEqual([
      { key: 'q', strategy: KV, value: ['a', 'b', 'c'] },
    ]);
  });

  it('emits seeds in document order, so a run is reproducible', () => {
    // The only source of seeds is the `storage.keys` entries. Nothing is
    // appended after them:
    // when `{ value: … }` existed, the resolver synthesised a second family of
    // seeds and concatenated them here.
    const workflow = makeWorkflow({
      storage: { defaultStrategy: KV, keys: { b: { seed: 2 }, a: { seed: 1 }, c: { seed: 3 } } },
      steps: [sleepStep] as Workflow['steps'],
    });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.seedData!.map((seed) => seed.key)).toEqual(['b', 'a', 'c']);
  });
});

describe('resolveWorkflow — steps', () => {
  it('gives a control-flow step with no outputs an empty output record', () => {
    const workflow = makeWorkflow({
      steps: [
        {
          label: 'check-ready',
          plugin: DEFAULT_PLUGIN,
          operation: 'control-flow/branch',
          inputs: { condition: 'is_ready', thenLabel: 'a', elseLabel: 'b' },
          errors: { message: 'branch_error' },
        },
      ] as Workflow['steps'],
    });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.stepList[0]!.storageLocation.output).toEqual({});
    expect(resolved.stepList[0]!.storageLocation.error).toEqual({
      message: { key: 'branch_error', strategy: KV },
    });
  });

  it('resolves an unlabelled step without inventing a label', () => {
    const { label: _label, ...unlabelled } = sleepStep;
    const workflow = makeWorkflow({ steps: [unlabelled] as Workflow['steps'] });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.stepList[0]!.label).toBeUndefined();
    expect('label' in resolved.stepList[0]!).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The removed `{ value: … }` binding
// pins FORMAT.md, "Bindings"
//
// An input used to accept an inline literal, which the resolver desugared into
// a storage key it synthesised under a reserved `__rawbox_literal__` namespace.
// Both are gone: an input reads from storage, and a constant is declared as a
// key and seeded exactly like every other input.
//
// The resolver still guards the shape because it is exported and pure, so it
// cannot assume `validateWorkflowType` ran first — and a literal reaching the
// binding loop would resolve to a location with no key rather than to an error.
// Both layers call one helper, so the sentence is identical rather than merely
// similar; `validation.test.ts` pins the wording in full.
// ---------------------------------------------------------------------------

describe('resolveWorkflow — the removed { value: … } binding', () => {
  const literalBranchStep = {
    label: 'check-ready',
    plugin: DEFAULT_PLUGIN,
    operation: 'control-flow/branch',
    inputs: {
      condition: 'is_ready',
      thenLabel: { value: 'sleep-step' },
      elseLabel: 'else_label',
    },
    errors: { message: 'branch_error' },
  };

  function literalWorkflow(): Workflow {
    return makeWorkflow({
      steps: [literalBranchStep] as unknown as Workflow['steps'],
    });
  }

  it('rejects a literal rather than resolving it to a keyless location', () => {
    const message = expectErr(
      resolveWorkflow(literalWorkflow(), makeCache(), DEFAULT_MAP),
    );

    expect(message).toContain('steps[0].inputs.thenLabel');
    expect(message).toContain('check-ready');
    expect(message).toContain('{ value: … } inline literal');
    expect(message).toContain('has been removed from the workflow format');
  });

  it('shows the seed plus key that replaces it', () => {
    // The message is the migration path: an author or an assistant arriving
    // with a working example from before this change is the reader the
    // diagnostic exists for.
    const message = expectErr(
      resolveWorkflow(literalWorkflow(), makeCache(), DEFAULT_MAP),
    );

    expect(message).toContain('then_label:\n            seed: "sleep-step"');
    expect(message).toContain('thenLabel: then_label');
  });

  it('reports every literal in the document, not just the first', () => {
    const workflow = makeWorkflow({
      steps: [
        literalBranchStep,
        { ...sleepStep, inputs: { ms: { value: 500 } } },
      ] as unknown as Workflow['steps'],
    });

    const message = expectErr(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(message).toContain('steps[0].inputs.thenLabel');
    expect(message).toContain('steps[1].inputs.ms');
    expect(message).toContain('ms:\n            seed: 500');
  });

  it('resolves the migrated form: a seeded key, bound by name', () => {
    // The end state the diagnostic asks for, resolving cleanly — jump targets
    // reach the handler the way every other input does, through storage.
    const workflow = makeWorkflow({
      storage: {
        defaultStrategy: KV,
        keys: {
          then_label: { seed: 'sleep-step' },
          else_label: { seed: '__END__' },
        },
      },
      steps: [
        {
          label: 'check-ready',
          plugin: DEFAULT_PLUGIN,
          operation: 'control-flow/branch',
          inputs: {
            condition: 'is_ready',
            thenLabel: 'then_label',
            elseLabel: 'else_label',
          },
          errors: { message: 'branch_error' },
        },
      ] as Workflow['steps'],
    });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.stepList[0]!.storageLocation.input).toEqual({
      condition: { key: 'is_ready', strategy: KV },
      thenLabel: { key: 'then_label', strategy: KV },
      elseLabel: { key: 'else_label', strategy: KV },
    });

    // The read location and the seed must agree, or the handler reads nothing:
    // `sync-db-actor` builds its input record exclusively from getSync.
    expect(resolved.seedData).toEqual([
      { key: 'then_label', strategy: KV, value: 'sleep-step' },
      { key: 'else_label', strategy: KV, value: '__END__' },
    ]);
  });

  it('leaves `__rawbox_literal__` an ordinary storage key, reserved by nothing', () => {
    // The namespace existed only to keep synthesised keys from colliding with
    // authored ones. With nothing synthesising keys there is nothing to reserve,
    // and a document using the old prefix is merely a document with an ugly key.
    const workflow = makeWorkflow({
      storage: {
        defaultStrategy: KV,
        keys: { __rawbox_literal__mine: { seed: 1 } },
      },
      steps: [
        { ...sleepStep, inputs: { ms: '__rawbox_literal__mine' } },
      ] as Workflow['steps'],
    });

    const resolved = expectOk(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(resolved.stepList[0]!.storageLocation.input.ms).toEqual({
      key: '__rawbox_literal__mine',
      strategy: KV,
    });
  });
});

describe('resolveWorkflow — rawbox.lock verification', () => {
  function lockWith(registryHash: string): RawboxLock {
    return {
      version: '1',
      plugins: { [DEFAULT_PLUGIN]: { resolved: '1.0.0', registryHash } },
    };
  }

  it('accepts a lock whose registry hash matches what is installed', () => {
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });

    const resolved = expectOk(
      resolveWorkflow(workflow, makeCache(), DEFAULT_MAP, lockWith(DEFAULT_HASH)),
    );

    expect(resolved.stepList[0]!.definitionLocation.contractRegistryHash).toBe(DEFAULT_HASH);
  });

  it('hard-errors on a mismatch, naming the package and telling the user to re-lock', () => {
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });

    const message = expectErr(
      resolveWorkflow(workflow, makeCache(), DEFAULT_MAP, lockWith('f'.repeat(64))),
    );

    expect(message).toContain(DEFAULT_PLUGIN);
    expect(message).toContain('rawbox.lock');
    expect(message).toContain(DEFAULT_HASH);
    expect(message).toContain('workflow lock');
  });

  it('treats a missing lock as "resolve whatever is installed"', () => {
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });
    expect(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP).isOk()).toBe(true);
  });

  it('ignores a lock entry for a package this workflow does not declare', () => {
    // The lock is keyed at the workspace level, so it legitimately covers
    // packages other workflows in the workspace use.
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });
    const lock: RawboxLock = {
      version: '1',
      plugins: {
        [DEFAULT_PLUGIN]: { resolved: '1.0.0', registryHash: DEFAULT_HASH },
        [KRAKEN_PLUGIN]: { resolved: '2.0.0', registryHash: 'a'.repeat(64) },
      },
    };

    expect(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP, lock).isOk()).toBe(true);
  });

  it('accepts a partial lock that has no entry for a declared package', () => {
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });
    const lock: RawboxLock = { version: '1', plugins: {} };
    expect(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP, lock).isOk()).toBe(true);
  });
});

describe('resolveWorkflow — plugin/registry mapping', () => {
  it('reports a declared package absent from the supplied map, listing what was supplied', () => {
    const workflow = makeWorkflow({
      plugins: { [DEFAULT_PLUGIN]: '^1.0.0', [KRAKEN_PLUGIN]: 'file:../kraken' },
      steps: [sleepStep] as Workflow['steps'],
    });

    const message = expectErr(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(message).toContain(KRAKEN_PLUGIN);
    expect(message).toContain('no contract registry was loaded for it');
    expect(message).toContain('Registries were loaded for (1):');
    expect(message).toContain(`- ${DEFAULT_PLUGIN}`);
    expect(message).toContain('workspace setup');
    // An unrelated package name must not attract a suggestion — a wrong "did
    // you mean" is worse than none, since the full list is printed anyway.
    expect(message).not.toContain('Did you mean');
  });

  it('suggests the nearest supplied package name on a near miss', () => {
    const workflow = makeWorkflow({
      plugins: { '@rawbox/rawbox-plugin-defualt': '^1.0.0' },
      steps: [
        { ...sleepStep, plugin: '@rawbox/rawbox-plugin-defualt' },
      ] as Workflow['steps'],
    });

    const message = expectErr(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(message).toContain(`Did you mean "${DEFAULT_PLUGIN}"?`);
  });

  it('reports a supplied hash that is not in the registry cache as a stale map', () => {
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });

    const message = expectErr(
      resolveWorkflow(workflow, makeCache(), { [DEFAULT_PLUGIN]: 'b'.repeat(64) }),
    );

    expect(message).toContain(DEFAULT_PLUGIN);
    expect(message).toContain('no registry with that hash is in the cache');
    expect(message).toContain('stale map');
  });

  it('ignores map entries for packages the workflow does not declare', () => {
    const workflow = makeWorkflow({ steps: [sleepStep] as Workflow['steps'] });

    const resolved = expectOk(
      resolveWorkflow(workflow, makeCache([DEFAULT_REGISTRY, KRAKEN_REGISTRY]), BOTH_MAP),
    );

    expect(resolved.pluginPathList).toEqual([DEFAULT_PLUGIN]);
  });
});

describe('resolveWorkflow — error quality', () => {
  it('lists the declared packages and suggests the nearest for an unmatched plugin', () => {
    const workflow = makeWorkflow({
      steps: [{ ...sleepStep, plugin: '@rawbox/rawbox-plugin-defualt' }] as Workflow['steps'],
    });

    const message = expectErr(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(message).toContain('is not declared in `plugins:`');
    expect(message).toContain(`- ${DEFAULT_PLUGIN}`);
    expect(message).toContain(`Did you mean "${DEFAULT_PLUGIN}"?`);
  });

  it("lists the registry's contract keys for an unmatched operation", () => {
    const workflow = makeWorkflow({
      steps: [{ ...sleepStep, operation: 'time/slep' }] as Workflow['steps'],
    });

    const message = expectErr(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(message).toContain('was not found in plugin');
    expect(message).toContain('./time/slep.definition.js');
    expect(message).toContain('- time/sleep');
    expect(message).toContain('- control-flow/branch');
    expect(message).toContain('Did you mean "time/sleep"?');
  });

  it('reports every problem in one pass, not just the first', () => {
    const workflow = makeWorkflow({
      steps: [
        { ...sleepStep, label: 'a', operation: 'time/nope' },
        { ...sleepStep, label: 'b', plugin: 'not-declared' },
        { ...sleepStep, label: 'c', inputs: { ms: { value: 'nan' } } },
      ] as Workflow['steps'],
    });

    const message = expectErr(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP));

    expect(message).toContain('step "a"');
    expect(message).toContain('step "b"');
    expect(message).toContain('step "c"');
  });

  it('names the workflow in the error header', () => {
    const workflow = makeWorkflow({
      name: 'my-workflow',
      steps: [{ ...sleepStep, operation: 'time/nope' }] as Workflow['steps'],
    });

    expect(expectErr(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP))).toContain(
      'Failed to resolve workflow "my-workflow"',
    );
  });
});

describe('resolveWorkflow — control-flow type cross-check', () => {
  const pickContracts = {
    './routing/pick.definition.js': {
      type: 'control-flow',
      description: 'Picks a branch',
      inputSchema: Type.Object({ condition: Type.Boolean() }),
      errorSchema: Type.Object({ message: Type.String() }),
      version: '1.0.0',
    },
  };

  it('accepts a control-flow contract outside the control-flow/ prefix', () => {
    // The prefix is a convention of @rawbox/rawbox-plugin-default, not a
    // guarantee: a third-party plugin may place a control-flow definition
    // anywhere, and as long as the step declares no outputs it resolves fine.
    const registry = makeRegistry(pickContracts);
    const workflow = makeWorkflow({
      plugins: { [KRAKEN_PLUGIN]: 'file:../kraken' },
      steps: [
        {
          label: 'pick',
          plugin: KRAKEN_PLUGIN,
          operation: 'routing/pick',
          inputs: { condition: 'is_ready' },
          errors: { message: 'pick_error' },
        },
      ] as Workflow['steps'],
    });

    const resolved = expectOk(
      resolveWorkflow(workflow, makeCache([registry]), { [KRAKEN_PLUGIN]: hashOf(registry) }),
    );

    expect(resolved.stepList[0]!.definitionLocation.definitionPath).toBe(
      './routing/pick.definition.js',
    );
    expect(resolved.stepList[0]!.storageLocation.output).toEqual({});
  });

  it('rejects outputs: on a control-flow contract the schema could not catch', () => {
    // Same third-party layout, but with outputs declared. The schema classified
    // this as an operation step (no control-flow/ prefix) and allowed outputs:,
    // so only the resolver can see that the contract has no outputSchema.
    const registry = makeRegistry(pickContracts);
    const workflow = makeWorkflow({
      plugins: { [KRAKEN_PLUGIN]: 'file:../kraken' },
      steps: [
        {
          label: 'pick',
          plugin: KRAKEN_PLUGIN,
          operation: 'routing/pick',
          inputs: { condition: 'is_ready' },
          outputs: { label: 'next_label' },
        },
      ] as Workflow['steps'],
    });

    const message = expectErr(
      resolveWorkflow(workflow, makeCache([registry]), { [KRAKEN_PLUGIN]: hashOf(registry) }),
    );

    expect(message).toContain('produces no outputs');
    expect(message).toContain('control-flow/');
  });

  it('rejects an operation contract placed under the control-flow/ prefix', () => {
    // The mirror image: the schema forbids outputs: here, so the operation's
    // results could never be written — silent data loss without this check.
    const registry = makeRegistry({
      './control-flow/tally.definition.js': {
        type: 'operation',
        description: 'Counts something',
        inputSchema: Type.Object({ n: Type.Number() }),
        outputSchema: Type.Object({ total: Type.Number() }),
        errorSchema: Type.Object({ message: Type.String() }),
        version: '1.0.0',
      },
    });
    const workflow = makeWorkflow({
      plugins: { [KRAKEN_PLUGIN]: 'file:../kraken' },
      steps: [
        {
          label: 'tally',
          plugin: KRAKEN_PLUGIN,
          operation: 'control-flow/tally',
          inputs: { n: 'count' },
        },
      ] as Workflow['steps'],
    });

    const message = expectErr(
      resolveWorkflow(workflow, makeCache([registry]), { [KRAKEN_PLUGIN]: hashOf(registry) }),
    );

    expect(message).toContain('declares type "operation"');
    expect(message).toContain('could never be written');
  });

  it('rejects a contract whose type is neither operation nor control-flow', () => {
    const registry = makeRegistry({
      './weird/thing.definition.js': { type: 'trigger', inputSchema: Type.Object({}) },
    });
    const workflow = makeWorkflow({
      plugins: { [KRAKEN_PLUGIN]: 'file:../kraken' },
      steps: [
        { label: 'w', plugin: KRAKEN_PLUGIN, operation: 'weird/thing' },
      ] as Workflow['steps'],
    });

    const message = expectErr(
      resolveWorkflow(workflow, makeCache([registry]), { [KRAKEN_PLUGIN]: hashOf(registry) }),
    );
    expect(message).toContain('unrecognised type "trigger"');
  });
});

// ---------------------------------------------------------------------------
// Bounded steps
//
// `effective = step.timeoutMs ?? contract.timeoutMs ?? unbounded` — override,
// not minimum, so a document may loosen or remove a contract's bound as well as
// tighten it. The resolved model has two states: a present `timeoutMs` is
// bounded, an absent one is unbounded, and the authoring word `unbounded` does
// not survive resolution.
// ---------------------------------------------------------------------------

describe('resolveWorkflow — bounded steps', () => {
  /** The sleep contract, with a bound the plugin declared. */
  const boundedContracts = {
    ...defaultPluginContracts,
    './time/sleep.definition.js': {
      ...defaultPluginContracts['./time/sleep.definition.js'],
      timeoutMs: 5_000,
    },
  };

  function resolveSleep(
    stepOverrides: Record<string, unknown>,
    contracts: Record<string, unknown> = defaultPluginContracts,
  ) {
    const registry = makeRegistry(contracts);
    const workflow = makeWorkflow({
      storage: { defaultStrategy: KV, keys: { sleep_ms: { seed: 500 } } },
      steps: [{ ...sleepStep, ...stepOverrides }] as Workflow['steps'],
    });

    return resolveWorkflow(workflow, makeCache([registry]), {
      [DEFAULT_PLUGIN]: hashOf(registry),
    });
  }

  it('leaves timeoutMs absent when neither the step nor the contract declares one', () => {
    const resolved = expectOk(resolveSleep({}));

    expect(resolved.stepList[0]!).not.toHaveProperty('timeoutMs');
  });

  it('inherits the contract\'s bound when the step declares none', () => {
    const resolved = expectOk(resolveSleep({}, boundedContracts));

    expect(resolved.stepList[0]!.timeoutMs).toBe(5_000);
  });

  it('takes the step\'s bound when the contract declares none', () => {
    const resolved = expectOk(resolveSleep({ timeoutMs: 750 }));

    expect(resolved.stepList[0]!.timeoutMs).toBe(750);
  });

  it('lets a step LOOSEN a contract\'s bound — override, not min()', () => {
    // The decision this pins: a document that knows more than the plugin can
    // widen the bound, which `Math.min` would silently ignore.
    const resolved = expectOk(resolveSleep({ timeoutMs: 60_000 }, boundedContracts));

    expect(resolved.stepList[0]!.timeoutMs).toBe(60_000);
  });

  it('lets a step tighten a contract\'s bound', () => {
    const resolved = expectOk(resolveSleep({ timeoutMs: 100 }, boundedContracts));

    expect(resolved.stepList[0]!.timeoutMs).toBe(100);
  });

  it('lets a step REMOVE a contract\'s bound with `unbounded`', () => {
    // The case that makes override necessary rather than merely convenient: a
    // step whose blocking wait is the workflow's own pacing mechanism.
    const resolved = expectOk(resolveSleep({ timeoutMs: 'unbounded' }, boundedContracts));

    expect(resolved.stepList[0]!).not.toHaveProperty('timeoutMs');
  });

  it('never carries the word `unbounded` into the resolved model', () => {
    const resolved = expectOk(resolveSleep({ timeoutMs: 'unbounded' }));

    expect(JSON.stringify(resolved)).not.toContain('unbounded');
  });

  it('rejects a contract whose own timeoutMs is malformed, and blames the plugin', () => {
    // `setupContractRegistry` rejects this at module evaluation, so the record
    // is corrupted afterwards here: the resolver must not assume the SDK vetted
    // a package it merely imported.
    // The contract object is copied, not just the record: the shared fixture
    // holds the same references, and mutating one would leak into every other
    // test in this file.
    const registry = makeRegistry({
      './time/sleep.definition.js': {
        ...defaultPluginContracts['./time/sleep.definition.js'],
      },
    });
    (
      registry.contractRecord['./time/sleep.definition.js'] as unknown as Record<
        string,
        unknown
      >
    ).timeoutMs = 0;

    const workflow = makeWorkflow({
      storage: { defaultStrategy: KV, keys: { sleep_ms: { seed: 500 } } },
      steps: [sleepStep] as Workflow['steps'],
    });

    const message = expectErr(
      resolveWorkflow(workflow, makeCache([registry]), {
        [DEFAULT_PLUGIN]: hashOf(registry),
      }),
    );

    expect(message).toContain('invalid timeoutMs');
    expect(message).toContain(DEFAULT_PLUGIN);
    expect(message).toContain('./time/sleep.definition.js');
    expect(message).toContain("plugin's own declaration, not this document's");
  });
});

describe('resolveWorkflow — purity', () => {
  it('does not mutate its input document', () => {
    const workflow = makeWorkflow({
      storage: { defaultStrategy: KV, keys: { sleep_ms: { seed: 500 } } },
      steps: [sleepStep] as Workflow['steps'],
    });
    const before = JSON.parse(JSON.stringify(workflow));

    expect(resolveWorkflow(workflow, makeCache(), DEFAULT_MAP).isOk()).toBe(true);
    expect(workflow).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// resolveWorkflow — every key fact comes off the key table
//
// A previous task added `storage.keys` and a normaliser (`resolveKeyTable`,
// `key-table.ts`) but migrated no reader. `strategyFor` read
// `storage.strategies[key] ?? storage.defaultStrategy` directly, so a `keys:`
// strategy was silently overridden by `defaultStrategy` — the wrong strategy,
// with no error. And the seed loop iterated `Object.entries(storage.seed ?? {})`
// directly, which `keys:` never populates, so a `keys:` seed was never expanded
// into a `Seed` at all: a key an author believed was seeded would resolve,
// verify clean, and run with nothing in the box.
//
// Both are fixed the same way `key-table.ts` prescribes — `strategyFor` and the
// seed loop are expressed against `resolveKeyTable(storage)` — and with the
// shorthand removed there is no second block for either to fall back to, so a
// reader that stopped consulting the table would now resolve *nothing* rather
// than half. These are the assertions that catch that.
// ---------------------------------------------------------------------------

describe('resolveWorkflow — every key fact comes off the key table', () => {
  const STORAGE = {
    defaultStrategy: KV,
    keys: {
      // A queue: strategy AND seed, seed a list that MUST expand — the case
      // that was silently broken twice over (wrong strategy, unwritten seed).
      queue_items: { strategy: FIFO, seed: ['a', 'b', 'c'] },
      // A cell: seed only, strategy resolves through `defaultStrategy`.
      other: { seed: 1 },
    },
  } as unknown as Workflow['storage'];

  const STEP_LIST = [
    {
      label: 'drain-step',
      plugin: KRAKEN_PLUGIN,
      operation: 'queue/drain',
      inputs: { item: 'queue_items' },
      outputs: { drained: 'drained_count' },
    },
  ] as Workflow['steps'];

  function resolve(): ResolvedWorkflow {
    return expectOk(
      resolveWorkflow(
        makeWorkflow({
          plugins: { [KRAKEN_PLUGIN]: 'file:../kraken' },
          storage: STORAGE,
          steps: STEP_LIST,
        }),
        makeCache([KRAKEN_REGISTRY]),
        KRAKEN_MAP,
      ),
    );
  }

  it('reaches a step location with the entry strategy, not defaultStrategy', () => {
    // `strategyFor`'s `byKey` lookup. Were the table not consulted, this would
    // silently be `KV` — the wrong box, with no error anywhere.
    expect(resolve().stepList[0]!.storageLocation.input['item']).toEqual({
      key: 'queue_items',
      strategy: FIFO,
    });
    // A key no entry declares still falls through to `defaultStrategy`, which
    // is the format's one resolution rule.
    expect(resolve().stepList[0]!.storageLocation.output['drained']).toEqual({
      key: 'drained_count',
      strategy: KV,
    });
  });

  it('expands a FIFO seed into one Seed per element, in document order', () => {
    // Asserting the exact expansion rather than a comparison is what catches
    // "quietly empty": a seed loop blind to the table produces `undefined`
    // here, and `undefined` compares equal to nothing worth noticing.
    expect(resolve().seedData).toEqual([
      { key: 'queue_items', strategy: FIFO, value: 'a' },
      { key: 'queue_items', strategy: FIFO, value: 'b' },
      { key: 'queue_items', strategy: FIFO, value: 'c' },
      { key: 'other', strategy: KV, value: 1 },
    ]);
  });
});
