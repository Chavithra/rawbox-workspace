import { setup, assign } from 'xstate';

import type { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import type { ContractRegistryCache } from 'rawbox-plugin/core';

import {
  MachineContext,
  MachineInput,
  MachineEvent,
} from './machine-types.js';

import { selectActor } from './actors/select-actor.js';
import { syncDbActor } from './actors/sync-db-actor.js';
import { runActor } from './actors/run-actor.js';

export {
  DoneStep,
  TodoStep,
  MachineContext,
  MachineInput,
  MachineEvent,
  MachineEventValidator,
} from './machine-types.js';

export const machineSetup = setup({
  actors: {
    selectActor: selectActor,
    syncDbActor: syncDbActor,
    runActor: runActor,
  },
  types: {
    context: {} as MachineContext,
    events: {} as MachineEvent,
    input: {} as MachineInput,
  },
});

export const createWorkflowMachine = (
  boxStoreLmdb: BoxStoreLmdb,
  contractRegistryCache: ContractRegistryCache,
) => {
  return machineSetup.createMachine({
    context: ({ input }): MachineContext => {
      const ctx: MachineContext = {
        instanceId: input.instanceId,
        stepList: input.stepList,
        workspace: input.workspace,
        todoStep: input.todoStep ?? { index: 0 },
      };
      if (input.doneStep) {
        ctx.doneStep = input.doneStep;
      }
      return ctx;
    },
    id: 'workflow_state_machine',
    initial: 'running',
    states: {
      running: {
        initial: 'selecting',
        on: {
          STOP: { target: 'stopping' },
        },
        states: {
          selecting: {
            invoke: {
              src: 'selectActor',
              input: ({ context }) => ({
                contractRegistryCache: contractRegistryCache,
                doneStep: context.doneStep,
                todoStep: context.todoStep,
                stepList: context.stepList,
              }),
              onDone: [
                {
                  guard: ({ event }) => event.output.todoStep === undefined,
                  target: '#workflow_state_machine.stopping',
                },
                {
                  target: 'syncingDb',
                  actions: assign({
                    todoStep: ({ event }) => event.output.todoStep,
                  }),
                },
              ],
              onError: {
                target: '#workflow_state_machine.stopping',
              },
            },
          },
          syncingDb: {
            invoke: {
              src: 'syncDbActor',
              input: ({ context }) => ({
                boxStoreLmdb: boxStoreLmdb,
                contractRegistryCache: contractRegistryCache,
                doneStep: context.doneStep,
                stepList: context.stepList,
                todoStep: context.todoStep,
              }),
              onDone: {
                target: 'running',
                actions: assign({
                  todoStep: ({ event }) => event.output.todoStep,
                  doneStep: ({ event }) => event.output.doneStep,
                }),
              },
            },
          },
          running: {
            invoke: {
              src: 'runActor',
              input: ({ context }) => ({
                contractRegistryCache: contractRegistryCache,
                boxStoreLmdb: boxStoreLmdb,
                todoStep: context.todoStep,
                stepList: context.stepList,
              }),
              onDone: {
                target: 'selecting',
                actions: assign({
                  doneStep: ({ event }) => event.output.doneStep,
                }),
              },
            },
          },
        },
      },
      stopping: {
        type: 'final',
      },
    },
  });
};
