import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import { ContractRegistryCache } from '@rawbox/plugin/core';
import {
  WriteBoxLocation,
  ReadBoxLocation,
  budgetForStorage,
  RAWBOX_KEY_SIZE_MAX,
} from '@rawbox/store';

import { parseConfig } from '../src/utils/config.js';
import { boxStorageFor } from '../src/workflow/key-table.js';
import { resolveWorkflow } from '../src/workflow/resolver.js';
import type { ResolvedWorkflow, Workflow } from '../src/workflow/workflow-types.js';
import {
  checkKeySize,
  collectBoundStorageKeys,
  collectStorageBindingList,
  validateWorkflowType,
  validateResolvedWorkflow,
  validateStorageBoundaries,
  validateStorageSizes,
  validateSeedData,
  collectTimeoutWarnings,
} from '../src/workflow/validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures');

async function loadFixture(name: string): Promise<unknown> {
  const filePath = path.join(fixtures, name);
  return parseConfig(await fs.readFile(filePath, 'utf-8'), filePath);
}

const KV = { name: 'lmdb-kv' as const, valueSizeMax: 100 };

/** A minimal valid authoring document, cloned and mutated per case. */
function baseDocument(): Record<string, unknown> {
  return {
    kind: 'Workflow',
    formatVersion: '1.0',
    name: 'example',
    plugins: { '@rawbox/rawbox-plugin-default': '^1.0.0' },
    // `sleep_ms` is seeded because the step below reads it, and a key that no
    // step writes and no seed sets is rejected. A base document every other
    // case is spliced from has to be valid on its own.
    storage: {
      defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
      keys: { sleep_ms: { seed: 500 } },
    },
    steps: [
      {
        label: 'sleep-step',
        plugin: '@rawbox/rawbox-plugin-default',
        operation: 'time/sleep',
        inputs: { ms: 'sleep_ms' },
        outputs: { timestamp: 'sleep_done_at' },
      },
    ],
  };
}

/** A minimal valid *resolved* workflow, cloned and mutated per case. */
function baseResolved(): ResolvedWorkflow {
  return {
    name: 'simple',
    pluginPathList: [],
    stepList: [
      {
        definitionLocation: {
          contractRegistryHash: 'hash-0',
          definitionPath: './time/sleep.definition.js',
        },
        storageLocation: {
          input: { ms: { key: 'sleep_ms', strategy: KV } },
          output: { timestamp: { key: 'sleep_done_at', strategy: KV } },
          error: {},
        },
        label: 'sleep-step',
      },
    ],
  } as unknown as ResolvedWorkflow;
}

// ---------------------------------------------------------------------------
// validateWorkflowType — the authoring model and document identity
// ---------------------------------------------------------------------------

describe('validateWorkflowType', () => {
  it('accepts the YAML fixture', async () => {
    const result = validateWorkflowType(await loadFixture('example.workflow.yaml'));
    expect(result.isOk()).toBe(true);
  });

  it('accepts the JSON fixture — the schema is over the parsed data model', async () => {
    const result = validateWorkflowType(await loadFixture('example.workflow.json'));
    expect(result.isOk()).toBe(true);
  });

  it('rejects a document with no `kind:` and says what was expected', async () => {
    const result = validateWorkflowType(await loadFixture('not-a-workflow-document.yaml'));

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe(
      '<file> is not a Rawbox workflow document: it has no "kind:" field.\n' +
        '  Expected "kind: Workflow" at the top level, alongside "formatVersion: 1.0".',
    );
  });

  it('decides on the absence of `kind:` alone, not on a shape heuristic', () => {
    // Nothing else about this document is wrong — the missing `kind` is the
    // whole test.
    const result = validateWorkflowType({ name: 'anything' });

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('is not a Rawbox workflow document');
    expect(message).toContain('no "kind:" field');
    expect(message).toContain('kind: Workflow');
  });

  it('names the offending file when a path is supplied', () => {
    const result = validateWorkflowType({ name: 'old' }, 'workflows/old.workflow.yaml');

    expect(result._unsafeUnwrapErr().message).toBe(
      'workflows/old.workflow.yaml is not a Rawbox workflow document: it has no "kind:" field.\n' +
        '  Expected "kind: Workflow" at the top level, alongside "formatVersion: 1.0".',
    );
  });

  it('rejects an unrecognised kind and names the valid kinds', () => {
    const document = { ...baseDocument(), kind: 'Pipeline' };
    const result = validateWorkflowType(document);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('Unrecognised document kind "Pipeline"');
    expect(message).toContain('"Workflow"');
    expect(message).toContain('"Workspace"');
    // A wrong kind is a different failure from a missing one.
    expect(message).not.toContain('no "kind:" field');
  });

  it('rejects a valid-but-wrong kind with its own message', () => {
    const result = validateWorkflowType({ kind: 'Workspace', name: 'ws' });

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('Expected a document of kind "Workflow"');
    expect(message).toContain('"Workspace"');
    expect(message).not.toContain('Unrecognised');
  });

  it('rejects an unsupported formatVersion by name', () => {
    const document = { ...baseDocument(), formatVersion: '3.0' };
    const result = validateWorkflowType(document);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Unsupported formatVersion "3.0"');
  });

  it('rejects a document that did not parse into an object', () => {
    expect(validateWorkflowType(null).isErr()).toBe(true);
    expect(validateWorkflowType([]).isErr()).toBe(true);
    expect(validateWorkflowType('kind: Workflow').isErr()).toBe(true);
  });

  it('reports schema violations once the document is identified as a workflow', () => {
    const document = baseDocument();
    delete document.plugins;

    const result = validateWorkflowType(document);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Workflow validation failed');
  });
});

// ---------------------------------------------------------------------------
// The removed `{ value: … }` binding
// pins FORMAT.md, "Bindings"
//
// The schema alone rejects the shape, but as a union failure listing the
// branches it is not. This is the layer that turns it into the migration path,
// and it runs before the schema for that reason — the reader is someone holding
// an example written before this change, and what they need is the
// replacement, not a list of what `{ value: … }` failed to be.
// ---------------------------------------------------------------------------

