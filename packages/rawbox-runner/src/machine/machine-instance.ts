import { setup, assign } from 'xstate';

import type { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import type { ContractRegistryCache } from 'rawbox-plugin/core';

import { MachineContext, MachineInput, MachineEvent } from './machine-types.js';

import { exitActor } from './actors/exit-actor.js';
import { selectActor } from './actors/select-actor.js';
import { syncDbActor } from './actors/sync-db-actor.js';
import { runActor } from './actors/run-actor.js';
import { startActor } from './actors/start-actor.js';

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
    exitActor,
    runActor,
    selectActor,
    startActor,
    syncDbActor,
  },
  types: {
    context: {} as MachineContext,
    events: {} as MachineEvent,
    input: {} as MachineInput,
  },
});

const resultErrorAssigner = ({ event }: any) => {
  const errVal = event.output._unsafeUnwrapErr();
  const result: { message: string; stack?: string } = {
    message: errVal.message || String(errVal),
  };
  if (errVal.stack) {
    result.stack = errVal.stack;
  }
  return { error: result };
};

const actorErrorAssigner = ({ event }: any) => {
  const errVal = event.error;
  const result: { message: string; stack?: string } = {
    message: errVal instanceof Error ? errVal.message : String(errVal),
  };
  if (errVal instanceof Error && errVal.stack) {
    result.stack = errVal.stack;
  }
  return { error: result };
};

const selectDoneAssigner = ({ context, event }: any) => {
  const val = event.output._unsafeUnwrap();
  return {
    execution: {
      ...context.execution,
      todoStep: val.todoStep ?? null,
    },
  };
};

const syncDbDoneAssigner = ({ context, event }: any) => {
  const val = event.output._unsafeUnwrap();
  return {
    execution: {
      ...context.execution,
      todoStep: val.todoStep ?? null,
      doneStep: val.doneStep ?? null,
    },
  };
};

const runDoneAssigner = ({ context, event }: any) => {
  const val = event.output._unsafeUnwrap();
  return {
    execution: {
      ...context.execution,
      doneStep: val.doneStep ?? null,
    },
  };
};

export const createWorkflowMachine = (
  boxStoreLmdb: BoxStoreLmdb,
  contractRegistryCache: ContractRegistryCache,
) => {
  return machineSetup.createMachine({
    context: ({ input }): MachineContext => {
      const params = input.params ?? {
        runId: (input as any).runId,
        workflow: (input as any).workflow,
        workspace: (input as any).workspace,
      };
      const executionRaw = input.execution ?? (input as any).stepState ?? {
        todoStep: (input as any).todoStep ?? { index: 0 },
        doneStep: (input as any).doneStep,
      };
      return {
        params,
        execution: {
          todoStep: executionRaw.todoStep ?? null,
          doneStep: executionRaw.doneStep ?? null,
        },
      };
    },
    id: 'workflow_state_machine',
    initial: 'running',
    states: {
      running: {
        initial: 'starting',
        on: {
          STOP: { target: 'stopping' },
        },
        states: {
          starting: {
            invoke: {
              src: 'startActor',
              input: ({ context }) => ({
                contractRegistryCache: contractRegistryCache,
                workflow: context.params.workflow,
                workspace: context.params.workspace,
              }),
              onDone: [
                {
                  guard: ({ event }) => event.output.isErr(),
                  target: '#workflow_state_machine.stopping',
                  actions: assign(resultErrorAssigner),
                },
                {
                  target: 'selecting',
                },
              ],
              onError: {
                target: '#workflow_state_machine.stopping',
                actions: assign(actorErrorAssigner),
              },
            },
          },
          selecting: {
            invoke: {
              src: 'selectActor',
              input: ({ context }) => ({
                contractRegistryCache: contractRegistryCache,
                execution: context.execution,
                workflow: context.params.workflow,
              }),
              onDone: [
                {
                  guard: ({ event }) => event.output.isErr(),
                  target: '#workflow_state_machine.stopping',
                  actions: assign(resultErrorAssigner),
                },
                {
                  guard: ({ event }) => {
                    const val = event.output._unsafeUnwrap();
                    return val.todoStep === undefined || val.todoStep === null;
                  },
                  target: 'exiting',
                },
                {
                  target: 'syncingDb',
                  actions: assign(selectDoneAssigner),
                },
              ],
              onError: {
                target: '#workflow_state_machine.stopping',
                actions: assign(actorErrorAssigner),
              },
            },
          },
          syncingDb: {
            invoke: {
              src: 'syncDbActor',
              input: ({ context }) => ({
                boxStoreLmdb: boxStoreLmdb,
                contractRegistryCache: contractRegistryCache,
                execution: context.execution,
                workflow: context.params.workflow,
                workspace: context.params.workspace,
              }),
              onDone: [
                {
                  guard: ({ event }) => event.output.isErr(),
                  target: 'exiting',
                  actions: assign(resultErrorAssigner),
                },
                {
                  target: 'running',
                  actions: assign(syncDbDoneAssigner),
                },
              ],
              onError: {
                target: 'exiting',
                actions: assign(actorErrorAssigner),
              },
            },
          },
          running: {
            invoke: {
              src: 'runActor',
              input: ({ context }) => ({
                contractRegistryCache: contractRegistryCache,
                boxStoreLmdb: boxStoreLmdb,
                execution: context.execution,
                workflow: context.params.workflow,
              }),
              onDone: [
                {
                  guard: ({ event }) => event.output.isErr(),
                  target: 'exiting',
                  actions: assign(resultErrorAssigner),
                },
                {
                  target: 'selecting',
                  actions: assign(runDoneAssigner),
                },
              ],
              onError: {
                target: 'exiting',
                actions: assign(actorErrorAssigner),
              },
            },
          },
          exiting: {
            invoke: {
              src: 'exitActor',
              input: ({ context }) => ({
                boxStoreLmdb: boxStoreLmdb,
                workflow: context.params.workflow,
                workspace: context.params.workspace,
                execution: context.execution,
              }),
              onDone: [
                {
                  guard: ({ event }) => event.output.isErr(),
                  target: '#workflow_state_machine.stopping',
                  actions: assign(resultErrorAssigner),
                },
                {
                  target: '#workflow_state_machine.stopping',
                },
              ],
              onError: {
                target: '#workflow_state_machine.stopping',
                actions: assign(actorErrorAssigner),
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
