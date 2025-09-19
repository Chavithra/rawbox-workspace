import { cwd } from "node:process";
import path from "node:path";

import { ok, err, type Result } from "neverthrow";

import { isAbsolute } from "./entries-utils.js";
import { RawboxConfigLoader } from "./rawbox-config-loader.js";
import type {
  ContractsRegistry,
  ContractsRegistryPath,
} from "./contracts-registry.js";

export class ContractsRegistryLoader {
  public static async loadContractsRegistryPathList(
    startFolderPath: string = cwd(),
    rawboxConfigFileName: string = "rawbox.config.json"
  ): Promise<ContractsRegistryPath[]> {
    const rawboxConfigFileList =
      await RawboxConfigLoader.loadValidRawboxConfigFileList(
        startFolderPath,
        rawboxConfigFileName
      );

    const contractsRegistryPathList = rawboxConfigFileList.reduce(
      (accumulator: ContractsRegistryPath[], currrentRawboxFile) => {
        const { content: rawboxConfig, path: rawboxConfigPath } =
          currrentRawboxFile;
        const { contractsRegistryPathList } = rawboxConfig;

        const absolutePathList = contractsRegistryPathList.map(
          (contractsRegistryPath) => {
            const rawboxConfigFolderPath = path.dirname(rawboxConfigPath);
            const absolutePath = isAbsolute(contractsRegistryPath)
              ? contractsRegistryPath
              : path.join(rawboxConfigFolderPath, contractsRegistryPath);
            return absolutePath;
          }
        );

        return [...accumulator, ...absolutePathList];
      },
      []
    );

    return contractsRegistryPathList;
  }

  public static async loadContractsRegistry(
    contractsRegistryPath: ContractsRegistryPath
  ): Promise<Result<ContractsRegistry<any>, string>> {
    let result: Result<ContractsRegistry<any>, string>;

    try {
      const module = await import(contractsRegistryPath);
      const registry = module.default;

      if (
        "contractsRecord" in registry &&
        typeof registry.contractsRecord === "object" &&
        "contractsRegistryPath" in registry &&
        typeof registry.contractsRegistryPath === "string"
      ) {
        result = ok(registry);
      } else {
        result = err(
          `Module at '${contractsRegistryPath}' does not have a default export that is an instance of ContractsRegistry.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = err(
        `Failed to load registry from '${contractsRegistryPath}': ${message}`
      );
    }

    return result;
  }

  public static async loadContractsRegistryList(
    startFolderPath: string = cwd(),
    rawboxConfigFileName: string = "rawbox.config.json"
  ): Promise<Result<ContractsRegistry<any>, string>[]> {
    const contractsRegistryPathList =
      await ContractsRegistryLoader.loadContractsRegistryPathList(
        startFolderPath,
        rawboxConfigFileName
      );

    const result = await Promise.all(
      contractsRegistryPathList.map((registryPath) =>
        ContractsRegistryLoader.loadContractsRegistry(registryPath)
      )
    );

    return result;
  }

  public static async loadValidContractsRegistryList(
    startFolderPath: string = cwd(),
    rawboxConfigFileName: string = "rawbox.config.json"
  ): Promise<ContractsRegistry<any>[]> {
    const contractsRegistryList =
      await ContractsRegistryLoader.loadContractsRegistryList(
        startFolderPath,
        rawboxConfigFileName
      );

    const filtered = Array.from(
      new Set(
        contractsRegistryList
          .filter((result) => result.isOk())
          .map((result) => result.value)
          .flat()
      )
    );

    return filtered;
  }
}
