// Expose what is necessary for a Plugin package (Contracts and Definitions building)
export type {
  Contract,
  ContractRecord,
  ContractRegistry,
  SpecificContractRegistry,
  ContractRegistryPath,
} from './contracts/contract-registry-types.js';
export { setupContractRegistry } from './contracts/contract-registry-utils.js';

export type {
  Definition,
  Handler,
  ValidatedHandler,
  ValidatedResult,
} from './definition/definition-types.js';
export { DefinitionLocation } from './definition/definition-types.js';

// Expose what is necessary for a Runner package (to load and execute)
export { ContractRegistryCache } from './contracts/contract-registry-cache.js';
export { ContractRegistryLoader } from './contracts/contract-registry-loader.js';
export { createLoadDefinition, createDefinitionCache } from './definition/definition-cache.js';
export { definitionGuard } from './definition/definition-utils.js';
export { loadDefinition, type LoadedOperationDefinition, type LoadedControlFlowDefinition } from './definition/definition-loader.js';
