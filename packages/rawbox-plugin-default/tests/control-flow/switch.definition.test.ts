import { describe, it, expect } from 'vitest';
import switchDefinition from '../../src/control-flow/definitions/switch.definition.js';

describe('switch.definition', () => {
  it('should jump to the mapped label for a matching case', async () => {
    const handler = switchDefinition.validatedHandler;
    const result = await handler({
      value: 'buy',
      caseMap: { buy: 'buy-step', sell: 'sell-step' },
      defaultLabel: 'skip',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: 'buy-step' });
      }
    }
  });

  it('should jump to defaultLabel when value has no matching case', async () => {
    const handler = switchDefinition.validatedHandler;
    const result = await handler({
      value: 'hold',
      caseMap: { buy: 'buy-step', sell: 'sell-step' },
      defaultLabel: 'skip',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: 'skip' });
      }
    }
  });

  it('should not treat inherited keys as cases', async () => {
    const handler = switchDefinition.validatedHandler;
    const result = await handler({
      value: 'toString',
      caseMap: { buy: 'buy-step' },
      defaultLabel: 'skip',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: 'skip' });
      }
    }
  });

  it('should always use defaultLabel for an empty caseMap', async () => {
    const handler = switchDefinition.validatedHandler;
    const result = await handler({
      value: 'x',
      caseMap: {},
      defaultLabel: '__EXIT__',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: '__EXIT__' });
      }
    }
  });

  it('should return validation error for missing defaultLabel', async () => {
    const handler = switchDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ value: 'buy', caseMap: { buy: 'buy-step' } });

    expect(result.isErr()).toBe(true);
  });

  it('should return validation error for a non-string caseMap value', async () => {
    const handler = switchDefinition.validatedHandler;
    const result = await handler({
      value: 'buy',
      // @ts-expect-error intentionally testing invalid case value type
      caseMap: { buy: 7 },
      defaultLabel: 'skip',
    });

    expect(result.isErr()).toBe(true);
  });
});
