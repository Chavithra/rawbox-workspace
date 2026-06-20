import { ok } from 'neverthrow';
import { contractRegistry } from './demo-registry.js';
import { getOperationDefinitionBuilder } from '../operation/definition/operation-definition-builder.js';

const operationDefinitionBuilder =
  getOperationDefinitionBuilder(contractRegistry);

const operationDefinition = operationDefinitionBuilder(
  './mul-definition.js',
  async (input) => {
    const { a, b, c } = input;
    return ok({ value: a * b * c });
  },
);

export default operationDefinition;

const result = await operationDefinition.validatedHandler({ a: 1, b: 2, c: 3 });

console.log(result._unsafeUnwrap()._unsafeUnwrap());
