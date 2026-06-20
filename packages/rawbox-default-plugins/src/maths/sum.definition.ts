import { ok } from 'neverthrow';
import { createOperationDefinition } from './contract-registry.js';

const operationDefinition = createOperationDefinition(
  './sum.definition.js',
  async (input) => {
    const { a, b } = input;
    return ok({ value: a + b });
  },
);

export default operationDefinition;
