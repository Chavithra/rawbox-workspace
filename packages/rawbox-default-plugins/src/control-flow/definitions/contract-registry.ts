import { Type } from 'typebox';
import {
  getControlFlowDefinitionBuilder,
  setupControlFlowContractRegistry,
} from 'rawbox-plugin';
import type { ControlFlowDefinitionBuilder } from 'rawbox-plugin/control-flow';
import type { SpecificContractRegistry } from 'rawbox-plugin/core';

const contractRecord = {
  './goto.definition.js': {
    type: 'control-flow',
    description: 'Sum two numbers',
    inputSchema: Type.Object({
      condition: Type.Boolean(),
      label: Type.String(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
} as const;

export const contractRegistry: SpecificContractRegistry<typeof contractRecord> =
  setupControlFlowContractRegistry({
    contractRecord,
  });

export const createControlFlowDefinition: ControlFlowDefinitionBuilder<
  typeof contractRecord
>['createDefinition'] = getControlFlowDefinitionBuilder(contractRegistry);

export default contractRegistry;
