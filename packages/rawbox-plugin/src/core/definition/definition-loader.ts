import { err, type Result } from 'neverthrow';
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
  let registry = contractRegistryCache.getContractRegistry(
    definitionLocation.contractRegistryHash,
  );
  if (!registry) {
    return err(
      `Registry with hash "${definitionLocation.contractRegistryHash}" is not loaded in the cache. Make sure the plugin is registered/loaded in your workspace config.`,
    );
  }
  const contract = registry.contractRecord[definitionLocation.definitionPath];
  if (!contract) {
    return err(`Contract not found in registry: ${definitionLocation.definitionPath}`);
  }

  if (contract.type === 'operation') {
    return await loadOperationDefinition({
      contractRegistryHash: registry.contractRegistryPath,
      definitionPath: definitionLocation.definitionPath,
    });
  }

  if (contract.type === 'control-flow') {
    return await loadControlFlowDefinition({
      contractRegistryHash: registry.contractRegistryPath,
      definitionPath: definitionLocation.definitionPath,
    });
  }

  return err(`Unknown contract type: ${contract.type}`);
}
