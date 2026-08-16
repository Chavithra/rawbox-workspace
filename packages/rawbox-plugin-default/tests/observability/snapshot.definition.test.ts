import { describe, it, expect, vi, afterEach } from 'vitest';
import { setRunEventChannel } from '@rawbox/plugin/core';
import type { HostRunEvent } from '@rawbox/plugin';
import snapshotDefinition from '../../src/observability/snapshot.definition.js';
import contractRegistry from '../../src/contract-registry.js';
import { SNAPSHOT_VALUE_FIELD_LIST } from '../../src/observability/snapshot-fields.js';

afterEach(() => {
  vi.restoreAllMocks();
  setRunEventChannel(undefined);
});

describe('snapshot.definition', () => {
  it('routes a labelled snapshot through the host run-event channel as one log event', async () => {
    const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const emitted: HostRunEvent[] = [];
    setRunEventChannel({ emit: (event) => emitted.push(event) });

    const handler = snapshotDefinition.validatedHandler;
    const result = await handler({
      label: 'grid vs reconciler',
      value1: { position: 42 },
      value2: 'ok',
    });

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: 'log',
      level: 'info',
      message: 'Snapshot: grid vs reconciler',
      data: { value1: { position: 42 }, value2: 'ok' },
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.isOk()).toBe(true);
      if (result.value.isOk()) {
        expect(result.value.value).toMatchObject({
          label: 'grid vs reconciler',
          snapshot: { value1: { position: 42 }, value2: 'ok' },
          count: 2,
        });
        expect(typeof result.value.value.timestamp).toBe('number');
      }
    }
  });

  it('uses a default message when no label is given', async () => {
    const emitted: HostRunEvent[] = [];
    setRunEventChannel({ emit: (event) => emitted.push(event) });

    const handler = snapshotDefinition.validatedHandler;
    await handler({ value1: 'a' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: 'log',
      level: 'info',
      message: 'Workflow snapshot',
      data: { value1: 'a' },
    });
  });

  it('emits an empty snapshot (count 0) when no values are bound', async () => {
    const emitted: HostRunEvent[] = [];
    setRunEventChannel({ emit: (event) => emitted.push(event) });

    const handler = snapshotDefinition.validatedHandler;
    const result = await handler({});

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      event: 'log',
      level: 'info',
      message: 'Workflow snapshot',
      data: {},
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.isOk()) {
      expect(result.value.value.count).toBe(0);
      expect(result.value.value.snapshot).toEqual({});
      expect(result.value.value).not.toHaveProperty('label');
    }
  });

  it('carries only the value fields that were actually bound, keyed by field name', async () => {
    const emitted: HostRunEvent[] = [];
    setRunEventChannel({ emit: (event) => emitted.push(event) });

    const handler = snapshotDefinition.validatedHandler;
    await handler({ value1: 1, value4: 4, value8: 8 });

    expect(emitted[0]?.data).toEqual({ value1: 1, value4: 4, value8: 8 });
  });

  it('falls back to console.info when no channel is installed', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = snapshotDefinition.validatedHandler;

    const result = await handler({ label: 'no channel', value1: 'x' });

    expect(spy).toHaveBeenCalledOnce();
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line).toMatchObject({
      level: 'info',
      message: 'Snapshot: no channel',
      data: { value1: 'x' },
    });
    expect(typeof line.timestamp).toBe('number');

    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.isOk()) {
      expect(result.value.value.snapshot).toEqual({ value1: 'x' });
    }
  });

  it('falls back to console.info with an empty data object when nothing is bound', async () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const handler = snapshotDefinition.validatedHandler;

    await handler({});

    expect(spy).toHaveBeenCalledOnce();
    const line = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(line.data).toEqual({});
    expect(line.message).toBe('Workflow snapshot');
  });

  it('accepts a value bound on every declared value field', async () => {
    const emitted: HostRunEvent[] = [];
    setRunEventChannel({ emit: (event) => emitted.push(event) });

    const input = Object.fromEntries(
      SNAPSHOT_VALUE_FIELD_LIST.map((field, index) => [field, index]),
    );

    const handler = snapshotDefinition.validatedHandler;
    const result = await handler(input);

    expect(emitted[0]?.data).toEqual(input);
    expect(result.isOk()).toBe(true);
    if (result.isOk() && result.value.isOk()) {
      expect(result.value.value.count).toBe(SNAPSHOT_VALUE_FIELD_LIST.length);
    }
  });

  it('declares exactly the shared value-field list on its inputSchema, so the schema and handler cannot drift', () => {
    const contract =
      contractRegistry.contractRecord['./observability/snapshot.definition.js'];
    expect(contract?.type).toBe('operation');
    const properties = (
      contract as { inputSchema: { properties: Record<string, unknown> } }
    ).inputSchema.properties;

    const declaredValueFields = Object.keys(properties)
      .filter((field) => field !== 'label')
      .sort();

    expect(declaredValueFields).toEqual(
      [...SNAPSHOT_VALUE_FIELD_LIST].sort(),
    );
  });
});
