import { describe, it, expect, vi, afterEach } from 'vitest';
import { setRunEventChannel } from '@rawbox/plugin/core';
import type { HostRunEvent } from '@rawbox/plugin';
import haltDefinition from '../../src/control-flow/halt.definition.js';

afterEach(() => {
  vi.restoreAllMocks();
  setRunEventChannel(undefined);
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

  it('should route the reason through the host run-event channel when one is installed, without touching console', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const emitted: HostRunEvent[] = [];
    setRunEventChannel({ emit: (event) => emitted.push(event) });

    const handler = haltDefinition.validatedHandler;
    const result = await handler({ reason: 'deadline exceeded' });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toEqual({ label: '__EXIT__' });
      }
    }

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: 'log',
      level: 'info',
      message: 'Workflow halted: deadline exceeded',
      data: { reason: 'deadline exceeded' },
    });
  });

  it('should return __FAIL__ with the reason attached when fail is true', async () => {
    const handler = haltDefinition.validatedHandler;
    const result = await handler({ reason: 'the position is unhedged', fail: true });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        // The reason travels out only on this path: it is what the runner turns
        // into the run's error message.
        expect(result.value.value).toEqual({
          label: '__FAIL__',
          reason: 'the position is unhedged',
        });
      }
    }
  });

  it('should return __FAIL__ alone when fail is true and no reason is given', async () => {
    const handler = haltDefinition.validatedHandler;
    const result = await handler({ fail: true });

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.isOk()) {
      expect(result.value.value).toEqual({ label: '__FAIL__' });
    }
  });

  it('should return __EXIT__ for an explicit fail: false', async () => {
    const handler = haltDefinition.validatedHandler;
    const result = await handler({ reason: 'all done', fail: false });

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.isOk()) {
      expect(result.value.value).toEqual({ label: '__EXIT__' });
    }
  });

  it('should log a failing halt at error level, so it is classified as an alarm', async () => {
    const emitted: HostRunEvent[] = [];
    setRunEventChannel({ emit: (event) => emitted.push(event) });

    const handler = haltDefinition.validatedHandler;
    await handler({ reason: 'the position is unhedged', fail: true });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: 'log',
      level: 'error',
      message: 'Workflow failed: the position is unhedged',
      data: { reason: 'the position is unhedged' },
    });
  });

  it('should return validation error for a non-boolean fail', async () => {
    const handler = haltDefinition.validatedHandler;
    // @ts-expect-error intentionally testing invalid input
    const result = await handler({ fail: 'yes' });

    expect(result.isErr()).toBe(true);
  });

  it('should not emit through the channel when no reason is given', async () => {
    const emitted: HostRunEvent[] = [];
    setRunEventChannel({ emit: (event) => emitted.push(event) });

    const handler = haltDefinition.validatedHandler;
    await handler({});

    expect(emitted).toHaveLength(0);
  });
});
