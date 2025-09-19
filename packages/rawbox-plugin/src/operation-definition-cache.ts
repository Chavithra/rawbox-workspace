import {
  OperationContract,
  operationContractGuard,
  OperationDefinition,
} from "./operation-definition.js";
import {
  createLoadDefinition,
  createDefinitionCache,
  DefinitionCache,
} from "./definition-cache.js";
import { Contract, ContractsRegistry } from "./contracts-registry.js";
import { Result } from "neverthrow";
import { Static, TObject, Type } from "@sinclair/typebox";
import {
  Definition,
  DefinitionLocation,
  DefinitionPath,
  ValidationError,
} from "./definition.js";
import { definitionGuard } from "./definition-utils.js";

const AnyObjectSchema = Type.Object({});

export type OperationContractAnyObjectSchema = OperationContract<
  typeof AnyObjectSchema,
  typeof AnyObjectSchema,
  typeof AnyObjectSchema
>;

export const loadOperationDefinition = createLoadDefinition<
  OperationContractAnyObjectSchema,
  OperationDefinition<OperationContractAnyObjectSchema>
>(operationContractGuard);

export const OperationDefinitionCache = createDefinitionCache<
  OperationContractAnyObjectSchema,
  OperationDefinition<OperationContractAnyObjectSchema>
>(loadOperationDefinition);

export type OperationDefinitionCache = InstanceType<
  typeof OperationDefinitionCache
>;

export class OperationDynamicCaller<
  TContractsRegistry extends ContractsRegistry<OperationContract>,
> {
  public constructor(private contractsRegistry: TContractsRegistry) {}

  public async callDefinition<
    TDefinitionPath extends Extract<
      keyof TContractsRegistry["contractsRecord"],
      string
    >,
  >(
    definitionPath: TDefinitionPath,
    handler: Static<
      TContractsRegistry["contractsRecord"][TDefinitionPath]["inputSchema"]
    >
  ): Promise<
    Result<
      Static<
        TContractsRegistry["contractsRecord"][TDefinitionPath]["outputSchema"]
      >,
      | Static<
          TContractsRegistry["contractsRecord"][TDefinitionPath]["errorSchema"]
        >
      | ValidationError
    >
  > {
    const contractsRegistry = this.contractsRegistry;

    const contractsRegistryPath = contractsRegistry.contractsRegistryPath;

    const definitionLocation: DefinitionLocation = {
      contractsRegistryPath,
      definitionPath,
    };

    const resultOfLoadOperationDefinition =
      await loadOperationDefinition(definitionLocation);

    if (resultOfLoadOperationDefinition.isOk()) {
      const definition = resultOfLoadOperationDefinition.value;
      if (definitionGuard(definition)) {
        const contract = definition.contract;
        if (operationContractGuard(contract)) {
          return await definition.validatedHandler(handler);
        }
      }
    }
    throw new Error("Unknown contract type");
  }
}
