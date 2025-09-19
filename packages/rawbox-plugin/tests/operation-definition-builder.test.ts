import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { ok } from "neverthrow";
import { getOperationDefinitionCreator } from "@/operation-definition-builder.js";
import {
  OperationDefinition,
  setupOperationContractsRegistry,
} from "@/operation-definition.js";

describe("Testing operation definition creation", () => {
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

  describe("getOperationDefinitionCreator", () => {
    it("should return a function that creates a valid OperationImplementation", async () => {
      const createOperationDefinition =
        getOperationDefinitionCreator(contractsRegistry);
      expect(createOperationDefinition).toBeInstanceOf(Function);

      const sumImplementation = createOperationDefinition(
        "./sum.impl.js",
        ({ a, b }) => ok({ value: a + b })
      );

      expect(sumImplementation).toBeInstanceOf(OperationDefinition);

      const result = await sumImplementation.validatedHandler({
        a: 10,
        b: 20,
      });

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value).toEqual({ value: 30 });
      }
    });
  });
});
