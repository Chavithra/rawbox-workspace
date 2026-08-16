import { fromPromise } from 'xstate';
import { ok, err, type Result } from 'neverthrow';

import type { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import { type Box, type BoxLocation, type ReadBoxLocation } from '@rawbox/store';

import type { MachineExecution } from '../machine-types.js';
import type { ResolvedStep } from '../../workflow/step-types.js';
import type { ResolvedWorkflow } from '../../workflow/workflow-types.js';
import { getOutputBoxRecord } from './exit-actor.js';

export const getInputBoxLocationRecord = (
  stepList: ResolvedStep[],
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

/**
 * Writes the finished step's outputs and reads the next step's inputs in ONE
 * transaction. Both halves in one commit is the point: a crash between them
 * would leave a step's outputs visible while the successor never observed
 * them.
 *
 * `async` only at the boundary. `BoxStoreLmdb.transaction` resolves a Promise
 * but still runs its callback synchronously inside `transactionSync`, so the
 * callback below stays synchronous — `putSync`/`getSync`, never `put`/`get`.
 * An `await` in there would both commit an empty transaction and pin an MVCC
 * snapshot across a suspension; see the doc comment on
 * `BoxStoreLmdb.transaction` (`rawbox-store/src/box-store/box-store-lmdb.ts`)
 * for why neither is recoverable. The `await` belongs here, outside.
 */
export const syncData = async (
  boxStoreLmdb: BoxStoreLmdb,
  inputBoxLocationRecord: Record<string, ReadBoxLocation>,
  outputBoxRecord: Record<string, Box<unknown>>,
  workflowName: string,
  workspaceName: string,
): Promise<Result<Record<string, unknown>, string>> => {
  return boxStoreLmdb.transaction((txStore) => {
    for (const box of Object.values(outputBoxRecord)) {
      const putResult = txStore.putSync(box);
      if (putResult.isErr()) {
        return err(putResult.error);
      }
    }

    const inputRecord: Record<string, unknown> = {};
    for (const [key, location] of Object.entries(inputBoxLocationRecord)) {
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
    workflow: ResolvedWorkflow;
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

  const inputRecordResult = await syncData(
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
