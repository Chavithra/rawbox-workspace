import { type OperationContract } from '../contract/operation-contract-types.js';
import { operationContractGuard } from '../contract/operation-contract-utils.js';
import { OperationDefinition } from './operation-definition.js';
import {
  createLoadDefinition,
  createDefinitionCache,
} from '../../core/definition/definition-cache.js';
import { type ContractRegistry } from '../../core/contracts/contract-registry-types.js';
import { type Static, type TObject } from 'typebox';
import type {
  DefinitionLocation,
  ValidatedResult,
  ValidatedHandler,
} from '../../core/definition/definition-types.js';

export type OperationContractAnyObjectSchema = OperationContract<
  TObject,
  TObject,
  TObject
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
  TContractRegistry extends ContractRegistry<OperationContract>,
> {
  public constructor(private contractRegistry: TContractRegistry) {}

  public async callDefinition<
    TDefinitionPath extends Extract<
      keyof TContractRegistry['contractRecord'],
      string
    >,
  >(
    definitionPath: TDefinitionPath,
    input: Static<
      TContractRegistry['contractRecord'][TDefinitionPath]['inputSchema']
    >,
  ): Promise<
    ValidatedResult<
      TContractRegistry['contractRecord'][TDefinitionPath]['errorSchema'],
      TContractRegistry['contractRecord'][TDefinitionPath]['outputSchema']
    >
  > {
    const registry = this.contractRegistry;

    const contractRegistryPath = registry.contractRegistryPath;

    const definitionLocation: DefinitionLocation = {
      contractRegistryPath,
      definitionPath,
    };

    const resultOfLoadOperationDefinition =
      await loadOperationDefinition(definitionLocation);

    if (resultOfLoadOperationDefinition.isOk()) {
      const definition = resultOfLoadOperationDefinition.value;
      const validatedHandler =
        definition.validatedHandler as unknown as ValidatedHandler<
          TContractRegistry['contractRecord'][TDefinitionPath]['errorSchema'],
          TContractRegistry['contractRecord'][TDefinitionPath]['inputSchema'],
          TContractRegistry['contractRecord'][TDefinitionPath]['outputSchema']
        >;

      return await validatedHandler(input);
    }
    throw new Error(
      `Failed to load operation definition from path "${definitionPath}": ${resultOfLoadOperationDefinition.error}`,
    );
  }
}
