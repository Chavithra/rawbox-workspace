import { setupContractRegistry } from './core/index.js';
import { getOperationDefinitionBuilder } from './operation/index.js';
import { getControlFlowDefinitionBuilder } from './control-flow/index.js';

export function setupPluginRegistry<
  TOperationsRecord extends Record<string, any> = Record<string, never>,
  TControlFlowRecord extends Record<string, any> = Record<string, never>,
>(options: {
  operationsRecord?: TOperationsRecord;
  controlFlowRecord?: TControlFlowRecord;
}) {
  const opsRecord = options.operationsRecord ?? ({} as TOperationsRecord);
  const cfRecord = options.controlFlowRecord ?? ({} as TControlFlowRecord);

  const contractRecord = {
    ...opsRecord,
    ...cfRecord,
  };
  const contractRegistry = setupContractRegistry({
    contractRecord,
  }, 3);

  const createOperationDefinition = getOperationDefinitionBuilder<TOperationsRecord>({
    ...contractRegistry,
    contractRecord: opsRecord,
  } as any);

  const createControlFlowDefinition = getControlFlowDefinitionBuilder<TControlFlowRecord>({
    ...contractRegistry,
    contractRecord: cfRecord,
  } as any);

  return {
    contractRegistry,
    createOperationDefinition,
    createControlFlowDefinition,
  };
}
