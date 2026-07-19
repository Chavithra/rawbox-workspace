import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ok, err, Result } from 'neverthrow';
import type { ContractRegistryCache } from 'rawbox-plugin/core';

export class PluginDiscoverer {
  /**
   * Helper to check if a dependency name matches the rawbox plugin naming convention.
   */
  public static isPlugin(pluginName: string): boolean {
    return (
      pluginName.startsWith('rawbox-plugin-') ||
      /^@[^/]+\/rawbox-plugin-/.test(pluginName)
    );
  }

  /**
   * Scans workspace dependencies for plugins matching rawbox plugin naming conventions
   * and containing the 'rawbox-plugin' keyword.
   * @param workspacePath - The workspace directory to search.
   * @returns A promise resolving to an array of discovered plugin package names.
   */
  public static async discoverPlugins(
    workspacePath: string,
  ): Promise<Result<string[], string>> {
    const require = createRequire(import.meta.url);
    const pjsonPath = path.join(workspacePath, 'package.json');

    let pjson;
    try {
      const content = await fs.readFile(pjsonPath, 'utf8');
      pjson = JSON.parse(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to read or parse package.json: ${message}`);
    }

    const dependencies = Object.keys({
      ...(typeof pjson.dependencies === 'object' ? pjson.dependencies : null),
    });

    const discovered: string[] = [];

    const checks = dependencies.map(async (dep) => {
      if (PluginDiscoverer.isPlugin(dep)) {
        try {
          const depPjsonPath = require.resolve(`${dep}/package.json`, {
            paths: [workspacePath],
          });
          const depPjson = JSON.parse(await fs.readFile(depPjsonPath, 'utf8'));

          if (
            Array.isArray(depPjson.keywords) &&
            depPjson.keywords.includes('rawbox-plugin')
          ) {
            discovered.push(dep);
          }
        } catch {
          // Skip invalid/unresolved plugins silently
        }
      }
    });

    await Promise.all(checks);

    return ok(discovered);
  }

  /**
   * Imports the ContractRegistry instance from a given plugin package and adds it to the provided cache.
   * @param pluginName - The package name of the plugin.
   * @param registryCache - The ContractRegistryCache to populate.
   */
  public static async loadPlugin(
    pluginName: string,
    registryCache: ContractRegistryCache,
  ): Promise<Result<void, string>> {
    try {
      // Import registry from the standard subpath export `./registry`
      const module = await import(`${pluginName}/registry`);
      const registry = module.default;
      if (registry) {
        registryCache.addContractRegistry(registry);
        return ok(undefined);
      }
      return err(
        `Module at '${pluginName}' does not have a default export ContractRegistry.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(`Failed to import registry for '${pluginName}': ${message}`);
    }
  }

  /**
   * Scans workspace dependencies for plugins starting with 'rawbox-plugin-', verifies their keywords,
   * imports their ContractRegistry instances, and adds them to the provided cache.
   * @param workspacePath - The workspace directory to search.
   * @param registryCache - The ContractRegistryCache to populate.
   */
  public static async discoverAndLoadPlugins(
    workspacePath: string,
    registryCache: ContractRegistryCache,
  ): Promise<Result<void, string>> {
    const pluginsResult = await PluginDiscoverer.discoverPlugins(workspacePath);
    if (pluginsResult.isErr()) {
      return err(pluginsResult.error);
    }

    const loadPromises = pluginsResult.value.map((plugin) =>
      PluginDiscoverer.loadPlugin(plugin, registryCache),
    );

    const loadResults = await Promise.all(loadPromises);
    const combinedResult = Result.combine(loadResults);

    return combinedResult.map(() => undefined);
  }
}
