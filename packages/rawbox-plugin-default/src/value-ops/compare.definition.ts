import { err, ok } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const compareDefinition = createOperationDefinition(
  './value-ops/compare.definition.js',
  async (input) => {
    const { a, b, operator } = input;

    if (operator === 'eq') {
      return ok({ result: a === b });
    }

    if (operator === 'ne') {
      return ok({ result: a !== b });
    }

    const sameOrderableType =
      typeof a === typeof b &&
      (typeof a === 'number' || typeof a === 'string');

    if (!sameOrderableType) {
      return err({
        message: `Cannot order ${typeof a} against ${typeof b}`,
      });
    }

    switch (operator) {
      case 'gt':
        return ok({ result: a > b });
      case 'gte':
        return ok({ result: a >= b });
      case 'lt':
        return ok({ result: a < b });
      case 'lte':
        return ok({ result: a <= b });
    }
  },
);

export default compareDefinition;
