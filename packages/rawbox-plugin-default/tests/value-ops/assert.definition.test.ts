import { describe, it, expect } from 'vitest';
import assertDefinition from '../../src/value-ops/assert.definition.js';

describe('assert.definition', () => {
  it('should pass when condition is true', async () => {
    const handler = assertDefinition.validatedHandler;
    const result = await handler({ condition: true });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ passed: true });
      }
    }
  });

  it('should ignore message when condition is true', async () => {
    const handler = assertDefinition.validatedHandler;
    const result = await handler({ condition: true, message: 'ignored' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ passed: true });
      }
    }
  });

  it('should fail with the given message when condition is false', async () => {
    const handler = assertDefinition.validatedHandler;
    const result = await handler({ condition: false, message: 'price out of range' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isErr()).toBe(true);
      if (result.value.isErr()) {
        expect(result.value.error).toEqual({ message: 'price out of range' });
      }
    }
  });

  it('should fail with the default message when condition is false and no message given', async () => {
    const handler = assertDefinition.validatedHandler;
    const result = await handler({ condition: false });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isErr()).toBe(true);
      if (result.value.isErr()) {
        expect(result.value.error).toEqual({ message: 'Assertion failed' });
      }
    }
  });

  it('should return an outer validation error for a non-boolean condition', async () => {
    const handler = assertDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ condition: 1 });

    expect(result.isErr()).toBe(true);
  });
});
