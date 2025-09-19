import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { loadOperationDefinition } from "@/operation-definition-cache.js";

describe("OperationDefinitionLoader", async () => {
  const currentFolder = path.dirname(fileURLToPath(import.meta.url));
  const startFolderPath = path.join(
    currentFolder,
    "../../rawbox-extension-maths/dist"
  );

  it("should load a valid operation definition", async () => {
    const operationLocation = {
      contractsRegistryPath: path.join(
        startFolderPath,
        "contracts-registry.js"
      ),
      definitionPath: "./mul.definition.js",
    };

    const result = await loadOperationDefinition(operationLocation);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const operationDefinition = result.value;
      expect(operationDefinition).toBeDefined();
    }
  });
});
