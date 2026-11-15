import { fromPromise } from 'xstate';
import { ok, err, type Result } from 'neverthrow';

import { buildBoxRecord, type Box, type BoxStore } from '@rawbox/store';

import type { MachineExecution } from '../machine-types.js';
import type { ResolvedStep } from '../../workflow/step-types.js';
import type { ResolvedWorkflow } from '../../workflow/workflow-types.js';

export const getOutputBoxRecord = (
  doneStep: MachineExecution['doneStep'],
  stepList: ResolvedStep[],
  workflow: string,
  workspace: string,
): Result<Record<string, Box<unknown>>, string> => {
  const outputBoxRecord: Record<string, Box<unknown>> = {};

  if (!doneStep) {
    return ok(outputBoxRecord);
  }

  const stepIndex = doneStep.index;
  const step = stepList[stepIndex];

  if (!step) {
    return err(`Can't find the step with index ${stepIndex}`);
  }

  if (doneStep.outputRecord) {
    const outputBoxRecordResult = buildBoxRecord(
      step.storageLocation.output,
      doneStep.outputRecord as Record<string, Box<unknown>>,
      workflow,
      workspace,
    );

    if (outputBoxRecordResult.isErr()) {
      return err(outputBoxRecordResult.error);
    }

    Object.assign(outputBoxRecord, outputBoxRecordResult.value);
  }

  if (doneStep.errorRecord) {
    const errorBoxRecordResult = buildBoxRecord(
      step.storageLocation.error,
      doneStep.errorRecord as Record<string, Box<unknown>>,
      workflow,
      workspace,
    );

    if (errorBoxRecordResult.isErr()) {
      return err(errorBoxRecordResult.error);
    }

    Object.assign(outputBoxRecord, errorBoxRecordResult.value);
  }

  return ok(outputBoxRecord);
};

export const exitFunc = async ({
  input: { boxStore, workflow, workspace, execution },
}: {
  input: {
    boxStore: BoxStore;
    workflow: ResolvedWorkflow;
    workspace: string;
    execution: MachineExecution;
  };
}): Promise<Result<void, Error>> => {
  const doneStep = execution.doneStep;
  if (!doneStep) {
    return ok(undefined);
  }

  const stepList = workflow.stepList;
  const outputBoxRecordResult = getOutputBoxRecord(doneStep, stepList, workflow.name, workspace);
  if (outputBoxRecordResult.isErr()) {
    return err(new Error(outputBoxRecordResult.error));
  }
  const outputBoxRecord = outputBoxRecordResult.value;

  const outputBoxes = Object.values(outputBoxRecord);
  if (outputBoxes.length === 0) {
    return ok(undefined);
  }

  const writeResult = await boxStore.transact({ puts: outputBoxes });

  if (writeResult.isErr()) {
    return err(new Error(writeResult.error));
  }

  return ok(undefined);
};

export const exitActor = fromPromise(exitFunc);
