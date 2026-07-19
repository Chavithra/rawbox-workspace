import crypto from 'node:crypto';

import type {
  Contract,
  ContractRegistry,
} from './contract-registry-types.js';
import type { DefinitionLocation } from '../definition/definition-types.js';

export class ContractRegistryCache {
  /**
   * Creates an instance of ContractRegistryCache.
   * @param registryMap - A map to store loaded registries, keyed by their SHA-256 content-hash.
   */
  public constructor(
    protected readonly registryMap: Map<
      string,
      ContractRegistry<Contract>
    > = new Map<string, ContractRegistry<Contract>>(),
  ) {}

  /**
   * Computes a stable, deterministic SHA-256 hash for a registry based on its sorted contractRecord keys.
   * @param contractRegistry - The registry to hash.
   * @returns A 64-character SHA-256 hex string.
   */
  public static computeHash(
    contractRegistry: ContractRegistry<Contract>,
  ): string {
    const sortedRecord: Record<string, Contract> = {};
    const sortedKeys = Object.keys(contractRegistry.contractRecord).sort();
    for (const key of sortedKeys) {
      sortedRecord[key] = contractRegistry.contractRecord[key]!;
    }
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(sortedRecord))
      .digest('hex');
  }

  /**
   * Adds a ContractRegistry instance to the cache, keying it by the SHA-256 hash of its contractRecord.
   * @param contractRegistry - The ContractRegistry instance to add.
   * @returns The computed SHA-256 hash key.
   */
  public addContractRegistry(
    contractRegistry: ContractRegistry<Contract>,
  ): string {
    const hash = ContractRegistryCache.computeHash(contractRegistry);
    this.registryMap.set(hash, contractRegistry);
    return hash;
  }

  /**
   * Adds multiple ContractRegistry instances to the cache.
   * @param contractRegistries - An array of ContractRegistry instances to add.
   * @returns An array of computed SHA-256 hash keys in the same order.
   */
  public addContractRegistries(
    contractRegistries: ContractRegistry<Contract>[],
  ): string[] {
    return contractRegistries.map((registry) =>
      this.addContractRegistry(registry),
    );
  }

  /**
   * Retrieves a ContractRegistry instance from the cache by its SHA-256 hash.
   * @param hash - The SHA-256 hash of the registry to retrieve.
   * @returns The ContractRegistry instance if found, otherwise undefined.
   */
  public getContractRegistry<TContract extends Contract>(
    hash: string,
  ): ContractRegistry<TContract> | undefined {
    if (!/^[a-f0-9]{64}$/i.test(hash)) {
      return undefined;
    }
    return this.registryMap.get(hash) as
      | ContractRegistry<TContract>
      | undefined;
  }

  /**
   * Gets a copy of the internal registry map.
   * @returns A Map where keys are SHA-256 registry hashes and values are ContractRegistry instances.
   */
  public getContractRegistryMap(): Map<
    string,
    ContractRegistry<Contract>
  > {
    return structuredClone(this.registryMap);
  }

  /**
   * Returns a list of definition locations for all cached registry schemas.
   */
  public getDefinitionLocationList(): DefinitionLocation[] {
    const result = Array.from(this.registryMap.values()).flatMap(
      (contractRegistry) => {
        const definitionPathList = Object.keys(contractRegistry.contractRecord);
        const hash = ContractRegistryCache.computeHash(contractRegistry);
        return definitionPathList.map((definitionPath) => ({
          contractRegistryHash: hash,
          definitionPath: definitionPath,
        }));
      },
    );

    return result;
  }
}
