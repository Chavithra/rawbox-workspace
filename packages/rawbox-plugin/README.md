# rawbox-plugin

## 1. Goal

This library allows the creation of Definitions for components (operation or control-flow).

These Definitions contents all the necessary information in order to load and execute these components.

A complete Definition consists of:

1.1. **Contract**: The interface or schema (e.g., `inputSchema`, `outputSchema`, `errorSchema`) defined using `typebox`.
1.2. **Handler**: The raw business-logic implementation of the component.
1.3. **ValidatedHandler**: A type-validated implementation wrapper that enforces the `typebox` schemas at runtime before and after executing the handler.

---

## 2. Workflow: Adding an Operation Type Component

### 2.1. Add an Operation Contract Registry

Define all your specific operation contracts in a registry. This explicitly states the IO structures of your plugins.

```typescript
// packages/rawbox-default-plugins/src/maths/contract-registry.ts
import { Type } from 'typebox';
import {
  setupOperationContractRegistry,
  getOperationDefinitionBuilder,
} from 'rawbox-plugin';

const ContractRegistry = setupOperationContractRegistry({
  contractRecord: {
    './sum.definition.js': {
      type: 'operation',
      description: 'Sum two numbers',
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
      version: '1.0.0',
    },
  },
});

// Export a typed creator bound to your specific registry
export const createOperationDefinition =
  getOperationDefinitionBuilder(ContractRegistry);
export default ContractRegistry;
```

### 2.2. Add the Operation Definition (The Implementation)

Write the actual logic/handler using the creator bound to your registry. Because of the registry's generic inference, your inputs and outputs are typed.

```typescript
// packages/rawbox-default-plugins/src/maths/sum.definition.ts
import { ok } from 'neverthrow';
import { createOperationDefinition } from './contract-registry.js';

const operationDefinition = createOperationDefinition(
  './sum.definition.js',
  async (input) => {
    // `input` is typed
    const { a, b } = input;

    // The return type is checked against outputSchema
    return ok({ value: a + b });
  },
);

export default operationDefinition;
```

---

## 3. Workflow: Adding a Control-Flow Type Component

Adding a control-flow component follows the exact same pattern but uses the control-flow specific registry and builders.

### 3.1. Add a Control-Flow Contract Registry

```typescript
// packages/rawbox-default-plugins/src/control-flow/definitions/contract-registry.ts
import { Type } from 'typebox';
import {
  getControlFlowDefinitionBuilder,
  setupControlFlowContractRegistry,
} from 'rawbox-plugin';

const ContractRegistry = setupControlFlowContractRegistry({
  contractRecord: {
    './goto.definition.js': {
      type: 'control-flow',
      description: 'Jump to a specific step',
      inputSchema: Type.Object({
        condition: Type.Boolean(),
        label: Type.String(),
      }),
      errorSchema: Type.Object({
        message: Type.String(),
      }),
      version: '1.0.0',
    },
  },
});

export const createControlFlowDefinition =
  getControlFlowDefinitionBuilder(ContractRegistry);

export default ContractRegistry;
```

### 3.2. Add the Control-Flow Definition

The control-flow handler always expects to return an object matching `{ label: string }`.

```typescript
// packages/rawbox-default-plugins/src/control-flow/definitions/jump.definition.ts
import { ok } from 'neverthrow';
import { createControlFlowDefinition } from './contract-registry.js';

const controlFlowDefinition = createControlFlowDefinition(
  './goto.definition.js',
  async (input) => {
    // `input` is typed
    const { label } = input;

    // Control-Flow handlers must return a label
    return ok({ label });
  },
);

export default controlFlowDefinition;
```

With this architecture, the Runner can trust that any `Definition` it receives matches its schema, eliminating runtime data anomalies.
