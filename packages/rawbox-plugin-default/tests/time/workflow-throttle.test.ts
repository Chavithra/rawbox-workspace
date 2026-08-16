import { expect, test } from 'vitest';
import workflowThrottleDefinition from '../../src/time/workflow-throttle.definition.js';

test('workflow throttle operation should wait for specified time', async () => {
  const start = Date.now();
  const ms = 100;
  const result = await workflowThrottleDefinition.handler({ ms });
  const duration = Date.now() - start;
  
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.throttledMs).toBe(ms);
    expect(result.value.timestamp).toBeGreaterThanOrEqual(start);
  }
  // Allow a small 10ms boundary margin for timer scheduling variances
  expect(duration).toBeGreaterThanOrEqual(ms - 10);
});

test('workflow throttle operation should throttle correctly when lastTimestamp is provided', async () => {
  const ms = 100;
  
  const lastTimestamp = Date.now() - 40;
  const start = Date.now();
  const result = await workflowThrottleDefinition.handler({ ms, lastTimestamp });
  const duration = Date.now() - start;
  
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    // Expected remaining throttle time is around 60ms
    expect(result.value.throttledMs).toBeLessThanOrEqual(65);
    expect(result.value.throttledMs).toBeGreaterThanOrEqual(50);
    expect(result.value.timestamp).toBeGreaterThanOrEqual(start);
  }
  expect(duration).toBeGreaterThanOrEqual(50);
});

test('workflow throttle operation should not wait if elapsed time is greater than or equal to ms', async () => {
  const ms = 100;
  
  const lastTimestamp = Date.now() - 150;
  const start = Date.now();
  const result = await workflowThrottleDefinition.handler({ ms, lastTimestamp });
  const duration = Date.now() - start;
  
  expect(result.isOk()).toBe(true);
  if (result.isOk()) {
    expect(result.value.throttledMs).toBe(0);
    expect(result.value.timestamp).toBeGreaterThanOrEqual(start);
  }
  expect(duration).toBeLessThan(25);
});
