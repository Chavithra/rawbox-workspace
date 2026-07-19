import { describe, it, expect, vi, afterEach } from 'vitest';
import logDefinition from '../../src/observability/log.definition.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('log.definition', () => {
  it('should write a structured line with data via console.info', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = logDefinition.validatedHandler;
    const result = await handler({ level: 'info', message: 'hi', data: { a: 1 } });

    expect(spy).toHaveBeenCalledOnce();
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ level: 'info', message: 'hi', data: { a: 1 } });
    expect(typeof line.timestamp).toBe('number');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value.timestamp).toBe(line.timestamp);
      }
    }
  });

  it('should omit the data key when not provided, via console.error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const handler = logDefinition.validatedHandler;
    await handler({ level: 'error', message: 'boom' });

    expect(spy).toHaveBeenCalledOnce();
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).not.toHaveProperty('data');
    expect(line.level).toBe('error');
    expect(line.message).toBe('boom');
  });

  it('should fall back to [unserializable] for circular data', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = logDefinition.validatedHandler;

    const c: any = {};
    c.self = c;

    const result = await handler({ level: 'warn', message: 'circular', data: c });

    expect(spy).toHaveBeenCalledOnce();
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line.data).toBe('[unserializable]');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
    }
  });

  it('should return a validation error for an unknown level without logging', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const handler = logDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid level
    const result = await handler({ level: 'verbose', message: 'x' });

    expect(result.isErr()).toBe(true);
    expect(debugSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
