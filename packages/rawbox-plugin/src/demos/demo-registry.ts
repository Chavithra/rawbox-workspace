import { Type } from 'typebox';
import { setupOperationContractRegistry } from '../operation/contract/operation-contract-utils.js';

export const contractRegistry = setupOperationContractRegistry({
  contractRecord: {
    './sum-definition.js': {
      type: 'operation',
      description: 'Adds numbers',
      inputSchema: Type.Object({ a: Type.Number() }),
      outputSchema: Type.Object({ res: Type.Number() }),
      errorSchema: Type.Object({ msg: Type.String() }),
      version: '1.0.0',
    },
    './mul-definition.js': {
      type: 'operation',
      description: 'Multiply two numbers',
      inputSchema: Type.Object({
        a: Type.Number(),
        b: Type.Number(),
        c: Type.Number(),
      }),
      outputSchema: Type.Object({ value: Type.Number() }),
      errorSchema: Type.Object({ message: Type.String() }),
      version: '1.0.0',
    },
  },
});
