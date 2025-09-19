import { cwd } from "node:process";

import { err, ok, type Result } from "neverthrow";

import type {
  Contract,
  ContractsRegistry,
  ContractsRegistryPath,
} from "./contracts-registry.js";
import { ContractsRegistryLoader } from "./contracts-registry-loader.js";
import { getDefinitionPathList } from "./contracts-registry-utils.js";
import type { DefinitionLocation } from "./definition.js";

/**
 * Caches ContractsRegistry instances to avoid redundant dynamic imports.
 */
export class ContractsRegistryCache {
  /**
   * Builds a ContractsRegistryCache by discovering and loading all valid contracts registries
   * based on the operation configuration files found upwards from a starting directory.
   * @param startFolderPath - The directory to start searching from. Defaults to the current working directory.
   * @param operationConfigFileName - The name of the operation configuration file. Defaults to "rawbox.config.json".
   * @returns A promise that resolves to a new ContractsRegistryCache instance populated with discovered registries.
   */
  public static async build(
    startFolderPath: string = cwd(),
    operationConfigFileName: string = "rawbox.config.json"
  ) {
    let result = new ContractsRegistryCache();

    const contractsRegistryList =
      await ContractsRegistryLoader.loadValidContractsRegistryList(
        startFolderPath,
        operationConfigFileName
      );

    contractsRegistryList.map((contractsRegistry) => {
      result.addContractsRegistry(contractsRegistry);
    });

    return result;
  }

  /**
   * Creates an instance of ContractsRegistryCache.
   * @param registryMap - A map to store loaded registries, with registry path as key.
   */
  public constructor(
    private readonly registryMap: Map<
      ContractsRegistryPath,
      ContractsRegistry<any>
    > = new Map<ContractsRegistryPath, ContractsRegistry<any>>()
  ) {}

  /**
   * Adds a SignatureRegistry instance to the cache.
   * @param contractsRegistry - The ContractsRegistry instance to add.
   */
  public addContractsRegistry(contractsRegistry: ContractsRegistry<any>): void {
    this.registryMap.set(
      contractsRegistry.contractsRegistryPath,
      contractsRegistry
    );
  }

  /**
   * Retrieves a ContractsRegistry instance from the cache.
   * @param registryPath - The path of the registry to retrieve.
   * @returns The ContractsRegistry instance if found, otherwise undefined.
   */
  public getContractsRegistry<TContract extends Contract>(
    contractsRegistryPath: ContractsRegistryPath
  ): ContractsRegistry<TContract> | undefined {
    return this.registryMap.get(contractsRegistryPath) as
      | ContractsRegistry<TContract>
      | undefined;
  }

  /**
   * Retrieves a registry from the cache, or loads it if it's not already cached.
   * @param contractsRegistryPath - The path to the registry file.
   * @param forceReload - If true, reloads the registry even if it's already in the cache. Defaults to false.
   * @returns A promise that resolves with a Result containing the SignatureRegistry on success, or an error string on failure.
   */
  public async getOrLoadSignaturesRegistry(
    contractsRegistryPath: ContractsRegistryPath,
    forceReload: boolean = false
  ): Promise<Result<ContractsRegistry<any>, string>> {
    const registryMap = this.registryMap;

    let result: Result<ContractsRegistry<any>, string>;

    const resultOfLoadRegistry = await this.loadSignaturesRegistry(
      contractsRegistryPath,
      forceReload
    );

    if (resultOfLoadRegistry.isOk()) {
      const registry = registryMap.get(contractsRegistryPath);

      if (registry) {
        result = ok(registry);
      } else {
        result = err(
          `SignatureRegistry at '${contractsRegistryPath}' not found.`
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
  public getContractsRegistryPathList(): string[] {
    const registryMap = this.registryMap;

    return [...registryMap.keys()];
  }
  /**
   * Gets a map of all cached registries, with their paths as keys.
   * @returns A Map where keys are registry paths and values are ContractsRegistry instances.
   */
  public getContractsRegistryMap(): Map<
    ContractsRegistryPath,
    ContractsRegistry<any>
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
  public async loadSignaturesRegistry(
    registryPath: ContractsRegistryPath,
    forceReload: boolean = false
  ): Promise<Result<void, string>> {
    const registryMap = this.registryMap;

    let result: Result<void, string>;

    if (!forceReload && registryMap.has(registryPath)) {
      result = ok();
    } else {
      const resultOfLoadContractsRegistry =
        await ContractsRegistryLoader.loadContractsRegistry(registryPath);

      if (resultOfLoadContractsRegistry.isOk()) {
        registryMap.set(registryPath, resultOfLoadContractsRegistry.value);
        result = ok();
      } else {
        result = err(resultOfLoadContractsRegistry.error);
      }
    }

    return result;
  }

  public getDefinitionLocationList(): DefinitionLocation[] {
    const registryMap = this.registryMap;

    const result = Array.from(registryMap.values()).flatMap(
      (contractsRegistry) =>
        getDefinitionPathList(contractsRegistry).map((definitionPath) => ({
          contractsRegistryPath: contractsRegistry.contractsRegistryPath,
          definitionPath: definitionPath,
        }))
    );

    return result;
  }
}
