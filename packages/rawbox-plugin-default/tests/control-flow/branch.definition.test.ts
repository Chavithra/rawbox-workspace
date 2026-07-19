import { describe, it, expect } from 'vitest';
import branchDefinition from '../../src/control-flow/definitions/branch.definition.js';

describe('branch.definition', () => {
  it('should jump to thenLabel when condition is true', async () => {
    const handler = branchDefinition.validatedHandler;
    const result = await handler({ condition: true, thenLabel: 'a', elseLabel: 'b' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: 'a' });
      }
    }
  });

  it('should jump to elseLabel when condition is false', async () => {
    const handler = branchDefinition.validatedHandler;
    const result = await handler({ condition: false, thenLabel: 'a', elseLabel: 'b' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: 'b' });
      }
    }
  });

  it('should pass through reserved labels untouched', async () => {
    const handler = branchDefinition.validatedHandler;
    const result = await handler({
      condition: false,
      thenLabel: 'a',
      elseLabel: '__EXIT__',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: '__EXIT__' });
      }
    }
  });

  it('should return validation error for missing elseLabel', async () => {
    const handler = branchDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ condition: true, thenLabel: 'a' });

    expect(result.isErr()).toBe(true);
  });

  it('should return validation error for non-boolean condition', async () => {
    const handler = branchDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ condition: 'yes', thenLabel: 'a', elseLabel: 'b' });

    expect(result.isErr()).toBe(true);
  });
});
