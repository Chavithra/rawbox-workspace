import { setupContractRegistry } from './core/index.js';
import type {
  ContractRecord,
  ObjectSchemaLike,
  SpecificContractRegistry,
} from './core/index.js';
import { getOperationDefinitionBuilder } from './operation/index.js';
import type { OperationContract } from './operation/index.js';
import { getControlFlowDefinitionBuilder } from './control-flow/index.js';
import type { ControlFlowContract } from './control-flow/index.js';

export function setupPluginRegistry<
  TOperationsRecord extends ContractRecord<
    OperationContract<ObjectSchemaLike, ObjectSchemaLike, ObjectSchemaLike>
  > = Record<string, never>,
  TControlFlowRecord extends ContractRecord<
    ControlFlowContract<ObjectSchemaLike, ObjectSchemaLike>
  > = Record<string, never>,
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

  // The merged registry is re-narrowed to each half's record type; the runtime
  // shape is identical, only the record's static type differs.
  const createOperationDefinition = getOperationDefinitionBuilder<TOperationsRecord>({
    ...contractRegistry,
    contractRecord: opsRecord,
  } as SpecificContractRegistry<TOperationsRecord>);

  const createControlFlowDefinition = getControlFlowDefinitionBuilder<TControlFlowRecord>({
    ...contractRegistry,
    contractRecord: cfRecord,
  } as SpecificContractRegistry<TControlFlowRecord>);

  return {
    contractRegistry,
    createOperationDefinition,
    createControlFlowDefinition,
  };
}
