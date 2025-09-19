import type { Result } from "neverthrow";

import type { Identifiable } from "./identifiable.js";

export interface BoxLocation {
  readonly env: Identifiable;
  readonly dbi: Identifiable;
  readonly key: Identifiable;
}

export interface Box<TValue> {
  readonly content: TValue;
  readonly location: BoxLocation;
}

export interface BoxStore<TValue> {
  /**
   * Sets multiple key-value pairs in the store.
   * @param storageMap - A StorageMap containing StorageKey-Buffer pairs to set.
   * @returns A StorageMap indicating success (true) or failure (false) for each key.
   */
  setMany(itemList: Box<TValue>[]): Promise<Result<Box<TValue>, string>[]>;

  /**
   * Retrieves multiple values from the store based on a list of StorageKeys.
   * @param storageKeyList - A list of StorageKeys to retrieve.
   * @returns A StorageMap containing the retrieved Buffer values, or undefined for keys not found.
   */
  getMany(
    storageKeyList: BoxLocation[]
  ): Promise<Result<Box<TValue>, string>[]>;

  /**
   * Deletes multiple key-value pairs from the store.
   * @param storageKeyList - A list of StorageKeys to delete.
   * @returns A StorageMap indicating success (true) or failure (false) for each key.
   */
  deleteMany(
    storageKeyList: BoxLocation[]
  ): Promise<Result<BoxLocation, string>[]>;
}