describe('validateWorkflowType — a { value: … } input is rejected', () => {
  /** The document as an author who copied an older example would have it. */
  function withLiteral(
    field: string,
    value: unknown,
    label?: string,
  ): Record<string, unknown> {
    return {
      ...baseDocument(),
      steps: [
        {
          ...(label === undefined ? {} : { label }),
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'control-flow/branch',
          inputs: { condition: 'is_ready', [field]: { value } },
        },
      ],
    };
  }

  function errorOf(document: Record<string, unknown>): string {
    const result = validateWorkflowType(document);
    expect(result.isErr()).toBe(true);
    return result._unsafeUnwrapErr().message;
  }

  it('names the step and the field, as a path the author can go to', () => {
    const message = errorOf(withLiteral('thenLabel', 'sleep-step', 'check-ready'));

    expect(message).toContain('steps[0].inputs.thenLabel');
    expect(message).toContain('check-ready');
    expect(message).toContain('{ value: … } inline literal');
    expect(message).toContain('has been removed from the workflow format');
  });

  it('shows the keys: entry plus key binding that replaces it', () => {
    const message = errorOf(withLiteral('thenLabel', 'sleep-step', 'check-ready'));

    // The snippet is the format as it stands, not as it stood: a suggestion
    // naming the removed `storage.seed` block would send an author from one
    // rejected document to another.
    expect(message).toContain(
      '      storage:\n' +
        '        keys:\n' +
        '          then_label:\n' +
        '            seed: "sleep-step"',
    );
    expect(message).toContain('thenLabel: then_label');
  });

  it('says the type check follows the value, and that a seed is writable', () => {
    // The one guarantee the migration could have dropped, and the one
    // difference it introduces: both are stated once, here, so an author does
    // not have to discover either.
    const message = errorOf(withLiteral('thenLabel', 'sleep-step'));

    expect(message).toContain("checked against the contract's inputSchema");
    expect(message).toContain("writable by a later step's outputs");
  });

  it('reports the literal before the schema does, not as a union failure', () => {
    const message = errorOf(withLiteral('thenLabel', 'sleep-step'));

    // The wall of branch mismatches the schema would otherwise emit.
    expect(message).not.toContain('Path: "/steps/0/inputs/thenLabel"');
  });

  it('works on an unlabelled step, where the path is the whole identity', () => {
    const message = errorOf(withLiteral('thenLabel', 'sleep-step'));

    expect(message).toContain('steps[0].inputs.thenLabel');
    expect(message).not.toContain('(step ');
  });

  it('renders the suggested seed as valid YAML, whatever the value is', () => {
    // JSON is a subset of YAML 1.2, so the rendered value can be pasted as-is.
    expect(errorOf(withLiteral('thenLabel', 500))).toContain('seed: 500');
    expect(errorOf(withLiteral('thenLabel', true))).toContain('seed: true');
    expect(errorOf(withLiteral('thenLabel', { a: 1 }))).toContain('seed: {"a":1}');
  });

  it('falls back to a placeholder rather than inlining an unreadable value', () => {
    const message = errorOf(withLiteral('thenLabel', 'x'.repeat(200)));

    expect(message).toContain('seed: <the value you wrote>');
  });

  it('leaves an output or error binding to the schema — nothing to migrate there', () => {
    // `{ value: … }` was never legal on a write, so there is no replacement to
    // show and the schema's own error is the honest one.
    const document = {
      ...baseDocument(),
      steps: [
        {
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          outputs: { timestamp: { value: 1 } },
        },
      ],
    };

    const message = errorOf(document);

    expect(message).not.toContain('has been removed from the workflow format');
    expect(message).toContain('Workflow validation failed');
  });

  it('accepts the migrated form', () => {
    const document = {
      ...baseDocument(),
      storage: {
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
        // `is_ready` is seeded as well as `then_label`: an `inputs:` binding
        // reads it, and a key nothing writes is rejected.
        keys: { then_label: { seed: 'sleep-step' }, is_ready: { seed: true } },
      },
      steps: [
        {
          label: 'check-ready',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'control-flow/branch',
          inputs: { condition: 'is_ready', thenLabel: 'then_label' },
        },
      ],
    };

    expect(validateWorkflowType(document).isOk()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// How a bounded step is spelled
//
// `StepTimeout` is a union, so the schema alone reports every one of these as a
// branch dump. Each of these mistakes is a *reasonable guess* at how the field
// works rather than a typo, so the message has to print the spelling that is
// right — these pin that, not merely the rejection.
// ---------------------------------------------------------------------------

describe('validateWorkflowType — how timeoutMs is spelled', () => {
  function withTimeout(
    timeoutMs: unknown,
    label = 'sleep-step',
  ): Record<string, unknown> {
    const document = baseDocument();
    return {
      ...document,
      steps: [{ ...(document.steps as Record<string, unknown>[])[0]!, label, timeoutMs }],
    };
  }

  function errorOf(document: Record<string, unknown>): string {
    const result = validateWorkflowType(document);
    expect(result.isErr()).toBe(true);
    return result._unsafeUnwrapErr().message;
  }

  it('accepts a whole number of milliseconds and the `unbounded` literal', () => {
    expect(validateWorkflowType(withTimeout(30_000)).isOk()).toBe(true);
    expect(validateWorkflowType(withTimeout('unbounded')).isOk()).toBe(true);
    expect(validateWorkflowType(withTimeout(1)).isOk()).toBe(true);
    expect(validateWorkflowType(withTimeout(2147483647)).isOk()).toBe(true);
  });

  it('accepts a step that declares nothing — absence inherits the contract', () => {
    expect(validateWorkflowType(baseDocument()).isOk()).toBe(true);
  });

  it('rejects 0 and says why it is not "no bound"', () => {
    const message = errorOf(withTimeout(0));

    expect(message).toContain('steps[0].timeoutMs');
    expect(message).toContain('is 0, which is not "no bound"');
    expect(message).toContain('timeoutMs: unbounded');
  });

  it('rejects a negative bound', () => {
    expect(errorOf(withTimeout(-1))).toContain('A duration cannot be negative');
  });

  it('rejects null, and names the bare `timeoutMs:` that produces it in YAML', () => {
    const message = errorOf(withTimeout(null));

    expect(message).toContain('is null');
    expect(message).toContain('bare "timeoutMs:"');
    expect(message).toContain('timeoutMs: unbounded');
  });

  it('rejects a bare `timeoutMs:` written in real YAML', () => {
    // The mistake as an author actually makes it: the key typed, the value not
    // yet. YAML parses it to null, which is why null cannot mean "no bound".
    const document = parseConfig(
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: example',
        'plugins:',
        '  "@rawbox/rawbox-plugin-default": "^1.0.0"',
        'storage:',
        '  defaultStrategy:',
        '    name: lmdb-kv',
        '    valueSizeMax: 1900',
        '  keys:',
        '    sleep_ms:',
        '      seed: 500',
        'steps:',
        '  - label: sleep-step',
        '    plugin: "@rawbox/rawbox-plugin-default"',
        '    operation: time/sleep',
        '    timeoutMs:',
        '    inputs:',
        '      ms: sleep_ms',
      ].join('\n'),
      'inline.yaml',
    );

    expect(errorOf(document as Record<string, unknown>)).toContain('is null');
  });

  it('rejects a boolean', () => {
    expect(errorOf(withTimeout(false))).toContain('is the boolean false');
  });

  it('rejects a fraction', () => {
    expect(errorOf(withTimeout(1.5))).toContain('not a whole number of milliseconds');
  });

  it('rejects a quoted number and shows it unquoted', () => {
    const message = errorOf(withTimeout('5000'));

    expect(message).toContain('is the string "5000", not a number');
    expect(message).toContain('timeoutMs: 5000');
  });

  it('rejects a bound past the setTimeout ceiling, which would invert it', () => {
    const message = errorOf(withTimeout(2147483648));

    expect(message).toContain('exceeds the maximum of 2147483647');
    expect(message).toContain('TimeoutOverflowWarning');
    expect(message).toContain('timeoutMs: unbounded');
  });

  it('rejects the words an author reaches for meaning "no bound"', () => {
    for (const word of ['never', 'none', 'off', 'infinity']) {
      const message = errorOf(withTimeout(word));
      expect(message).toContain(`is ${JSON.stringify(word)}`);
      expect(message).toContain('The only word this field accepts is unbounded');
    }
  });

  it('corrects the case of an almost-right `Unbounded`', () => {
    expect(errorOf(withTimeout('Unbounded'))).toContain(
      'The literal is exactly unbounded, lower-case and unpadded',
    );
  });

  it('reports every offending step, not the first', () => {
    const document = baseDocument();
    const step = (document.steps as Record<string, unknown>[])[0]!;
    const message = errorOf({
      ...document,
      steps: [
        { ...step, label: 'first', timeoutMs: 0 },
        { ...step, label: 'second', timeoutMs: 'never' },
      ],
    });

    expect(message).toContain('steps[0].timeoutMs (step "first")');
    expect(message).toContain('steps[1].timeoutMs (step "second")');
  });

  it('reports it before the schema does, not as a union branch dump', () => {
    const message = errorOf(withTimeout(0));

    expect(message).not.toContain('Path: "/steps/0/timeoutMs"');
    expect(message).not.toContain('anyOf');
  });
});

// ---------------------------------------------------------------------------
// A field belonging to the other strategy
// pins FORMAT.md, "Validation"
//
// `LmdbKV` and `LmdbFIFO` are closed, so the stray field is rejected either
// way. But they are closed inside a *union*, so the schema alone reports it as
// a branch dump over both variants — the same trap the `{ value: … }` check
// above exists to avoid. These pin the message, not just the rejection.
// ---------------------------------------------------------------------------

describe('validateWorkflowType — a field from the other strategy', () => {
  /**
   * The example from "Validation and errors": a queue the author declared as a
   * key-value cell.
   */
  function withStrategies(strategies: Record<string, unknown>): Record<string, unknown> {
    return {
      ...baseDocument(),
      storage: {
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
        keys: {
          ...Object.fromEntries(
            Object.entries(strategies).map(([key, strategy]) => [key, { strategy }]),
          ),
          sleep_ms: { seed: 500 },
        },
      },
    };
  }

  function errorOf(document: Record<string, unknown>): string {
    const result = validateWorkflowType(document);
    expect(result.isErr()).toBe(true);
    return result._unsafeUnwrapErr().message;
  }

  const crossStrategy = () =>
    withStrategies({
      queue_items: { name: 'lmdb-kv', valueSizeMax: 1900, queueSizeMax: 4 },
    });

  it('names the field, the strategy it belongs to, and asks whether that was meant', () => {
    const message = errorOf(crossStrategy());

    expect(message).toContain('storage.keys.queue_items.strategy');
    expect(message).toContain('sets "queueSizeMax"');
    expect(message).toContain('but declares name: lmdb-kv');
    expect(message).toContain('"queueSizeMax" is a field of lmdb-fifo');
    expect(message).toContain('Did you mean name: lmdb-fifo?');
  });

  it('gives the other remedy too — remove it — and says it used to be ignored', () => {
    const message = errorOf(crossStrategy());

    expect(message).toContain('If lmdb-kv is what you meant, remove "queueSizeMax"');
    expect(message).toContain('dropped it silently');
    expect(message).toContain('may have been running as lmdb-kv all along');
    expect(message).toContain('The lmdb-kv strategy takes exactly: name, valueSizeMax.');
  });

  it('is not a union dump: neither variant is listed as a failed branch', () => {
    const message = errorOf(crossStrategy());

    expect(message).not.toContain('anyOf');
    expect(message).not.toContain('must not have additional properties');
    expect(message).not.toContain('must be equal to constant');
    expect(message).not.toContain('Path: "/storage/keys/queue_items/strategy"');
  });

  it('reports the same field on `defaultStrategy`, naming that path', () => {
    const document = {
      ...baseDocument(),
      storage: {
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900, queueSizeMax: 4 },
        keys: { sleep_ms: { seed: 500 } },
      },
    };

    const message = errorOf(document);

    expect(message).toContain('storage.defaultStrategy sets "queueSizeMax"');
    expect(message).toContain('Did you mean name: lmdb-fifo?');
  });

  it('reports an unknown field as a typo rather than as the other strategy', () => {
    const message = errorOf(
      withStrategies({ queue_items: { name: 'lmdb-fifo', queueSizeMax: 4, valueSizeMax: 1900, ttl: 30 } }),
    );

    expect(message).toContain('storage.keys.queue_items.strategy sets "ttl"');
    expect(message).toContain('which is not a field of lmdb-fifo');
    expect(message).toContain('The lmdb-fifo strategy takes exactly: name, queueSizeMax, valueSizeMax.');
    expect(message).toContain('never silently ignored');
    expect(message).not.toContain('Did you mean name:');
  });

  it('reports every stray field in one pass, not one per run', () => {
    const message = errorOf(
      withStrategies({
        queue_items: { name: 'lmdb-kv', valueSizeMax: 1900, queueSizeMax: 4 },
        other_key: { name: 'lmdb-kv', valueSizeMax: 1900, ttl: 30 },
      }),
    );

    expect(message).toContain('storage.keys.queue_items.strategy');
    expect(message).toContain('storage.keys.other_key.strategy');
  });

  it('leaves an unrecognised `name:` to the schema — there is nothing to compare against', () => {
    const message = errorOf(
      withStrategies({ queue_items: { name: 'nonesuch-kv', valueSizeMax: 1900 } }),
    );

    expect(message).toContain('Workflow validation failed');
    expect(message).not.toContain('takes exactly');
  });

  it('accepts each strategy carrying exactly its own fields', () => {
    // Split across two documents, not because the field rules are per-document
    // but because the *store* rule is: a `redis-kv` key beside an `lmdb-kv`
    // default is two stores, and a document whose keys are split across stores
    // is rejected whatever its fields say
    // (`validateCoTransactionalStore`, FORMAT.md, "Strategies"). Both
    // halves below are co-transactional, so what each asserts is what this
    // block is about: every field is accepted on the strategy that owns it.
    expect(
      validateWorkflowType(
        withStrategies({
          queue_items: { name: 'lmdb-fifo', queueSizeMax: 4, valueSizeMax: 1900 },
          plain_key: { name: 'lmdb-kv', valueSizeMax: 1900 },
        }),
      ).isOk(),
    ).toBe(true);

    expect(
      validateWorkflowType({
        ...baseDocument(),
        storage: {
          defaultStrategy: { name: 'redis-kv', valueSizeMax: 1900, backend: 'main' },
          keys: {
            cache_entry: {
              strategy: { name: 'redis-kv', valueSizeMax: 1900, backend: 'main' },
            },
            sleep_ms: { seed: 500 },
          },
        },
      }).isOk(),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The derived field table, against a strategy added after it was written
  //
  // `STRATEGY_SHAPE_LIST` reads the variants off `BoxStrategy.anyOf` rather
  // than listing them, so a third strategy is described by both diagnostics the
  // day it joins the union — with no edit to `validation.ts` and nothing here
  // to keep in step. `redis-kv` is the first strategy to test that claim by
  // actually being added, so these pin the property in both directions rather
  // than only the direction the original two happened to cover.
  // -------------------------------------------------------------------------

  it('describes redis-kv with no hand-kept list: its own fields, quoted back', () => {
    const message = errorOf(
      withStrategies({
        cache_entry: {
          name: 'redis-kv',
          valueSizeMax: 1900,
          backend: 'main',
          ttl: 30,
        },
      }),
    );

    expect(message).toContain('storage.keys.cache_entry.strategy sets "ttl"');
    expect(message).toContain('which is not a field of redis-kv');
    expect(message).toContain(
      'The redis-kv strategy takes exactly: name, valueSizeMax, backend.',
    );
  });

  it('points `queueSizeMax` under redis-kv at lmdb-fifo, and vice versa', () => {
    // The cross-strategy shape, in both directions across the new member: the
    // owner of a stray field is found by searching the derived table, so
    // neither side of this pair needed writing down.
    const queueUnderRedis = errorOf(
      withStrategies({
        cache_entry: {
          name: 'redis-kv',
          valueSizeMax: 1900,
          backend: 'main',
          queueSizeMax: 4,
        },
      }),
    );
    expect(queueUnderRedis).toContain('"queueSizeMax" is a field of lmdb-fifo');
    expect(queueUnderRedis).toContain('Did you mean name: lmdb-fifo?');

    const backendUnderKv = errorOf(
      withStrategies({
        plain_key: { name: 'lmdb-kv', valueSizeMax: 1900, backend: 'main' },
      }),
    );
    expect(backendUnderKv).toContain('"backend" is a field of redis-kv');
    expect(backendUnderKv).toContain('Did you mean name: redis-kv?');
  });

  it('describes redis-fifo the day it joined, with no edit to validation.ts', () => {
    // The second confirmation of the same claim, and the stronger one: this
    // strategy was added (task #14) with `STRATEGY_SHAPE_LIST` untouched, and
    // its four fields are quoted back here because the table is read off
    // `BoxStrategy.anyOf`. A hand-kept list would have described it as
    // "unrecognised" until somebody remembered to add a row.
    const message = errorOf(
      withStrategies({
        job_queue: {
          name: 'redis-fifo',
          queueSizeMax: 8,
          valueSizeMax: 1900,
          backend: 'main',
          ringSizeMax: 8,
        },
      }),
    );

    expect(message).toContain('storage.keys.job_queue.strategy sets "ringSizeMax"');
    expect(message).toContain('which is not a field of redis-fifo');
    expect(message).toContain(
      'The redis-fifo strategy takes exactly: name, queueSizeMax, valueSizeMax, backend.',
    );
  });
});

// ---------------------------------------------------------------------------
// Structural storage boundaries at the authoring layer
//
// The schema's `additionalProperties: false` makes a boundary violation
// unrepresentable in an authored *file*. These pin that down so a future schema
// edit cannot quietly relax it.
// ---------------------------------------------------------------------------

describe('validateWorkflowType — structural storage boundaries', () => {
  function withStep(step: Record<string, unknown>): Record<string, unknown> {
    return { ...baseDocument(), steps: [step] };
  }

  const step = () => ({
    label: 's',
    plugin: '@rawbox/rawbox-plugin-default',
    operation: 'time/sleep',
    inputs: {} as Record<string, unknown>,
    outputs: {} as Record<string, unknown>,
  });

  it('rejects `workspace:` on an output — writes never leave the workspace', () => {
    const s = step();
    s.outputs = { timestamp: { key: 'k', workspace: 'other-workspace' } };

    expect(validateWorkflowType(withStep(s)).isErr()).toBe(true);
  });

  it('rejects `workflow:` on an output — a step only writes into its own workflow', () => {
    const s = step();
    s.outputs = { timestamp: { key: 'k', workflow: 'other-workflow' } };

    expect(validateWorkflowType(withStep(s)).isErr()).toBe(true);
  });

  it('rejects `workspace:` on an input — reads never cross a workspace', () => {
    const s = step();
    s.inputs = { ms: { key: 'k', workspace: 'other-workspace' } };

    expect(validateWorkflowType(withStep(s)).isErr()).toBe(true);
  });

  it('accepts `workflow:` on an input — cross-workflow reads are the one exception', () => {
    const s = step();
    s.inputs = { ms: { key: 'k', workflow: 'upstream-workflow' } };

    expect(validateWorkflowType(withStep(s)).isOk()).toBe(true);
  });

  it('rejects a stray `strategy:` on a location — strategy belongs to the key table', () => {
    const s = step();
    s.inputs = { ms: { key: 'k', strategy: { name: 'lmdb-kv', valueSizeMax: 10 } } };

    expect(validateWorkflowType(withStep(s)).isErr()).toBe(true);
  });

  it('rejects unknown top-level properties — `metadata:`/`settings:` are reserved', () => {
    expect(validateWorkflowType({ ...baseDocument(), metadata: {} }).isErr()).toBe(true);
  });

  it('names the unknown property, which the schema message alone does not', () => {
    // A stray field at the root reports at path "", so "must not have
    // additional properties" would otherwise name nothing at all.
    const result = validateWorkflowType({ ...baseDocument(), metadata: {}, settings: {} });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain(
      'must not have additional properties: "metadata", "settings"',
    );
  });
});

// ---------------------------------------------------------------------------
// validateStorageSizes — the declared byte budget
//
// The over-limit seed value is the whole of the check. An over-limit
// `{ value: … }` literal used to be measured against the key the resolver
// synthesised for it; with that form removed, a constant is a seed like any
// other and there is nothing left for a separate case to cover.
//
// "A FIFO seed list longer than `queueSizeMax - 1` fails validation" is
// implemented below. It was previously backed out, because the runtime stored a
// FIFO seed as one queue entry and a validator must never reject a document the
// runtime would run. That conflict has since been resolved the other way: an
// `lmdb-fifo` seed MUST be a list and each element becomes one queue entry, so
// the element count *is* the queue's initial depth and the check is sound
// again.
// ---------------------------------------------------------------------------

describe('validateStorageSizes', () => {
  /** A document with a `storage:` block spliced in, and no steps to distract. */
  function withStorage(storage: Record<string, unknown>): Record<string, unknown> {
    return { ...baseDocument(), storage, steps: [] };
  }

  const kv = (valueSizeMax: number) => ({ name: 'lmdb-kv', valueSizeMax });
  const fifo = (queueSizeMax: number, valueSizeMax: number) => ({
    name: 'lmdb-fifo',
    queueSizeMax,
    valueSizeMax,
  });
  const redisFifo = (queueSizeMax: number, valueSizeMax: number) => ({
    name: 'redis-fifo',
    queueSizeMax,
    valueSizeMax,
    backend: 'main',
  });

  function errorOf(storage: Record<string, unknown>): string {
    const result = validateStorageSizes(withStorage(storage) as unknown as Workflow);
    expect(result.isErr()).toBe(true);
    return result._unsafeUnwrapErr().message;
  }

  it('accepts the shipped fixtures', async () => {
    for (const name of ['example.workflow.yaml', 'example.workflow.json']) {
      const document = (await loadFixture(name)) as Workflow;
      expect(validateStorageSizes(document).isOk()).toBe(true);
    }
  });

  it('accepts a seed that fits, and a seed for a key with no strategy override', () => {
    const result = validateStorageSizes(
      withStorage({
        defaultStrategy: kv(1900),
        keys: { sleep_ms: { seed: 500 }, greeting: { seed: 'hello' } },
      }) as unknown as Workflow,
    );

    expect(result.isOk()).toBe(true);
  });

  it('T10: rejects an over-limit seed value, naming the key and both sizes', () => {
    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: { ticker: { strategy: kv(100), seed: 'x'.repeat(200) } },
    });

    expect(message).toContain('Storage validation failed');
    expect(message).toContain('storage.keys.ticker.seed');
    expect(message).toContain('202 bytes');
    expect(message).toContain('valueSizeMax of 100');
    expect(message).toContain('storage.keys.ticker.strategy');
    // The value that would be right, not just the one that is wrong.
    expect(message).toContain('Raise storage.keys.ticker.strategy.valueSizeMax to at least 202');
  });

  it('T10: an over-limit seed fails validateWorkflowType, so `verify` catches it', () => {
    const document = withStorage({
      defaultStrategy: kv(10),
      keys: { greeting: { seed: 'x'.repeat(200) } },
    });

    const result = validateWorkflowType(document, 'workflows/big.workflow.yaml');

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('workflows/big.workflow.yaml');
    expect(message).toContain('storage.keys.greeting.seed');
    expect(message).toContain('storage.defaultStrategy');
  });

  it('names storage.defaultStrategy when the key has no override', () => {
    const message = errorOf({
      defaultStrategy: kv(10),
      keys: { greeting: { seed: 'x'.repeat(200) } },
    });

    expect(message).toContain('declared at storage.defaultStrategy');
    expect(message).toContain('Raise storage.defaultStrategy.valueSizeMax to at least 202');
    expect(message).not.toContain('storage.strategies');
  });

  it('reports every over-limit seed in one pass, not just the first', () => {
    const message = errorOf({
      defaultStrategy: kv(10),
      keys: { a: { seed: 'x'.repeat(200) }, b: { seed: 'y'.repeat(300) } },
    });

    expect(message).toContain('storage.keys.a.seed');
    expect(message).toContain('storage.keys.b.seed');
  });

  // -- FIFO seeds: one entry per element -------------------------------------

  it('an lmdb-fifo seed MUST be a list — naming the key, the strategy and the fix', () => {
    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: { queue_items: { strategy: fifo(1000, 1900), seed: 5 } },
    });

    expect(message).toContain('storage.keys.queue_items.seed is a number');
    expect(message).toContain('lmdb-fifo');
    expect(message).toContain('declared at storage.keys.queue_items.strategy');
    expect(message).toContain('MUST be a list: each element becomes one queue entry');
    // The text that would be right, not just the text that is wrong.
    expect(message).toContain('Write [5] to seed a single entry');
    expect(message).toContain('[] to seed an empty queue');
  });

  it('names the offending kind, not just "invalid"', () => {
    const cases: [unknown, string][] = [
      ['abc', 'a string'],
      [{ a: 1 }, 'a map'],
      [true, 'a boolean'],
      [null, 'null'],
    ];

    for (const [value, kind] of cases) {
      const message = errorOf({
        defaultStrategy: kv(1900),
        keys: { q: { strategy: fifo(1000, 1900), seed: value } },
      });
      expect(message).toContain(`storage.keys.q.seed is ${kind}`);
    }
  });

  it('accepts an empty list — a queue seeded with nothing is legal', () => {
    expect(
      validateStorageSizes(
        withStorage({
          defaultStrategy: kv(1900),
          keys: { q: { strategy: fifo(1000, 1900), seed: [] } },
        }) as unknown as Workflow,
      ).isOk(),
    ).toBe(true);
  });

  it('leaves an lmdb-kv seed free to be any shape — the rule is the strategy’s', () => {
    expect(
      validateStorageSizes(
        withStorage({
          defaultStrategy: kv(1900),
          keys: { not_a_queue: { seed: 5 }, still_not: { seed: { a: 1 } } },
        }) as unknown as Workflow,
      ).isOk(),
    ).toBe(true);
  });

  // -- The list length against the ring's usable capacity --------------------

  it('T12: rejects a FIFO seed list longer than queueSizeMax - 1', () => {
    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: {
        queue_items: {
          strategy: fifo(4, 1900),
          seed: Array.from({ length: 50 }, (_, i) => `item-${i}`),
        },
      },
    });

    expect(message).toContain('storage.keys.queue_items.seed has 50 elements');
    expect(message).toContain('holds 3 entries');
    expect(message).toContain('queueSizeMax is 4');
    // The reserved slot is the reason, and the author is told it.
    expect(message).toContain('one slot is permanently reserved');
    expect(message).toContain(
      'Raise storage.keys.queue_items.strategy.queueSizeMax to at least 51',
    );
    expect(message).toContain('or seed at most 3 entries');
  });

  it('T12: accepts exactly queueSizeMax - 1 elements, and rejects one more', () => {
    const storageFor = (count: number) => ({
      defaultStrategy: kv(1900),
      keys: {
        q: { strategy: fifo(4, 1900), seed: Array.from({ length: count }, (_, i) => i) },
      },
    });

    expect(
      validateStorageSizes(withStorage(storageFor(3)) as unknown as Workflow).isOk(),
    ).toBe(true);
    expect(errorOf(storageFor(4))).toContain('has 4 elements');
  });

  it('T12: says "entry", not "entries", at the singular capacity of queueSizeMax 2', () => {
    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: { q: { strategy: fifo(2, 1900), seed: ['a', 'b'] } },
    });

    expect(message).toContain('holds 1 entry');
    expect(message).toContain('or seed at most 1 entry');
  });

  // -- The same check under a strategy that reserves NO slot -----------------
  //
  // `redis-fifo` is a native Redis list: `LLEN` reports the depth outright and
  // an empty list is a key that does not exist, so nothing is held back to tell
  // full from empty. Its `queueSizeMax` of N holds N, where the ring's holds
  // N-1. Both the capacity and the *explanation* come from the strategy's own
  // registry row, and these cases are what stops the verifier from asserting
  // `lmdb-fifo`'s reserved slot over a queue that has none.

  it('T12: a redis-fifo seed may fill queueSizeMax exactly, where the ring may not', () => {
    // 4 elements: legal under `redis-fifo`, and one too many under `lmdb-fifo`
    // at the identical declaration. The pair is the whole divergence.
    expect(
      validateStorageSizes(
        withStorage({
          defaultStrategy: kv(1900),
          keys: { q: { strategy: redisFifo(4, 1900), seed: ['a', 'b', 'c', 'd'] } },
        }) as unknown as Workflow,
      ).isOk(),
    ).toBe(true);

    expect(
      errorOf({
        defaultStrategy: kv(1900),
        keys: { q: { strategy: fifo(4, 1900), seed: ['a', 'b', 'c', 'd'] } },
      }),
    ).toContain('holds 3 entries');
  });

  it('T12: a redis-fifo of queueSizeMax 1 holds its one entry', () => {
    // The schema minimum the ring cannot express. Under `lmdb-fifo` a
    // `queueSizeMax` of 1 would be a queue with zero usable capacity, which is
    // why its schema refuses it; here it is a legal one-entry queue and the
    // seed check must agree with the schema that let it through.
    expect(
      validateStorageSizes(
        withStorage({
          defaultStrategy: kv(1900),
          keys: { q: { strategy: redisFifo(1, 1900), seed: ['only'] } },
        }) as unknown as Workflow,
      ).isOk(),
    ).toBe(true);

    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: { q: { strategy: redisFifo(1, 1900), seed: ['one', 'too many'] } },
    });

    expect(message).toContain('holds 1 entry');
    expect(message).toContain('or seed at most 1 entry');
  });

  it('T12: does NOT tell a redis-fifo author a slot is reserved — it is not', () => {
    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: {
        queue_items: {
          strategy: redisFifo(4, 1900),
          seed: Array.from({ length: 50 }, (_, i) => `item-${i}`),
        },
      },
    });

    expect(message).toContain('storage.keys.queue_items.seed has 50 elements');
    // Capacity IS the ceiling, so the sentence ends after the number...
    expect(message).toContain('holds 4 entries');
    expect(message).toContain('its queueSizeMax is 4.');
    // ...with no reserved-slot clause, which would be a false statement about
    // this author's queue.
    expect(message).not.toContain('permanently reserved');
    // And the remedy asks for exactly what is needed — 50, not the ring's 51.
    expect(message).toContain(
      'Raise storage.keys.queue_items.strategy.queueSizeMax to at least 50,',
    );
    expect(message).toContain('or seed at most 4 entries');
  });

  // -- valueSizeMax bounds an element, not the list --------------------------

  it('measures each element of a FIFO seed individually, not the list whole', () => {
    // Three 49-character strings: each packs to 51 bytes and fits in 100, but
    // the array they form packs to 154. It is the elements that get stored, so
    // it is the elements that must fit — this list is fine.
    const item = 'x'.repeat(49);

    expect(
      validateStorageSizes(
        withStorage({
          defaultStrategy: kv(1900),
          keys: { q: { strategy: fifo(1000, 100), seed: [item, item, item] } },
        }) as unknown as Workflow,
      ).isOk(),
    ).toBe(true);
  });

  it('reports the over-limit element by index, with the per-element rationale', () => {
    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: { q: { strategy: fifo(1000, 100), seed: ['ok', 'x'.repeat(200), 'ok'] } },
    });

    expect(message).toContain('storage.keys.q.seed[1] is 202 bytes');
    expect(message).toContain('valueSizeMax of 100');
    expect(message).toContain(
      'Each element of an lmdb-fifo seed becomes one queue entry',
    );
    expect(message).toContain('Raise storage.keys.q.strategy.valueSizeMax to at least 202');
    // The elements that fit are not mentioned.
    expect(message).not.toContain('storage.keys.q.seed[0]');
    expect(message).not.toContain('storage.keys.q.seed[2]');
  });

  it('reports every over-limit element in one pass, not just the first', () => {
    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: {
        q: { strategy: fifo(1000, 10), seed: ['x'.repeat(200), 'ok', 'y'.repeat(300)] },
      },
    });

    expect(message).toContain('storage.keys.q.seed[0]');
    expect(message).toContain('storage.keys.q.seed[2]');
  });

  it('measures a nested element whole — [[a, b, c]] is one entry holding the list', () => {
    const item = 'x'.repeat(49);

    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: { q: { strategy: fifo(1000, 100), seed: [[item, item, item]] } },
    });

    expect(message).toContain('storage.keys.q.seed[0] is 154 bytes');
    expect(message).toContain('valueSizeMax of 100');
  });

  it('does not consult queueSizeMax when sizing an element', () => {
    // Same seed, same valueSizeMax, different queueSizeMax — both large enough
    // to hold the list, so only the size diagnostic fires and it must be
    // identical: capacity has no bearing on how big one entry may be.
    const seed = ['a'.repeat(200)];
    const small = errorOf({
      defaultStrategy: kv(1900),
      keys: { q: { strategy: fifo(2, 4), seed } },
    });
    const large = errorOf({
      defaultStrategy: kv(1900),
      keys: { q: { strategy: fifo(100000, 4), seed } },
    });

    expect(small).toBe(large);
    expect(small).not.toContain('queueSizeMax');
  });

  // -- Key lengths — Rawbox's portability contract ---------------------------
  //
  // pins FORMAT.md, "Storage keys"
  //
  // The limit is `RAWBOX_KEY_SIZE_MAX` (79 bytes), measured on the **author's**
  // key, and it is the same number for every strategy and every `queueSizeMax`.
  // Its predecessor compared the *derived* key against LMDB's 1978, so the
  // cutoff moved: 1978 under `lmdb-kv`, 1964 at `queueSizeMax: 1000`. That
  // movement is what the `queueSizeMax` case below exists to prevent coming
  // back.

  function acceptsKey(key: string, strategy: Record<string, unknown>): boolean {
    return validateStorageSizes(
      withStorage({
        defaultStrategy: kv(1900),
        keys: { [key]: { strategy } },
      }) as unknown as Workflow,
    ).isOk();
  }

  it('K1: accepts a 79-byte key and rejects an 80-byte one, identically for both strategies', () => {
    expect(RAWBOX_KEY_SIZE_MAX).toBe(79);

    for (const strategy of [kv(10), fifo(1000, 10)]) {
      expect(acceptsKey('k'.repeat(RAWBOX_KEY_SIZE_MAX), strategy)).toBe(true);
      expect(acceptsKey('k'.repeat(RAWBOX_KEY_SIZE_MAX + 1), strategy)).toBe(false);
    }
  });

  it('K1: the cutoff is bytes, not characters — though no legal key can show it', () => {
    // `measureKeySize` is UTF-8 byte length, and the rule is still written over
    // bytes: a 40-character key of 2-byte characters is 80 bytes and is over
    // the limit; 39 of them is 78 and is not.
    const keyLabel = 'Storage key';
    expect(checkKeySize({ key: 'é'.repeat(39), keyLabel })).toBeUndefined();
    expect(checkKeySize({ key: 'é'.repeat(40), keyLabel })).toContain('80 bytes');

    // But neither key survives the character set, which admits ASCII
    // only — so every key a document may actually contain measures one byte per
    // character, and the byte/character distinction is unobservable through a
    // key that passes. The 79 stays a byte count regardless; that is what the
    // two assertions above pin, and they call `checkKeySize` directly because
    // nothing else can reach it with a multi-byte key any more.
    expect(acceptsKey('é'.repeat(39), kv(10))).toBe(false);
    expect(acceptsKey('é'.repeat(40), kv(10))).toBe(false);
  });

  it('K2: queueSizeMax does not move the cutoff', () => {
    const key = 'q'.repeat(RAWBOX_KEY_SIZE_MAX);
    const tooLong = 'q'.repeat(RAWBOX_KEY_SIZE_MAX + 1);

    // Under the old rule the derived key grew with the digit count, so a key
    // acceptable at `queueSizeMax: 2` could be refused at `2 ** 30`. Both ends
    // of that range now answer the same, and so does `lmdb-kv`.
    for (const queueSizeMax of [2, 1000, 2 ** 30]) {
      expect(acceptsKey(key, fifo(queueSizeMax, 10))).toBe(true);
      expect(acceptsKey(tooLong, fifo(queueSizeMax, 10))).toBe(false);
    }

    // And the diagnostic itself is byte-identical across the range: nothing in
    // it can be a function of the strategy.
    const at2 = errorOf({
      defaultStrategy: kv(1900),
      keys: { [tooLong]: { strategy: fifo(2, 10) } },
    });
    const atHuge = errorOf({
      defaultStrategy: kv(1900),
      keys: { [tooLong]: { strategy: fifo(2 ** 30, 10) } },
    });
    const atKv = errorOf({
      defaultStrategy: kv(1900),
      keys: { [tooLong]: { strategy: kv(10) } },
    });

    expect(at2).toBe(atHuge);
    expect(at2).toBe(atKv);
  });

  it('K4: the diagnostic names the key, its length and the limit — and not the derivation', () => {
    const key = 'k'.repeat(80);
    const message = errorOf({ defaultStrategy: kv(1900), keys: { [key]: { strategy: fifo(1000, 10) } } });

    expect(message).toContain(JSON.stringify(key));
    expect(message).toContain('storage.keys');
    expect(message).toContain('80 bytes long');
    expect(message).toContain("Rawbox's maximum storage key size of 79 bytes");
    expect(message).toContain('Shorten the key to at most 79 bytes');
    expect(message).toContain('not configurable');

    // The derivation is no longer the author's concern, and neither is LMDB:
    // an author must not go looking for a backend setting to change.
    expect(message).not.toContain('fifo:');
    expect(message).not.toContain('derived');
    expect(message).not.toContain('queueSizeMax');
    expect(message).not.toContain('LMDB');
    expect(message).not.toContain('1978');
    expect(message).not.toContain('511');
  });

  it('reports a value that cannot be msgpack-encoded rather than throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const message = errorOf({ defaultStrategy: kv(1900), keys: { bad: { seed: cyclic } } });

    expect(message).toContain('storage.keys.bad.seed cannot be stored');
    expect(message).toContain('cycles, out-of-range BigInt and Symbol');
  });

  // -- Keys bound only by a step ---------------------------------------------
  //
  // A key named in a binding and declared nowhere is legal — it resolves
  // through `strategies[key] ?? defaultStrategy` — and is written at run time.
  // It used to be swept by neither static check, so an over-long one passed
  // `verify` and failed hard at the first write.

  it('K3: checks the length of a key bound only by a step', () => {
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv(1900), keys: { sleep_ms: { seed: 500 } } },
      steps: [
        {
          label: 'sleep-step',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { ms: 'sleep_ms' },
          outputs: { timestamp: 'k'.repeat(RAWBOX_KEY_SIZE_MAX + 1) },
        },
      ],
    };

    const result = validateStorageSizes(document as unknown as Workflow);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('bound at steps[0].outputs.timestamp');
    expect(message).toContain('declared nowhere in storage:');
    expect(message).toContain("Rawbox's maximum storage key size of 79 bytes");
  });

  it('does not check a cross-workflow input as one of its own keys', () => {
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv(1900) },
      steps: [
        {
          label: 'drain-step',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: {
            prev: {
              key: 'k'.repeat(RAWBOX_KEY_SIZE_MAX + 1),
              workflow: 'upstream-workflow',
            },
          },
        },
      ],
    };

    // The key is over-long, but it is another workflow's key: this document
    // only reads it, and the workflow that declares it is where it must be
    // checked and charged.
    expect(validateStorageSizes(document as unknown as Workflow).isOk()).toBe(true);
  });

  // -- The key character set -------------------------------------------------
  // pins FORMAT.md, "Storage keys"
  //
  // The point is portability: length alone does not make a key usable as a
  // filename, a path segment or a column value. `:` is excluded because it
  // separates the parts of `fifo:<key>:data:<n>`.

  it('rejects a key outside [A-Za-z0-9_.-]+, naming the offending characters', () => {
    for (const [key, offending] of [
      ['user/profile', '"/"'],
      ['fifo:queue', '":"'],
      ['two words', '" "'],
      ['tab\there', '"\\t"'],
      ['nul\0key', '"\\u0000"'],
      ['café', '"é"'],
    ] as const) {
      const message = errorOf({
        defaultStrategy: kv(1900),
        keys: { [key]: { strategy: kv(10) } },
      });

      expect(message).toContain(JSON.stringify(key));
      expect(message).toContain(`contains ${offending}`);
      expect(message).toContain('MUST match [A-Za-z0-9_.-]+');
      expect(message).toContain('using only those');
      expect(message).toContain('not configurable');
    }
  });

  it('names the empty key as empty rather than listing no characters', () => {
    const message = errorOf({ defaultStrategy: kv(1900), keys: { '': { seed: 1 } } });

    expect(message).toContain('is empty');
    expect(message).toContain('MUST match [A-Za-z0-9_.-]+');
    expect(message).not.toContain('contains ,');
  });

  it('explains why ":" is excluded, since nothing else would say so', () => {
    const message = errorOf({
      defaultStrategy: kv(1900),
      keys: { 'a:b': { strategy: kv(10) } },
    });

    expect(message).toContain('fifo:<key>:data:<n>');
  });

  it('accepts every character the set admits, in either case', () => {
    const key = 'Abc.def-ghi_JKL.0123456789';

    expect(
      validateStorageSizes(
        withStorage({
          defaultStrategy: kv(1900),
          keys: { [key]: { seed: 1 } },
        }) as unknown as Workflow,
      ).isOk(),
    ).toBe(true);
  });

  it('checks the character set of a key bound only by a step, too', () => {
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv(1900), keys: { sleep_ms: { seed: 500 } } },
      steps: [
        {
          label: 'sleep-step',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { ms: 'sleep_ms' },
          outputs: { timestamp: 'slept/at' },
        },
      ],
    };

    const result = validateStorageSizes(document as unknown as Workflow);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('bound at steps[0].outputs.timestamp');
    expect(message).toContain('contains "/"');
  });

  it('leaves a cross-workflow read out of the character-set check as well', () => {
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv(1900) },
      steps: [
        {
          label: 'drain-step',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { prev: { key: 'their/key', workflow: 'upstream-workflow' } },
        },
      ],
    };

    expect(validateStorageSizes(document as unknown as Workflow).isOk()).toBe(true);
  });

  // -- A key read but never written ------------------------------------------
  // pins FORMAT.md, "Storage keys"
  //
  // Not a style complaint: an unwritten `lmdb-kv` key reads as "Value not
  // found" and an unwritten `lmdb-fifo` key as "Queue empty", so the workflow
  // cannot run. Two exclusions decide whether the rule is correct — a
  // cross-workflow read is another workflow's responsibility, and a write by
  // *any* step counts whatever the order.

  /** A document whose one step reads `key` and writes nothing else. */
  function readsOnly(key: string, storage: Record<string, unknown>) {
    return {
      ...baseDocument(),
      storage,
      steps: [
        {
          label: 'reader',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { ms: key },
        },
      ],
    } as unknown as Workflow;
  }

  it('rejects a key read but never written, naming the key, the binding and both fixes', () => {
    const result = validateStorageSizes(
      readsOnly('sleep_ms', { defaultStrategy: kv(1900) }),
    );

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;

    expect(message).toContain('steps[0].inputs.ms (step "reader")');
    expect(message).toContain('reads storage key "sleep_ms"');
    expect(message).toContain('no step writes it and no storage.keys entry seeds it');
    // Both fixes, not just the diagnosis.
    expect(message).toContain('seed it — set storage.keys.sleep_ms.seed');
    expect(message).toContain("name \"sleep_ms\" in some step's outputs: or errors:");
    expect(message).toContain('A write by any step counts, whatever the order');
  });

  it('says how the read fails, per the strategy the key resolves to', () => {
    expect(
      validateStorageSizes(
        readsOnly('cell', { defaultStrategy: kv(1900) }),
      )._unsafeUnwrapErr().message,
    ).toContain('the read fails with "Value not found"');

    expect(
      validateStorageSizes(
        readsOnly('queue', {
          defaultStrategy: kv(1900),
          keys: { queue: { strategy: fifo(1000, 1900) } },
        }),
      )._unsafeUnwrapErr().message,
    ).toContain('the read fails with "Queue empty"');
  });

  it('accepts a seeded key, and one declared under strategies is not thereby written', () => {
    expect(
      validateStorageSizes(
        readsOnly('sleep_ms', {
          defaultStrategy: kv(1900),
          keys: { sleep_ms: { seed: 500 } },
        }),
      ).isOk(),
    ).toBe(true);

    // A strategy declares how the key stores, not that anything ever puts
    // something in it — so it does not satisfy the rule.
    expect(
      validateStorageSizes(
        readsOnly('sleep_ms', {
          defaultStrategy: kv(1900),
          keys: { sleep_ms: { strategy: kv(1900) } },
        }),
      ).isErr(),
    ).toBe(true);
  });

  it('does not flag a `{ key, workflow }` cross-workflow read', () => {
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv(1900) },
      steps: [
        {
          label: 'drain-step',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { prev: { key: 'upstream_result', workflow: 'upstream-workflow' } },
        },
      ],
    };

    // That key is `upstream-workflow`'s to write. Flagging it would reject a
    // legitimate document.
    expect(validateStorageSizes(document as unknown as Workflow).isOk()).toBe(true);
  });

  it('does not flag a key read at step 1 and written at step 5 — order is not analysed', () => {
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv(1900) },
      steps: [
        {
          label: 'read-first',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { ms: 'accumulator' },
        },
        ...['b', 'c', 'd'].map((label) => ({
          label,
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: {},
        })),
        {
          label: 'write-last',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          outputs: { timestamp: 'accumulator' },
        },
      ],
    };

    // Fails on the first run and works thereafter: a legitimate pattern for
    // state that accumulates across runs, so no order analysis is attempted.
    expect(validateStorageSizes(document as unknown as Workflow).isOk()).toBe(true);
  });

  it('counts an `errors:` binding as a write, like an `outputs:` one', () => {
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv(1900) },
      steps: [
        {
          label: 'reader',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { ms: 'last_error' },
          errors: { message: 'last_error' },
        },
      ],
    };

    expect(validateStorageSizes(document as unknown as Workflow).isOk()).toBe(true);
  });

  it('reports one line per unwritten key, not one per binding that reads it', () => {
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv(1900) },
      steps: [
        {
          label: 'first',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { ms: 'missing' },
        },
        {
          label: 'second',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { ms: 'missing' },
        },
      ],
    };

    const message = validateStorageSizes(
      document as unknown as Workflow,
    )._unsafeUnwrapErr().message;

    expect(message.split('reads storage key')).toHaveLength(2);
    expect(message).toContain('(step "first")');
    expect(message).not.toContain('(step "second")');
  });

  it('names the step by index when it has no label', () => {
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv(1900) },
      steps: [
        {
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: { ms: 'missing' },
        },
      ],
    };

    const message = validateStorageSizes(
      document as unknown as Workflow,
    )._unsafeUnwrapErr().message;

    expect(message).toContain('steps[0].inputs.ms reads storage key "missing"');
  });
});

