import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import { ok } from 'neverthrow';
import { setupOperationContractRegistry } from '../../src/operation/contract/operation-contract-utils.js';
import {
  OperationDefinitionBuilder,
  getOperationDefinitionBuilder,
} from '../../src/operation/definition/operation-definition-builder.js';
import { OperationDefinition } from '../../src/operation/definition/operation-definition.js';

describe('OperationDefinitionBuilder', () => {
  const contractRegistry = setupOperationContractRegistry({
    contractRecord: {
      './sum-definition.js': {
        type: 'operation',
        description: 'Adds numbers',
        inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
        outputSchema: Type.Object({ value: Type.Number() }),
        errorSchema: Type.Object({ message: Type.String() }),
        version: '1.0.0',
      },
      './mul-definition.js': {
        type: 'operation',
        description: 'Multiply numbers',
        inputSchema: Type.Object({
          a: Type.Number(),
          b: Type.Number(),
          c: Type.Number(),
        }),
        outputSchema: Type.Object({ value: Type.Number() }),
        errorSchema: Type.Object({ message: Type.String() }),
        version: '1.0.0',
      },
    },
  });

  describe('getOperationDefinitionBuilder', () => {
    it('should return a function that builds definitions', () => {
      const builderFn = getOperationDefinitionBuilder(contractRegistry);
      expect(typeof builderFn).toBe('function');
    });
  });

  describe('createDefinition', () => {
    const builderFn = getOperationDefinitionBuilder(contractRegistry);

    it('should create an OperationDefinition correctly', async () => {
      const operationDefinition = builderFn(
        './mul-definition.js',
        async (input) => {
          const { a, b, c } = input;
          return ok({ value: a * b * c });
        },
      );

      expect(operationDefinition).toBeInstanceOf(OperationDefinition);
      expect(operationDefinition.contract).toBe(
        contractRegistry.contractRecord['./mul-definition.js'],
      );

      // Test the validated handler
      const result = await operationDefinition.validatedHandler({
        a: 2,
        b: 3,
        c: 4,
      });
      expect(result.isOk()).toBe(true);

      const logicResult = result._unsafeUnwrap();
      expect(logicResult.isOk()).toBe(true);
      expect(logicResult._unsafeUnwrap()).toEqual({ value: 24 });
    });

    it('should throw an error if the definition path does not exist', () => {
      const builder = new OperationDefinitionBuilder(
        contractRegistry.contractRecord,
      );

      expect(() => {
        builder.createDefinition('./non-existent.js' as never, async () =>
          ok({ value: 1 }),
        );
      }).toThrow('Contract for definition path "./non-existent.js" not found');
    });

    it('should return a validation error if the handler returns invalid output', async () => {
      const operationDefinition = builderFn(
        './sum-definition.js',
        // @ts-expect-error intentionally returning the wrong type to trigger output validation
        async () => {
          // returning string instead of number to trigger validation error
          return ok({ value: 'invalid-string' });
        },
      );

      const result = await operationDefinition.validatedHandler({ a: 1, b: 2 });

      // The outer result is an error from ValidatedHandler due to output validation failure
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain(
        'Output validation error',
      );
    });

    it('should return an error if input validation fails', async () => {
      const operationDefinition = builderFn(
        './sum-definition.js',
        async (input) => {
          const { a, b } = input;
          return ok({ value: a + b });
        },
      );

      // @ts-expect-error missing 'b' parameter intentionally
      const result = await operationDefinition.validatedHandler({ a: 1 });

      // The outer result is an error from ValidatedHandler due to input validation failure
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain(
        'Input validation error',
      );
    });
  });
});
