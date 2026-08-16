import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Type } from 'typebox';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createActor, type StateValue } from 'xstate';
import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import { ContractRegistryCache } from '@rawbox/plugin/core';
import { selectFunc as selectStepFunc } from '../src/machine/actors/select-actor.js';
import {
  StepTimeoutError,
  runFunc as runStepFunc,
} from '../src/machine/actors/run-actor.js';
import { createWorkflowMachine } from '../src/machine/machine-instance.js';
import { contractRegistry } from '../../rawbox-plugin-default/dist/contract-registry.js';
import { validateSeedData } from '../src/workflow/validation.js';
import type { ResolvedWorkflow } from '../src/workflow/workflow-types.js';

describe('selectStepFunc', () => {

  const mockRegistry = {
    contractRecord: {
      './sum.js': {
        type: 'operation' as const,
        description: 'Sum two numbers',
        errorSchema: Type.Object({}),
        inputSchema: Type.Object({}),
        outputSchema: Type.Object({}),
        version: '1.0.0',
      },
      './jump.js': {
        type: 'control-flow' as const,
        description: 'Jump to a step',
        errorSchema: Type.Object({}),
        inputSchema: Type.Object({}),
        version: '1.0.0',
      },
    },
    contractRegistryPath: '/path/to/registry.js',
    rawboxPluginVersion: '1.0.0',
  };

  const mockRegistryHash = ContractRegistryCache.computeHash(mockRegistry);

  const stepList = [
    {
      definitionLocation: {
        contractRegistryHash: mockRegistryHash,
        definitionPath: './sum.js',
      },
      storageLocation: { input: {}, output: {}, error: {} },
      label: 'step-0',
    },
    {
      definitionLocation: {
        contractRegistryHash: mockRegistryHash,
        definitionPath: './jump.js',
      },
      storageLocation: { input: {}, output: {}, error: {} },
      label: 'step-1',
    },
  ];

  const contractRegistryCache = new ContractRegistryCache(
    new Map([[mockRegistryHash, mockRegistry]]),
  );

  const workflow = {
    name: 'simple',
    pluginPathList: [],
    stepList,
  };

  it('should return index 0 when doneStep is undefined and stepList is not empty', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        execution: {
          doneStep: null,
          todoStep: null,
        },
        workflow,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        todoStep: { index: 0 },
      });
    }
  });

  it('should return index 0 for next todoStep when doneStep is an operation type contract', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        execution: {
          doneStep: {
            index: 0,
            outputRecord: {},
          },
          todoStep: null,
        },
        workflow,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        todoStep: { index: 1 },
      });
    }
  });

  it('should return correct target index when doneStep is control-flow and output record contains matching label', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        execution: {
          doneStep: {
            index: 1,
            outputRecord: {
              label: 'step-0',
            },
          },
          todoStep: null,
        },
        workflow,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        todoStep: { index: 0 },
      });
    }
  });

  it('should return an Err result if doneStep index is out of bounds', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        execution: {
          doneStep: {
            index: 99,
          },
          todoStep: null,
        },
        workflow,
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('Step at index 99 not found in stepList');
    }
  });

  it('should return an Err result if label from control-flow does not match any step', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        execution: {
          doneStep: {
            index: 1,
            outputRecord: {
              label: 'non-existent-step',
            },
          },
          todoStep: null,
        },
        workflow,
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('No step found with label: "non-existent-step"');
    }
  });

  it('should set todoStep to undefined when control-flow returns ReservedLabel.EXIT', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        execution: {
          doneStep: {
            index: 1,
            outputRecord: {
              label: '__EXIT__',
            },
          },
          todoStep: null,
        },
        workflow,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        todoStep: null,
      });
    }
  });

  it('should fail the run with the reason when control-flow returns ReservedLabel.FAIL', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        execution: {
          doneStep: {
            index: 1,
            outputRecord: {
              label: '__FAIL__',
              reason: 'the symbol is ACTIVE with no grid_state',
            },
          },
          todoStep: null,
        },
        workflow,
      },
    });

    // An `err` here is the deliberate reuse of the path a failed step actor
    // takes: it becomes `context.error`, then an error `run.end`.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe('the symbol is ACTIVE with no grid_state');
    }
  });

  it('should name the step when ReservedLabel.FAIL carries no reason', async () => {
    for (const outputRecord of [
      { label: '__FAIL__' },
      // An empty reason counts as none: an empty `Error.message` would be
      // reported as the bare word "Error" by the machine's error assigner.
      { label: '__FAIL__', reason: '' },
    ]) {
      const result = await selectStepFunc({
        input: {
          contractRegistryCache,
          execution: { doneStep: { index: 1, outputRecord }, todoStep: null },
          workflow,
        },
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.message).toBe(
          'Step 1 "step-1" ended the run as a failure (__FAIL__ with no reason given).',
        );
      }
    }
  });

  it('should jump to index 0 when control-flow returns ReservedLabel.START', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        execution: {
          doneStep: {
            index: 1,
            outputRecord: {
              label: '__START__',
            },
          },
          todoStep: null,
        },
        workflow,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        todoStep: { index: 0 },
      });
    }
  });

  it('should jump to last index when control-flow returns ReservedLabel.END', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        execution: {
          doneStep: {
            index: 1,
            outputRecord: {
              label: '__END__',
            },
          },
          todoStep: null,
        },
        workflow,
      },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        todoStep: { index: stepList.length - 1 },
      });
    }
  });

  it('should return an Err result if contract is not found in registry', async () => {
    const registryWithoutSum = {
      ...mockRegistry,
      contractRecord: {
        './jump.js': mockRegistry.contractRecord['./jump.js'],
      },
    };
    const registryWithoutSumHash = ContractRegistryCache.computeHash(registryWithoutSum);
    const badCache = new ContractRegistryCache(
      new Map([[registryWithoutSumHash, registryWithoutSum]]),
    );

    const badStepList = [
      {
        definitionLocation: {
          contractRegistryHash: registryWithoutSumHash,
          definitionPath: './sum.js',
        },
        storageLocation: { input: {}, output: {}, error: {} },
        label: 'step-0',
      },
    ];

    const badWorkflow = {
      name: 'simple',
      pluginPathList: [],
      stepList: badStepList,
    };

    const result = await selectStepFunc({
      input: {
        contractRegistryCache: badCache,
        execution: {
          doneStep: {
            index: 0,
          },
          todoStep: null,
        },
        workflow: badWorkflow,
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('Contract not found in registry: ./sum.js');
    }
  });
});

