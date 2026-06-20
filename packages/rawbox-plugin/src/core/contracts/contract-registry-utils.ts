import type {
  Contract,
  ContractRecord,
  ContractRegistry,
  ContractRegistryPath,
  DefinitionPath,
  SpecificContractRegistry,
} from './contract-registry-types.js';
import { getCallerFilePath } from '../entries-utils.js';

export function setupContractRegistry<
  TContractRecord extends ContractRecord<Contract>,
>(
  options: {
    contractRecord: TContractRecord;
    contractRegistryPath?: ContractRegistryPath;
  },
  callerDepth: number = 2,
): SpecificContractRegistry<TContractRecord> {
  const { contractRecord, contractRegistryPath = getCallerFilePath(callerDepth) } =
    options;

  return {
    contractRecord,
    contractRegistryPath,
    rawboxPluginVersion: '1.0.0',
  } as SpecificContractRegistry<TContractRecord>;
}

export function getDefinitionPathList<TContract extends Contract>(
  contractRegistry: ContractRegistry<TContract>,
): DefinitionPath[] {
  return Object.keys(contractRegistry.contractRecord);
}
