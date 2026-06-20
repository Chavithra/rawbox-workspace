import type { TObject } from 'typebox';
import type { OperationContract } from '../contract/operation-contract-types.js';
import type {
  ContractRecord,
  SpecificContractRegistry,
} from '../../core/contracts/contract-registry-types.js';
import type { Handler } from '../../core/definition/definition-types.js';
import { OperationDefinition } from './operation-definition.js';

/**
 * Builder class to create OperationDefinition instances from contracts with type-safe handler binding
 */
export class OperationDefinitionBuilder<
  TContractRecord extends ContractRecord<
    OperationContract<TObject, TObject, TObject>
  >,
> {
  public constructor(private readonly contractRecord: TContractRecord) {}

  public createDefinition<K extends Extract<keyof TContractRecord, string>>(
    definitionPath: K,
    handler: Handler<
      TContractRecord[K]['errorSchema'],
      TContractRecord[K]['inputSchema'],
      TContractRecord[K]['outputSchema']
    >,
  ): OperationDefinition<TContractRecord[K]> {
    const ContractRecord = this.contractRecord;

    const contract = ContractRecord[definitionPath];
    if (!contract) {
      throw new Error(
        `Contract for definition path "${definitionPath}" not found`,
      );
    }
    const operationDefinition = new OperationDefinition(contract, handler);

    return operationDefinition;
  }

  /**
   * Returns a bound version of createDefinition.
   */
  public getDefinitionCreator(): this['createDefinition'] {
    return this.createDefinition.bind(this) as this['createDefinition'];
  }
}

export function getOperationDefinitionBuilder<
  TContractRecord extends ContractRecord<
    OperationContract<TObject, TObject, TObject>
  >,
>(
  contractRegistry: SpecificContractRegistry<TContractRecord>,
): OperationDefinitionBuilder<TContractRecord>['createDefinition'] {
  const builder = new OperationDefinitionBuilder(
    contractRegistry.contractRecord,
  );
  return builder.getDefinitionCreator();
}
