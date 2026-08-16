import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Compile } from 'typebox/compile';
import { ContractRegistryCache } from '@rawbox/plugin/core';

import { parseConfig } from '../src/utils/config.js';
import { Workflow, Storage } from '../src/workflow/workflow-types.js';
import { Step } from '../src/workflow/step-types.js';
import { RawboxLock } from '../src/workflow/lock-types.js';
import { Workspace } from '../src/workspace/workspace-types.js';
import { resolveWorkflow } from '../src/workflow/resolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures');

const workflowValidator = Compile(Workflow);
const stepValidator = Compile(Step);
const storageValidator = Compile(Storage);
const lockValidator = Compile(RawboxLock);
const workspaceValidator = Compile(Workspace);

async function loadFixture(name: string): Promise<unknown> {
  const filePath = path.join(fixtures, name);
  return parseConfig(await fs.readFile(filePath, 'utf-8'), filePath);
}

/** A minimal valid workflow document, cloned and mutated per case. */
function baseWorkflow(): Record<string, unknown> {
  return {
    kind: 'Workflow',
    formatVersion: '1.0',
    name: 'example',
    plugins: { '@rawbox/rawbox-plugin-default': '^1.0.0' },
    storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
    steps: [],
  };
}

function operationStep(): Record<string, unknown> {
  return {
    label: 'sleep-step',
    plugin: '@rawbox/rawbox-plugin-default',
    operation: 'time/sleep',
    inputs: { ms: 'sleep_ms' },
    outputs: { timestamp: 'sleep_done_at' },
    errors: { message: 'sleep_error' },
  };
}

function controlFlowStep(): Record<string, unknown> {
  return {
    label: 'check-ready',
    plugin: '@rawbox/rawbox-plugin-default',
    operation: 'control-flow/branch',
    inputs: {
      condition: 'is_ready',
      thenLabel: 'then_label',
      elseLabel: 'else_label',
    },
    errors: { message: 'branch_error' },
  };
}

describe('Workflow schema — fixtures', () => {
  it('accepts the hand-written YAML fixture', async () => {
    const workflow = await loadFixture('example.workflow.yaml');
    expect(workflowValidator.Check(workflow)).toBe(true);
  });

  it('accepts the same document encoded as JSON (schema is over the parsed data model)', async () => {
    const workflow = await loadFixture('example.workflow.json');
    expect(workflowValidator.Check(workflow)).toBe(true);
  });

  it('parses the YAML and JSON fixtures to the same data model', async () => {
    const fromYaml = await loadFixture('example.workflow.yaml');
    const fromJson = await loadFixture('example.workflow.json');
    expect(fromYaml).toEqual(fromJson);
  });

  it('rejects a document with no `kind:`', async () => {
    const workflow = await loadFixture('not-a-workflow-document.yaml');
    expect(workflowValidator.Check(workflow)).toBe(false);
  });

  it('reports the missing `kind` and the resolved-shape keys when rejecting it', async () => {
    const workflow = await loadFixture('not-a-workflow-document.yaml');
    const messages = Array.from(workflowValidator.Errors(workflow))
      .map((e) => `${e.message} ${JSON.stringify(e.params)}`)
      .join('\n');
    expect(messages).toContain('kind');
    expect(messages).toContain('pluginPathList');
    expect(messages).toContain('stepList');
  });
});

describe('Workflow schema — document identity', () => {
  it('requires kind', () => {
    const { kind: _kind, ...withoutKind } = baseWorkflow();
    expect(workflowValidator.Check(withoutKind)).toBe(false);
  });

  it('rejects an unrecognised kind', () => {
    expect(workflowValidator.Check({ ...baseWorkflow(), kind: 'Workspace' })).toBe(false);
  });

  it('requires formatVersion "1.0"', () => {
    expect(workflowValidator.Check({ ...baseWorkflow(), formatVersion: '2.0' })).toBe(false);
    expect(workflowValidator.Check({ ...baseWorkflow(), formatVersion: 1.0 })).toBe(false);
  });

  it('keeps identity flat and rejects the reserved metadata/settings envelopes', () => {
    expect(workflowValidator.Check({ ...baseWorkflow(), metadata: { name: 'x' } })).toBe(false);
    expect(workflowValidator.Check({ ...baseWorkflow(), settings: {} })).toBe(false);
  });

  it('accepts an optional description', () => {
    expect(workflowValidator.Check({ ...baseWorkflow(), description: 'hello' })).toBe(true);
  });
});

