import type {
  Contract,
  ContractsRecord,
  ContractsRegistry,
  ContractsRegistryPath,
} from "./contracts-registry.js";
import { getCallerFilePath } from "./entries-utils.js";

export function exportSetupContractsRegistry<TContract extends Contract>() {
  return function setupRegistry<
    const TContractsRecord extends ContractsRecord<TContract>
  >(options: {
    contractsRecord: TContractsRecord;
    contractsRegistryPath?: ContractsRegistryPath;
  }): ContractsRegistry<TContract> & { contractsRecord: TContractsRecord } {
    const { contractsRecord, contractsRegistryPath = getCallerFilePath() } =
      options;

    return {
      contractsRecord,
      contractsRegistryPath,
    };
  };
}

export function getDefinitionPathList<TContract extends Contract>(
  contractsRegistry: ContractsRegistry<TContract>
): string[] {
  return Object.keys(contractsRegistry.contractsRecord);
}
