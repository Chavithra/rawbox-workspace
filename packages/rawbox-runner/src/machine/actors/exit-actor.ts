import { fromPromise } from 'xstate';
import { ok, err, type Result } from 'neverthrow';

import type { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import { buildBoxRecord, type Box } from 'rawbox-store';

import type { MachineExecution } from '../machine-types.js';
import type { Step } from '../../workflow/step-types.js';
import type { Workflow } from '../../workflow/workflow-types.js';

export const getOutputBoxRecord = (
  doneStep: MachineExecution['doneStep'],
  stepList: Step[],
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
  input: { boxStoreLmdb, workflow, workspace, execution },
}: {
  input: {
    boxStoreLmdb: BoxStoreLmdb;
    workflow: Workflow;
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

  const writeResult = boxStoreLmdb.transaction((txStore) => {
    for (const box of Object.values(outputBoxRecord)) {
      const putResult = txStore.putSync(box);
      if (putResult.isErr()) {
        return err(putResult.error);
      }
    }
    return ok(undefined);
  });

  if (writeResult.isErr()) {
    return err(new Error(writeResult.error));
  }

  return ok(undefined);
};

export const exitActor = fromPromise(exitFunc);
