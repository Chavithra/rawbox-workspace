import { type ControlFlowContract } from '../contract/control-flow-contract-types.js';
import { controlFlowContractGuard } from '../contract/control-flow-contract-utils.js';
import { ControlFlowDefinition, OutputSchema } from './control-flow-definition.js';
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

export type ControlFlowContractAnyObjectSchema = ControlFlowContract<
  TObject,
  TObject
>;

export const loadControlFlowDefinition = createLoadDefinition<
  ControlFlowContractAnyObjectSchema,
  ControlFlowDefinition<ControlFlowContractAnyObjectSchema>
>(controlFlowContractGuard);

export const ControlFlowDefinitionCache = createDefinitionCache<
  ControlFlowContractAnyObjectSchema,
  ControlFlowDefinition<ControlFlowContractAnyObjectSchema>
>(loadControlFlowDefinition);

export type ControlFlowDefinitionCache = InstanceType<
  typeof ControlFlowDefinitionCache
>;

export class ControlFlowDynamicCaller<
  TContractRegistry extends ContractRegistry<ControlFlowContract>,
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
      typeof OutputSchema
    >
  > {
    const registry = this.contractRegistry;

    const contractRegistryPath = registry.contractRegistryPath;

    const definitionLocation: DefinitionLocation = {
      contractRegistryPath,
      definitionPath,
    };

    const resultOfLoadControlFlowDefinition =
      await loadControlFlowDefinition(definitionLocation);

    if (resultOfLoadControlFlowDefinition.isOk()) {
      const definition = resultOfLoadControlFlowDefinition.value;
      const validatedHandler =
        definition.validatedHandler as unknown as ValidatedHandler<
          TContractRegistry['contractRecord'][TDefinitionPath]['errorSchema'],
          TContractRegistry['contractRecord'][TDefinitionPath]['inputSchema'],
          typeof OutputSchema
        >;

      return await validatedHandler(input);
    }
    throw new Error(
      `Failed to load control-flow definition from path "${definitionPath}": ${resultOfLoadControlFlowDefinition.error}`,
    );
  }
}
