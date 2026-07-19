import { fromPromise } from 'xstate';
import { ok, err, type Result } from 'neverthrow';

import type { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import { buildBoxRecord, type Box, type BoxLocation, type ReadBoxLocation } from 'rawbox-store';

import type { MachineExecution } from '../machine-types.js';
import type { Step } from '../../workflow/step-types.js';
import type { Workflow } from '../../workflow/workflow-types.js';
import { getOutputBoxRecord } from './exit-actor.js';

export const getInputBoxLocationRecord = (
  stepList: Step[],
  todoStep: MachineExecution['todoStep'],
): Result<Record<string, ReadBoxLocation>, string> => {
  if (!todoStep) {
    return err(`Invalid state: there should be a todoStep`);
  }

  const stepIndex = todoStep.index;
  const step = stepList[stepIndex];

  if (!step) {
    return err(`Can't find the step with index ${stepIndex}`);
  }

  return ok(step.storageLocation.input);
};

export const syncData = (
  boxStoreLmdb: BoxStoreLmdb,
  inputBoxLocationRecord: Record<string, ReadBoxLocation>,
  outputBoxRecord: Record<string, Box<unknown>>,
  workflowName: string,
  workspaceName: string,
): Result<Record<string, unknown>, string> => {
  return boxStoreLmdb.transaction((txStore) => {
    for (const box of Object.values(outputBoxRecord)) {
      const putResult = txStore.putSync(box);
      if (putResult.isErr()) {
        return err(putResult.error);
      }
    }

    const inputRecord: Record<string, unknown> = {};
    for (const [key, location] of Object.entries(inputBoxLocationRecord)) {
      // Dynamic enrichment of workflow and workspace context on inputs
      const resolvedLocation: BoxLocation = {
        key: location.key,
        workflow: location.workflow ?? workflowName,
        workspace: workspaceName,
        strategy: location.strategy,
      };

      const getResult = txStore.getSync(resolvedLocation);
      if (getResult.isErr()) {
        return err(getResult.error);
      }
      inputRecord[key] = getResult.value;
    }

    return ok(inputRecord);
  });
};

export const syncDbFunc = async ({
  input: { boxStoreLmdb, workflow, workspace, execution },
}: {
  input: {
    boxStoreLmdb: BoxStoreLmdb;
    workflow: Workflow;
    workspace: string;
    execution: MachineExecution;
  };
}): Promise<Result<{
  doneStep: MachineExecution['doneStep'];
  todoStep: MachineExecution['todoStep'];
}, Error>> => {
  const doneStep = execution.doneStep;
  const todoStep = execution.todoStep;
  if (!todoStep) {
    return err(new Error('Parameter `todoStep` should be defined at this stage.'));
  }

  const stepList = workflow.stepList;
  const outputBoxRecordResult = getOutputBoxRecord(doneStep, stepList, workflow.name, workspace);
  if (outputBoxRecordResult.isErr()) {
    return err(new Error(outputBoxRecordResult.error));
  }
  const outputBoxRecord = outputBoxRecordResult.value;

  const inputBoxLocationRecordResult = getInputBoxLocationRecord(stepList, todoStep);
  if (inputBoxLocationRecordResult.isErr()) {
    return err(new Error(inputBoxLocationRecordResult.error));
  }
  const inputBoxLocationRecord = inputBoxLocationRecordResult.value;

  const inputRecordResult = syncData(
    boxStoreLmdb,
    inputBoxLocationRecord,
    outputBoxRecord,
    workflow.name,
    workspace,
  );
  if (inputRecordResult.isErr()) {
    return err(new Error(inputRecordResult.error));
  }
  const inputRecord = inputRecordResult.value;

  return ok({
    doneStep: null,
    todoStep: {
      index: todoStep.index,
      inputRecord: inputRecord,
    },
  });
};

export const syncDbActor = fromPromise(syncDbFunc);
