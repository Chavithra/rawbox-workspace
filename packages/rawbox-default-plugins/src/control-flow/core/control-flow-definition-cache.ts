import { Type } from "@sinclair/typebox";
import {
  ControlFlowContract,
  controlFlowContractGuard,
  ControlFlowDefinition,
} from "./control-flow-definition.js";
import {
  createLoadDefinition,
  createDefinitionCache,
} from "rawbox-plugin/definition-cache";

const AnyObjectSchema = Type.Object({});

export type ControlFlowContractAnyObjectSchema = ControlFlowContract<
  typeof AnyObjectSchema,
  typeof AnyObjectSchema
>;
export const loadControlFlowDefinition = createLoadDefinition<
  ControlFlowContractAnyObjectSchema,
  ControlFlowDefinition<ControlFlowContractAnyObjectSchema>
>(controlFlowContractGuard);

export const OperationDefinitionCache = createDefinitionCache<
  ControlFlowContractAnyObjectSchema,
  ControlFlowDefinition<ControlFlowContractAnyObjectSchema>
>(loadControlFlowDefinition);
