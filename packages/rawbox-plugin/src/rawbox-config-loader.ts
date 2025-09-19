import { readFile } from "node:fs/promises";
import { cwd } from "node:process";
import path from "node:path";

import { err, ok, Result } from "neverthrow";
import { findUpward, findFileAtFolderRoot } from "./entries-utils.js";

import {
  RawboxConfig,
  RawboxConfigFile,
  RawboxConfigValidator,
} from "./rawbox-config-file.js";

export class RawboxConfigFinder {
  public static async findPackageRoot(
    startFolderPath: string
  ): Promise<string | undefined> {
    let packageRootPath: string | undefined;
    const pathList = await findUpward(startFolderPath, "package.json");

    const lastPath = pathList.at(-1);
    if (lastPath) {
      packageRootPath = path.dirname(lastPath);
    } else {
      packageRootPath = undefined;
    }

    return packageRootPath;
  }

  public static async findRawboxConfigPathList(
    startFolderPath: string = cwd(),
    configFileName: string = "rawbox.config.json"
  ): Promise<string[]> {
    startFolderPath = path.resolve(startFolderPath);
    const nodeModulesPathList = await findUpward(
      startFolderPath,
      "node_modules"
    );
    const currentPackageRootPath = await RawboxConfigFinder.findPackageRoot(
      startFolderPath
    );
    const pathListToSearch =
      currentPackageRootPath != undefined
        ? [...nodeModulesPathList, currentPackageRootPath]
        : nodeModulesPathList;
    const configFilePathList = await findFileAtFolderRoot(
      pathListToSearch,
      configFileName
    );

    return configFilePathList;
  }
}

export class RawboxConfigLoader {
  public static async loadConfigFile(
    rawboxConfigPath: string
  ): Promise<Result<RawboxConfigFile, string>> {
    let result: Result<RawboxConfigFile, string>;
    try {
      const fileContent = await readFile(rawboxConfigPath, "utf-8");
      const rawboxConfig: RawboxConfig = JSON.parse(fileContent);

      const isValid = RawboxConfigValidator.Check(rawboxConfig);

      if (isValid) {
        const rawboxConfigFile: RawboxConfigFile = {
          path: rawboxConfigPath,
          content: rawboxConfig,
        };
        result = ok(rawboxConfigFile);
      } else {
        result = err(`Invalide format, file: '${rawboxConfigPath}'`);
      }
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      result = err(
        `Error loading config file ${rawboxConfigPath}: ${e.message}`
      );
    }

    return result;
  }

  public static async loadRawboxConfigFileList(
    startFolderPath: string = cwd(),
    configFileName: string = "rawbox.config.json"
  ): Promise<Result<RawboxConfigFile, string>[]> {
    let result: Result<RawboxConfigFile, string>[] = [];

    startFolderPath = path.resolve(startFolderPath);
    const configPathList = await RawboxConfigFinder.findRawboxConfigPathList(
      startFolderPath,
      configFileName
    );

    result = await Promise.all(
      configPathList.map(async (rawboxConfigPath) =>
        RawboxConfigLoader.loadConfigFile(rawboxConfigPath)
      )
    );

    return result;
  }

  public static async loadValidRawboxConfigFileList(
    startFolderPath: string = cwd(),
    rawboxConfigFileName: string = "rawbox.config.json"
  ): Promise<RawboxConfigFile[]> {
    const rawboxConfigFileList =
      await RawboxConfigLoader.loadRawboxConfigFileList(
        startFolderPath,
        rawboxConfigFileName
      );

    const filtered = Array.from(
      new Set(
        rawboxConfigFileList
          .filter((result) => result.isOk())
          .map((result) => result.value)
          .flat()
      )
    );

    return filtered;
  }
}
