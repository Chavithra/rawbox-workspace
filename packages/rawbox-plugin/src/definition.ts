import type { Static, TObject } from "@sinclair/typebox";
import type { Result } from "neverthrow";

import type { Contract, ContractsRegistryPath } from "./contracts-registry.js";

export type DefinitionPath = string;

export interface DefinitionLocation {
  contractsRegistryPath: ContractsRegistryPath;
  definitionPath: DefinitionPath;
}

export type MaybeAsync<T> = T | Promise<T>;

export type ValidationError = Error;

export type Handler<
  TError extends TObject,
  TInput extends TObject,
  TOutput extends TObject,
> = (
  input: Static<TInput>
) => MaybeAsync<Result<Static<TOutput>, Static<TError>>>;

export type ValidatedHandler<
  TError extends TObject,
  TInput extends TObject,
  TOutput extends TObject,
> = (
  input: Static<TInput>
) => MaybeAsync<Result<Static<TOutput>, Static<TError> | ValidationError>>;

export interface Definition<
  TContract extends Contract,
  TError extends TObject = TObject,
  TInput extends TObject = TObject,
  TOutput extends TObject = TObject,
> {
  readonly contract: TContract;
  readonly handler: Handler<TInput, TOutput, TError>;
  readonly validatedHandler: ValidatedHandler<TInput, TOutput, TError>;
}

export type DefinitionLoader<
  TContract extends Contract,
  TDefinition extends Definition<TContract>,
> = (
  definitionLocation: DefinitionLocation
) => Promise<Result<TDefinition, string>>;
