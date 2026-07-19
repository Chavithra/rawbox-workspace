import { ok, err, type Result } from 'neverthrow';

import type {
  Contract,
  ContractRegistry,
  ContractRegistryPath,
} from './contract-registry-types.js';

export class ContractRegistryLoader {
  /**
   * Dynamically imports a ContractRegistry from a given file path and validates its structure.
   * @param contractRegistryPath - The file path to the registry module.
   * @returns A promise resolving to a Result containing the registry on success, or an error string on failure.
   */
  public static async loadContractRegistry(
    contractRegistryPath: ContractRegistryPath,
  ): Promise<Result<ContractRegistry<Contract>, string>> {
    let result: Result<ContractRegistry<Contract>, string>;

    try {
      const module = await import(contractRegistryPath);
      const registry = module.default;

      if (
        registry &&
        typeof registry === 'object' &&
        'contractRecord' in registry &&
        typeof registry.contractRecord === 'object' &&
        'contractRegistryPath' in registry &&
        typeof registry.contractRegistryPath === 'string'
      ) {
        result = ok(registry as ContractRegistry<Contract>);
      } else {
        result = err(
          `Module at '${contractRegistryPath}' does not have a default export that is an instance of ContractRegistry.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = err(
        `Failed to load registry from '${contractRegistryPath}': ${message}`,
      );
    }

    return result;
  }
}

