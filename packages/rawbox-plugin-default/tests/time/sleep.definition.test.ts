import { expect, test } from 'vitest';
import sleepDefinition from '../../src/time/sleep.definition.js';

test('sleep operation should wait for the specified duration', async () => {
  const start = Date.now();
  const ms = 100;
  const result = await sleepDefinition.handler({ ms });
  const duration = Date.now() - start;

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.timestamp).toBeGreaterThanOrEqual(start);
  }
  // Allow a small 10ms boundary margin for timer scheduling variances
  expect(duration).toBeGreaterThanOrEqual(ms - 10);
});

test('sleep operation should resolve almost immediately when ms is 0', async () => {
  const start = Date.now();
  const result = await sleepDefinition.handler({ ms: 0 });
  const duration = Date.now() - start;

  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.timestamp).toBeGreaterThanOrEqual(start);
  }
  expect(duration).toBeLessThan(25);
});

test('sleep operation should return validation error for negative ms', async () => {
  const handler = sleepDefinition.validatedHandler;
  // `-5` is a perfectly valid `number`, so this is not a type error — the
  // contract's `minimum: 0` is a runtime constraint, and rejecting it is
  // exactly what `validatedHandler` exists to do.
  const result = await handler({ ms: -5 });

  expect(result.isErr()).toBe(true);
});