// ---------------------------------------------------------------------------
// One workflow, one store
// pins FORMAT.md, "Strategies" and "Validation"
//
// One step's outputs are written and the next step's inputs are read in a single
// transaction (`syncData`), and a transaction cannot span two stores — so a
// document whose keys resolve to more than one store cannot run, and is rejected
// at verify time where the author is looking.
//
// **The crux these cases exist for is the discriminator.** A `backend` category
// — `'lmdb' | 'redis'` — would pass the two-servers case below, because it would
// call two Redis servers one backend. The pair of cases marked SAME and
// DIFFERENT is the assertion that the check reads store *identity* instead: same
// `backend:` id accepted, different `backend:` ids rejected, both under one
// strategy name.
// ---------------------------------------------------------------------------

describe('validateWorkflowType — every key in one store', () => {
  const kv = { name: 'lmdb-kv', valueSizeMax: 1900 };
  const fifo = { name: 'lmdb-fifo', queueSizeMax: 8, valueSizeMax: 1900 };
  const redis = (backend: string) => ({
    name: 'redis-kv',
    valueSizeMax: 1900,
    backend,
  });
  const redisQueue = (backend: string) => ({
    name: 'redis-fifo',
    queueSizeMax: 8,
    valueSizeMax: 1900,
    backend,
  });

  /** `baseDocument`'s steps and identity, with a `storage:` block spliced in. */
  function withStorage(storage: Record<string, unknown>): Record<string, unknown> {
    return { ...baseDocument(), storage };
  }

  function errorOf(storage: Record<string, unknown>): string {
    const result = validateWorkflowType(withStorage(storage));
    expect(result.isErr()).toBe(true);
    return result._unsafeUnwrapErr().message;
  }

  it('verifies an all-LMDB document, cells and queues together', () => {
    // `lmdb-kv` and `lmdb-fifo` are two key layouts inside ONE environment, and
    // one `transactionSync` writes both — so a cell beside a queue is
    // co-transactional and must not be reported. This is the false positive a
    // per-strategy identity would produce.
    expect(
      validateWorkflowType(
        withStorage({
          defaultStrategy: kv,
          keys: {
            queue_items: { strategy: fifo, seed: ['a', 'b'] },
            plain_key: { strategy: kv },
            sleep_ms: { seed: 500 },
          },
        }),
      ).isOk(),
    ).toBe(true);
  });

  it('rejects an lmdb-kv default beside a redis-kv key, naming both stores', () => {
    const message = errorOf({
      defaultStrategy: kv,
      keys: { cache_entry: { strategy: redis('main') }, sleep_ms: { seed: 500 } },
    });

    // Both keys, and where each strategy is declared.
    expect(message).toContain('storage key "cache_entry"');
    expect(message).toContain('storage key "sleep_ms"');
    expect(message).toContain('declared at storage.keys.cache_entry.strategy');
    expect(message).toContain('declared at storage.defaultStrategy');

    // Both stores, in terms a reader can act on — never the opaque ids.
    expect(message).toContain('the Redis server named by backend: "main"');
    expect(message).toContain("the workspace's LMDB environment");
    expect(message).not.toContain('lmdb:workspace');
    expect(message).not.toContain('redis:main');

    // Why it cannot work, and the two edits that fix it.
    expect(message).toContain(
      "One step's outputs are written and the next step's inputs are read in a " +
        'single transaction, and a transaction cannot span two stores',
    );
    expect(message).toContain(
      'Point them at one store: change the strategy at ' +
        'storage.keys.cache_entry.strategy, or the one at storage.defaultStrategy.',
    );
  });

  it('accepts two redis-kv keys on the SAME backend id', () => {
    // One server, so one `MULTI`: co-transactional, and nothing to report.
    expect(
      validateWorkflowType(
        withStorage({
          defaultStrategy: redis('cache'),
          keys: {
            session: { strategy: redis('cache') },
            token: { strategy: redis('cache') },
            sleep_ms: { seed: 500 },
          },
        }),
      ).isOk(),
    ).toBe(true);
  });

  it('accepts a redis-kv cell beside a redis-fifo queue on ONE backend', () => {
    // The Redis counterpart of the all-LMDB case above, and the pairing most
    // likely to be got wrong: a cell and a queue on one server are ONE store —
    // one connection, one `MULTI`, one Lua scope — exactly as `lmdb-kv` and
    // `lmdb-fifo` are one environment. An identity spelled per *strategy*
    // rather than per *server* would reject this legal document, so the two
    // rows build it through one function (`@rawbox/store`,
    // `strategy/descriptor.ts`, `redisBackendStore`).
    expect(
      validateWorkflowType(
        withStorage({
          defaultStrategy: redis('cache'),
          keys: {
            job_queue: { strategy: redisQueue('cache'), seed: ['a', 'b'] },
            session: { strategy: redis('cache') },
            sleep_ms: { seed: 500 },
          },
        }),
      ).isOk(),
    ).toBe(true);
  });

  it('rejects a redis-fifo queue on a DIFFERENT backend from the cells', () => {
    // The other direction, and the one a shared `redis:` prefix must not
    // paper over: nothing spans two Redis servers, whatever the strategies are
    // called. The ids differ, so the stores differ.
    const message = errorOf({
      defaultStrategy: redis('alpha'),
      keys: { job_queue: { strategy: redisQueue('beta'), seed: ['a'] }, sleep_ms: { seed: 500 } },
    });

    expect(message).toContain('are in different stores');
    expect(message).toContain('the Redis server named by backend: "beta"');
    expect(message).toContain('the Redis server named by backend: "alpha"');
    expect(message).toContain('declared at storage.keys.job_queue.strategy');
    expect(message).toContain('(name: redis-fifo)');
  });

  it('rejects a redis-fifo queue beside an lmdb-fifo one — two queues, two stores', () => {
    // Both are queues and both expand a seed into one entry per element, which
    // is exactly the similarity a `kind`-based check would have been fooled by.
    // A ring in this workspace's LMDB file and a list on a server are not one
    // transaction.
    const message = errorOf({
      defaultStrategy: kv,
      keys: {
        local_queue: { strategy: fifo, seed: ['a'] },
        remote_queue: { strategy: redisQueue('main'), seed: ['b'] },
        sleep_ms: { seed: 500 },
      },
    });

    expect(message).toContain('storage key "remote_queue"');
    expect(message).toContain('the Redis server named by backend: "main"');
    expect(message).toContain("the workspace's LMDB environment");
  });

  it('rejects two redis-kv keys on DIFFERENT backend ids — the case a backend label gets wrong', () => {
    // Same strategy name, same schema, same fields: a check comparing a
    // `'redis'` category would accept this document, and the run would fail on
    // the first step-to-step hand-off because nothing spans two servers.
    const message = errorOf({
      defaultStrategy: redis('alpha'),
      keys: { session: { strategy: redis('beta') }, sleep_ms: { seed: 500 } },
    });

    expect(message).toContain('are in different stores');
    expect(message).toContain('the Redis server named by backend: "beta"');
    expect(message).toContain('the Redis server named by backend: "alpha"');
    expect(message).toContain('declared at storage.keys.session.strategy');

    // The rule the author has to learn, stated in the message rather than left
    // to be inferred from two Redis servers being called two stores.
    expect(message).toContain(
      'two keys on the same backend: id are one store, and two keys on ' +
        'different backend: ids are two',
    );
  });

  it('does not reach a { key, workflow } cross-workflow read', () => {
    // The key names ANOTHER workflow's box. That workflow owns it, writes it
    // and stores it — wherever it stores it — and it is not part of this
    // workflow's transaction, so this document is co-transactional and
    // verifies. The same exclusion the budget and the unwritten-read rule
    // already make.
    const document = {
      ...baseDocument(),
      storage: { defaultStrategy: kv, keys: { sleep_ms: { seed: 500 } } },
      steps: [
        {
          label: 'read-upstream',
          plugin: '@rawbox/rawbox-plugin-default',
          operation: 'time/sleep',
          inputs: {
            ms: 'sleep_ms',
            // Held in Redis by `upstream-workflow`, which is that document's
            // business and not this one's.
            other: { key: 'their_cache', workflow: 'upstream-workflow' },
          },
          outputs: { timestamp: 'slept_at' },
        },
      ],
    };

    expect(validateWorkflowType(document).isOk()).toBe(true);
  });

  it('reports one problem per divergent store, listing the rest of its keys', () => {
    // One mistake, not four: a line per key would bury the split it is
    // describing.
    const message = errorOf({
      defaultStrategy: kv,
      keys: {
        cache_entry: { strategy: redis('main') },
        session: { strategy: redis('main') },
        token: { strategy: redis('main') },
        sleep_ms: { seed: 500 },
      },
    });

    expect(message.split('are in different stores')).toHaveLength(2);
    expect(message).toContain(
      'Also resolving to the Redis server named by backend: "main": ' +
        '"session", "token".',
    );
  });

  it('reports one problem per store when three stores are named', () => {
    const message = errorOf({
      defaultStrategy: kv,
      keys: {
        alpha_key: { strategy: redis('alpha') },
        beta_key: { strategy: redis('beta') },
        sleep_ms: { seed: 500 },
      },
    });

    expect(message.split('are in different stores')).toHaveLength(3);
  });

  it('is deterministic: the same document gives byte-identical output', () => {
    const storage = {
      defaultStrategy: kv,
      keys: {
        zeta: { strategy: redis('main') },
        alpha: { strategy: redis('other') },
        mid: { strategy: redis('main') },
        sleep_ms: { seed: 500 },
      },
    };

    expect(errorOf(storage)).toBe(errorOf(storage));
    // Declaration order, not sorted and not a set's iteration order: `zeta` is
    // declared first, so its store is reported first.
    expect(errorOf(storage).indexOf('"zeta"')).toBeLessThan(
      errorOf(storage).indexOf('"alpha"'),
    );
  });

  it('is not a schema branch dump over the strategy union', () => {
    const message = errorOf({
      defaultStrategy: kv,
      keys: { cache_entry: { strategy: redis('main') }, sleep_ms: { seed: 500 } },
    });

    expect(message).not.toContain('anyOf');
    expect(message).not.toContain('must not have additional properties');
    expect(message).not.toContain('must be equal to constant');
    expect(message).not.toContain('Path: "/storage/keys/cache_entry/strategy"');
  });

  it('leaves a document the schema rejects to the schema', () => {
    // The check reads resolved strategy fields — `backend:` among them — so it
    // runs only after the schema has accepted the document. A strategy with no
    // recognised `name:` has no store to ask about, and the author needs the
    // schema's error rather than a second opinion about stores.
    const message = errorOf({
      defaultStrategy: kv,
      keys: {
        cache_entry: { strategy: { name: 'nonesuch-kv', valueSizeMax: 1900 } },
        sleep_ms: { seed: 500 },
      },
    });

    expect(message).toContain('Workflow validation failed');
    expect(message).not.toContain('are in different stores');
  });

  it('runs after the per-key checks, so a bad seed is reported first', () => {
    // Two different subjects: `validateStorageSizes` reports each key's own
    // declaration, this reports the key table compared against itself. An
    // author fixes the declarations first.
    const message = errorOf({
      defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 2 },
      keys: { cache_entry: { strategy: redis('main') }, sleep_ms: { seed: 500 } },
    });

    expect(message).toContain('exceeds the valueSizeMax of 2');
    expect(message).not.toContain('are in different stores');
  });
});

