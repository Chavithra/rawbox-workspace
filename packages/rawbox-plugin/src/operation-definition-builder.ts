import type {
  ContractsRecord,
  ContractsRegistry,
} from "./contracts-registry.js";
import type { Handler } from "./definition.js";
import {
  type OperationContract,
  OperationDefinition,
} from "./operation-definition.js";

export class OperationDefinitionBuilder<
  TContractsRecord extends ContractsRecord<OperationContract>,
> {
  public constructor(private readonly contractsRecord: TContractsRecord) {}

  public createDefinition<K extends Extract<keyof TContractsRecord, string>>(
    definitionPath: K,
    handler: Handler<
      TContractsRecord[K]["errorSchema"],
      TContractsRecord[K]["inputSchema"],
      TContractsRecord[K]["outputSchema"]
    >
  ): OperationDefinition<
    OperationContract<
      TContractsRecord[K]["errorSchema"],
      TContractsRecord[K]["inputSchema"],
      TContractsRecord[K]["outputSchema"]
    >
  > {
    const contractsRecord = this.contractsRecord;

    const contract = contractsRecord[definitionPath];
    const operationDefinition = new OperationDefinition<
      OperationContract<
        TContractsRecord[K]["errorSchema"],
        TContractsRecord[K]["inputSchema"],
        TContractsRecord[K]["outputSchema"]
      >
    >(contract, handler);

    return operationDefinition;
  }

  /**
   * Returns a bound version of createDefinition.
   */
  public getDefinitionCreator(): this["createDefinition"] {
    return this.createDefinition.bind(this) as this["createDefinition"];
  }
}

export function getOperationDefinitionCreator<
  TContractsRegistry extends ContractsRegistry<OperationContract>,
>(
  contractsRegistry: TContractsRegistry
): OperationDefinitionBuilder<
  TContractsRegistry["contractsRecord"]
>["createDefinition"] {
  const builder = new OperationDefinitionBuilder(
    contractsRegistry.contractsRecord
  );
  return builder.getDefinitionCreator();
}
