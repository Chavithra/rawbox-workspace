import { err, ok } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const logicDefinition = createOperationDefinition(
  './value-ops/logic.definition.js',
  async (input) => {
    const { operator, values } = input;

    if (operator === 'not') {
      if (values.length !== 1) {
        return err({
          message: `Operator 'not' requires exactly one value, got ${values.length}`,
        });
      }
      return ok({ result: !values[0]! });
    }

    if (values.length === 0) {
      return err({
        message: `Operator '${operator}' requires at least one value`,
      });
    }

    if (operator === 'and') {
      return ok({ result: values.every(Boolean) });
    }

    return ok({ result: values.some(Boolean) });
  },
);

export default logicDefinition;
