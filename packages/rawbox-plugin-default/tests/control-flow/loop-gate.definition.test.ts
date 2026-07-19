import { describe, it, expect } from 'vitest';
import loopGateDefinition from '../../src/control-flow/definitions/loop-gate.definition.js';

describe('loop-gate.definition', () => {
  it('should jump to loopLabel when counter < max', async () => {
    const handler = loopGateDefinition.validatedHandler;
    const result = await handler({ counter: 0, max: 3, loopLabel: 'body', exitLabel: 'done' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: 'body' });
      }
    }
  });

  it('should jump to exitLabel when counter equals max (strict <)', async () => {
    const handler = loopGateDefinition.validatedHandler;
    const result = await handler({ counter: 3, max: 3, loopLabel: 'body', exitLabel: 'done' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: 'done' });
      }
    }
  });

  it('should jump to exitLabel when counter exceeds max', async () => {
    const handler = loopGateDefinition.validatedHandler;
    const result = await handler({ counter: 5, max: 3, loopLabel: 'body', exitLabel: 'done' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: 'done' });
      }
    }
  });

  it('should return an outer validation error for a NaN counter', async () => {
    // TypeBox's Type.Number() schema rejects NaN (JSON has no NaN
    // representation), so this never reaches the handler's comparison logic —
    // it fails fast at input validation instead.
    const handler = loopGateDefinition.validatedHandler;
    const result = await handler({ counter: NaN, max: 3, loopLabel: 'body', exitLabel: 'done' });

    expect(result.isErr()).toBe(true);
  });

  it('should return validation error for missing max', async () => {
    const handler = loopGateDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ counter: 0, loopLabel: 'body', exitLabel: 'done' });

    expect(result.isErr()).toBe(true);
  });
});
