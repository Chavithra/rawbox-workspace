import { fromPromise } from 'xstate';
import { ok, err, type Result } from 'neverthrow';
import { loadDefinition } from 'rawbox-plugin/core';

import type { ContractRegistryCache } from 'rawbox-plugin/core';
import type { DoneStep, MachineExecution } from '../machine-types.js';
import type { Workflow } from '../../workflow/workflow-types.js';

export const runFunc = async ({
  input: { contractRegistryCache, workflow, execution },
}: {
  input: {
    contractRegistryCache: ContractRegistryCache;
    workflow: Workflow;
    execution: MachineExecution;
  };
}): Promise<Result<{
  doneStep: DoneStep;
}, Error>> => {
  const todoStep = execution.todoStep;
  if (!todoStep || !todoStep.inputRecord) {
    return err(new Error('todoStep is required to execute runFunc'));
  }

  const stepList = workflow.stepList;
  const handlerInput: Record<string, unknown> = todoStep.inputRecord;
  const stepIndex = todoStep.index;
  const step = stepList[stepIndex];

  if (!step) {
    return err(new Error(`Step at index ${stepIndex} not found in stepList`));
  }

  const definitionResult = await loadDefinition(
    step.definitionLocation,
    contractRegistryCache,
  );

  if (definitionResult.isErr()) {
    return err(new Error(definitionResult.error));
  }

  const definition = definitionResult.value;

  const handlerResult = await definition.validatedHandler(handlerInput);

  if (handlerResult.isErr()) {
    return err(handlerResult.error instanceof Error ? handlerResult.error : new Error(String(handlerResult.error)));
  }

  const logicResult = handlerResult.value;

  if (logicResult.isErr()) {
    return ok({
      doneStep: {
        index: stepIndex,
        errorRecord: logicResult.error,
      },
    });
  }

  return ok({
    doneStep: {
      index: stepIndex,
      outputRecord: logicResult.value,
    },
  });
};

export const runActor = fromPromise(runFunc);
