import { Type } from "@sinclair/typebox";
import {
  setupOperationContractsRegistry,
  getOperationDefinitionCreator,
} from "rawbox-plugin";

const contractsRegistry = setupOperationContractsRegistry({
  contractsRecord: {
    "./sum.definition.js": {
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
    "./mul.definition.js": {
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

export const createOperationDefinition =
  getOperationDefinitionCreator(contractsRegistry);

export default contractsRegistry;
