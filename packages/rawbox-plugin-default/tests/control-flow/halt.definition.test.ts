import { describe, it, expect, vi, afterEach } from 'vitest';
import haltDefinition from '../../src/control-flow/definitions/halt.definition.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('halt.definition', () => {
  it('should terminate the workflow without logging when no reason is given', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = haltDefinition.validatedHandler;
    const result = await handler({});

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: '__EXIT__' });
      }
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('should log the reason and terminate the workflow', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = haltDefinition.validatedHandler;
    const result = await handler({ reason: 'deadline exceeded' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: '__EXIT__' });
      }
    }
    expect(spy).toHaveBeenCalledOnce();
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ event: 'halt', reason: 'deadline exceeded' });
    expect(typeof line.timestamp).toBe('number');
  });

  it('should log an empty-string reason (it counts as provided)', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = haltDefinition.validatedHandler;
    await handler({ reason: '' });

    expect(spy).toHaveBeenCalledOnce();
  });

  it('should return validation error for a non-string reason', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = haltDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ reason: 42 });

    expect(result.isErr()).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});
