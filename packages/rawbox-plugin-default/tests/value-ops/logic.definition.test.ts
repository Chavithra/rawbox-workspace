import { describe, it, expect } from 'vitest';
import logicDefinition from '../../src/value-ops/logic.definition.js';

describe('logic.definition', () => {
  it('should AND multiple values', async () => {
    const handler = logicDefinition.validatedHandler;

    const allTrue = await handler({ operator: 'and', values: [true, true, true] });
    expect(allTrue.isOk()).toBe(true);
    if (allTrue.isOk()) {
      expect(allTrue.value.isOk()).toBe(true);
      if (allTrue.value.isOk()) {
        expect(allTrue.value.value).toEqual({ result: true });
      }
    }

    const oneFalse = await handler({ operator: 'and', values: [true, false] });
    expect(oneFalse.isOk()).toBe(true);
    if (oneFalse.isOk()) {
      expect(oneFalse.value.isOk()).toBe(true);
      if (oneFalse.value.isOk()) {
        expect(oneFalse.value.value).toEqual({ result: false });
      }
    }
  });

  it('should OR multiple values', async () => {
    const handler = logicDefinition.validatedHandler;

    const oneTrue = await handler({ operator: 'or', values: [false, false, true] });
    expect(oneTrue.isOk()).toBe(true);
    if (oneTrue.isOk()) {
      expect(oneTrue.value.isOk()).toBe(true);
      if (oneTrue.value.isOk()) {
        expect(oneTrue.value.value).toEqual({ result: true });
      }
    }

    const allFalse = await handler({ operator: 'or', values: [false] });
    expect(allFalse.isOk()).toBe(true);
    if (allFalse.isOk()) {
      expect(allFalse.value.isOk()).toBe(true);
      if (allFalse.value.isOk()) {
        expect(allFalse.value.value).toEqual({ result: false });
      }
    }
  });

  it('should NOT a single value', async () => {
    const handler = logicDefinition.validatedHandler;
    const result = await handler({ operator: 'not', values: [false] });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ result: true });
      }
    }
  });

  it('should return an inner error for empty and/or arrays', async () => {
    const handler = logicDefinition.validatedHandler;
    const result = await handler({ operator: 'and', values: [] });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isErr()).toBe(true);
      if (result.value.isErr()) {
        expect(result.value.error.message).toContain('and');
      }
    }
  });

  it('should return an inner error for not with more than one value', async () => {
    const handler = logicDefinition.validatedHandler;
    const result = await handler({ operator: 'not', values: [true, false] });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isErr()).toBe(true);
    }
  });

  it('should return an outer validation error for an unknown operator', async () => {
    const handler = logicDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid operator
    const result = await handler({ operator: 'xor', values: [true] });

    expect(result.isErr()).toBe(true);
  });

  it('should return an outer validation error for a non-boolean array member', async () => {
    const handler = logicDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid array member type
    const result = await handler({ operator: 'or', values: [true, 1] });

    expect(result.isErr()).toBe(true);
  });
});
