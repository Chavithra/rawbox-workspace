import { ok } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const workflowThrottleDefinition = createOperationDefinition(
  './time/workflow-throttle.definition.js',
  async (input) => {
    const { ms, lastTimestamp } = input;
    let sleepMs = Math.max(0, ms);

    if (typeof lastTimestamp === 'number') {
      const elapsed = Date.now() - lastTimestamp;
      sleepMs = Math.max(0, ms - elapsed);
    }

    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }

    return ok({
      throttledMs: sleepMs,
      timestamp: Date.now(),
    });
  }
);

export default workflowThrottleDefinition;
