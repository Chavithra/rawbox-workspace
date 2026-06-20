import { err, ok, Result } from 'neverthrow';
import type { ContractRegistryCache } from './contract-registry-cache.js';
import type { DefinitionLocation } from '../definition/definition-types.js';
import type { OperationContract } from '../../operation/contract/operation-contract-types.js';
import type { ControlFlowContract } from '../../control-flow/contract/control-flow-contract-types.js';

/**
 * Dynamically retrieves a contract registry from cache and extracts the contract associated with the definition path.
 */
export async function loadContract(
  definitionLocation: DefinitionLocation,
  contractRegistryCache: ContractRegistryCache,
): Promise<Result<OperationContract | ControlFlowContract, string>> {
  const registryResult = await contractRegistryCache.getOrLoadContractRegistry(
    definitionLocation.contractRegistryPath,
  );
  if (registryResult.isErr()) {
    return err(`Failed to load registry: ${registryResult.error}`);
  }

  const registry = registryResult.value;
  const contract = registry.contractRecord[definitionLocation.definitionPath];
  if (!contract) {
    return err(`Contract not found in registry: ${definitionLocation.definitionPath}`);
  }

  if (contract.type === 'operation' || contract.type === 'control-flow') {
    return ok(contract as OperationContract | ControlFlowContract);
  }

  return err(`Unknown contract type: ${contract.type}`);
}