// ---------------------------------------------------------------------------
// collectBoundStorageKeys — the sweep the budget is built on
// ---------------------------------------------------------------------------

describe('collectBoundStorageKeys', () => {
  it('sweeps the shipped fixture, in binding order, excluding what it must', async () => {
    const document = await loadFixture('example.workflow.yaml');

    // Every shorthand and long-form binding across the three steps, first
    // occurrence only. One thing is deliberately absent: `upstream_result`, a
    // `{ key, workflow }` cross-workflow read. Those bytes belong to
    // `upstream-workflow`'s budget, and a workspace total is a plain sum over
    // workflows, so counting them here double-counts them.
    //
    // `then_label` and `else_label` — the branch step's jump targets — are
    // present, and that is what removing `{ value: … }` changed: they used to be
    // `{ value: … }` literals carrying no key at all, swept by nothing and
    // budgeted nowhere, because the resolver synthesised a key for them after
    // this sweep had run. They are now ordinary seeded keys, so the sweep sees
    // them like any other.
    expect(collectBoundStorageKeys(document)).toEqual([
      'sleep_ms',
      'sleep_done_at',
      'sleep_error',
      'queue_items',
      'drained_count',
      'drain_error',
      'is_ready',
      'then_label',
      'else_label',
      'branch_error',
    ]);
  });

  it('deduplicates a key bound by more than one step, and tolerates a document with no steps', () => {
    const document = {
      steps: [
        { inputs: { a: 'shared' }, outputs: { b: 'shared' } },
        { errors: { message: 'shared' } },
      ],
    };

    expect(collectBoundStorageKeys(document)).toEqual(['shared']);
    expect(collectBoundStorageKeys({ steps: [] })).toEqual([]);
    expect(collectBoundStorageKeys({})).toEqual([]);
    expect(collectBoundStorageKeys(undefined)).toEqual([]);
  });

  // One traversal, two rules. `collectBoundStorageKeys` is a view over
  // `collectStorageBindingList` rather than a second walk, so the budget and
  // the unwritten-read check can never disagree about what a document
  // binds.
  it('is a view over one traversal that keeps roles and cross-workflow reads', () => {
    const document = {
      steps: [
        {
          label: 'read-step',
          inputs: { a: 'local', b: { key: 'theirs', workflow: 'other-flow' } },
          outputs: { c: 'written' },
        },
      ],
    };

    expect(collectStorageBindingList(document)).toEqual([
      {
        key: 'local',
        role: 'inputs',
        path: 'steps[0].inputs.a',
        stepLabel: 'read-step',
        bindingWorkflow: undefined,
        keyWorkflow: undefined,
        owningWorkflow: undefined,
        crossWorkflow: false,
      },
      {
        key: 'theirs',
        role: 'inputs',
        path: 'steps[0].inputs.b',
        stepLabel: 'read-step',
        // The binding names the owner; this document's `storage:` block does
        // not exist at all, so the key table names nobody. Both spellings feed
        // the one `owningWorkflow` every reader now uses.
        bindingWorkflow: 'other-flow',
        keyWorkflow: undefined,
        owningWorkflow: 'other-flow',
        crossWorkflow: true,
      },
      {
        key: 'written',
        role: 'outputs',
        path: 'steps[0].outputs.c',
        stepLabel: 'read-step',
        bindingWorkflow: undefined,
        keyWorkflow: undefined,
        owningWorkflow: undefined,
        crossWorkflow: false,
      },
    ]);

    // The budget's view drops the cross-workflow read, exactly as before.
    expect(collectBoundStorageKeys(document)).toEqual(['local', 'written']);
  });

  // -------------------------------------------------------------------------
  // The budget over the shipped fixture — 10 keys, not 5
  //
  // Every figure below is derived by hand, not read back out of
  // `budgetForStorage`. overhead(k) = LMDB_INDEX_POINTER + LMDB_NODE_HEADER + k
  //                                = 2 + 8 + k = k + 10.
  //
  // `example.workflow.yaml` declares `defaultStrategy: lmdb-kv, valueSizeMax
  // 1900` and five `storage.keys` entries, of which one (`queue_items`) states
  // a strategy of its own.
  //
  // Both calls below go through `boxStorageFor`, never `document.storage`
  // spread directly. That is not a stylistic preference: `BoxStorage` is
  // `{ defaultStrategy, strategies?, seed?, boundKeyList? }` and every field
  // past the first is optional, so a raw `{ defaultStrategy, keys }` still
  // TYPE-CHECKS as one and charges **nothing** — this whole table would come
  // back as an empty list and two zeroes, and the assertions that survived
  // would pass for the wrong reason.
  //
  // DECLARED — the `storage.keys` entries, in document order:
  //
  //   queue_items   lmdb-fifo, queueSizeMax 1000, valueSizeMax 1900
  //                 dataKeyLen = len("fifo:queue_items:data:") + digits(999)
  //                            = (5 + 11 + 6) + 3                    =      25
  //                 in-page?  25 + 1900 = 1925 ≤ 2013, yes
  //                 slot      = overhead(25) + 1900 = 35 + 1900      =   1 935
  //                 slots     = (1000 - 1) * 1935                    = 1933 065
  //                 head      = overhead(len("fifo:queue_items:head")) + 9
  //                           = overhead(21) + 9 = 31 + 9            =      40
  //                 tail      = same                                 =      40
  //                                                                    -------
  //                                                                   1933 145
  //                 entries   = 999 + 2                              =    1001
  //
  //   sleep_ms      lmdb-kv (defaultStrategy), key 8 bytes
  //                 8 + 1900 = 1908 ≤ 2013, in-page
  //                 overhead(8) + 1900 = 18 + 1900                   =   1 918
  //   is_ready      identical, key 8 bytes                           =   1 918
  //   then_label    lmdb-kv, key 10 bytes  overhead(10) + 1900       =   1 920
  //   else_label    identical, key 10 bytes                          =   1 920
  //
  //   declared total                                                 = 1940 821
  //   declared entries = 1001 + 1 + 1 + 1 + 1                        =    1005
  //
  // BOUND — named by a step binding, declared nowhere. All resolve to
  // `defaultStrategy` (lmdb-kv, valueSizeMax 1900), all in-page:
  //
  //   sleep_done_at  13 bytes  overhead(13) + 1900 = 23 + 1900       =   1 923
  //   sleep_error    11 bytes  overhead(11) + 1900 = 21 + 1900       =   1 921
  //   drained_count  13 bytes                                        =   1 923
  //   drain_error    11 bytes                                        =   1 921
  //   branch_error   12 bytes  overhead(12) + 1900 = 22 + 1900       =   1 922
  //                                                                    -------
  //   bound total                                                    =   9 610
  //   bound entries                                                  =       5
  //
  // NOT counted: `upstream_result`, a `{ key, workflow }` cross-workflow read —
  // the owning workflow's bytes. That is now the only exclusion. `check-ready`'s
  // two jump targets used to be `{ value: … }` literals and escaped the budget
  // entirely, because the key they were stored under did not exist until after
  // this sweep ran; as seeded keys they are counted above, among the declared.
  //
  //   dataBytesMax = 1 940 821 + 9 610                               = 1950 431
  //   entryCount   = 1005 + 5                                        =    1010
  //
  //   recommendedVolumeBytes = ceil((1950431 * 4 + 262144) / 4096) * 4096
  //                          = ceil(8 063 868 / 4096) * 4096
  //                          = ceil(1968.717...) * 4096 = 1969 * 4096
  //                                                                  = 8065 024
  // -------------------------------------------------------------------------

  it("covers 10 keys of the shipped fixture, not the 5 it declares", async () => {
    const document = (await loadFixture('example.workflow.yaml')) as Workflow;

    const declaredOnly = budgetForStorage(boxStorageFor(document.storage));
    const withBindings = budgetForStorage({
      ...boxStorageFor(document.storage),
      boundKeyList: collectBoundStorageKeys(document),
    });

    // What the budget used to report: the declared keys only, and an
    // under-count of 9,610 bytes against what the workflow can actually write.
    expect(declaredOnly.keyBudgetList).toHaveLength(5);
    expect(declaredOnly.dataBytesMax).toBe(1_940_821);
    expect(declaredOnly.entryCount).toBe(1005);

    expect(
      withBindings.keyBudgetList.map((keyBudget) => [
        keyBudget.key,
        keyBudget.source,
        keyBudget.dataBytesMax,
      ]),
    ).toEqual([
      ['queue_items', 'declared', 1_933_145],
      ['sleep_ms', 'declared', 1918],
      ['is_ready', 'declared', 1918],
      ['then_label', 'declared', 1920],
      ['else_label', 'declared', 1920],
      ['sleep_done_at', 'bound', 1923],
      ['sleep_error', 'bound', 1921],
      ['drained_count', 'bound', 1923],
      ['drain_error', 'bound', 1921],
      ['branch_error', 'bound', 1922],
    ]);

    expect(withBindings.dataBytesMax).toBe(1_950_431);
    expect(withBindings.dataBytesMax - declaredOnly.dataBytesMax).toBe(9610);
    expect(withBindings.entryCount).toBe(1010);
    // Page model: leaf shares accumulated fractionally and
    // rounded once — a leaf page belongs to the dbi, not to a key:
    //   queue_items  999 data slots, node 2+8+even(25)+even(1918) = 1954,
    //                floor(4080/1954) = 2 -> 999 / 1.1        = 908.181818
    //                head+tail, node 60, floor(4080/60) = 68  =   0.053476
    //   9 kv keys    node <= 1942, 2 to a page -> 1 / 1.1 each =   8.181818
    //                                                           -----------
    //   pageCountMax                            ceil(916.417112) =       917
    //   (8192 + 6144 + 4096 * 917) * 1.15 = 4,335,923.2 -> 1059 pages
    expect(withBindings.recommendedVolumeBytes).toBe(4_337_664);

    // The cross-workflow read is absent from the budget entirely, not merely
    // charged elsewhere: counting it here would double-count it against
    // `upstream-workflow` in a workspace total, which is a plain sum.
    expect(
      withBindings.keyBudgetList.map((keyBudget) => keyBudget.key),
    ).not.toContain('upstream_result');
  });
});

