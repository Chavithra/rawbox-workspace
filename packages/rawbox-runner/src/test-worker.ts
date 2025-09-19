import { Worker } from "node:worker_threads";

import {
  setup,
  createActor,
  assign,
  fromCallback,
  ActorRefFromLogic,
  CallbackActorLogic,
  NonReducibleUnknown,
  EventObject,
} from "xstate";
import { LmdbBoxEnvCache, LmdbBoxStore } from "rawbox-store/lmdb-box-store";

import type { WorkerData } from "./workflow-worker.js";
import { workflow } from "./workflow-data.js";
import { Box, BoxLocation } from "rawbox-store";
import { Workflow } from "./workflow.js";

type AgentWorkerBridgeEvent =
  | {
      type: "STORE_GET_MANY_RESPONSE";
      boxList: Box<Uint8Array>[];
      workflowId: string;
    }
  | {
      type: "STORE_PUT_MANY_RESPONSE";
    };

type MachineEvent =
  | {
      type: "START_WORFKLOW";
      workflow: Workflow;
    }
  | {
      type: "STOP_WORFKLOW";
      workflowIdentifier: string;
    }
  | {
      type: "TERMINATE_WORKFLOW";
      workflowIdentifier: string;
    }
  | {
      type: "STORE_GET_MANY";
      boxLocationList: BoxLocation[];
      workflowId: string;
    }
  | {
      type: "STORE_PUT_MANY";
      box: Box<Uint8Array>[];
      workflowId: string;
    };

interface MachineContext {
  workflowWorkerBridgeMap: Map<
    string,
    ActorRefFromLogic<
      CallbackActorLogic<
        AgentWorkerBridgeEvent,
        NonReducibleUnknown,
        EventObject
      >
    >
  >;
}

function buildLmdbBoxStore(): LmdbBoxStore<Uint8Array> {
  const folderPath =
    "/home/dtp2/code/javascript/real/rawbox-workspace/packages/data";
  const boxEnvCache = new LmdbBoxEnvCache<Uint8Array>(folderPath);
  const boxStore = new LmdbBoxStore<Uint8Array>(boxEnvCache);

  return boxStore;
}

function buildWorker(): Worker {
  const currentPath = import.meta.url;
  const workerPath = new URL("./workflow-worker.js", currentPath);
  const workerData: WorkerData = { workflow };
  const worker = new Worker(workerPath, { workerData });
  return worker;
}

const lmdbBoxStore = buildLmdbBoxStore();

const machine = setup({
  actors: {
    workflowBridgeActorLogic: fromCallback(({ sendBack, receive }) => {
      const worker = buildWorker();

      worker.on("message", (msg) => {
        sendBack(msg);
      });

      receive((event) => {
        worker.postMessage(event);
      });

      return () => {
        worker.terminate();
      };
    }),
  },
  actions: {
    storeGetManyActionFunction: async ({ context, event }) => {
      if (event.type === "STORE_GET_MANY") {
        const { boxLocationList, workflowId } = event;
        const resultOfGetMany = await lmdbBoxStore.getMany(boxLocationList);
        const boxList = resultOfGetMany
          .filter((result) => result.isOk())
          .map((result) => result.value);
        const workflowWorkerBridge =
          context.workflowWorkerBridgeMap.get(workflowId);

        if (workflowWorkerBridge) {
          workflowWorkerBridge.send({
            type: "STORE_GET_MANY_RESPONSE",
            boxList,
            workflowId,
          });
        }
      }
    },
    storePutManyActionFunction: async ({ context, event }) => {
      if (event.type === "STORE_PUT_MANY") {
        const { box, workflowId } = event;
        await lmdbBoxStore.setMany(box);

        const workflowWorkerBridge =
          context.workflowWorkerBridgeMap.get(workflowId);
        if (workflowWorkerBridge) {
          workflowWorkerBridge.send({ type: "STORE_PUT_MANY_RESPONSE" });
        }
      }
    },
  },
  types: {
    events: {} as MachineEvent,
    context: {} as MachineContext,
  },
}).createMachine({
  id: "workflowOrchestrator",
  initial: "running",
  context: { workflowWorkerBridgeMap: new Map() },
  states: {
    running: {
      on: {
        START_WORFKLOW: {
          actions: assign({
            workflowWorkerBridgeMap: ({ context, event, spawn }) => {
              const workflowId = event.workflow.id;
              const workflowActor = spawn("workflowBridgeActorLogic", {
                input: event.workflow,
              });
              const newMap = new Map(context.workflowWorkerBridgeMap);
              newMap.set(workflowId, workflowActor);
              return newMap;
            },
          }),
        },
        STORE_GET_MANY: {
          actions: "storeGetManyActionFunction",
        },
        STORE_PUT_MANY: {
          actions: "storePutManyActionFunction",
        },
      },
    },
  },
});

const actor = createActor(machine);
actor.subscribe((snapshot) => {
  console.log(snapshot.context);
});

actor.start();

actor.send({ type: "START_WORFKLOW", workflow });

// worker.on("message", async (event) => {
//   console.log("MAIN:", JSON.stringify(event, null, 2));

//   const { type } = event;

//   switch (type) {
//     case "STORE_GET_MANY":
//       const { boxLocationList } = event;
//       const resultOfGetMany = await lmdbBoxStore.getMany(boxLocationList);
//       const boxList = resultOfGetMany
//         .filter((result) => result.isOk())
//         .map((result) => result.value);
//       worker.postMessage({
//         type: "STORE_GET_MANY_RESPONSE",
//         boxList,
//       });
//       break;
//     default:
//       console.warn(
//         "Main thread received unknown message from worker:",
//         event.data
//       );
//   }
// });

// worker.on("exit", (code) => {
//   if (code !== 0) {
//     console.error(`Worker stopped with exit code ${code}`);
//   } else {
//     console.log("Worker exited successfully.");
//   }
// });
