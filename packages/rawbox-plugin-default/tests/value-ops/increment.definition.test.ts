import { describe, it, expect } from 'vitest';
import incrementDefinition from '../../src/value-ops/increment.definition.js';

describe('increment.definition', () => {
  it('should default step to 1', async () => {
    const handler = incrementDefinition.validatedHandler;
    const result = await handler({ value: 4 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: 5 });
      }
    }
  });

  it('should add the given step', async () => {
    const handler = incrementDefinition.validatedHandler;
    const result = await handler({ value: 4, step: 3 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: 7 });
      }
    }
  });

  it('should leave value unchanged for an explicit step of 0', async () => {
    const handler = incrementDefinition.validatedHandler;
    const result = await handler({ value: 4, step: 0 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: 4 });
      }
    }
  });

  it('should support negative steps for countdown loops', async () => {
    const handler = incrementDefinition.validatedHandler;
    const result = await handler({ value: 10, step: -2 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: 8 });
      }
    }
  });

  it('should return validation error for a non-number value', async () => {
    const handler = incrementDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ value: '4' });

    expect(result.isErr()).toBe(true);
  });
});
