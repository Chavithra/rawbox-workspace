import { type Static, Type } from 'typebox';

export const DefinitionPath = Type.String();
export type DefinitionPath = Static<typeof DefinitionPath>;

export const ContractRegistryPath = Type.String();
export type ContractRegistryPath = Static<typeof DefinitionPath>;

export interface Contract {
  type: string;
}

export type ContractRecord<TContract extends Contract> = Record<
  DefinitionPath,
  TContract
>;

export interface ContractRegistry<TContract extends Contract> {
  contractRecord: ContractRecord<TContract>;
  contractRegistryPath: ContractRegistryPath;
  rawboxPluginVersion: string;
}

export type SpecificContractRegistry<
  TContractRecord extends ContractRecord<Contract>,
> = ContractRegistry<TContractRecord[keyof TContractRecord]> & {
  contractRecord: TContractRecord;
};