describe('Workflow schema — plugins map', () => {
  it('accepts registry, file: and git+ specifiers', () => {
    const workflow = {
      ...baseWorkflow(),
      plugins: {
        '@rawbox/rawbox-plugin-default': '^1.0.0',
        '@acme/rawbox-plugin-kraken': 'file:../../packages/rawbox-plugin-kraken',
        '@acme/rawbox-plugin-exp': 'git+https://github.com/acme/exp.git#v1.2.3',
      },
    };
    expect(workflowValidator.Check(workflow)).toBe(true);
  });

  it('rejects a `plugins` array — it is a package -> specifier map', () => {
    const workflow = { ...baseWorkflow(), plugins: ['@rawbox/rawbox-plugin-default'] };
    expect(workflowValidator.Check(workflow)).toBe(false);
  });

  it('rejects a structured plugin entry — the specifier carries the source', () => {
    const workflow = {
      ...baseWorkflow(),
      plugins: { '@rawbox/rawbox-plugin-default': { source: 'npm', version: '^1.0.0' } },
    };
    expect(workflowValidator.Check(workflow)).toBe(false);
  });

  it('rejects an empty specifier', () => {
    const workflow = { ...baseWorkflow(), plugins: { '@rawbox/rawbox-plugin-default': '' } };
    expect(workflowValidator.Check(workflow)).toBe(false);
  });
});

describe('Storage schema', () => {
  it('requires a defaultStrategy', () => {
    expect(storageValidator.Check({})).toBe(false);
  });

  it('accepts a keys: entry stating a strategy, a seed, or neither', () => {
    const storage = {
      defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
      keys: {
        queue_items: {
          strategy: { name: 'lmdb-fifo', queueSizeMax: 1000, valueSizeMax: 1900 },
          seed: ['a', 'b', 'c'],
        },
        sleep_ms: { seed: 500 },
        // A seed is arbitrary data, so a literal object is a seed and not a
        // wrapper the schema reads as something else.
        config: { seed: { value: 1 } },
        scratch: {},
      },
    };
    expect(storageValidator.Check(storage)).toBe(true);
  });

  it('rejects the removed strategies: and seed: blocks — keys: is the only one', () => {
    const base = { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } };
    expect(
      storageValidator.Check({
        ...base,
        strategies: { q: { name: 'lmdb-fifo', queueSizeMax: 8, valueSizeMax: 1900 } },
      }),
    ).toBe(false);
    expect(storageValidator.Check({ ...base, seed: { sleep_ms: 500 } })).toBe(false);
    // `defaultStrategy` is not one of them and is untouched.
    expect(storageValidator.Check(base)).toBe(true);
  });

  it('rejects an unknown strategy name', () => {
    const storage = { defaultStrategy: { name: 'nonesuch-kv', valueSizeMax: 1900 } };
    expect(storageValidator.Check(storage)).toBe(false);
  });

  it('rejects a `keys` array — it is a pure key -> entry map', () => {
    const workflow = {
      ...baseWorkflow(),
      storage: {
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
        keys: [{ key: 'sleep_ms', seed: 500 }],
      },
    };
    expect(workflowValidator.Check(workflow)).toBe(false);
  });

  it('rejects any other top-level field on storage:', () => {
    const storage = {
      defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
      keys: { sleep_ms: { seed: 500 } },
      extra: {},
    };
    expect(storageValidator.Check(storage)).toBe(false);
  });

  describe('queueSizeMax', () => {
    function storageWithQueueSizeMax(queueSizeMax: unknown): unknown {
      return {
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
        keys: {
          queue_items: {
            strategy: { name: 'lmdb-fifo', queueSizeMax, valueSizeMax: 1900 },
          },
        },
      };
    }

    it.each([0, 1, 3.5, -4])('rejects %s', (queueSizeMax) => {
      expect(storageValidator.Check(storageWithQueueSizeMax(queueSizeMax))).toBe(false);
    });

    it.each([2, 3, 100, 1000, 1024])('accepts %s', (queueSizeMax) => {
      expect(storageValidator.Check(storageWithQueueSizeMax(queueSizeMax))).toBe(true);
    });
  });

  // Both strategies are closed. The *diagnostic* for a stray field is
  // `collectStrategyFieldProblems`, covered in validation.test.ts — these pin
  // the schema half, so a future edit cannot quietly reopen either variant.
  describe('a strategy takes exactly its own fields', () => {
    function withDefaultStrategy(strategy: unknown): unknown {
      return { defaultStrategy: strategy };
    }

    it('rejects queueSizeMax on lmdb-kv — the field belongs to lmdb-fifo', () => {
      expect(
        storageValidator.Check(
          withDefaultStrategy({ name: 'lmdb-kv', valueSizeMax: 1900, queueSizeMax: 4 }),
        ),
      ).toBe(false);
    });

    it('rejects an unknown field on lmdb-kv', () => {
      expect(
        storageValidator.Check(
          withDefaultStrategy({ name: 'lmdb-kv', valueSizeMax: 1900, ttl: 30 }),
        ),
      ).toBe(false);
    });

    it('rejects an unknown field on lmdb-fifo', () => {
      expect(
        storageValidator.Check(
          withDefaultStrategy({
            name: 'lmdb-fifo',
            queueSizeMax: 4,
            valueSizeMax: 1900,
            ttl: 30,
          }),
        ),
      ).toBe(false);
    });

    it('rejects the stray field on a per-key override too, not just the default', () => {
      expect(
        storageValidator.Check({
          defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
          strategies: {
            queue_items: { name: 'lmdb-kv', valueSizeMax: 1900, queueSizeMax: 4 },
          },
        }),
      ).toBe(false);
    });
  });
});

