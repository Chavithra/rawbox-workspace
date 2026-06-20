import { fromPromise } from 'xstate';
import { loadDefinition } from 'rawbox-plugin/core';

import type { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import type { ContractRegistryCache } from 'rawbox-plugin/core';
import type { DoneStep, MachineContext } from '../machine-types.js';

export const runFunc = async ({
  input: { boxStoreLmdb, contractRegistryCache, stepList, todoStep },
}: {
  input: {
    boxStoreLmdb: BoxStoreLmdb;
    contractRegistryCache: ContractRegistryCache;
    stepList: MachineContext['stepList'];
    todoStep: MachineContext['todoStep'];
  };
}): Promise<{
  doneStep: DoneStep;
}> => {
  if (!todoStep || !todoStep.inputRecord) {
    throw new Error('todoStep is required to execute runFunc');
  }

  const handlerInput: Record<string, unknown> = todoStep.inputRecord;
  const stepIndex = todoStep.index;
  const step = stepList[stepIndex];

  if (!step) {
    throw new Error(`Step at index ${stepIndex} not found in stepList`);
  }

  const definitionResult = await loadDefinition(
    step.definitionLocation,
    contractRegistryCache,
  );

  if (definitionResult.isErr()) {
    throw new Error(definitionResult.error);
  }

  const definition = definitionResult.value;

  const handlerResult = await definition.validatedHandler(handlerInput);

  if (handlerResult.isErr()) {
    throw handlerResult.error;
  }

  const logicResult = handlerResult.value;

  if (logicResult.isErr()) {
    return {
      doneStep: {
        index: stepIndex,
        errorRecord: logicResult.error,
      },
    };
  }

  return {
    doneStep: {
      index: stepIndex,
      outputRecord: logicResult.value,
    },
  };
};

export const runActor = fromPromise(runFunc);
