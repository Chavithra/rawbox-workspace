import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import { ContractRegistryCache } from 'rawbox-plugin/core';
import { selectFunc as selectStepFunc } from '../src/actors/select-actor.js';

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

  const stepList = [
    {
      definitionLocation: {
        contractRegistryPath: '/path/to/registry.js',
        definitionPath: './sum.js',
      },
      inputBoxLocationRecord: {},
      outputBoxLocationRecord: {},
      stepLabel: 'step-0',
    },
    {
      definitionLocation: {
        contractRegistryPath: '/path/to/registry.js',
        definitionPath: './jump.js',
      },
      inputBoxLocationRecord: {},
      outputBoxLocationRecord: {},
      stepLabel: 'step-1',
    },
  ];

  const contractRegistryCache = new ContractRegistryCache(
    new Map([[mockRegistry.contractRegistryPath, mockRegistry]]),
  );

  it('should return index 0 when doneStep is undefined and stepList is not empty', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        doneStep: undefined,
        todoStep: undefined,
        stepList,
      },
    });

    expect(result).toEqual({
      doneStep: undefined,
      todoStep: { index: 0 },
    });
  });

  it('should return index 0 for next todoStep when doneStep is an operation type contract', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        doneStep: {
          index: 0,
          outputRecord: {},
        },
        todoStep: undefined,
        stepList,
      },
    });

    expect(result).toEqual({
      doneStep: undefined,
      todoStep: { index: 1 },
    });
  });

  it('should return correct target index when doneStep is control-flow and output record contains matching label', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        doneStep: {
          index: 1,
          outputRecord: {
            label: 'step-0',
          },
        },
        todoStep: undefined,
        stepList,
      },
    });

    expect(result).toEqual({
      doneStep: undefined,
      todoStep: { index: 0 },
    });
  });

  it('should throw an error if doneStep index is out of bounds', async () => {
    await expect(
      selectStepFunc({
        input: {
          contractRegistryCache,
          doneStep: {
            index: 99,
          },
          todoStep: undefined,
          stepList,
        },
      }),
    ).rejects.toThrow('Step at index 99 not found in stepList');
  });

  it('should throw an error if label from control-flow does not match any step', async () => {
    await expect(
      selectStepFunc({
        input: {
          contractRegistryCache,
          doneStep: {
            index: 1,
            outputRecord: {
              label: 'non-existent-step',
            },
          },
          todoStep: undefined,
          stepList,
        },
      }),
    ).rejects.toThrow('No step found with label: "non-existent-step"');
  });

  it('should set todoStep to undefined when control-flow returns ReservedLabel.EXIT', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        doneStep: {
          index: 1,
          outputRecord: {
            label: '__EXIT__',
          },
        },
        todoStep: undefined,
        stepList,
      },
    });

    expect(result).toEqual({
      doneStep: undefined,
      todoStep: undefined,
    });
  });

  it('should jump to index 0 when control-flow returns ReservedLabel.START', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        doneStep: {
          index: 1,
          outputRecord: {
            label: '__START__',
          },
        },
        todoStep: undefined,
        stepList,
      },
    });

    expect(result).toEqual({
      doneStep: undefined,
      todoStep: { index: 0 },
    });
  });

  it('should jump to last index when control-flow returns ReservedLabel.END', async () => {
    const result = await selectStepFunc({
      input: {
        contractRegistryCache,
        doneStep: {
          index: 1,
          outputRecord: {
            label: '__END__',
          },
        },
        todoStep: undefined,
        stepList,
      },
    });

    expect(result).toEqual({
      doneStep: undefined,
      todoStep: { index: stepList.length - 1 },
    });
  });

  it('should throw an error if contract is not found in registry', async () => {
    const registryWithoutSum = {
      ...mockRegistry,
      contractRecord: {
        './jump.js': mockRegistry.contractRecord['./jump.js'],
      },
    };
    const badCache = new ContractRegistryCache(
      new Map([[registryWithoutSum.contractRegistryPath, registryWithoutSum]]),
    );

    await expect(
      selectStepFunc({
        input: {
          contractRegistryCache: badCache,
          doneStep: {
            index: 0,
          },
          todoStep: undefined,
          stepList,
        },
      }),
    ).rejects.toThrow('Contract not found in registry: ./sum.js');
  });
});
