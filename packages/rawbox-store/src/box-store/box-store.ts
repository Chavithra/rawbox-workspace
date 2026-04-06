import type { Result } from 'neverthrow';

import { type Box, type BoxEmpty } from '../box.js';

export interface BoxStore {
  get(boxEmpty: BoxEmpty): Promise<Result<any, string>>;
  put(box: Box<any>): Promise<Result<void, string>>;
}

// export interface BoxStore<TValue> {
//   /**
//    * Sets multiple key-value pairs in the store.
//    * @param boxList - A list of Boxes to set.
//    * @returns A Promise resolving to a list of Results indicating success or failure for each box.
//    */
//   setMany(boxList: Box<TValue>[]): Promise<Result<Box<TValue>, string>[]>;

//   /**
//    * Retrieves multiple values from the store based on a list of locations.
//    * @param boxLocationList - A list of BoxLocations to retrieve.
//    * @returns A Promise resolving to a list of Results containing the retrieved Boxes or error messages.
//    */
//   getMany(
//     boxLocationList: BoxLocation[],
//   ): Promise<Result<Box<TValue>, string>[]>;

//   /**
//    * Deletes multiple key-value pairs from the store.
//    * @param boxLocationList - A list of BoxLocations to delete.
//    * @returns A Promise resolving to a list of Results indicating success (with the location) or failure for each key.
//    */
//   deleteMany(
//     boxLocationList: BoxLocation[],
//   ): Promise<Result<BoxLocation, string>[]>;
// }
