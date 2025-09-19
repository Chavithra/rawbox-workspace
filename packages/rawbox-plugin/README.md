# rawbox-operation

`rawbox-operation` is a TypeScript library for defining, validating, and dynamically loading operation contracts and implementations in the Rawbox automation framework. It enables robust, type-safe automation by providing a registry system for operation contracts, runtime validation, and dynamic discovery of operations.

---

## Features

- **Contracts Registry**: Centralized management of operation contracts (schemas, descriptions, versions).
- **Type-Safe Implementations**: Enforce input/output types at compile time.
- **Dynamic Loading**: Discover and load registries and implementations at runtime.
- **Schema Validation**: Validate operation inputs/outputs with [@sinclair/typebox](https://github.com/sinclairzx81/typebox).
- **Robust Error Handling**: Use [neverthrow](https://github.com/supermacro/neverthrow) for safe error management.

---

## Installation

```sh
npm install rawbox-operation
```

---

## Quick Start

### 1. Write Operation Contracts

First you write a contract for your Operation.

A contract define how one can interact with an Operation.

```ts
import { Type } from "@sinclair/typebox";
import {
  getOperationDefinitionCreator,
  setupOperationContractsRegistry,
} from "rawbox-operation";

const contractsRegistry = setupOperationContractsRegistry({
  contractsRecord: {
    "./sum.definition.js": {
      type: "operation",
      description: "Sum two numbers",
      inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
      outputSchema: Type.Object({ value: Type.Number() }),
      errorSchema: Type.Object({ message: Type.String() }),
      version: "1.0.0",
    },
  },
});

export const createOperationDefinition =
  getOperationDefinitionCreator(contractsRegistry);

export default contractsRegistry;
```

### 2. Write Operation Definition

This is the code for your Operation.

TypeScript static analyzer will make sure you respect the Contract.

```ts
import { ok } from "neverthrow";
import {
  createOperationDefinition,
  contractsRegistry,
} from "./contracts-registry.js";

const operationDefinition = createOperationDefinition(
  "./sum.definition.js",
  (input) => ok({ value: input.a + input.b })
);

export default operationDefinition;
```

### 3. Manually invoke an Operation

You can dynamically load and invoke operation implementations using `OperationDynamicCaller`:

TypeScript static analyzer will make sure you respect the Contract.

```ts
import { OperationDynamicCaller } from "rawbox-operation";
import contractsRegistry from "./contracts-registry.js";

const dynamicCaller = new OperationDynamicCaller(contractsRegistry);

const result = await dynamicCaller.callDefinition("./sum.definition.js", {
  a: 2,
  b: 3,
});

if (result.isOk()) {
  console.log("Sum result:", result.value); // { value: 5 }
} else {
  console.error("Operation failed:", result.error);
}
```

### 4. Configuration

Declare your registry in a `rawbox.config.json` file:

```json
{
  "contractsRegistryPath": "./dist/contracts-registry.js"
}
```

### 5. Auto Discovery of Registries

You can automatically discover all available operation contract registries in your workspace using `ContractsRegistryCache`. This is useful for building tools or plugins that need to work with all registered operations.

```ts
import { ContractsRegistryCache } from "rawbox-operation";

// Build the cache (scans for rawbox.config.json files)
const cache = await ContractsRegistryCache.build({
  startFolder: "/optional/start/folder/path",
});

// Get all discovered registry paths
const registryPaths = cache.getContractsRegistryPathList();

console.log("Discovered registries:", registryPaths);

// Optionally, load a specific registry
const registry = await cache.getContractsRegistry(registryPaths[0]);
```

This mechanism scans for `rawbox.config.json` files and collects all declared `contractsRegistryPath` entries, enabling dynamic and scalable operation discovery.

---

## API Reference

- **setupOperationContractsRegistry**: Create a contracts registry for your operations.
- **getOperationDefinitionCreator**: Generate type-safe operation implementations.
- **ContractsRegistryCache**: In-memory cache for discovered registries.
- **ContractsRegistryLoader**: Load registries from disk.
- **OperationDefinitionLoader**: Load operation implementations.

---

## Development

Build the package:

```sh
npm run build
```

Run tests:

```sh
npm test
```

---

## License

MIT
