/**
 * @file This is the main public API entry point for the rawbox-operation package.
 * It exports the necessary classes and types for developers to create their own
 * Operation Definitions and use them.
 */

export { getOperationDefinitionCreator } from "./operation-definition-builder.js";
export { setupOperationContractsRegistry } from "./operation-definition.js";
export type { Contract, ContractsRecord } from "./contracts-registry.js";
