import { ok } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const incrementDefinition = createOperationDefinition(
  './value-ops/increment.definition.js',
  async (input) => {
    const { value, step } = input;

    return ok({ value: value + (step ?? 1) });
  },
);

export default incrementDefinition;
