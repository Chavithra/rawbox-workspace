import { decode, encode } from "msgpackr";
import { Box, BoxLocation } from "rawbox-store";

import type { Item } from "./workflow.js";

export function decodeBoxList<Uint8Array>(
  boxList: Box<Uint8Array>[]
): Box<Item<any>>[] {
  // MSGPACKR.DECODE SHOULD ALLOW UINT8ARRAY
  // BUT EXPECT A UINT8ARRAY<ARRAYBUFFERLIKE>
  // IS TYPESCRIPT COMPLAINING FOR NO REASON?
  // USING BUFFER TYPE HINT BUT IT'S A UINT8ARRAY

  return boxList.map((box) => ({
    content: decode(box.content as Buffer),
    location: box.location,
  }));
}

export function boxLocationToLookupKey(location: BoxLocation): string {
  return `${location.env.id}:${location.dbi.id}:${location.key.id}`;
}

export function boxListToObject(
  boxList: Box<Item<any>>[],
  boxLocationRecord: Record<string, BoxLocation>
): Record<string, any> {
  const result: Record<string, any> = {};
  const boxMap = new Map(
    boxList.map((box) => [boxLocationToLookupKey(box.location), box])
  );

  for (const [recordKey, recordBoxLocation] of Object.entries(
    boxLocationRecord
  )) {
    const boxLocationKey = boxLocationToLookupKey(recordBoxLocation);
    const box = boxMap.get(boxLocationKey);

    if (box) {
      result[recordKey] = box.content.data;
    }
  }

  return result;
}

export function encodeBoxList(boxList: Box<Item<any>>[]): Box<Uint8Array>[] {
  return boxList.map((box) => {
    const contentBuffer = encode(box.content);
    const contentUint8Array = new Uint8Array(
      contentBuffer.buffer,
      contentBuffer.byteOffset,
      contentBuffer.byteLength
    );

    const newBox: Box<Uint8Array> = {
      content: contentUint8Array,
      location: box.location,
    };

    return newBox;
  });
}