// ---------------------------------------------------------------------------
// `runStepFunc` — the enforcement half of bounded steps, at the actor itself.
//
// Driven directly, the same way `selectStepFunc` is above: the machine, the
// producer and the event stream are covered by `tests/timeout.test.ts`, so what
// is left to pin here is the actor's own contract — which exit an expired bound
// takes, and what the failure it returns carries. Against the *real* built
// `time/sleep`, because the bound wraps a real dynamic `import()` and a real
// `validatedHandler`, neither of which a stub would exercise.
// ---------------------------------------------------------------------------

describe('runStepFunc — a step\'s timeoutMs', () => {
  const registryHash = ContractRegistryCache.computeHash(contractRegistry);
  const contractRegistryCache = new ContractRegistryCache(
    new Map([[registryHash, contractRegistry]]),
  );

  /** A one-step workflow whose only step sleeps, bounded or not. */
  const sleepWorkflow = (timeoutMs?: number): ResolvedWorkflow =>
    ({
      name: 'bounded',
      pluginPathList: [],
      stepList: [
        {
          definitionLocation: {
            contractRegistryHash: registryHash,
            definitionPath: './time/sleep.definition.js',
          },
          storageLocation: { input: {}, output: {}, error: {} },
          label: 'slow-step',
          // Absent, not `undefined`: the resolved model has two states, and a
          // present key is the whole of "bounded".
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      ],
    }) as unknown as ResolvedWorkflow;

  const runSleep = async (ms: number, timeoutMs?: number) =>
    await runStepFunc({
      input: {
        contractRegistryCache,
        workflow: sleepWorkflow(timeoutMs),
        execution: { todoStep: { index: 0, inputRecord: { ms } }, doneStep: null },
      },
    });

  it('resolves err(StepTimeoutError) long before the handler would return', async () => {
    const startedAtMs = Date.now();
    const result = await runSleep(60_000, 50);
    const elapsedMs = Date.now() - startedAtMs;

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(StepTimeoutError);
    expect((error as StepTimeoutError).timeoutMs).toBe(50);
    expect(error.message).toBe(
      'Step 0 "slow-step" timed out after 50 ms (the handler did not return).',
    );

    // The point of the bound: the wait is over in ~50ms, not in 60s. The
    // handler's own timer is still pending — a bound stops the *waiting*, not
    // the work (see `run-actor.ts`, "Known limitations").
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('leaves an unbounded step alone', async () => {
    const result = await runSleep(10);

    expect(result.isOk(), `run failed: ${result.isErr() ? result.error.message : ''}`).toBe(true);
    expect(result._unsafeUnwrap().doneStep).toMatchObject({ index: 0 });
    expect(result._unsafeUnwrap().doneStep?.outputRecord).toHaveProperty('timestamp');
  });
});

describe('Workflow State Machine Integration', () => {
  let dbDirUrl: URL;
  let boxStoreLmdb: BoxStoreLmdb;

  beforeAll(async () => {
    const rand = Math.floor(Math.random() * 1000000);
    dbDirUrl = new URL(
      `./sandbox/test-machine-db-${Date.now()}-${rand}/`,
      import.meta.url,
    );
    await fs.mkdir(fileURLToPath(dbDirUrl), { recursive: true });
    boxStoreLmdb = BoxStoreLmdb.create('test-workspace', dbDirUrl);
  });

  afterAll(async () => {
    try {
      boxStoreLmdb.dbiCache.env.close();
    } catch {
      void 0;
    }
    try {
      await fs.rm(fileURLToPath(dbDirUrl), { recursive: true, force: true });
    } catch {
      void 0;
    }
  });

  it('should transition through starting state to selecting and exit cleanly', async () => {
    const registryHash = ContractRegistryCache.computeHash(contractRegistry);
    const stepList = [
      {
        definitionLocation: {
          contractRegistryHash: registryHash,
          definitionPath: './control-flow/jump.definition.js',
        },
        storageLocation: {
          input: {},
          output: {},
          error: {},
        },
        label: 'step-0',
      },
    ];

    const workflow = {
      name: 'simple',
      pluginPathList: [],
      stepList,
    };

    const contractRegistryCache = new ContractRegistryCache(
      new Map([
        [
          registryHash,
          contractRegistry,
        ],
      ]),
    );

    const input = {
      params: {
        runId: 'run1',
        workflow,
        workspace: 'test-workspace',
      },
      execution: {
        todoStep: null,
        doneStep: {
          index: 0,
          outputRecord: {
            label: '__EXIT__',
          },
        },
      },
      rootDirectoryUrl: dbDirUrl.href,
      boxStoreLmdb: boxStoreLmdb,
    };

    const machine = createWorkflowMachine(boxStoreLmdb, contractRegistryCache);
    const actor = createActor(machine, { input });

    const states: StateValue[] = [];
    actor.subscribe((state) => {
      states.push(state.value);
    });

    actor.start();

    // Wait for state machine to start and run through to final state
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(states).toContainEqual({ running: 'starting' });
    expect(states).toContainEqual({ running: 'selecting' });
    expect(states).toContainEqual('stopping');

    actor.stop();
  });

  it('should fail preflight check if workflow is invalid (Typebox check)', async () => {
    // workflow missing pluginPathList (required by schema)
    const workflow = {
      name: 'invalid-workflow',
      stepList: [],
    } as unknown as ResolvedWorkflow;

    const contractRegistryCache = new ContractRegistryCache(new Map());

    const input = {
      params: {
        runId: 'run1',
        workflow,
        workspace: 'test-workspace',
      },
      execution: {
        todoStep: null,
        doneStep: null,
      },
      rootDirectoryUrl: dbDirUrl.href,
      boxStoreLmdb: boxStoreLmdb,
    };

    const machine = createWorkflowMachine(boxStoreLmdb, contractRegistryCache);
    const actor = createActor(machine, { input });

    const states: StateValue[] = [];
    actor.subscribe((state) => {
      states.push(state.value);
    });

    actor.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(states).toContainEqual({ running: 'starting' });
    expect(states).toContainEqual('stopping');
    expect(states).not.toContainEqual({ running: 'selecting' });

    actor.stop();
  });

  it('should fail preflight check if output location is in another workspace or workflow', async () => {
    const registryHash = 'dummyRegistryHash';
    const stepList = [
      {
        definitionLocation: {
          contractRegistryHash: registryHash,
          definitionPath: './jump.js',
        },
        storageLocation: {
          input: {},
          output: {
            result: {
              key: 'result-key',
              workflow: 'other-workflow', // mismatch workflow name (expected 'simple')
              workspace: 'test-workspace',
              strategy: { name: 'lmdb-kv' as const, valueSizeMax: 100 },
            },
          },
          error: {},
        },
        label: 'step-0',
      },
    ];

    const workflow = {
      name: 'simple',
      pluginPathList: [],
      stepList,
    };

    const contractRegistryCache = new ContractRegistryCache(
      new Map([
        [
          registryHash,
          {
            contractRecord: {
              './jump.js': {
                type: 'control-flow' as const,
                description: 'Jump to a step',
                errorSchema: Type.Object({}),
                inputSchema: Type.Object({}),
                version: '1.0.0',
              },
            },
            contractRegistryPath: '/path/to/registry.js',
            rawboxPluginVersion: '1.0.0',
          },
        ],
      ]),
    );

    const input = {
      params: {
        runId: 'run1',
        workflow,
        workspace: 'test-workspace',
      },
      execution: {
        todoStep: null,
        doneStep: null,
      },
      rootDirectoryUrl: dbDirUrl.href,
      boxStoreLmdb: boxStoreLmdb,
    };

    const machine = createWorkflowMachine(boxStoreLmdb, contractRegistryCache);
    const actor = createActor(machine, { input });

    const states: StateValue[] = [];
    actor.subscribe((state) => {
      states.push(state.value);
    });

    actor.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(states).toContainEqual({ running: 'starting' });
    expect(states).toContainEqual('stopping');
    expect(states).not.toContainEqual({ running: 'selecting' });

    actor.stop();
  });

  it('should fail preflight check if input location is in another workspace', async () => {
    const registryHash = 'dummyRegistryHash';
    const stepList = [
      {
        definitionLocation: {
          contractRegistryHash: registryHash,
          definitionPath: './jump.js',
        },
        storageLocation: {
          input: {
            source: {
              key: 'source-key',
              workflow: 'simple',
              workspace: 'other-workspace', // mismatch workspace name (expected 'test-workspace')
              strategy: { name: 'lmdb-kv' as const, valueSizeMax: 100 },
            },
          },
          output: {},
          error: {},
        },
        label: 'step-0',
      },
    ];

    const workflow = {
      name: 'simple',
      pluginPathList: [],
      stepList,
    };

    const contractRegistryCache = new ContractRegistryCache(
      new Map([
        [
          registryHash,
          {
            contractRecord: {
              './jump.js': {
                type: 'control-flow' as const,
                description: 'Jump to a step',
                errorSchema: Type.Object({}),
                inputSchema: Type.Object({}),
                version: '1.0.0',
              },
            },
            contractRegistryPath: '/path/to/registry.js',
            rawboxPluginVersion: '1.0.0',
          },
        ],
      ]),
    );

    const input = {
      params: {
        runId: 'run1',
        workflow,
        workspace: 'test-workspace',
      },
      execution: {
        todoStep: null,
        doneStep: null,
      },
      rootDirectoryUrl: dbDirUrl.href,
      boxStoreLmdb: boxStoreLmdb,
    };

    const machine = createWorkflowMachine(boxStoreLmdb, contractRegistryCache);
    const actor = createActor(machine, { input });

    const states: StateValue[] = [];
    actor.subscribe((state) => {
      states.push(state.value);
    });

    actor.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(states).toContainEqual({ running: 'starting' });
    expect(states).toContainEqual('stopping');
    expect(states).not.toContainEqual({ running: 'selecting' });

    actor.stop();
  });

  it('should fail preflight check if step definition cannot be loaded in contractRegistryCache', async () => {
    const registryHash = 'dummyRegistryHash';
    const stepList = [
      {
        definitionLocation: {
          contractRegistryHash: registryHash,
          definitionPath: './non-existent.js', // not in contractRegistry
        },
        storageLocation: {
          input: {},
          output: {},
          error: {},
        },
        label: 'step-0',
      },
    ];

    const workflow = {
      name: 'simple',
      pluginPathList: [],
      stepList,
    };

    const contractRegistryCache = new ContractRegistryCache(
      new Map([
        [
          registryHash,
          {
            contractRecord: {
              './jump.js': {
                type: 'control-flow' as const,
                description: 'Jump to a step',
                errorSchema: Type.Object({}),
                inputSchema: Type.Object({}),
                version: '1.0.0',
              },
            },
            contractRegistryPath: '/path/to/registry.js',
            rawboxPluginVersion: '1.0.0',
          },
        ],
      ]),
    );

    const input = {
      params: {
        runId: 'run1',
        workflow,
        workspace: 'test-workspace',
      },
      execution: {
        todoStep: null,
        doneStep: null,
      },
      rootDirectoryUrl: dbDirUrl.href,
      boxStoreLmdb: boxStoreLmdb,
    };

    const machine = createWorkflowMachine(boxStoreLmdb, contractRegistryCache);
    const actor = createActor(machine, { input });

    const states: StateValue[] = [];
    actor.subscribe((state) => {
      states.push(state.value);
    });

    actor.start();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(states).toContainEqual({ running: 'starting' });
    expect(states).toContainEqual('stopping');
    expect(states).not.toContainEqual({ running: 'selecting' });

    actor.stop();
  });

  describe('validateSeedData (Approach A)', () => {
    const registryHash = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const contractRegistryCache = new ContractRegistryCache(
      new Map([
        [
          registryHash,
          {
            contractRecord: {
              './sum.js': {
                type: 'operation' as const,
                description: 'Sum two numbers',
                errorSchema: Type.Object({}),
                inputSchema: Type.Object({
                  a: Type.Number(),
                  b: Type.String(),
                }),
                outputSchema: Type.Object({}),
                version: '1.0.0',
              },
            },
            contractRegistryPath: '/path/to/registry.js',
            rawboxPluginVersion: '1.0.0',
          },
        ],
      ]),
    );

    const stepList = [
      {
        definitionLocation: {
          contractRegistryHash: registryHash,
          definitionPath: './sum.js',
        },
        storageLocation: {
          input: {
            a: {
              key: 'key-a',
              strategy: { name: 'lmdb-kv' as const, valueSizeMax: 100 },
            },
            b: {
              key: 'key-b',
              strategy: { name: 'lmdb-kv' as const, valueSizeMax: 100 },
            },
          },
          output: {},
          error: {},
        },
        label: 'step-0',
      },
    ];

    it('should validate successfully when seed data matches schemas', () => {
      const workflow = {
        name: 'test-wf',
        pluginPathList: [],
        stepList,
        seedData: [
          { key: 'key-a', strategy: { name: 'lmdb-kv' as const, valueSizeMax: 100 }, value: 42 },
          { key: 'key-b', strategy: { name: 'lmdb-kv' as const, valueSizeMax: 100 }, value: 'hello' },
        ],
      };

      const result = validateSeedData(workflow as unknown as ResolvedWorkflow, contractRegistryCache);
      expect(result.isOk()).toBe(true);
    });

    it('should fail validation when seed data does not match schema', () => {
      const workflow = {
        name: 'test-wf',
        pluginPathList: [],
        stepList,
        seedData: [
          { key: 'key-a', strategy: { name: 'lmdb-kv' as const, valueSizeMax: 100 }, value: 'not-a-number' },
        ],
      };

      const result = validateSeedData(workflow as unknown as ResolvedWorkflow, contractRegistryCache);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Seed validation failed for key "key-a"');
    });

    it('should ignore keys not consumed by steps', () => {
      const workflow = {
        name: 'test-wf',
        pluginPathList: [],
        stepList,
        seedData: [
          { key: 'unrelated-key', strategy: { name: 'lmdb-kv' as const, valueSizeMax: 100 }, value: { foo: 'bar' } },
        ],
      };

      const result = validateSeedData(workflow as unknown as ResolvedWorkflow, contractRegistryCache);
      expect(result.isOk()).toBe(true);
    });
  });
});


