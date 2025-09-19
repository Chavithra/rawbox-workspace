import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { getDefinitionPathList } from "@/contracts-registry-utils.js";
import { setupOperationContractsRegistry } from "@/operation-definition.js";

describe("Testing contracts-registry-utils", () => {
  const contractsRegistry = setupOperationContractsRegistry({
    contractsRecord: {
      "./sum.impl.js": {
        type: "operation",
        description: "Sum two numbers",
        inputSchema: Type.Object({
          a: Type.Number(),
          b: Type.Number(),
        }),
        outputSchema: Type.Object({
          value: Type.Number(),
        }),
        errorSchema: Type.Object({
          message: Type.String(),
        }),
        version: "1.0.0",
      },
      "./mul.impl.js": {
        type: "operation",
        description: "Multiply two numbers",
        inputSchema: Type.Object({
          a: Type.Number(),
          b: Type.Number(),
          c: Type.Number(),
        }),
        outputSchema: Type.Object({
          value: Type.Number(),
        }),
        errorSchema: Type.Object({
          message: Type.String(),
        }),
        version: "1.0.0",
      },
    },
  });

  describe("getDefinitionPathList", () => {
    it("should return an array of definition paths from the contracts record", () => {
      const pathList = getDefinitionPathList(contractsRegistry);
      expect(pathList).toEqual(["./sum.impl.js", "./mul.impl.js"]);
    });

    it("should return an empty array for an empty contracts record", () => {
      const pathList = getDefinitionPathList({
        contractsRecord: {},
        contractsRegistryPath: "",
      });
      expect(pathList).toEqual([]);
    });
  });

  describe("setupContractsRegistry", () => {
    it("should use the provided contractsRegistryPath when given", () => {
      const registryPath = "/test/path/to/registry.ts";
      const contractsRegistry = setupOperationContractsRegistry({
        contractsRecord: {},
        contractsRegistryPath: registryPath,
      });

      expect(contractsRegistry.contractsRegistryPath).toBe(registryPath);
    });

    it("should automatically determine the path when contractsRegistryPath is not provided", () => {
      const contractsRegistry = setupOperationContractsRegistry({
        contractsRecord: {},
      });

      expect(contractsRegistry.contractsRegistryPath).toBeDefined();
    });
  });
});
