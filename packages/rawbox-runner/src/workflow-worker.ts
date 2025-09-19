import { MessagePort, parentPort, workerData } from "node:worker_threads";

import {
  createActor,
  assign,
  fromPromise,
  setup,
  fromCallback,
  ActorRefFromLogic,
  CallbackActorLogic,
  NonReducibleUnknown,
  EventObject,
} from "xstate";
import { Box, BoxLocation } from "rawbox-store";
import { OperationDefinitionCache } from "rawbox-plugin/operation-definition-cache";

import { boxListToObject, decodeBoxList } from "./workflow-utils.js";
import type { Workflow, Step } from "./workflow.js";

export type OrchestratorBridgeEvent =
  | {
      type: "STORE_GET_MANY";
      boxLocationList: BoxLocation[];
      agentId: string;
    }
  | {
      type: "STORE_PUT_MANY";
      box: Box<Uint8Array>[];
    }
  | {
      type: "ORCHESTRATOR_BRIDGE_READY";
    };

export interface AgentState {
  errorObject: Record<string, unknown> | null;
  inputObject: Record<string, unknown> | null;
  outputObject: Record<string, unknown> | null;
  step: Step | null;
  stepIndex: number;
}

export interface WorkerData {
  workflow: Workflow;
}

type MachineEvent =
  | {
      type: "ORCHESTRATOR_BRIDGE_READY";
    }
  | {
      type: "RESTART";
    }
  | {
      type: "STOP";
    }
  | {
      type: "STORE_GET_MANY_RESPONSE";
      boxList: Box<Uint8Array>[];
    }
  | {
      type: "STORE_PUT_MANY_RESPONSE";
      boxList: Box<Uint8Array>[];
    }
  | {
      type: "OPERATION_OUTPUT_READY";
      boxList: Box<Uint8Array>[];
    };

interface MachineContext {
  workflow: Workflow;
  agentState: AgentState;
  orchestratorBridge: ActorRefFromLogic<
    CallbackActorLogic<
      OrchestratorBridgeEvent,
      NonReducibleUnknown,
      EventObject
    >
  > | null;
}

