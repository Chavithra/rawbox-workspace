import { ok, err, type Result } from 'neverthrow';
import { type Box, type WriteBoxLocation, type ReadBoxLocation, type BoxLocation } from './box.js';

/**
 * Combines box location structures with their corresponding contents
 * from a lookup record to build fully populated {@link Box} objects by matching
 * each `BoxLocation.key` against the record's keys.
 */
export function buildBoxRecord<TValue>(
  boxLocationRecord: Record<string, WriteBoxLocation | ReadBoxLocation>,
  lookupRecord: Record<string, TValue>,
  workflow: string,
  workspace: string,
): Result<Record<string, Box<TValue>>, string> {
  const boxRecord: Record<string, Box<TValue>> = {};

  for (const [field, boxLocation] of Object.entries(boxLocationRecord)) {
    if (!Object.prototype.hasOwnProperty.call(lookupRecord, field)) {
      return err(`Field ${field} not found in the values record`);
    }

    const content = lookupRecord[field] as TValue;

    // Resolve fully-qualified BoxLocation at runtime
    const resolvedLocation: BoxLocation = {
      key: boxLocation.key,
      workflow: ('workflow' in boxLocation && boxLocation.workflow) ? boxLocation.workflow : workflow,
      workspace,
      strategy: boxLocation.strategy,
    };

    boxRecord[field] = {
      content,
      location: resolvedLocation,
    };
  }

  return ok(boxRecord);
}

/**
 * Builds a record mapping names to their respective box contents.
 */
export function buildRecord(
  boxLocationRecord: Record<string, WriteBoxLocation | ReadBoxLocation>,
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
