import { Type, type Static } from '@sinclair/typebox';

import { BoxLocation, Box } from 'rawbox-store';

export const BoxLocationRecord = Type.Record(Type.String(), BoxLocation);

export const DefinitionLocation = Type.Object({
  contractsRegistryPath: Type.String(),
  definitionPath: Type.String(),
});

export type DefinitionLocation = Static<typeof DefinitionLocation>;

export type BoxLocationRecord = Static<typeof BoxLocationRecord>;

export const Step = Type.Object({
  definitionLocation: DefinitionLocation,
  errorLocationRecord: BoxLocationRecord,
  inputLocationRecord: BoxLocationRecord,
  outputLocationRecord: BoxLocationRecord,
  stepLabel: Type.Optional(Type.String()),
});

export type Step = Static<typeof Step>;

export const BoxRecord = Type.Record(Type.String(), Box(Type.Uint8Array()));
export type BoxRecord = Static<typeof BoxRecord>;

export const StepOutput = Type.Object({
  errorBoxRecord: BoxRecord,
  inputBoxRecord: BoxRecord,
  outputBoxRecord: BoxRecord,
});

export type StepOutput = Static<typeof StepOutput>;
