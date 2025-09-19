import path from "node:path";
import { ContractsRegistryCache } from "./contracts-registry-cache.js";

/**
 * This function demonstrates how to load all ContractsRegistry instances
 * starting from a specific directory. It uses the ContractsRegistryCache.build
 * method which is designed for this purpose.
 *
 * @param startPath The directory to start the discovery from.
 */
async function loadAllRegistries(startPath: string) {
  console.log(`Starting plugin discovery from: ${startPath}`);

  // The `build` method handles finding all `rawbox.config.json` files,
  // loading the associated contract registries, and caching them.
  const startTime = performance.now();
  const registryCache = await ContractsRegistryCache.build(startPath);
  const endTime = performance.now();

  const duration = (endTime - startTime).toFixed(2);
  console.log(`Discovery and loading finished in ${duration} ms.`);

  const discoveredRegistries = registryCache.getContractsRegistryPathList();
  console.log(`Found ${discoveredRegistries.length} contract registries:`);

  // You can now access the registries from the cache
  discoveredRegistries.forEach((registryPath) => {
    console.log(` - ${registryPath}`);
  });

  return registryCache;
}

// Example usage: Point this to the directory where you generated the benchmark files.

const benchmarkFilesPath = path.resolve(
  "/home/dtp2/code/javascript/real/rawbox-workspace/packages/rawbox-default-plugins"
);
await loadAllRegistries(benchmarkFilesPath).catch(console.error);
