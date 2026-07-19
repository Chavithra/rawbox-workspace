import { fromPromise } from 'xstate';

import { err, ok, type Result } from 'neverthrow';
import { ContractRegistryLoader } from 'rawbox-plugin/core';
import type { ContractRegistryCache, DefinitionLocation } from 'rawbox-plugin/core';
import type { ControlFlowContract } from 'rawbox-plugin/control-flow';
import type { OperationContract } from 'rawbox-plugin/operation';
import { ReservedLabel } from 'rawbox-plugin/control-flow';

/**
 * Dynamically retrieves a contract registry from cache and extracts the contract associated with the definition path.
 */
export async function loadContract(
  definitionLocation: DefinitionLocation,
  contractRegistryCache: ContractRegistryCache,
): Promise<Result<OperationContract | ControlFlowContract, string>> {
  let registry = contractRegistryCache.getContractRegistry(
    definitionLocation.contractRegistryHash,
  );
  if (!registry) {
    const loadResult = await ContractRegistryLoader.loadContractRegistry(
      definitionLocation.contractRegistryHash,
    );
    if (loadResult.isErr()) {
      return err(`Failed to load registry: ${loadResult.error}`);
    }
    registry = loadResult.value;
    contractRegistryCache.addContractRegistry(registry);
  }

  const contract = registry.contractRecord[definitionLocation.definitionPath];
  if (!contract) {
    return err(`Contract not found in registry: ${definitionLocation.definitionPath}`);
  }

  if (contract.type === 'operation' || contract.type === 'control-flow') {
    return ok(contract as OperationContract | ControlFlowContract);
  }

  return err(`Unknown contract type: ${contract.type}`);
}

import type { MachineExecution } from '../machine-types.js';
import type { Step } from '../../workflow/step-types.js';
import type { Workflow } from '../../workflow/workflow-types.js';

export const getStepContract = async (
  stepList: Step[],
  stepIndex: number,
  contractRegistryCache: ContractRegistryCache,
): Promise<Result<OperationContract | ControlFlowContract, string>> => {
  const step = stepList[stepIndex];

  if (!step) {
    return err(`Step at index ${stepIndex} not found in stepList`);
  }

  return await loadContract(
    step.definitionLocation,
    contractRegistryCache,
  );
};

export const selectFunc = async ({
  input: { contractRegistryCache, execution, workflow },
}: {
  input: {
    contractRegistryCache: ContractRegistryCache;
    execution: MachineExecution;
    workflow: Workflow;
  };
}): Promise<Result<{
  todoStep: MachineExecution['todoStep'];
}, Error>> => {
  const stepList = workflow.stepList;
  const doneStep = execution.doneStep;
  let output;

  if (doneStep) {
    const contractResult = await getStepContract(
      stepList,
      doneStep.index,
      contractRegistryCache,
    );

    if (contractResult.isErr()) {
      return err(new Error(contractResult.error));
    }

    const contract = contractResult.value;

    if (contract.type === 'operation') {
      const nextIndex = doneStep.index + 1;
      output = {
        todoStep: stepList[nextIndex] ? { index: nextIndex } : null,
      };
    } else if (contract.type === 'control-flow') {
      const label = doneStep.outputRecord!.label as string;

      if (label === ReservedLabel.EXIT) {
        output = { todoStep: null };
      } else if (label === ReservedLabel.START) {
        output = { todoStep: { index: 0 } };
      } else if (label === ReservedLabel.END) {
        output = { todoStep: { index: stepList.length - 1 } };
      } else {
        const index = stepList.findIndex((step) => step.label === label);
        if (index !== -1) {
          output = {
            todoStep: { index: index },
          };
        } else {
          return err(new Error(`No step found with label: "${label}"`));
        }
      }
    } else {
      return err(new Error(`Unknown contract type: ${(contract as any).type}`));
    }
  } else {
    if (stepList.length > 0) {
      output = {
        todoStep: stepList[0] ? { index: 0 } : null,
      };
    } else {
      return err(new Error(`Array stepList shouldn't be empty.`));
    }
  }

  return ok(output);
};

export const selectActor = fromPromise(selectFunc);
