import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import { ContractsRegistryLoader } from "@/contracts-registry-loader.js";

describe("ContractsRegistryLoader", () => {
  const currentFolder = path.dirname(fileURLToPath(import.meta.url));
  const startFolderPath = path.join(
    currentFolder,
    "../../rawbox-extension-maths"
  );
  it("should load contracts registry paths", async () => {
    const contractsRegistryList =
      await ContractsRegistryLoader.loadValidContractsRegistryList(
        startFolderPath
      );

    expect(contractsRegistryList.length).toBeGreaterThan(0);
  });
});
