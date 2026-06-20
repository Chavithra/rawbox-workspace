import { readFile } from 'node:fs/promises';
import { cwd } from 'node:process';
import path from 'node:path';

import { err, ok, Result } from 'neverthrow';
import { findUpward, findFileAtFolderRoot } from '../entries-utils.js';

import {
  RawboxPlugin,
  type RawboxPluginFile,
  RawboxPluginValidator,
} from './rawbox-plugin-types.js';

const DEFAULT_RAWBOX_PLUGIN_FILE = 'rawbox.plugin.json';

export class RawboxPluginFinder {
  public static async findPackageRoot(
    startFolderPath: string,
  ): Promise<string | undefined> {
    let packageRootPath: string | undefined;
    const pathList = await findUpward(startFolderPath, 'package.json');

    const lastPath = pathList.at(-1);
    if (lastPath) {
      packageRootPath = path.dirname(lastPath);
    } else {
      packageRootPath = undefined;
    }

    return packageRootPath;
  }

  public static async findRawboxPluginPathList(
    startFolderPath: string = cwd(),
    configFileName: string = DEFAULT_RAWBOX_PLUGIN_FILE,
  ): Promise<string[]> {
    startFolderPath = path.resolve(startFolderPath);
    const nodeModulesPathList = await findUpward(
      startFolderPath,
      'node_modules',
    );
    const currentPackageRootPath =
      await RawboxPluginFinder.findPackageRoot(startFolderPath);
    const pathListToSearch =
      currentPackageRootPath != undefined
        ? [...nodeModulesPathList, currentPackageRootPath]
        : nodeModulesPathList;
    const configFilePathList = await findFileAtFolderRoot(
      pathListToSearch,
      configFileName,
    );

    return configFilePathList;
  }
}

export class RawboxPluginLoader {
  public static async loadConfigFile(
    rawboxPluginPath: string,
  ): Promise<Result<RawboxPluginFile, string>> {
    let result: Result<RawboxPluginFile, string>;
    try {
      const fileContent = await readFile(rawboxPluginPath, 'utf-8');
      const rawboxPlugin: RawboxPlugin = JSON.parse(fileContent);

      const isValid = RawboxPluginValidator.Check(rawboxPlugin);

      if (isValid) {
        const rawboxPluginFile: RawboxPluginFile = {
          path: rawboxPluginPath,
          content: rawboxPlugin,
        };
        result = ok(rawboxPluginFile);
      } else {
        result = err(`Invalide format, file: '${rawboxPluginPath}'`);
      }
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      result = err(
        `Error loading config file ${rawboxPluginPath}: ${e.message}`,
      );
    }

    return result;
  }

  public static async loadRawboxPluginFileList(
    startFolderPath: string = cwd(),
    configFileName: string = DEFAULT_RAWBOX_PLUGIN_FILE,
  ): Promise<Result<RawboxPluginFile, string>[]> {
    let result: Result<RawboxPluginFile, string>[] = [];

    startFolderPath = path.resolve(startFolderPath);
    const configPathList = await RawboxPluginFinder.findRawboxPluginPathList(
      startFolderPath,
      configFileName,
    );

    result = await Promise.all(
      configPathList.map(async (rawboxPluginPath) =>
        RawboxPluginLoader.loadConfigFile(rawboxPluginPath),
      ),
    );

    return result;
  }

  public static async loadValidRawboxPluginFileList(
    startFolderPath: string = cwd(),
    rawboxPluginFileName: string = DEFAULT_RAWBOX_PLUGIN_FILE,
  ): Promise<RawboxPluginFile[]> {
    const rawboxPluginFileList =
      await RawboxPluginLoader.loadRawboxPluginFileList(
        startFolderPath,
        rawboxPluginFileName,
      );

    const filtered = Array.from(
      new Set(
        rawboxPluginFileList
          .filter((result) => result.isOk())
          .map((result) => result.value)
          .flat(),
      ),
    );

    return filtered;
  }
}
