import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { ContractsRegistryCache } from "@/contracts-registry-cache.js";

describe("OperationImplementationCache", async () => {
  const currentFolder = path.dirname(fileURLToPath(import.meta.url));
  const startFolderPath = path.join(
    currentFolder,
    "../../rawbox-extension-maths"
  );

  it("should return an error if loading fails", async () => {
    const contractsRegistryCache = await ContractsRegistryCache.build(
      startFolderPath
    );

    const contractsRegistryPathList =
      contractsRegistryCache.getContractsRegistryPathList();

    expect(contractsRegistryPathList.length).toBeGreaterThan(0);

    const definitionLocationList =
      contractsRegistryCache.getDefinitionLocationList();

    const definitionPathList = definitionLocationList.map(
      (definitionLocation) => definitionLocation.definitionPath
    );

    expect(definitionPathList).toEqual([
      "./sum.definition.js",
      "./mul.definition.js",
    ]);
  });
});