describe('Step schema — operation steps', () => {
  it('accepts shorthand storage keys', () => {
    expect(stepValidator.Check(operationStep())).toBe(true);
  });

  it('accepts an unlabelled step', () => {
    const { label: _label, ...step } = operationStep();
    expect(stepValidator.Check(step)).toBe(true);
  });

  it('accepts the long form on an input, including a cross-workflow read', () => {
    const step = {
      ...operationStep(),
      inputs: { ms: { key: 'sleep_ms' }, prev: { key: 'upstream', workflow: 'other-workflow' } },
    };
    expect(stepValidator.Check(step)).toBe(true);
  });

  it('rejects a { value: ... } literal on an input — the form was removed', () => {
    // The schema is the structural half of the removal; `validateWorkflowType`
    // is what turns this into a diagnostic carrying the migration path, and it
    // runs first for exactly that reason.
    const step = { ...operationStep(), inputs: { ms: { value: 500 } } };
    expect(stepValidator.Check(step)).toBe(false);
  });

  it('requires plugin and operation', () => {
    const { plugin: _plugin, ...noPlugin } = operationStep();
    const { operation: _operation, ...noOperation } = operationStep();
    expect(stepValidator.Check(noPlugin)).toBe(false);
    expect(stepValidator.Check(noOperation)).toBe(false);
  });

  it('rejects the resolved definitionLocation/storageLocation shape', () => {
    const step = {
      label: 'sleep-step',
      definitionLocation: { contractRegistryHash: 'abc', definitionPath: './time/sleep.definition.js' },
      storageLocation: { input: {}, output: {}, error: {} },
    };
    expect(stepValidator.Check(step)).toBe(false);
  });

  it('rejects an unknown step property', () => {
    expect(stepValidator.Check({ ...operationStep(), storageLocation: {} })).toBe(false);
  });

  it('rejects a per-location strategy — the strategy is a property of the key', () => {
    const step = {
      ...operationStep(),
      inputs: { ms: { key: 'sleep_ms', strategy: { name: 'lmdb-kv', valueSizeMax: 1900 } } },
    };
    expect(stepValidator.Check(step)).toBe(false);
  });

  it('rejects a path-traversing operation value', () => {
    expect(stepValidator.Check({ ...operationStep(), operation: '../escape' })).toBe(false);
    expect(stepValidator.Check({ ...operationStep(), operation: '/abs/path' })).toBe(false);
    expect(stepValidator.Check({ ...operationStep(), operation: '' })).toBe(false);
  });
});

