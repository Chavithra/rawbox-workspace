import { type Static, Type } from 'typebox';
import type { Result } from 'neverthrow';

import {
  type Contract,
  ContractRegistryPath,
  DefinitionPath,
  type ObjectSchemaLike,
} from '../contracts/contract-registry-types.js';

export const DefinitionLocation = Type.Object({
  contractRegistryHash: ContractRegistryPath,
  definitionPath: DefinitionPath,
});

export type DefinitionLocation = Static<typeof DefinitionLocation>;

export type LogicResult<
  TError extends ObjectSchemaLike,
  TOutput extends ObjectSchemaLike,
> = Result<Static<TOutput>, Static<TError>>;

export type ValidationError = Error;

export type ValidatedResult<
  TError extends ObjectSchemaLike,
  TOutput extends ObjectSchemaLike,
> = Result<LogicResult<TError, TOutput>, ValidationError>;

export type Handler<
  TError extends ObjectSchemaLike,
  TInput extends ObjectSchemaLike,
  TOutput extends ObjectSchemaLike,
> = (input: Static<TInput>) => Promise<LogicResult<TError, TOutput>>;

export type ValidatedHandler<
  TError extends ObjectSchemaLike,
  TInput extends ObjectSchemaLike,
  TOutput extends ObjectSchemaLike,
> = (input: Static<TInput>) => Promise<ValidatedResult<TError, TOutput>>;

export interface Definition<
  TContract extends Contract,
  TError extends ObjectSchemaLike = ObjectSchemaLike,
  TInput extends ObjectSchemaLike = ObjectSchemaLike,
  TOutput extends ObjectSchemaLike = ObjectSchemaLike,
> {
  readonly contract: TContract;
  readonly handler: Handler<TError, TInput, TOutput>;
  readonly validatedHandler: ValidatedHandler<TError, TInput, TOutput>;
}

export type DefinitionLoader<
  TContract extends Contract,
  TDefinition extends Definition<TContract>,
> = (
  definitionLocation: DefinitionLocation,
) => Promise<Result<TDefinition, string>>;
