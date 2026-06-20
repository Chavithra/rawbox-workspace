import { describe, it, expect } from 'vitest';
import mulDefinition from '../../src/maths/mul.definition.js';

describe('mul.definition', () => {
  it('should multiply three numbers correctly', async () => {
    const handler = mulDefinition.validatedHandler;
    const result = await handler({ a: 2, b: 3, c: 4 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: 24 });
      }
    }
  });

  it('should return error for missing parameters', async () => {
    const handler = mulDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ a: 5, b: 7 });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message || result.error).toContain('Input validation error');
    }
  });
});