describe('Step schema — storage boundaries', () => {
  it('rejects `workflow:` on an output — a step only writes into its own workflow', () => {
    const step = {
      ...operationStep(),
      outputs: { timestamp: { key: 'sleep_done_at', workflow: 'other-workflow' } },
    };
    expect(stepValidator.Check(step)).toBe(false);
  });

  it('rejects `workflow:` on an error location', () => {
    const step = {
      ...operationStep(),
      errors: { message: { key: 'sleep_error', workflow: 'other-workflow' } },
    };
    expect(stepValidator.Check(step)).toBe(false);
  });

  it('rejects a { value: ... } literal on an output, as it always did', () => {
    const step = { ...operationStep(), outputs: { timestamp: { value: 1 } } };
    expect(stepValidator.Check(step)).toBe(false);
  });

  it('rejects a `workspace:` field anywhere — workspace is supplied at run time', () => {
    const step = {
      ...operationStep(),
      inputs: { ms: { key: 'sleep_ms', workspace: 'other-workspace' } },
    };
    expect(stepValidator.Check(step)).toBe(false);
  });
});

describe('Step schema — control-flow steps', () => {
  it('accepts a control-flow step with inputs and errors', () => {
    expect(stepValidator.Check(controlFlowStep())).toBe(true);
  });

  it('rejects `outputs:` on a control-flow step', () => {
    const step = { ...controlFlowStep(), outputs: { label: 'next_label' } };
    expect(stepValidator.Check(step)).toBe(false);
  });

  it('rejects an empty `outputs:` on a control-flow step', () => {
    const step = { ...controlFlowStep(), outputs: {} };
    expect(stepValidator.Check(step)).toBe(false);
  });

  it('rejects a control-flow step with outputs inside a whole workflow', () => {
    const workflow = {
      ...baseWorkflow(),
      steps: [operationStep(), { ...controlFlowStep(), outputs: { label: 'x' } }],
    };
    expect(workflowValidator.Check(workflow)).toBe(false);
  });

  it('still allows `outputs:` on a non-control-flow operation', () => {
    const workflow = { ...baseWorkflow(), steps: [operationStep(), controlFlowStep()] };
    expect(workflowValidator.Check(workflow)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// `timeoutMs` is a property of a *step*, not of an operation step
//
// It sits in `stepCommonProperties`, so both arms of the `Step` union accept
// it. On `OperationStep` alone it would not be "ignored" on a control-flow
// step — it would fail that arm, fail the union, and report itself as a dump of
// every branch that did not match.
// ---------------------------------------------------------------------------

describe('Step schema — timeoutMs', () => {
  it('accepts a bound on an operation step', () => {
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: 30_000 })).toBe(true);
  });

  it('accepts a bound on a control-flow step', () => {
    expect(stepValidator.Check({ ...controlFlowStep(), timeoutMs: 30_000 })).toBe(true);
  });

  it('accepts the `unbounded` literal on either variant', () => {
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: 'unbounded' })).toBe(true);
    expect(stepValidator.Check({ ...controlFlowStep(), timeoutMs: 'unbounded' })).toBe(true);
  });

  it('accepts a step that declares no bound', () => {
    expect(stepValidator.Check(operationStep())).toBe(true);
  });

  it('rejects 0, null and a negative bound', () => {
    // `validateWorkflowType` is what turns each of these into a diagnostic
    // naming the spelling to write instead; the schema is the structural half.
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: 0 })).toBe(false);
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: null })).toBe(false);
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: -1 })).toBe(false);
  });

  it('rejects a fraction, a quoted number and a word that is not `unbounded`', () => {
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: 1.5 })).toBe(false);
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: '5000' })).toBe(false);
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: 'never' })).toBe(false);
  });

  it('rejects a bound past the setTimeout ceiling', () => {
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: 2147483647 })).toBe(true);
    expect(stepValidator.Check({ ...operationStep(), timeoutMs: 2147483648 })).toBe(false);
  });

  it('accepts a whole document carrying bounds on both step kinds', () => {
    const workflow = {
      ...baseWorkflow(),
      steps: [
        { ...operationStep(), timeoutMs: 5_000 },
        { ...controlFlowStep(), timeoutMs: 'unbounded' },
      ],
    };
    expect(workflowValidator.Check(workflow)).toBe(true);
  });
});

