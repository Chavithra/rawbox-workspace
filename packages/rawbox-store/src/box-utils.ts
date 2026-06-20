import { ok, err, type Result } from 'neverthrow';

import { type Box, type BoxLocation, type BoxLocationRecord } from './box.js';

/**
 * Combines box location structures within a {@link BoxLocationRecord} with their corresponding contents
 * from a lookup record to build fully populated {@link Box} objects by matching
 * each `BoxLocation.key` against the record's keys.
 *
 * If any box location has a key that does not exist in the `lookupMap` record, the operation
 * fails immediately and returns an `err` Result containing the error message.
 *
 * @example
 * ```typescript
 * const boxLocationRecord = { input: { key: 1, workflow: 'wf', workspace: 'ws', strategy } };
 * const lookupMap = { 1: "my-data" };
 * const result = buildBoxRecord(boxLocationRecord, lookupMap);
 * if (result.isOk()) {
 *   console.log(result.value);
 *   // { input: { content: "my-data", location: { key: 1, ... } } }
 * }
 * ```
 *
 * @template TValue - The type of content stored in the boxes.
 * @param boxLocationRecord - A record of box locations to populate.
 * @param lookupRecord - A record mapping location keys to their respective contents.
 * @returns A {@link Result} representing success (holding the populated boxes record) or failure (holding an error string).
 */
export function buildBoxRecord<TValue>(
  boxLocationRecord: Readonly<BoxLocationRecord>,
  lookupRecord: Record<string, TValue>,
): Result<Record<string, Box<TValue>>, string> {
  const boxRecord: Record<string, Box<TValue>> = {};

  for (const [field, boxLocation] of Object.entries(boxLocationRecord)) {
    if (!Object.prototype.hasOwnProperty.call(lookupRecord, field)) {
      return err(`Field ${field} not found in the values record`);
    }

    const content = lookupRecord[field] as TValue;

    boxRecord[field] = {
      content,
      location: boxLocation,
    };
  }

  return ok(boxRecord);
}

/**
 * Builds a record mapping names to their respective box contents.
 *
 * @param boxLocationRecord - A record of box locations.
 * @param boxList - An array of boxes to extract content from.
 * @returns A record mapping names to the contents of the matched boxes.
 */
export function buildRecord(
  boxLocationRecord: Readonly<BoxLocationRecord>,
  boxList: ReadonlyArray<Box<unknown>>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};

  for (const [field, boxLocation] of Object.entries(boxLocationRecord)) {
    const box = boxList.find((b) => b.location.key === boxLocation.key);
    if (box !== undefined) {
      record[field] = box.content;
    }
  }

  return record;
}
