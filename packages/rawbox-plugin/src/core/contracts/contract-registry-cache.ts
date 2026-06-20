import { cwd } from 'node:process';

import { err, ok, type Result } from 'neverthrow';

import type {
  Contract,
  ContractRegistry,
  ContractRegistryPath,
} from './contract-registry-types.js';
import { ContractRegistryLoader } from './contract-registry-loader.js';
import { getDefinitionPathList } from './contract-registry-utils.js';
import type { DefinitionLocation } from '../definition/definition-types.js';

/**
 * Caches ContractRegistry instances to avoid redundant dynamic imports.
 */
export class ContractRegistryCache {
  /**
   * Builds a ContractRegistryCache by discovering and loading all valid contracts registries
   * based on the operation configuration files found upwards from a starting directory.
   * @param startFolderPath - The directory to start searching from. Defaults to the current working directory.
   * @param operationConfigFileName - The name of the operation configuration file. Defaults to "rawbox.config.json".
   * @returns A promise that resolves to a new ContractRegistryCache instance populated with discovered registries.
   */
  public static async build(
    startFolderPath: string = cwd(),
    operationConfigFileName: string = 'rawbox.config.json',
  ) {
    const result = new ContractRegistryCache();

    const ContractRegistryList =
      await ContractRegistryLoader.loadValidContractRegistryList(
        startFolderPath,
        operationConfigFileName,
      );

    ContractRegistryList.map((ContractRegistry) => {
      result.addContractRegistry(ContractRegistry);
    });

    return result;
  }

  /**
   * Creates an instance of ContractRegistryCache.
   * @param registryMap - A map to store loaded registries, with registry path as key.
   */
  public constructor(
    private readonly registryMap: Map<
      ContractRegistryPath,
      ContractRegistry<Contract>
    > = new Map<ContractRegistryPath, ContractRegistry<Contract>>(),
  ) {}

  /**
   * Adds a SignatureRegistry instance to the cache.
   * @param ContractRegistry - The ContractRegistry instance to add.
   */
  public addContractRegistry(
    contractRegistry: ContractRegistry<Contract>,
  ): void {
    this.registryMap.set(
      contractRegistry.contractRegistryPath,
      contractRegistry,
    );
  }

  /**
   * Retrieves a ContractRegistry instance from the cache.
   * @param registryPath - The path of the registry to retrieve.
   * @returns The ContractRegistry instance if found, otherwise undefined.
   */
  public getContractRegistry<TContract extends Contract>(
    contractRegistryPath: ContractRegistryPath,
  ): ContractRegistry<TContract> | undefined {
    return this.registryMap.get(contractRegistryPath) as
      | ContractRegistry<TContract>
      | undefined;
  }

  /**
   * Retrieves a registry from the cache, or loads it if it's not already cached.
   * @param ContractRegistryPath - The path to the registry file.
   * @param forceReload - If true, reloads the registry even if it's already in the cache. Defaults to false.
   * @returns A promise that resolves with a Result containing the SignatureRegistry on success, or an error string on failure.
   */
  public async getOrLoadContractRegistry(
    contractRegistryPath: ContractRegistryPath,
    forceReload: boolean = false,
  ): Promise<Result<ContractRegistry<Contract>, string>> {
    const registryMap = this.registryMap;

    let result: Result<ContractRegistry<Contract>, string>;

    const resultOfLoadRegistry = await this.loadContractRegistry(
      contractRegistryPath,
      forceReload,
    );

    if (resultOfLoadRegistry.isOk()) {
      const registry = registryMap.get(contractRegistryPath);

      if (registry) {
        result = ok(registry);
      } else {
        result = err(
          `SignatureRegistry at '${contractRegistryPath}' not found.`,
        );
      }
    } else {
      result = err(resultOfLoadRegistry.error);
    }

    return result;
  }

  /**
   * Gets a list of all cached registry paths.
   * @returns An array of strings, where each string is a path to a cached registry.
   */
  public getContractRegistryPathList(): string[] {
    const registryMap = this.registryMap;

    return [...registryMap.keys()];
  }
  /**
   * Gets a map of all cached registries, with their paths as keys.
   * @returns A Map where keys are registry paths and values are ContractRegistry instances.
   */
  public getContractRegistryMap(): Map<
    ContractRegistryPath,
    ContractRegistry<Contract>
  > {
    return structuredClone(this.registryMap);
  }

  /**
   * Loads a registry into the cache from a given path.
   * If the registry is already cached, it will not be reloaded unless `forceReload` is true.
   * @param registryPath - The path to the registry file to load.
   * @param forceReload - If true, reloads the registry even if it's already in the cache. Defaults to false.
   * @returns A promise that resolves with a Result. `ok(void)` on success, or `err(string)` on failure.
   */
  public async loadContractRegistry(
    registryPath: ContractRegistryPath,
    forceReload: boolean = false,
  ): Promise<Result<void, string>> {
    const registryMap = this.registryMap;

    let result: Result<void, string>;

    if (!forceReload && registryMap.has(registryPath)) {
      result = ok();
    } else {
      const resultOfLoadContractRegistry =
        await ContractRegistryLoader.loadContractRegistry(registryPath);

      if (resultOfLoadContractRegistry.isOk()) {
        registryMap.set(registryPath, resultOfLoadContractRegistry.value);
        result = ok();
      } else {
        result = err(resultOfLoadContractRegistry.error);
      }
    }

    return result;
  }

  public getDefinitionLocationList(): DefinitionLocation[] {
    const registryMap = this.registryMap;

    const result = Array.from(registryMap.values()).flatMap(
      (contractRegistry) =>
        getDefinitionPathList(contractRegistry).map((definitionPath) => ({
          contractRegistryPath: contractRegistry.contractRegistryPath,
          definitionPath: definitionPath,
        })),
    );

    return result;
  }
}
