import { Type, type Static } from 'typebox';

import { Box, BoxLocationRecord } from 'rawbox-store';
import { Uint8Array } from './uint8array.js';
import { DefinitionLocation } from 'rawbox-plugin/core';

export { BoxLocationRecord, DefinitionLocation };


export const Step = Type.Object({
  definitionLocation: DefinitionLocation,
  errorBoxLocationRecord: BoxLocationRecord,
  inputBoxLocationRecord: BoxLocationRecord,
  outputBoxLocationRecord: BoxLocationRecord,
  stepLabel: Type.Optional(Type.String()),
});

export type Step = Static<typeof Step>;

export const BoxRecord = Type.Record(Type.String(), Box(Uint8Array()));
export type BoxRecord = Static<typeof BoxRecord>;
