---
name: rawbox-operation-creation
description: >-
  Provides the step-by-step procedure to add, implement schemas, write handlers, and unit-test a new Rawbox operation definition inside a plugin.
  Activate this skill when the user asks to create, modify, or test a Rawbox operation.
---

# Creating and Testing Rawbox Operations

This guide provides a comprehensive walkthrough for creating, implementing, and unit testing new **Operations** in a Rawbox plugin using [rawbox-cli](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli).

---

## 1. Creating a New Operation

To create a new operation, run the operation scaffolding command inside your plugin package directory:

```bash
npx rawbox-cli operation create --name <operation-name>
```

### Example:
```bash
npx rawbox-cli operation create --name sum-numbers
```

### Behind the Scenes:
As implemented in [operation/create.ts](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/commands/operation/create.ts):
1. **Definition Scaffolding:** Generates a template operation definition at `src/operations/sum-numbers.definition.ts`.
2. **Registry Registration:** Automatically registers the operation in `src/contract-registry.ts` under the `operationsRecord` with default schema properties.

> [!TIP]
> Before writing a new operation, check whether a built-in one already covers the
> need: `rawbox-plugin-default` ships timing (`sleep`, `workflow-throttle`), data
> plumbing (`echo`, `compare`, `logic`, `increment`, `assert`), observability
> (`log`), and control-flows (`jump`, `branch`, `switch`, `loop-gate`, `halt`).
> See its [README](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-plugin-default/README.md).

---

## 2. Defining the Contract

Open `src/contract-registry.ts` and modify the schema properties for your new operation inside the `operationsRecord` object.

You will need to specify:
- **`inputSchema`**: TypeBox schema mapping incoming parameters.
- **`outputSchema`**: TypeBox schema mapping output values upon success.
- **`errorSchema`**: TypeBox schema mapping the shape of expected error objects.
- **`version`**: The version of the operation contract (defaults to `"1.0.0"`).
- **`description`**: A description explaining the purpose of the operation.

### Example Contract Registry:
```typescript
import { Type } from 'typebox';
import { setupPluginRegistry } from 'rawbox-plugin';

const operationsRecord = {
  './operations/sum-numbers.definition.js': {
    type: 'operation' as const,
    description: 'Add two numbers together',
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
} as const;
```

---

## 3. Implementing the Handler

Open the generated definition file (e.g., `src/operations/sum-numbers.definition.ts`). It wraps the contract with type-safe handler logic using `neverthrow` for functional error handling.

### Example Implementation:
```typescript
import { ok, err } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const sumNumbersDefinition = createOperationDefinition(
  './operations/sum-numbers.definition.js',
  async (input) => {
    const { a, b } = input;
    
    // Perform operation logic
    const value = a + b;

    // Return ok or err result conforming to contract schemas
    return ok({ value });
  }
);

export default sumNumbersDefinition;
```

---

## 4. Testing the Operation

Rawbox plugins use [Vitest](https://vitest.dev/) for unit testing. Write test cases by calling the `validatedHandler` property of your operation definition, which validates the inputs and outputs against the defined schemas.

### Example Test File (`tests/sum-numbers.definition.test.ts`):
```typescript
import { describe, it, expect } from 'vitest';
import sumNumbersDefinition from '../src/operations/sum-numbers.definition.js';

describe('sum-numbers definition', () => {
  it('should sum two numbers correctly and pass validations', async () => {
    const handler = sumNumbersDefinition.validatedHandler;
    const result = await handler({ a: 10, b: 20 });

    // Ensure type-safe Result wrapper succeeded
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const innerResult = result.value;
      // Ensure the handler execution did not return a Result.Err
      expect(innerResult.isOk()).toBe(true);
      if (innerResult.isOk()) {
        // Assert on the returned output schema values
        expect(innerResult.value).toEqual({ value: 30 });
      }
    }
  });

  it('should return a validation error if inputs are invalid types', async () => {
    const handler = sumNumbersDefinition.validatedHandler;
    
    // @ts-expect-error Intentionally passing invalid parameter types
    const result = await handler({ a: 10, b: '20' });

    // Validated handler intercepts schema mismatches and returns an outer Result.Err
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('Input validation error');
    }
  });
});
```

---

## 5. Building and Running Tests

To verify your operation builds and tests successfully:

1. **Build the plugin:**
   ```bash
   npm run build
   ```
2. **Execute tests:**
   ```bash
   npm run test
   ```
