import type { DefinitionPath } from "./definition.js";

export type ContractsRegistryPath = string;

export interface Contract {
  type: string;
}

export type ContractsRecord<T extends Contract> = Record<DefinitionPath, T>;

export interface ContractsRegistry<TContract extends Contract> {
  contractsRecord: ContractsRecord<TContract>;
  contractsRegistryPath: ContractsRegistryPath;
}