describe('RawboxLock schema', () => {
  it('accepts the shape rawbox.lock documents', () => {
    const lock = {
      version: '1',
      plugins: {
        '@rawbox/rawbox-plugin-default': { resolved: '1.0.0', registryHash: '92837f61c312' },
      },
    };
    expect(lockValidator.Check(lock)).toBe(true);
  });

  it('accepts an empty plugins map', () => {
    expect(lockValidator.Check({ version: '1', plugins: {} })).toBe(true);
  });

  it('requires both resolved and registryHash on an entry', () => {
    const lock = { version: '1', plugins: { a: { resolved: '1.0.0' } } };
    expect(lockValidator.Check(lock)).toBe(false);
  });

  it('rejects an unknown lock version', () => {
    const lock = { version: '2', plugins: {} };
    expect(lockValidator.Check(lock)).toBe(false);
  });
});

describe('Workspace schema', () => {
  it('accepts kind: Workspace', () => {
    const workspace = {
      kind: 'Workspace',
      name: 'my-workspace',
      workflowPathList: ['./workflows/example.workflow.yaml'],
    };
    expect(workspaceValidator.Check(workspace)).toBe(true);
  });

  it('rejects a wrong kind', () => {
    const workspace = { kind: 'Workflow', name: 'w', workflowPathList: [] };
    expect(workspaceValidator.Check(workspace)).toBe(false);
  });

  it('accepts the optional targetFolder', () => {
    const workspace = {
      kind: 'Workspace',
      name: 'my-workspace',
      workflowPathList: [],
      targetFolder: './target',
    };
    expect(workspaceValidator.Check(workspace)).toBe(true);
  });

  // The Workspace document is an authoring model like the Workflow, so the
  // closed-model rule applies to it identically: an unrecognised field is an
  // error. It was the one authored document that silently accepted anything —
  // including `metadata:`, which the format reserves and which the Workflow has
  // always rejected, so the two halves of the format disagreed about the same
  // word.
  it('rejects an unknown top-level property', () => {
    const workspace = {
      kind: 'Workspace',
      name: 'my-workspace',
      workflowPathList: [],
      pluginPathList: ['./plugins'],
    };
    expect(workspaceValidator.Check(workspace)).toBe(false);
  });

  it('rejects the reserved `metadata:` envelope, exactly as the Workflow does', () => {
    const workspace = {
      kind: 'Workspace',
      name: 'my-workspace',
      workflowPathList: [],
      metadata: { name: 'x' },
    };
    expect(workspaceValidator.Check(workspace)).toBe(false);
    expect(workflowValidator.Check({ ...baseWorkflow(), metadata: { name: 'x' } })).toBe(false);
  });
});

describe('resolveWorkflow', () => {
  // Behaviour is covered in tests/resolver.test.ts. This case only pins that
  // the fixture reaches the resolver as a Result rather than throwing.
  it('reports missing registries as an error result rather than throwing', async () => {
    const workflow = (await loadFixture('example.workflow.yaml')) as Parameters<
      typeof resolveWorkflow
    >[0];
    const result = resolveWorkflow(workflow, new ContractRegistryCache(), {});
    expect(result.isErr()).toBe(true);
  });
});
