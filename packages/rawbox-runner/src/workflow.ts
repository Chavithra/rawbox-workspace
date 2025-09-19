import { Type, type Static, type TSchema } from "@sinclair/typebox";

export const StepLabel = Type.Optional(Type.String());

export type StepLabel = Static<typeof StepLabel>;

export interface Item<T extends TSchema> {
  data: Static<T>;
  schema: T;
}

export const Identifiable = Type.Object({
  alias: Type.String(),
  id: Type.String(),
});

export type Identifiable = Static<typeof Identifiable>;

export const BoxLocation = Type.Object({
  env: Identifiable,
  dbi: Identifiable,
  key: Identifiable,
});
export type BoxLocation = Static<typeof BoxLocation>;

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

export interface Workflow {
  alias: string;
  description: string;
  id: string;
  stepList: Step[];
  workspaceId: string;
}
