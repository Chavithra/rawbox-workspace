import { describe, it, expect } from 'vitest';
import compareDefinition from '../../src/value-ops/compare.definition.js';

describe('compare.definition', () => {
  it('should return true for gt when a > b', async () => {
    const handler = compareDefinition.validatedHandler;
    const result = await handler({ a: 2, b: 1, operator: 'gt' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ result: true });
      }
    }
  });

  it('should compare strings lexicographically for lt', async () => {
    const handler = compareDefinition.validatedHandler;
    const result = await handler({ a: 'apple', b: 'banana', operator: 'lt' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ result: true });
      }
    }
  });

  it('should use strict equality for eq', async () => {
    const handler = compareDefinition.validatedHandler;

    const sameTypeResult = await handler({ a: 3, b: 3, operator: 'eq' });
    expect(sameTypeResult.isOk()).toBe(true);
    if (sameTypeResult.isOk()) {
      expect(sameTypeResult.value.isOk()).toBe(true);
      if (sameTypeResult.value.isOk()) {
        expect(sameTypeResult.value.value).toEqual({ result: true });
      }
    }

    const mixedTypeResult = await handler({ a: 3, b: '3', operator: 'eq' });
    expect(mixedTypeResult.isOk()).toBe(true);
    if (mixedTypeResult.isOk()) {
      expect(mixedTypeResult.value.isOk()).toBe(true);
      if (mixedTypeResult.value.isOk()) {
        expect(mixedTypeResult.value.value).toEqual({ result: false });
      }
    }
  });

  it('should return an inner error when ordering mismatched types', async () => {
    const handler = compareDefinition.validatedHandler;
    const result = await handler({ a: 1, b: 'x', operator: 'gte' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isErr()).toBe(true);
      if (result.value.isErr()) {
        expect(typeof result.value.error.message).toBe('string');
      }
    }
  });

  it('should return an outer validation error for an unknown operator', async () => {
    const handler = compareDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid operator
    const result = await handler({ a: 1, b: 2, operator: 'between' });

    expect(result.isErr()).toBe(true);
  });

  it('should treat NaN eq as false, following JS semantics', async () => {
    const handler = compareDefinition.validatedHandler;
    const result = await handler({ a: NaN, b: NaN, operator: 'eq' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ result: false });
      }
    }
  });

  it('should treat NaN ordering as false, following JS semantics', async () => {
    const handler = compareDefinition.validatedHandler;
    const result = await handler({ a: NaN, b: 5, operator: 'lt' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ result: false });
      }
    }
  });

  it('should treat null eq null as true (strict equality)', async () => {
    const handler = compareDefinition.validatedHandler;
    const result = await handler({ a: null, b: null, operator: 'eq' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ result: true });
      }
    }
  });

  it('should treat eq on two structurally-equal objects as false (reference equality)', async () => {
    const handler = compareDefinition.validatedHandler;
    const result = await handler({ a: { x: 1 }, b: { x: 1 }, operator: 'eq' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ result: false });
      }
    }
  });
});
