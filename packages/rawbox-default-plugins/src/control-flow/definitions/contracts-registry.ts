import { Type } from "@sinclair/typebox";
import { getControlFlowDefinitionCreator } from "../core/control-flow-definition-builder.js";
import { setupControlFlowContractsRegistry } from "../core/control-flow-definition.js";

const contractsRegistry = setupControlFlowContractsRegistry({
  contractsRecord: {
    "./goto.definition.js": {
      type: "control-flow",
      description: "Sum two numbers",
      inputSchema: Type.Object({
        condition: Type.Boolean(),
        runItemLabel: Type.String(),
      }),
      errorSchema: Type.Object({
        message: Type.String(),
      }),
      version: "1.0.0",
    },
  },
});

export const createControlFlowDefinition =
  getControlFlowDefinitionCreator(contractsRegistry);

export default contractsRegistry;
