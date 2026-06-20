import { cwd } from 'node:process';
import path from 'node:path';

import { ok, err, type Result } from 'neverthrow';

import { isAbsolute } from '../entries-utils.js';
import { RawboxPluginLoader } from './rawbox-plugin-loader.js';
import type {
  Contract,
  ContractRegistry,
  ContractRegistryPath,
} from './contract-registry-types.js';

export class ContractRegistryLoader {
  public static async loadContractRegistryPathList(
    startFolderPath: string = cwd(),
    rawboxPluginFileName: string = 'rawbox.config.json',
  ): Promise<ContractRegistryPath[]> {
    const rawboxPluginFileList =
      await RawboxPluginLoader.loadValidRawboxPluginFileList(
        startFolderPath,
        rawboxPluginFileName,
      );

    const ContractRegistryPathList = rawboxPluginFileList.reduce(
      (accumulator: ContractRegistryPath[], currrentRawboxFile) => {
        const { content: rawboxPlugin, path: rawboxPluginPath } =
          currrentRawboxFile;
        const { ContractRegistryPathList } = rawboxPlugin;

        const absolutePathList = ContractRegistryPathList.map(
          (ContractRegistryPath) => {
            const rawboxPluginFolderPath = path.dirname(rawboxPluginPath);
            const absolutePath = isAbsolute(ContractRegistryPath)
              ? ContractRegistryPath
              : path.join(rawboxPluginFolderPath, ContractRegistryPath);
            return absolutePath;
          },
        );

        return [...accumulator, ...absolutePathList];
      },
      [],
    );

    return ContractRegistryPathList;
  }

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

  public static async loadContractRegistryList(
    startFolderPath: string = cwd(),
    rawboxPluginFileName: string = 'rawbox.config.json',
  ): Promise<Result<ContractRegistry<Contract>, string>[]> {
    const ContractRegistryPathList =
      await ContractRegistryLoader.loadContractRegistryPathList(
        startFolderPath,
        rawboxPluginFileName,
      );

    const result = await Promise.all(
      ContractRegistryPathList.map((registryPath) =>
        ContractRegistryLoader.loadContractRegistry(registryPath),
      ),
    );

    return result;
  }

  public static async loadValidContractRegistryList(
    startFolderPath: string = cwd(),
    rawboxPluginFileName: string = 'rawbox.config.json',
  ): Promise<ContractRegistry<Contract>[]> {
    const ContractRegistryList =
      await ContractRegistryLoader.loadContractRegistryList(
        startFolderPath,
        rawboxPluginFileName,
      );

    const filtered = Array.from(
      new Set(
        ContractRegistryList.filter((result) => result.isOk())
          .map((result) => result.value)
          .flat(),
      ),
    );

    return filtered;
  }
}
