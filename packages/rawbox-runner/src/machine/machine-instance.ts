import { setup, assign, type AnyEventObject } from 'xstate';
import type { Result } from 'neverthrow';

import type { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import type { ContractRegistryCache } from '@rawbox/plugin/core';

import { MachineContext, MachineInput, MachineEvent } from './machine-types.js';
import type { MachineExecution, MachineParams } from './machine-types.js';

import { exitActor } from './actors/exit-actor.js';
import { selectActor } from './actors/select-actor.js';
import { syncDbActor } from './actors/sync-db-actor.js';
import { runActor } from './actors/run-actor.js';
import { startActor } from './actors/start-actor.js';

export {
  DEFAULT_PREFLIGHT_TIMEOUT_MS,
  PreflightTimeoutError,
} from './actors/start-actor.js';

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

// The machine only declares `STOP` in `types.events`, so xstate passes actor
// done/error events as `AnyEventObject`; each assigner narrows the payload it
// reads at the point of use.

/** The execution slice the "done" assigners read off the actor output. */
type StepOutput = {
  todoStep?: MachineExecution['todoStep'] | undefined;
  doneStep?: MachineExecution['doneStep'] | undefined;
};

type AssignerArgs = { context: MachineContext; event: AnyEventObject };

/** The flat input shape still accepted alongside `{ params, execution }`. */
type LegacyMachineInput = {
  runId: MachineParams['runId'];
  workflow: MachineParams['workflow'];
  workspace: MachineParams['workspace'];
  stepState?: MachineExecution | undefined;
  todoStep?: MachineExecution['todoStep'] | undefined;
  doneStep?: MachineExecution['doneStep'] | undefined;
};

/**
 * Turns an actor's `err` branch into `context.error`.
 *
 * Every field is copied **structurally** — `typeof errVal?.x === 'string'`,
 * never `instanceof` — because the value crossed an actor boundary and may have
 * been minted by a *different copy* of this package in the dependency tree,
 * where the same class has a different identity. `timeoutMs` follows exactly
 * the rule `stack` already follows for that reason: a bounded step's
 * `StepTimeoutError` (`actors/run-actor.ts`) and a preflight bound's
 * `PreflightTimeoutError` (`actors/start-actor.ts`) each carry the bound that
 * expired, and losing it to a duplicated install would silently downgrade a
 * timeout to an ordinary failure in the event stream. One structural read
 * serves both, which is the point of reading the field rather than the class.
 */
const resultErrorAssigner = ({ event }: AssignerArgs) => {
  const output = event.output as Result<unknown, unknown>;
  const raw: unknown = output._unsafeUnwrapErr();
  const errVal = raw as
    | { message?: unknown; stack?: unknown; timeoutMs?: unknown }
    | null
    | undefined;
  const result: { message: string; stack?: string; timeoutMs?: number } = {
    message:
      typeof errVal?.message === 'string' && errVal.message ? errVal.message : String(raw),
  };
  if (typeof errVal?.stack === 'string' && errVal.stack) {
    result.stack = errVal.stack;
  }
  if (typeof errVal?.timeoutMs === 'number') {
    result.timeoutMs = errVal.timeoutMs;
  }
  return { error: result };
};

/**
 * Turns an actor *rejection* into `context.error`.
 *
 * Deliberately unchanged by bounded steps: a rejection is never a timeout,
 * because `runFunc` reports an expired bound by returning `err(...)` — the
 * `onDone`/`resultErrorAssigner` path above — rather than by throwing. A
 * rejection reaching here means the actor itself blew up, which is a different
 * failure with nothing to say about a bound.
 */
const actorErrorAssigner = ({ event }: AssignerArgs) => {
  const errVal: unknown = event.error;
  const result: { message: string; stack?: string } = {
    message: errVal instanceof Error ? errVal.message : String(errVal),
  };
  if (errVal instanceof Error && errVal.stack) {
    result.stack = errVal.stack;
  }
  return { error: result };
};

const selectDoneAssigner = ({ context, event }: AssignerArgs) => {
  const val = (event.output as Result<StepOutput, unknown>)._unsafeUnwrap();
  return {
    execution: {
      ...context.execution,
      todoStep: val.todoStep ?? null,
    },
  };
};

const syncDbDoneAssigner = ({ context, event }: AssignerArgs) => {
  const val = (event.output as Result<StepOutput, unknown>)._unsafeUnwrap();
  return {
    execution: {
      ...context.execution,
      todoStep: val.todoStep ?? null,
      doneStep: val.doneStep ?? null,
    },
  };
};

const runDoneAssigner = ({ context, event }: AssignerArgs) => {
  const val = (event.output as Result<StepOutput, unknown>)._unsafeUnwrap();
  return {
    execution: {
      ...context.execution,
      doneStep: val.doneStep ?? null,
    },
  };
};

/**
 * @param preflightTimeoutMs - The bound on the definition-preload pass, carried
 *   in the closure beside `contractRegistryCache` rather than in the machine's
 *   context: it is a *runner* option (`RunWorkflowOptions.preflightTimeoutMs`),
 *   not part of the run's identity, and nothing but `startActor` reads it.
 *   `undefined` takes `DEFAULT_PREFLIGHT_TIMEOUT_MS`; `0` disables the bound.
 */
export const createWorkflowMachine = (
  boxStoreLmdb: BoxStoreLmdb,
  contractRegistryCache: ContractRegistryCache,
  preflightTimeoutMs?: number | undefined,
) => {
  return machineSetup.createMachine({
    context: ({ input }): MachineContext => {
      // The flat and `{ params, execution }` shapes are disjoint, so
      // reinterpreting the input requires going through `unknown`.
      const legacyInput = input as unknown as LegacyMachineInput;
      const params = input.params ?? {
        runId: legacyInput.runId,
        workflow: legacyInput.workflow,
        workspace: legacyInput.workspace,
      };
      const executionRaw = input.execution ?? legacyInput.stepState ?? {
        todoStep: legacyInput.todoStep ?? { index: 0 },
        doneStep: legacyInput.doneStep,
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
                preflightTimeoutMs,
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
