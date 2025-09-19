import type {
  ContractsRecord,
  ContractsRegistry,
} from "rawbox-plugin/contracts-registry";
import type { Handler } from "rawbox-plugin/definition";
import {
  ControlFlowContract,
  ControlFlowDefinition,
  OutputSchema,
} from "./control-flow-definition.js";

export class ControlFlowDefinitionBuilder<
  TContractsRecord extends ContractsRecord<ControlFlowContract>
> {
  public constructor(private readonly contractsRecord: TContractsRecord) {}

  public createDefinition<K extends Extract<keyof TContractsRecord, string>>(
    definitionPath: K,
    handler: Handler<
      TContractsRecord[K]["errorSchema"],
      TContractsRecord[K]["inputSchema"],
      typeof OutputSchema
    >
  ): ControlFlowDefinition<
    ControlFlowContract<
      TContractsRecord[K]["errorSchema"],
      TContractsRecord[K]["inputSchema"]
    >
  > {
    const contractsRecord = this.contractsRecord;

    const contract = contractsRecord[definitionPath];
    const operationDefinition = new ControlFlowDefinition<
      ControlFlowContract<
        TContractsRecord[K]["errorSchema"],
        TContractsRecord[K]["inputSchema"]
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

export function getControlFlowDefinitionCreator<
  TContractsRegistry extends ContractsRegistry<ControlFlowContract>
>(
  contractsRegistry: TContractsRegistry
): ControlFlowDefinitionBuilder<
  TContractsRegistry["contractsRecord"]
>["createDefinition"] {
  const builder = new ControlFlowDefinitionBuilder(
    contractsRegistry.contractsRecord
  );
  return builder.getDefinitionCreator();
}
