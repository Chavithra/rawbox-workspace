import { describe, it, expect } from 'vitest';
import jumpDefinition from '../../src/control-flow/definitions/jump.definition.js';

describe('jump.definition', () => {
  it('should return the next step label successfully', async () => {
    const handler = jumpDefinition.validatedHandler;
    const result = await handler({ condition: true, label: 'step_2' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: 'step_2' });
      }
    }
  });

  it('should return validation error for missing label', async () => {
    const handler = jumpDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ condition: false });

    expect(result.isErr()).toBe(true);
  });
});
