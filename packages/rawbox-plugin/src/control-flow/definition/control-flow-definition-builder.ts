import type { TObject } from 'typebox';
import type { ControlFlowContract } from '../contract/control-flow-contract-types.js';
import type {
  ContractRecord,
  SpecificContractRegistry,
} from '../../core/contracts/contract-registry-types.js';
import type { Handler } from '../../core/definition/definition-types.js';
import { ControlFlowDefinition, OutputSchema } from './control-flow-definition.js';

export class ControlFlowDefinitionBuilder<
  TContractRecord extends ContractRecord<
    ControlFlowContract<TObject, TObject>
  >,
> {
  public constructor(private readonly contractRecord: TContractRecord) {}

  public createDefinition<K extends Extract<keyof TContractRecord, string>>(
    definitionPath: K,
    handler: Handler<
      TContractRecord[K]['errorSchema'],
      TContractRecord[K]['inputSchema'],
      typeof OutputSchema
    >,
  ): ControlFlowDefinition<TContractRecord[K]> {
    const ContractRecord = this.contractRecord;

    const contract = ContractRecord[definitionPath];
    if (!contract) {
      throw new Error(
        `Contract for definition path "${definitionPath}" not found`,
      );
    }
    const controlFlowDefinition = new ControlFlowDefinition(contract, handler);

    return controlFlowDefinition;
  }

  public getDefinitionCreator(): this['createDefinition'] {
    return this.createDefinition.bind(this) as this['createDefinition'];
  }
}

export function getControlFlowDefinitionBuilder<
  TContractRecord extends ContractRecord<
    ControlFlowContract<TObject, TObject>
  >,
>(
  contractRegistry: SpecificContractRegistry<TContractRecord>,
): ControlFlowDefinitionBuilder<TContractRecord>['createDefinition'] {
  const builder = new ControlFlowDefinitionBuilder(
    contractRegistry.contractRecord,
  );
  return builder.getDefinitionCreator();
}
