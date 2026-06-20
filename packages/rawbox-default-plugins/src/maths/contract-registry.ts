import { Type } from 'typebox';
import {
  setupOperationContractRegistry,
  getOperationDefinitionBuilder,
} from 'rawbox-plugin';
import type { OperationDefinitionBuilder } from 'rawbox-plugin/operation';
import type { SpecificContractRegistry } from 'rawbox-plugin/core';

const contractRecord = {
  './sum.definition.js': {
    type: 'operation',
    description: 'Sum two numbers',
    inputSchema: Type.Object({
      a: Type.Number(),
      b: Type.Number(),
    }),
    outputSchema: Type.Object({
      value: Type.Number(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './mul.definition.js': {
    type: 'operation',
    description: 'Multiply two numbers',
    inputSchema: Type.Object({
      a: Type.Number(),
      b: Type.Number(),
      c: Type.Number(),
    }),
    outputSchema: Type.Object({
      value: Type.Number(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
} as const;

export const contractRegistry: SpecificContractRegistry<typeof contractRecord> =
  setupOperationContractRegistry({
    contractRecord,
  });

export const createOperationDefinition: OperationDefinitionBuilder<
  typeof contractRecord
>['createDefinition'] = getOperationDefinitionBuilder(contractRegistry);

export default contractRegistry;
