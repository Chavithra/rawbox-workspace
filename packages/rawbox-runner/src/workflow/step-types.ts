import { Type, type Static } from 'typebox';

import { Box, WriteBoxLocation, ReadBoxLocation } from 'rawbox-store';
import { Uint8Array } from './uint8array.js';
import { DefinitionLocation } from 'rawbox-plugin/core';

export { DefinitionLocation };

export const StorageLocation = Type.Object({
  error: Type.Record(Type.String(), WriteBoxLocation),
  input: Type.Record(Type.String(), ReadBoxLocation),
  output: Type.Record(Type.String(), WriteBoxLocation),
});
export type StorageLocation = Static<typeof StorageLocation>;

export const Step = Type.Object({
  definitionLocation: DefinitionLocation,
  storageLocation: StorageLocation,
  label: Type.Optional(Type.String()),
});

export type Step = Static<typeof Step>;

export const BoxRecord = Type.Record(Type.String(), Box(Uint8Array()));
export type BoxRecord = Static<typeof BoxRecord>;
