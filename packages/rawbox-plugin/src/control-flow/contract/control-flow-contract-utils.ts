import { type TObject } from 'typebox';

import type {
  ContractRecord,
  ContractRegistryPath,
  SpecificContractRegistry,
} from '../../core/contracts/contract-registry-types.js';
import { setupContractRegistry } from '../../core/contracts/contract-registry-utils.js';
import { type ControlFlowContract } from './control-flow-contract-types.js';

export function controlFlowContractGuard(
  contract: object,
): contract is ControlFlowContract {
  return (
    typeof contract === 'object' &&
    contract !== null &&
    'type' in contract &&
    contract.type === 'control-flow' &&
    'inputSchema' in contract &&
    'errorSchema' in contract &&
    'version' in contract
  );
}

export const setupControlFlowContractRegistry = <
  TContractRecord extends ContractRecord<ControlFlowContract>,
>(options: {
  contractRecord: TContractRecord;
  contractRegistryPath?: ContractRegistryPath;
}): SpecificContractRegistry<TContractRecord> =>
  setupContractRegistry<TContractRecord>(options, 3);

export function setupControlFlowContract<
  TInputSchema extends TObject = TObject,
  TErrorSchema extends TObject = TObject,
>(controlFlowContract: ControlFlowContract<TInputSchema, TErrorSchema>) {
  return controlFlowContract;
}
