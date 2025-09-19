import { ok } from "neverthrow";
import { createOperationDefinition } from "./contracts-registry.js";

const operationDefinition = createOperationDefinition(
  "./sum.definition.js",
  (input) => {
    const { a, b } = input;
    return ok({ value: a + b });
  }
);

export default operationDefinition;
