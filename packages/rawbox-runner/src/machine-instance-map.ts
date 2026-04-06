import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

/**
 * Low-level storage for Machine instances.
 */
export class MachineInstanceMap {
  private readonly map = new Map<string, Worker>();

  /**
   * Adds a worker instance to the manager and assigns it a unique ID.
   * @param worker The Node.js Worker thread to manage.
   * @param uuid Optional specific UUID. If not provided, a random one is generated.
   * @returns The UUID assigned to the worker.
   * @throws Error if the UUID is already in use.
   */
  public addInstance(worker: Worker, uuid?: string): string {
    const id = uuid ?? randomUUID();

    if (this.map.has(id)) {
      throw new Error(`Machine instance with UUID "${id}" already exists.`);
    }

    this.map.set(id, worker);
    return id;
  }

  /**
   * Retrieves a managed worker by its UUID.
   */
  public getInstance(uuid: string): Worker | undefined {
    return this.map.get(uuid);
  }

  /**
   * Removes a worker from the manager.
   * Note: This only removes the reference from the map; it does not stop the worker.
   * @returns true if the instance was found and removed.
   */
  public removeInstance(uuid: string): boolean {
    return this.map.delete(uuid);
  }

  /**
   * Returns an array of all managed machine instance IDs.
   */
  public getAllInstanceIds(): string[] {
    return Array.from(this.map.keys());
  }

  /**
   * The total count of managed machine instances.
   */
  public get size(): number {
    return this.map.size;
  }
}
