// Expose what is necessary for a Plugin package (to make component Definitions)
export { getOperationDefinitionBuilder, setupOperationContractRegistry } from './operation/index.js';
export { getControlFlowDefinitionBuilder, setupControlFlowContractRegistry } from './control-flow/index.js';
export { setupPluginRegistry } from './plugin-registry-utils.js';

// The structural constraint every schema-generic in the SDK is written against.
// Exported so a plugin can annotate its own generics without importing typebox.
export type { ObjectSchemaLike } from './core/contracts/contract-registry-types.js';

// The ceiling on a contract's (or a step's) `timeoutMs`, exported so a plugin
// author can name it rather than repeating 2147483647 — see the field's own
// documentation for why a larger value inverts the bound instead of widening it.
export { TIMEOUT_MS_MAX } from './core/contracts/contract-registry-types.js';

// The one seam a definition handler has for handing a structured event to its
// host (the runner's typed run-event stream, when a runner is the host).
export { emitRunEvent, type HostRunEvent } from './core/run-event-channel.js';
