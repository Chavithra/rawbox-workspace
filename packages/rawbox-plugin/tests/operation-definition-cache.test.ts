import { fileURLToPath } from "node:url";
import path from "node:path";

import { describe, it, expect } from "vitest";

import { OperationDefinitionCache } from "@/operation-definition-cache.js";

describe("OperationDefinitionCache", async () => {
  const operationLocation = {
    contractsRegistryPath: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../rawbox-extension-maths/dist/contracts-registry.js"
    ),
    definitionPath: "./mul.definition.js",
  };
  const operationDefinitionCache = new OperationDefinitionCache();
  const resultOrgetOrLoadDefinition =
    await operationDefinitionCache.getOrLoadDefinition(operationLocation);

  it("should get or load operation definition", async () => {
    if (resultOrgetOrLoadDefinition.isOk()) {
      const operationDefinition = resultOrgetOrLoadDefinition.value;

      const input = { a: 2, b: 3, c: 4 };
      const resultOfGetWrappedHandler =
        await operationDefinition.validatedHandler(input);

      expect(resultOrgetOrLoadDefinition.isOk()).toBe(true);

      if (resultOfGetWrappedHandler.isOk()) {
        expect(resultOfGetWrappedHandler.value).toEqual({ value: 24 });
        return resultOfGetWrappedHandler.value;
      } else {
        throw Error("Operation failed: " + JSON.stringify(input));
      }
    } else {
      throw Error("Operation failed: " + JSON.stringify(operationLocation));
    }
  });
});
