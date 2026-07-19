import { ok } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const sleepDefinition = createOperationDefinition(
  './time/sleep.definition.js',
  async (input) => {
    const { ms } = input;

    if (ms > 0) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    }

    return ok({
      timestamp: Date.now(),
    });
  }
);

export default sleepDefinition;
