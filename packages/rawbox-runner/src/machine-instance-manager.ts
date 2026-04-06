import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { TypeCompiler } from '@sinclair/typebox/compiler';

import { MachineInstanceMap } from './machine-instance-map.js';
import {
  type MachineInput,
  type MachineEvent,
  StopConfirmationEvent,
} from './machine-instance.js';

const StopConfirmationEventValidator = TypeCompiler.Compile(
  StopConfirmationEvent,
);

/**
 * MachineInstanceManager handles the lifecycle and indexing of Worker threads
 * that represent machine instances in the Rawbox runner.
 */
export class MachineInstanceManager {
  private readonly machineInstanceMap = new MachineInstanceMap();
  private readonly workerPath: URL;

  constructor(workerPath: URL) {
    this.workerPath = workerPath;
  }

  /**
   * Retrieves a managed worker by its UUID.
   */
  public getInstance(uuid: string): Worker | undefined {
    return this.machineInstanceMap.getInstance(uuid);
  }

  /**
   * Returns an array of all managed machine instance IDs.
   */
  public getAllInstanceIds(): string[] {
    return this.machineInstanceMap.getAllInstanceIds();
  }

  /**
   * The total count of managed machine instances.
   */
  public get size(): number {
    return this.machineInstanceMap.size;
  }

  /**
   * Spawns a new worker thread, initializes the state machine with a unique ID, and registers it.
   * @param params The initial context for the machine.
   * @returns The generated UUID for the new machine instance.
   */
  public startMachine(params: Omit<MachineInput, 'machineInstanceId'>): string {
    const machineInstanceId = randomUUID();
    const workerData: MachineInput = { ...params, machineInstanceId };

    const worker = new Worker(this.workerPath, { workerData });
    this.machineInstanceMap.addInstance(worker, machineInstanceId);

    return machineInstanceId;
  }

  /**
   * Orchestrates the graceful shutdown of a machine instance.
   * Sends a STOP event and waits for a 'DONE' confirmation message from the worker
   * before removing it from the managed map.
   *
   * @returns true if the instance was found and removed.
   */
  public async stopInstance(uuid: string): Promise<void> {
    const worker = this.machineInstanceMap.getInstance(uuid);
    if (!worker) {
      throw new Error(`Cannot stop instance "${uuid}": Instance not found.`);
    }

    return new Promise((resolve) => {
      const onMessage = (event: unknown) => {
        if (StopConfirmationEventValidator.Check(event)) {
          if (event.machineInstanceId == uuid) {
            worker.off('message', onMessage);
            this.machineInstanceMap.removeInstance(uuid);
          }
          resolve();
        } else {
          throw new Error(`Received invalid event from main thread: {event}`);
        }
      };

      worker.on('message', onMessage);
      const stopEvent: MachineEvent = { type: 'STOP' };
      worker.postMessage(stopEvent);
    });
  }
}
