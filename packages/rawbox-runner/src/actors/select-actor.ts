import { fromPromise } from 'xstate';

import type { ContractRegistryCache } from 'rawbox-plugin/core';
import type { ControlFlowContract } from 'rawbox-plugin/control-flow';
import type { OperationContract } from 'rawbox-plugin/operation';
import { loadContract } from 'rawbox-plugin/core';
import { ReservedLabel } from 'rawbox-plugin/control-flow';

import type { MachineContext } from '../machine-types.js';
import type { Step } from '../step-types.js';

export const getStepContract = async (
  stepList: Step[],
  stepIndex: number,
  contractRegistryCache: ContractRegistryCache,
): Promise<OperationContract | ControlFlowContract> => {
  const step = stepList[stepIndex];

  if (!step) {
    throw new Error(`Step at index ${stepIndex} not found in stepList`);
  }

  const contractResult = await loadContract(
    step.definitionLocation,
    contractRegistryCache,
  );
  if (contractResult.isErr()) {
    throw new Error(contractResult.error);
  }

  return contractResult.value;
};

export const selectFunc = async ({
  input: { contractRegistryCache, doneStep, stepList },
}: {
  input: {
    contractRegistryCache: ContractRegistryCache;
    doneStep: MachineContext['doneStep'];
    todoStep: MachineContext['todoStep'];
    stepList: MachineContext['stepList'];
  };
}): Promise<{
  todoStep: MachineContext['todoStep'];
}> => {
  let output;

  if (doneStep) {
    const contract = await getStepContract(
      stepList,
      doneStep.index,
      contractRegistryCache,
    );

    if (contract.type === 'operation') {
      const nextIndex = doneStep.index + 1;
      output = {
        todoStep: stepList[nextIndex] ? { index: nextIndex } : undefined,
      };
    } else if (contract.type === 'control-flow') {
      const label = doneStep.outputRecord!.label as string;

      if (label === ReservedLabel.EXIT) {
        output = { todoStep: undefined };
      } else if (label === ReservedLabel.START) {
        output = { todoStep: { index: 0 } };
      } else if (label === ReservedLabel.END) {
        output = { todoStep: { index: stepList.length - 1 } };
      } else {
        const index = stepList.findIndex((step) => step.stepLabel === label);
        if (index !== -1) {
          output = {
            todoStep: { index: index },
          };
        } else {
          throw new Error(`No step found with label: "${label}"`);
        }
      }
    } else {
      throw new Error(`Unknown contract type: ${(contract as any).type}`);
    }
  } else {
    if (stepList.length > 0) {
      output = {
        todoStep: stepList[0] ? { index: 0 } : undefined,
      };
    } else {
      throw new Error(`Array stepList shouldn't be empty.`);
    }
  }

  return output;
};

export const selectActor = fromPromise(selectFunc);
