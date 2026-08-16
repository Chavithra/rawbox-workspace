import type {
  ContractRecord,
  ContractRegistryPath,
  ObjectSchemaLike,
  SpecificContractRegistry,
} from '../../core/contracts/contract-registry-types.js';
import { setupContractRegistry } from '../../core/contracts/contract-registry-utils.js';
import type { OperationContract } from './operation-contract-types.js';

export function operationContractGuard(
  contract: object,
): contract is OperationContract {
  return (
    typeof contract === 'object' &&
    contract !== null &&
    'type' in contract &&
    contract.type === 'operation' &&
    'inputSchema' in contract &&
    'outputSchema' in contract &&
    'errorSchema' in contract &&
    'version' in contract
  );
}

export const setupOperationContractRegistry = <
  TContractRecord extends ContractRecord<OperationContract>,
>(options: {
  contractRecord: TContractRecord;
  contractRegistryPath?: ContractRegistryPath;
}): SpecificContractRegistry<TContractRecord> =>
  setupContractRegistry<TContractRecord>(options, 3);

export function setupOperationContract<
  ErrorSchema extends ObjectSchemaLike = ObjectSchemaLike,
  InputSchema extends ObjectSchemaLike = ObjectSchemaLike,
  OutputSchema extends ObjectSchemaLike = ObjectSchemaLike,
>(
  operationContract: OperationContract<ErrorSchema, InputSchema, OutputSchema>,
) {
  return operationContract;
}
