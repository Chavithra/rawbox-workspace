import { MachineInstanceManager } from './machine-instance-manager.js';

const workerPath = new URL('./demo-worker.js', import.meta.url);
const manager = new MachineInstanceManager(workerPath);

// Encapsulated start: The manager handles ID generation and worker creation
const machineInstanceId = manager.startMachine({
  stepIndex: 0,
  stepList: [],
});

const worker = manager.getInstance(machineInstanceId);
if (!worker) {
  throw new Error(`Failed to start machine instance ${machineInstanceId}`);
}

console.log(`Started machine instance: ${machineInstanceId}`);
console.log(`Total managed instances: ${manager.size}`);

worker.on('message', (data) => {
  console.log(`[${machineInstanceId}] Received message from worker:`, data);
});

worker.on('exit', (code) => {
  console.log(`[${machineInstanceId}] Worker exited with code ${code}`);
});

// Encapsulated stop call that waits for confirmation
console.log(`[${machineInstanceId}] Requesting STOP...`);
await manager.stopInstance(machineInstanceId);
console.log(
  `[${machineInstanceId}] STOP confirmed and instance removed from manager.`,
);

setTimeout(() => {
  console.log(
    'Final check on managed instances (should be empty):',
    manager.getAllInstanceIds(),
  );
  process.exit(0);
}, 4000);
