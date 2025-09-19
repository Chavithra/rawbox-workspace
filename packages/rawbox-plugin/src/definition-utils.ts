import { Definition } from "./definition.js";
import type { Contract } from "./contracts-registry.js";

export function definitionGuard(
  definition: object
): definition is Definition<Contract> {
  return (
    typeof definition === "object" &&
    definition !== null &&
    "contract" in definition &&
    "handler" in definition &&
    "validatedHandler" in definition
  );
}
