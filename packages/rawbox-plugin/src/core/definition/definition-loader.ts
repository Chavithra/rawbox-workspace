import { err, Result } from 'neverthrow';
import type { ContractRegistryCache } from '../contracts/contract-registry-cache.js';
import type { DefinitionLocation } from './definition-types.js';
import {
  loadOperationDefinition,
} from '../../operation/definition/operation-definition-cache.js';
import {
  loadControlFlowDefinition,
} from '../../control-flow/definition/control-flow-definition-cache.js';

type ExtractOk<T> = T extends Result<infer OkType, unknown> ? OkType : never;

export type LoadedOperationDefinition = ExtractOk<Awaited<ReturnType<typeof loadOperationDefinition>>>;
export type LoadedControlFlowDefinition = ExtractOk<Awaited<ReturnType<typeof loadControlFlowDefinition>>>;

/**
 * Dynamically loads a definition (either operation or control-flow) based on the contract registry type.
 */
export async function loadDefinition(
  definitionLocation: DefinitionLocation,
  contractRegistryCache: ContractRegistryCache,
): Promise<Result<LoadedOperationDefinition | LoadedControlFlowDefinition, string>> {
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

  if (contract.type === 'operation') {
    return await loadOperationDefinition(definitionLocation);
  }

  if (contract.type === 'control-flow') {
    return await loadControlFlowDefinition(definitionLocation);
  }

  return err(`Unknown contract type: ${contract.type}`);
}
