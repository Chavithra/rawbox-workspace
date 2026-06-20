import { describe, it, expect } from 'vitest';
import sumDefinition from '../../src/maths/sum.definition.js';

describe('sum.definition', () => {
  it('should sum two numbers correctly', async () => {
    const handler = sumDefinition.validatedHandler;
    const result = await handler({ a: 5, b: 7 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: 12 });
      }
    }
  });

  it('should return error for invalid input types', async () => {
    const handler = sumDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ a: 5, b: '7' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message || result.error).toContain('Input validation error');
    }
  });
});
