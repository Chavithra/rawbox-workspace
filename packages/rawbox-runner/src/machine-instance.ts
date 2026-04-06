import { parentPort, workerData } from 'node:worker_threads';

import { Type, type Static } from '@sinclair/typebox';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { createActor, setup } from 'xstate';

import { Step, StepOutput } from './step.js';

if (!parentPort) {
  throw new Error(
    'parentPort is null. This script must be run as a worker thread.',
  );
}

export const MachineInput = Type.Object({
  machineInstanceId: Type.String(),
  stepIndex: Type.Number(),
  stepList: Type.Array(Step),
  workspace: Type.String(),
});

export type MachineInput = Static<typeof MachineInput>;

export const MachineContext = Type.Object({
  machineInstanceId: Type.String(),
  stepIndex: Type.Number(),
  stepList: Type.Array(Step),
  stepOutput: Type.Optional(StepOutput),
  workspace: Type.String(),
});

export type MachineContext = Static<typeof MachineContext>;

export const StopConfirmationEvent = Type.Object({
  type: Type.Literal('STOP_CONFIRMATION'),
  machineInstanceId: Type.String(),
});

export type StopConfirmationEvent = Static<typeof StopConfirmationEvent>;

const StopEvent = Type.Object({
  type: Type.Literal('STOP'),
});

export const MachineEvent = Type.Union([StopEvent]);

export type MachineEvent = Static<typeof MachineEvent>;

const MachineEventValidator = TypeCompiler.Compile(MachineEvent);

const machine = setup({
  actors: {},
  actions: {},
  types: {
    context: {} as MachineContext,
    events: {} as MachineEvent,
    input: {} as MachineInput,
  },
}).createMachine({
  id: 'workflow_state_machine',
  initial: 'synchronizingWithDB',
  context: ({ input }: { input: MachineInput }) => ({
    machineInstanceId: input.machineInstanceId,
    stepIndex: input.stepIndex,
    stepList: input.stepList,
    workspace: input.workspace,
  }),
  states: {
    synchronizingWithDB: { on: { STOP: 'stopping' } },
    runningOperation: { on: { STOP: 'stopping' } },
    stopping: {
      type: 'final',
    },
  },
});

const input = workerData as MachineInput;

const actor = createActor(machine, { input });

actor.start();

actor.on('done', (_event) => {
  console.log('Machine reached a final state');
  const stopConfirmationEvent: StopConfirmationEvent = {
    type: 'STOP_CONFIRMATION',
    machineInstanceId: input.machineInstanceId,
  };
  parentPort!.postMessage(stopConfirmationEvent);
  process.exit(0);
});

actor.subscribe((state) => {
  console.log('Current state', state);
});

parentPort.on('message', (event: unknown) => {
  if (MachineEventValidator.Check(event)) {
    actor.send(event);
  } else {
    throw new Error(`Received invalid event from main thread:{event}`);
  }
});
