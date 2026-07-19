import { type Static, Type, type TObject } from 'typebox';
import type { Result } from 'neverthrow';

import {
  type Contract,
  ContractRegistryPath,
  DefinitionPath,
} from '../contracts/contract-registry-types.js';

export const DefinitionLocation = Type.Object({
  contractRegistryHash: ContractRegistryPath,
  definitionPath: DefinitionPath,
});

export type DefinitionLocation = Static<typeof DefinitionLocation>;

export type LogicResult<
  TError extends TObject,
  TOutput extends TObject,
> = Result<Static<TOutput>, Static<TError>>;

export type ValidationError = Error;

export type ValidatedResult<
  TError extends TObject,
  TOutput extends TObject,
> = Result<LogicResult<TError, TOutput>, ValidationError>;

export type Handler<
  TError extends TObject,
  TInput extends TObject,
  TOutput extends TObject,
> = (input: Static<TInput>) => Promise<LogicResult<TError, TOutput>>;

export type ValidatedHandler<
  TError extends TObject,
  TInput extends TObject,
  TOutput extends TObject,
> = (input: Static<TInput>) => Promise<ValidatedResult<TError, TOutput>>;

export interface Definition<
  TContract extends Contract,
  TError extends TObject = TObject,
  TInput extends TObject = TObject,
  TOutput extends TObject = TObject,
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
