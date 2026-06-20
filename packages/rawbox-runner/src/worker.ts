// import { parentPort, workerData } from 'node:worker_threads';

// import { TypeCompiler } from 'typebox/compile';
// import { createActor } from 'xstate';
// import Type from 'typebox';

// if (!parentPort) {
//   throw new Error(
//     'parentPort is null. This script must be run as a worker thread.',
//   );
// }

// export const StopConfirmationEvent = Type.Object({
//   type: Type.Literal('STOP_CONFIRMATION'),
//   instanceId: Type.String(),
// });

// export type StopConfirmationEvent = Static<typeof StopConfirmationEvent>;

// const StopConfirmationEventValidator = TypeCompiler.Compile(
//   StopConfirmationEvent,
// );

// const MachineEventValidator = TypeCompiler.Compile(MachineEvent);

// const input = workerData as MachineInput;

// const actor = createActor(machine, { input });

// actor.start();

// actor.on('done', (_event) => {
//   console.log('Machine reached a final state');
//   const stopConfirmationEvent: StopConfirmationEvent = {
//     type: 'STOP_CONFIRMATION',
//     machineInstanceId: input.machineInstanceId,
//   };
//   parentPort!.postMessage(stopConfirmationEvent);
//   process.exit(0);
// });

// actor.subscribe((state) => {
//   console.log('Current state', state);
// });

// parentPort.on('message', (event: unknown) => {
//   if (MachineEventValidator.Check(event)) {
//     actor.send(event);
//   } else {
//     throw new Error(`Received invalid event from main thread:{event}`);
//   }
// });
