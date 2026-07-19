import { ok } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const echoDefinition = createOperationDefinition(
  './value-ops/echo.definition.js',
  async (input) => {
    return ok({ value: input.value });
  },
);

export default echoDefinition;