// ---------------------------------------------------------------------------
// validateResolvedWorkflow — the runtime model
// ---------------------------------------------------------------------------

describe('validateResolvedWorkflow', () => {
  it('accepts a resolved workflow', () => {
    expect(validateResolvedWorkflow(baseResolved()).isOk()).toBe(true);
  });

  it('rejects a resolved workflow missing pluginPathList', () => {
    const workflow = { name: 'invalid', stepList: [] };
    const result = validateResolvedWorkflow(workflow);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Resolved workflow validation failed');
  });

  it('does not require `kind:` — a resolved workflow never comes from a file', () => {
    expect(validateResolvedWorkflow(baseResolved()).isOk()).toBe(true);
    // The same object is *not* a valid authoring document, which is precisely why
    // the two models need separate entry points.
    expect(validateWorkflowType(baseResolved()).isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateStorageBoundaries — the boundary rules a schema cannot state
// ---------------------------------------------------------------------------

describe('validateStorageBoundaries', () => {
  it('accepts a workflow whose locations stay inside their boundaries', () => {
    expect(validateStorageBoundaries(baseResolved(), 'test-workspace').isOk()).toBe(true);
  });

  it('accepts a cross-workflow read on an input', () => {
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.input = {
      ms: { key: 'upstream_result', strategy: KV, workflow: 'upstream-workflow' },
    };

    expect(validateStorageBoundaries(workflow, 'test-workspace').isOk()).toBe(true);
  });

  it('REJECTS an output that names another workspace', () => {
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.output = {
      timestamp: { key: 'k', strategy: KV, workspace: 'other-workspace' },
    } as never;

    const result = validateStorageBoundaries(workflow, 'test-workspace');

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('Storage boundary validation failed');
    expect(message).toContain('output "timestamp"');
    expect(message).toContain('other-workspace');
    expect(message).toContain('never write to another workspace');
  });

  it('REJECTS an input that names another workspace', () => {
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.input = {
      ms: { key: 'k', strategy: KV, workspace: 'other-workspace' },
    } as never;

    const result = validateStorageBoundaries(workflow, 'test-workspace');

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('input "ms"');
    expect(message).toContain('never read from another workspace');
  });

  it('REJECTS an output that names another workflow', () => {
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.output = {
      timestamp: { key: 'k', strategy: KV, workflow: 'other-workflow' },
    } as never;

    const result = validateStorageBoundaries(workflow, 'test-workspace');

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('only write into its own workflow');
    expect(message).toContain('other-workflow');
  });

  it('REJECTS an error location that names another workflow', () => {
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.error = {
      message: { key: 'k', strategy: KV, workflow: 'other-workflow' },
    } as never;

    const result = validateStorageBoundaries(workflow, 'test-workspace');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('error "message"');
  });

  it('rejects a workspace property even when it names the current workspace', () => {
    // It is still not part of the model, and `buildBoxRecord` would drop it
    // silently — reporting beats discarding.
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.output = {
      timestamp: { key: 'k', strategy: KV, workspace: 'test-workspace' },
    } as never;

    expect(validateStorageBoundaries(workflow, 'test-workspace').isErr()).toBe(true);
  });

  it('rejects an unknown storage property', () => {
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.input = {
      ms: { key: 'k', strategy: KV, ttl: 30 },
    } as never;

    const result = validateStorageBoundaries(workflow, 'test-workspace');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('unknown storage property "ttl"');
  });

  it('rejects an empty `workflow` on an input, which would silently fall back', () => {
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.input = {
      ms: { key: 'k', strategy: KV, workflow: '' },
    };

    const result = validateStorageBoundaries(workflow, 'test-workspace');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('empty "workflow" property');
  });

  it('identifies the offending step by label, and by index when unlabelled', () => {
    const labelled = baseResolved();
    labelled.stepList[0]!.storageLocation.output = {
      t: { key: 'k', strategy: KV, workspace: 'elsewhere' },
    } as never;
    expect(validateStorageBoundaries(labelled, 'ws')._unsafeUnwrapErr().message).toContain(
      'Step "sleep-step"',
    );

    const unlabelled = baseResolved();
    delete unlabelled.stepList[0]!.label;
    unlabelled.stepList[0]!.storageLocation.output = {
      t: { key: 'k', strategy: KV, workspace: 'elsewhere' },
    } as never;
    expect(validateStorageBoundaries(unlabelled, 'ws')._unsafeUnwrapErr().message).toContain(
      'Step #0',
    );
  });

  it('is doubled by the store schemas, which now close the same hole', () => {
    // `WriteBoxLocation`/`ReadBoxLocation` are `StrictObject`s, so a stray
    // property no longer passes the schema to be silently discarded by
    // `buildBoxRecord`. This test used to assert the opposite, back when the
    // schemas did not in fact close the hole.
    const writeValidator = Compile(WriteBoxLocation);
    const readValidator = Compile(ReadBoxLocation);

    expect(
      writeValidator.Check({ key: 'k', strategy: KV, workflow: 'other', workspace: 'other' }),
    ).toBe(false);
    expect(readValidator.Check({ key: 'k', strategy: KV, workspace: 'other' })).toBe(false);

    // …and so does the ResolvedWorkflow schema that embeds them.
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.output = {
      timestamp: { key: 'k', strategy: KV, workspace: 'other-workspace' },
    } as never;
    expect(validateResolvedWorkflow(workflow).isErr()).toBe(true);
  });

  it('is still load-bearing: it says what the schema cannot', () => {
    // The schema can say `workspace` is not a property of a write location. It
    // cannot say that a step may never write outside its own workspace, nor
    // which workspace was named — which is the whole of a usable diagnostic.
    // That is why this check survives the schemas being closed, and why
    // `startFunc` runs it first.
    const workflow = baseResolved();
    workflow.stepList[0]!.storageLocation.output = {
      timestamp: { key: 'k', strategy: KV, workspace: 'other-workspace' },
    } as never;

    // The schema names the property — that much comes from the formatter —
    // but not the workspace it named, and not what the property means.
    const schemaMessage = validateResolvedWorkflow(workflow)._unsafeUnwrapErr().message;
    expect(schemaMessage).toContain('must not have additional properties: "workspace"');
    expect(schemaMessage).not.toContain('other-workspace');
    expect(schemaMessage).not.toContain('never write to another workspace');

    const boundaryMessage = validateStorageBoundaries(workflow, 'test-workspace')
      ._unsafeUnwrapErr()
      .message;
    expect(boundaryMessage).toContain('other-workspace');
    expect(boundaryMessage).toContain('never write to another workspace');
  });
});

// ---------------------------------------------------------------------------
// validateSeedData — the seed map, on resolver output
// ---------------------------------------------------------------------------

describe('validateSeedData', () => {
  // `ContractRegistryCache.getContractRegistry` only answers for a 64-char hex
  // SHA-256; anything else returns undefined and would skip validation silently.
  const registryHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

  const contractRegistryCache = new ContractRegistryCache(
    new Map([
      [
        registryHash,
        {
          contractRecord: {
            './sum.definition.js': {
              type: 'operation' as const,
              description: 'Sum two numbers',
              errorSchema: Type.Object({}),
              inputSchema: Type.Object({ a: Type.Number(), b: Type.String() }),
              outputSchema: Type.Object({}),
              version: '1.0.0',
            },
            './control-flow/branch.definition.js': {
              type: 'control-flow' as const,
              description: 'Branch',
              errorSchema: Type.Object({}),
              inputSchema: Type.Object({
                condition: Type.Boolean(),
                thenLabel: Type.String(),
              }),
              version: '1.0.0',
            },
          },
          contractRegistryPath: '/path/to/registry.js',
          rawboxPluginVersion: '1.0.0',
        },
      ],
    ]),
  );

  function sumWorkflow(
    seedData: { key: string; strategy: typeof KV; value: unknown }[],
    input?: Record<string, { key: string; strategy: typeof KV; workflow?: string }>,
  ): ResolvedWorkflow {
    return {
      name: 'test-wf',
      pluginPathList: [],
      stepList: [
        {
          definitionLocation: {
            contractRegistryHash: registryHash,
            definitionPath: './sum.definition.js',
          },
          storageLocation: {
            input: input ?? {
              a: { key: 'key-a', strategy: KV },
              b: { key: 'key-b', strategy: KV },
            },
            output: {},
            error: {},
          },
          label: 'sum-step',
        },
      ],
      seedData,
    } as unknown as ResolvedWorkflow;
  }

  it('passes when every seed matches its input field schema', () => {
    const workflow = sumWorkflow([
      { key: 'key-a', strategy: KV, value: 42 },
      { key: 'key-b', strategy: KV, value: 'hello' },
    ]);

    expect(validateSeedData(workflow, contractRegistryCache).isOk()).toBe(true);
  });

  it('fails when a seed does not match its input field schema', () => {
    const workflow = sumWorkflow([{ key: 'key-a', strategy: KV, value: 'not-a-number' }]);

    const result = validateSeedData(workflow, contractRegistryCache);

    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr().message;
    expect(message).toContain('Seed validation failed for key "key-a"');
    expect(message).toContain('sum-step');
    expect(message).toContain('input field "a"');
  });

  it('ignores seed keys no step consumes', () => {
    const workflow = sumWorkflow([
      { key: 'unrelated-key', strategy: KV, value: { foo: 'bar' } },
    ]);

    expect(validateSeedData(workflow, contractRegistryCache).isOk()).toBe(true);
  });

  it('returns ok when there is no seed data at all', () => {
    const workflow = sumWorkflow([]);
    expect(validateSeedData(workflow, contractRegistryCache).isOk()).toBe(true);
  });

  it('skips a seed whose matching input reads from another workflow', () => {
    // The seed belongs to this workflow; the input is fed by `upstream`, so the
    // two are unrelated despite sharing a key, and the type mismatch is not an
    // error here.
    const workflow = sumWorkflow(
      [{ key: 'key-a', strategy: KV, value: 'not-a-number' }],
      { a: { key: 'key-a', strategy: KV, workflow: 'upstream' } },
    );

    expect(validateSeedData(workflow, contractRegistryCache).isOk()).toBe(true);
  });

  it('still validates when the input names this workflow explicitly', () => {
    const workflow = sumWorkflow(
      [{ key: 'key-a', strategy: KV, value: 'not-a-number' }],
      { a: { key: 'key-a', strategy: KV, workflow: 'test-wf' } },
    );

    expect(validateSeedData(workflow, contractRegistryCache).isErr()).toBe(true);
  });

  describe('expanded lmdb-fifo seeds', () => {
    // A FIFO seed arrives here already expanded, one `Seed` per element, so
    // several entries share a key. That is the correct pairing rather than an
    // accident: one `get` on an `lmdb-fifo` key dequeues one entry, so the
    // consuming field's schema types one entry, not the list.
    const FIFO = { name: 'lmdb-fifo' as const, queueSizeMax: 1000, valueSizeMax: 1900 };

    /** Three entries sharing key `key-b`, as the resolver would emit them. */
    function queueSeed(...valueList: unknown[]) {
      return valueList.map((value) => ({
        key: 'key-b',
        strategy: FIFO,
        value,
      })) as unknown as Parameters<typeof sumWorkflow>[0];
    }

    it('checks each element against the consuming field, not the list', () => {
      // `b` is a string field. Every element is a string, so this passes —
      // whereas the whole list would not have been a string at all.
      const workflow = sumWorkflow(queueSeed('x', 'y', 'z'));

      expect(validateSeedData(workflow, contractRegistryCache).isOk()).toBe(true);
    });

    it('reports an element that does not match, naming key, step and field', () => {
      const workflow = sumWorkflow(queueSeed('x', 42, 'z'));

      const result = validateSeedData(workflow, contractRegistryCache);

      expect(result.isErr()).toBe(true);
      const message = result._unsafeUnwrapErr().message;
      expect(message).toContain('Seed validation failed for key "key-b"');
      expect(message).toContain('sum-step');
      expect(message).toContain('input field "b"');
    });

    it('does not index by key — repeated keys are all checked', () => {
      // The bad element is last, so a validator that kept only one entry per
      // key, or stopped at the first match, would pass this.
      const workflow = sumWorkflow(queueSeed('x', 'y', 42));

      expect(validateSeedData(workflow, contractRegistryCache).isErr()).toBe(true);
    });

    it('an empty queue seeds nothing and validates vacuously', () => {
      expect(validateSeedData(sumWorkflow(queueSeed()), contractRegistryCache).isOk()).toBe(
        true,
      );
    });
  });

  it('tolerates an unloadable registry rather than throwing', () => {
    const workflow = sumWorkflow([{ key: 'key-a', strategy: KV, value: 'anything' }]);
    const emptyCache = new ContractRegistryCache(new Map());

    expect(validateSeedData(workflow, emptyCache).isOk()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // The type check that had to survive removing `{ value: … }`
  //
  // A literal was validated against the consuming field's `inputSchema` at
  // *resolve* time, by code that is now deleted. The claim is that the check
  // survived the move rather than the removal quietly taking it with it: a
  // seeded value reaches the same schema through `validateSeedData`, which
  // pairs a seed to the input field that reads its key.
  //
  // These run the real `resolveWorkflow` on an *authored* document rather than
  // hand-building a `ResolvedWorkflow`, because the pairing is what is under
  // test, and hand-writing the resolved form would assume the very thing the
  // deletion could have broken.
  // -------------------------------------------------------------------------

  describe('a seeded jump target is still type-checked against inputSchema', () => {
    const PLUGIN = '@rawbox/rawbox-plugin-default';

    /** The migrated form of the old `thenLabel: { value: … }` binding. */
    function branchDocument(thenLabelSeed: unknown): Workflow {
      return {
        kind: 'Workflow',
        formatVersion: '1.0',
        name: 'test-wf',
        plugins: { [PLUGIN]: '^1.0.0' },
        storage: {
          defaultStrategy: KV,
          keys: { is_ready: { seed: true }, then_label: { seed: thenLabelSeed } },
        },
        steps: [
          {
            label: 'check-ready',
            plugin: PLUGIN,
            operation: 'control-flow/branch',
            inputs: { condition: 'is_ready', thenLabel: 'then_label' },
          },
        ],
      } as unknown as Workflow;
    }

    function resolveThen(thenLabelSeed: unknown): ResolvedWorkflow {
      const result = resolveWorkflow(
        branchDocument(thenLabelSeed),
        contractRegistryCache,
        { [PLUGIN]: registryHash },
      );
      expect(result.isErr() ? result._unsafeUnwrapErr() : '').toBe('');
      return result._unsafeUnwrap();
    }

    it('accepts a seed matching the field the step reads it into', () => {
      expect(
        validateSeedData(resolveThen('sleep-step'), contractRegistryCache).isOk(),
      ).toBe(true);
    });

    it('rejects a wrongly typed seed, naming the key, the step and the field', () => {
      // `thenLabel` is `Type.String()`. Under the old format this exact mistake
      // was caught at resolve time, as `thenLabel: { value: 123 }`; it must
      // still be caught, and still name what to fix.
      const result = validateSeedData(resolveThen(123), contractRegistryCache);

      expect(result.isErr()).toBe(true);
      const message = result._unsafeUnwrapErr().message;
      expect(message).toContain('Seed validation failed for key "then_label"');
      expect(message).toContain('check-ready');
      expect(message).toContain('input field "thenLabel"');
    });

    it('checks the seed against the *consuming* field, not the key spelling', () => {
      // The pairing is `readBoxLocation.key === seed.key` and nothing else, so
      // a key named after no field at all is still typed by the field that
      // reads it. This is why the check survived a change of key naming.
      const document = branchDocument('sleep-step') as unknown as {
        storage: { keys: Record<string, { seed?: unknown }> };
        steps: { inputs: Record<string, string> }[];
      };
      document.storage.keys['x'] = { seed: 123 };
      document.steps[0]!.inputs.thenLabel = 'x';

      const resolved = resolveWorkflow(
        document as unknown as Workflow,
        contractRegistryCache,
        { [PLUGIN]: registryHash },
      )._unsafeUnwrap();

      const result = validateSeedData(resolved, contractRegistryCache);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('input field "thenLabel"');
    });
  });
});

// ---------------------------------------------------------------------------
// collectTimeoutWarnings — legal bounds that are probably not meant
//
// Warnings, not errors: the runner enforces what the document says, and an
// author is allowed to mean something surprising. One rule for now.
// ---------------------------------------------------------------------------

describe('collectTimeoutWarnings', () => {
  const registryHash =
    'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

  const cache = new ContractRegistryCache(
    new Map([
      [
        registryHash,
        {
          contractRecord: {
            './time/sleep.definition.js': {
              type: 'operation' as const,
              description: 'Sleeps',
              errorSchema: Type.Object({}),
              inputSchema: Type.Object({ ms: Type.Number() }),
              outputSchema: Type.Object({}),
              version: '1.0.0',
            },
            './control-flow/branch.definition.js': {
              type: 'control-flow' as const,
              description: 'Branch',
              errorSchema: Type.Object({}),
              inputSchema: Type.Object({ condition: Type.Boolean() }),
              version: '1.0.0',
            },
          },
          contractRegistryPath: '/path/to/registry.js',
          rawboxPluginVersion: '1.0.0',
        },
      ],
    ]),
  );

  /** One resolved step addressing `definitionPath`, bounded or not. */
  function resolvedWith(
    definitionPath: string,
    timeoutMs?: number,
  ): ResolvedWorkflow {
    return {
      name: 'test-wf',
      pluginPathList: [],
      stepList: [
        {
          definitionLocation: { contractRegistryHash: registryHash, definitionPath },
          storageLocation: { input: {}, output: {}, error: {} },
          label: 'the-step',
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      ],
    } as unknown as ResolvedWorkflow;
  }

  it('says nothing about a bound on an operation step', () => {
    expect(
      collectTimeoutWarnings(resolvedWith('./time/sleep.definition.js', 5_000), cache),
    ).toEqual([]);
  });

  it('says nothing about an unbounded control-flow step', () => {
    expect(
      collectTimeoutWarnings(resolvedWith('./control-flow/branch.definition.js'), cache),
    ).toEqual([]);
  });

  it('warns about a bound on a control-flow step, and says what to bound instead', () => {
    // A control-flow handler chooses a label and returns: it waits on nothing
    // outside the process, so a bound there either never fires or ends the run
    // over a decision that took a moment longer than expected.
    const warnings = collectTimeoutWarnings(
      resolvedWith('./control-flow/branch.definition.js', 5_000),
      cache,
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!).toContain('"the-step"');
    expect(warnings[0]!).toContain('control-flow contract');
    expect(warnings[0]!).toContain('Bound the step that does the waiting instead');
  });

  it('stays silent when the contract cannot be reached', () => {
    // An unknown registry hash is a resolution problem, reported by whoever
    // owns it; a warning pass must not invent a second diagnostic for it.
    const workflow = resolvedWith('./control-flow/branch.definition.js', 5_000);
    workflow.stepList[0]!.definitionLocation.contractRegistryHash =
      '0000000000000000000000000000000000000000000000000000000000000000';

    expect(collectTimeoutWarnings(workflow, cache)).toEqual([]);
  });
});
