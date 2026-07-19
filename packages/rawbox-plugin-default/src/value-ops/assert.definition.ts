import { err, ok } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const assertDefinition = createOperationDefinition(
  './value-ops/assert.definition.js',
  async (input) => {
    const { condition, message } = input;

    if (condition) {
      return ok({ passed: true });
    }

    return err({ message: message ?? 'Assertion failed' });
  },
);

export default assertDefinition;
