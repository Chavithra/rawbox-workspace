import { ok } from "neverthrow";
import { createControlFlowDefinition } from "./contracts-registry.js";

const controlFlowDefinition = createControlFlowDefinition(
  "./goto.definition.js",
  (input) => {
    const { runItemLabel } = input;

    return ok({ runItemLabel });
  }
);

export default controlFlowDefinition;
