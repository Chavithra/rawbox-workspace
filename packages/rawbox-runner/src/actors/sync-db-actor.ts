import { fromPromise } from 'xstate';
import { ok, err } from 'neverthrow';

import type { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import { buildBoxRecord, type Box, type BoxLocation } from 'rawbox-store';

import type { MachineContext } from '../machine-types.js';
import type { BoxRecord } from '../step-types.js';

export const getOutputBoxRecord = (
  doneStep: MachineContext['doneStep'],
  stepList: MachineContext['stepList'],
): Record<string, Box<unknown>> => {
  const outputBoxRecord: Record<string, Box<unknown>> = {};

  if (!doneStep) {
    return outputBoxRecord;
  }

  const stepIndex = doneStep.index;
  const step = stepList[stepIndex];

  if (!step) {
    throw new Error(`Can't find the step with index ${stepIndex}`);
  }

  if (doneStep.outputRecord) {
    const outputBoxRecordResult = buildBoxRecord(
      step.outputBoxLocationRecord,
      doneStep.outputRecord as Record<string, Box<unknown>>,
    );

    if (outputBoxRecordResult.isErr()) {
      throw new Error(outputBoxRecordResult.error);
    }

    Object.assign(outputBoxRecord, outputBoxRecordResult.value);
  }

  if (doneStep.errorRecord) {
    const errorBoxRecordResult = buildBoxRecord(
      step.errorBoxLocationRecord,
      doneStep.errorRecord as Record<string, Box<unknown>>,
    );

    if (errorBoxRecordResult.isErr()) {
      throw new Error(errorBoxRecordResult.error);
    }

    Object.assign(outputBoxRecord, errorBoxRecordResult.value);
  }

  return outputBoxRecord;
};

export const getInputBoxLocationRecord = (
  stepList: MachineContext['stepList'],
  todoStep: MachineContext['todoStep'],
): Record<string, BoxLocation> => {
  let inputBoxLocationRecord;

  if (todoStep) {
    const stepIndex = todoStep.index;
    const step = stepList[stepIndex];

    if (step) {
      inputBoxLocationRecord = step.inputBoxLocationRecord;
    } else {
      throw new Error(`Can't find the step with index ${stepIndex}`);
    }
  } else {
    throw new Error(`Invalid state: there should be a todoStep`);
  }

  return inputBoxLocationRecord;
};

export const syncData = (
  boxStoreLmdb: BoxStoreLmdb,
  inputBoxLocationRecord: Record<string, BoxLocation>,
  outputBoxRecord: Record<string, Box<unknown>>,
): Record<string, unknown> => {
  const inputBoxRecordResult = boxStoreLmdb.transaction((txStore) => {
    for (const box of Object.values(outputBoxRecord)) {
      const putResult = txStore.putSync(box);
      if (putResult.isErr()) {
        return err(putResult.error);
      }
    }

    const inputRecord: Record<string, unknown> = {};
    for (const [key, location] of Object.entries(inputBoxLocationRecord)) {
      const getResult = txStore.getSync(location);
      if (getResult.isErr()) {
        return err(getResult.error);
      }
      inputRecord[key] = getResult.value;
    }

    return ok(inputRecord);
  });

  if (inputBoxRecordResult.isErr()) {
    throw new Error(inputBoxRecordResult.error);
  } else {
    return inputBoxRecordResult.value;
  }
};

export const syncDbFunc = async ({
  input: { boxStoreLmdb, doneStep, stepList, todoStep },
}: {
  input: {
    boxStoreLmdb: BoxStoreLmdb;
    doneStep: MachineContext['doneStep'];
    todoStep: MachineContext['todoStep'];
    stepList: MachineContext['stepList'];
  };
}): Promise<{
  doneStep: MachineContext['doneStep'];
  todoStep: MachineContext['todoStep'];
}> => {
  if (!todoStep) {
    throw new Error('Parameter `todoStep` should be defined at this stage.');
  }

  const outputBoxRecord = getOutputBoxRecord(doneStep, stepList);
  const inputBoxLocationRecord = getInputBoxLocationRecord(stepList, todoStep);

  const inputRecord = syncData(
    boxStoreLmdb,
    inputBoxLocationRecord,
    outputBoxRecord,
  );

  return {
    doneStep: undefined,
    todoStep: {
      index: todoStep.index,
      inputRecord: inputRecord,
    },
  };
};

export const syncDbActor = fromPromise(syncDbFunc);