const agentWorkerMachineFactory = (
  workflow: Workflow,
  messagePort: MessagePort,
  operationDefinitionCache: OperationDefinitionCache
) => {
  return setup({
    actors: {
      orchestratorBridgeActorLogic: fromCallback(({ sendBack, receive }) => {
        console.log(`WORKER:BRIDGE:`);
        messagePort!.on("message", (msg) => {
          sendBack(msg);
        });

        receive((event) => {
          messagePort!.postMessage(event);
        });

        sendBack({ type: "ORCHESTRATOR_BRIDGE_READY" });

        return () => {
          messagePort?.removeAllListeners("message");
        };
      }),
      operationActorLogic: fromPromise(
        async ({ input }: { input: { step: Step; inputObject: object } }) => {
          const { inputObject, step } = input;
          const { definitionLocation } = step;

          const resultOrgetOrLoadOperationImplementation =
            await operationDefinitionCache.getOrLoadDefinition(
              definitionLocation
            );
          if (resultOrgetOrLoadOperationImplementation.isOk()) {
            const operation = resultOrgetOrLoadOperationImplementation.value;

            const resultOfGetWrappedHandler = await operation.validatedHandler(
              inputObject
            );
            if (resultOfGetWrappedHandler.isOk()) {
              console.log(resultOfGetWrappedHandler.value);
              return resultOfGetWrappedHandler.value;
            } else {
              throw Error("Operation failed: " + JSON.stringify(input));
            }
          } else {
            console.log(resultOrgetOrLoadOperationImplementation.error);
            throw Error("Operation failed: " + JSON.stringify(input));
          }
        }
      ),
    },
    actions: {
      setupAgentState: assign({
        agentState: ({ context }) => {
          const { workflow, agentState } = context;
          const { stepList } = workflow;
          const { stepIndex } = agentState;
          const step = stepList[stepIndex];

          const newAgentState = {
            errorObject: null,
            inputObject: null,
            outputObject: null,
            step,
            stepIndex,
          };

          return newAgentState;
        },
      }),
      getOperationInput: ({ context }) => {
        const { agentState, orchestratorBridge } = context;

        const step = agentState.step!;
        const inputLocationRecord = step.inputLocationRecord;
        const boxLocationList = Object.values(inputLocationRecord);
        const agentId = workflow.id;

        orchestratorBridge!.send({
          type: "STORE_GET_MANY",
          boxLocationList,
          agentId,
        });
      },
      // putOutput: ({ context }) => {
      //   const { agentState, orchestratorBridge } = context;

      //   const step = agentState.step!;
      //   const inputLocationRecord = step.inputLocationRecord;
      //   const boxLocationList = Object.values(inputLocationRecord);

      //   orchestratorBridge!.send({
      //     type: "STORE_GET_MANY",
      //     boxLocationList,
      //   });
      // },
      processOperationInput: assign({
        agentState: ({ context, event }) => {
          console.log("PROCESSINPUT");
          const { agentState } = context;
          const { step } = agentState;
          const { inputLocationRecord } = step!;

          let input;
          if ("boxList" in event) {
            console.log(event);
            const boxItemList = decodeBoxList(event.boxList);
            input = boxListToObject(boxItemList, inputLocationRecord);
          } else {
            throw Error("Invalid event");
          }

          return {
            ...agentState,
            inputObject: input,
          };
        },
      }),
      processOperationOutput: assign({
        agentState: ({ context, event }) => {
          if ("output" in event) {
            const newAgentState = {
              ...context.agentState,
              outputObject: event.output as Record<string, unknown>,
            };

            return newAgentState;
          } else {
            throw Error("Invalid event");
          }
        },
      }),
      processOperationError: ({ event }) => {
        console.log(event);
        console.log("ERROR");
      },
      exitAgentWorker: () => {
        process.exit(0);
      },
    },
    types: {
      events: {} as MachineEvent,
      context: {} as MachineContext,
    },
  }).createMachine({
    id: "agentWorkerMachine",
    initial: "settingOrchestratorBridge",
    context: {
      workflow: workflow,
      agentState: {
        errorObject: null,
        inputObject: null,
        outputObject: null,
        step: workflow.stepList[0],
        stepIndex: 0,
      },
      orchestratorBridge: null,
    },
    states: {
      settingOrchestratorBridge: {
        entry: [
          assign(({ spawn }) => ({
            orchestratorBridge: spawn("orchestratorBridgeActorLogic"),
          })),
        ],
        on: {
          ORCHESTRATOR_BRIDGE_READY: "prepareOperation",
        },
      },
      prepareOperation: {
        entry: ["setupAgentState", "getOperationInput"],
        on: {
          STORE_GET_MANY_RESPONSE: {
            target: "runningOperation",
            actions: "processOperationInput",
          },
        },
      },
      runningOperation: {
        invoke: {
          src: "operationActorLogic",
          input: ({ context }) => ({
            inputObject: context.agentState.inputObject!,
            step: context.agentState.step!,
          }),
          onDone: {
            target: "stopping",
            actions: "processOperationOutput",
          },
          onError: {
            target: "failure",
            actions: "processOperationError",
          },
        },
      },
      // saveOutput: {
      //   entry: "putOperationOutput",
      //   on: {
      //     STORE_PUT_MANY_RESPONSE: {
      //       target: "success",
      //       actions: "processOperationInput",
      //     },
      //   },
      // },
      loadingNextRunInfo: {
        type: "final",
        // always: {
        //   target: "prepareOperation",
        //   actions: "loadNext",
        // },
        // entry: "exitWorker",
      },
      stopping: {
        type: "final",
        entry: "exitAgentWorker",
      },
      failure: {
        type: "final",
        entry: "exitAgentWorker",
      },
    },
  });
};

function runAgentWorkerMachine(
  workflow: Workflow,
  messagePort: MessagePort,
  operationDefinitionCache: OperationDefinitionCache
) {
  const agentWorkerMachine = agentWorkerMachineFactory(
    workflow,
    messagePort,
    operationDefinitionCache
  );
  const agentWorkerActor = createActor(agentWorkerMachine);

  agentWorkerActor.subscribe((snapshot) => {
    console.log(`WORKER:STATUS:`, snapshot.value);
    console.log(`WORKER:AGENT_STATE:`, snapshot.context.agentState);
  });

  agentWorkerActor.start();
}

function runAgentWorker(
  messagePort: MessagePort | null,
  operationDefinitionCache: OperationDefinitionCache,
  workerData: WorkerData
) {
  if (messagePort) {
    if (workerData && "workflow" in workerData) {
      const { workflow } = workerData;

      runAgentWorkerMachine(workflow, messagePort, operationDefinitionCache);
    } else {
      throw new Error("Invalid Workdata");
    }
  } else {
    throw new Error("'parentPort' is null !.");
  }
}

const operationDefinitionCache = new OperationDefinitionCache();
const messagePort = parentPort;
runAgentWorker(messagePort, operationDefinitionCache, workerData);
