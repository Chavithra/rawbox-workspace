import { describe, it, expect } from 'vitest';
import echoDefinition from '../../src/value-ops/echo.definition.js';

describe('echo.definition', () => {
  it('should pass through a number unchanged', async () => {
    const handler = echoDefinition.validatedHandler;
    const result = await handler({ value: 42 });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: 42 });
      }
    }
  });

  it('should pass through a string unchanged', async () => {
    const handler = echoDefinition.validatedHandler;
    const result = await handler({ value: 'hello' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: 'hello' });
      }
    }
  });

  it('should pass through null unchanged', async () => {
    const handler = echoDefinition.validatedHandler;
    const result = await handler({ value: null });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: null });
      }
    }
  });

  it('should pass through a nested object structure unchanged', async () => {
    const handler = echoDefinition.validatedHandler;
    const nested = { nested: { list: [1, 2, 3] } };
    const result = await handler({ value: nested });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: nested });
      }
    }
  });

  it('should pass through a falsy boolean unchanged', async () => {
    const handler = echoDefinition.validatedHandler;
    const result = await handler({ value: false });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ value: false });
      }
    }
  });
});
