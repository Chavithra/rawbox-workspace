import { err, ok } from 'neverthrow';
import type { TObject } from 'typebox';
import { Compile } from 'typebox/compile';

import type {
  Definition,
  Handler,
  ValidatedHandler,
} from '../../core/definition/definition-types.js';
import type { OperationContract } from '../contract/operation-contract-types.js';

export type HandlerValidator<T extends TObject> = ReturnType<typeof Compile<T>>;

export interface HandlerValidatorSet<
  TError extends TObject,
  TInput extends TObject,
  TOutput extends TObject,
> {
  inputValidator: HandlerValidator<TInput>;
  outputValidator: HandlerValidator<TOutput>;
  errorValidator: HandlerValidator<TError>;
}

export class OperationDefinition<
  TContract extends OperationContract<TObject, TObject, TObject>,
> implements Definition<
  TContract,
  TContract['errorSchema'],
  TContract['inputSchema'],
  TContract['outputSchema']
> {
  public readonly handlerValidatorSet: HandlerValidatorSet<
    TContract['errorSchema'],
    TContract['inputSchema'],
    TContract['outputSchema']
  >;
  public readonly validatedHandler: ValidatedHandler<
    TContract['errorSchema'],
    TContract['inputSchema'],
    TContract['outputSchema']
  >;

  public static buildHandlerValidatorSet<
    TContract extends OperationContract<TObject, TObject, TObject>,
  >(
    contract: TContract,
  ): HandlerValidatorSet<
    TContract['errorSchema'],
    TContract['inputSchema'],
    TContract['outputSchema']
  > {
    return {
      inputValidator: Compile(contract.inputSchema),
      outputValidator: Compile(contract.outputSchema),
      errorValidator: Compile(contract.errorSchema),
    };
  }

  public static buildValidatedHandler<
    TError extends TObject,
    TInput extends TObject,
    TOutput extends TObject,
  >(
    handler: Handler<TError, TInput, TOutput>,
    validatorSet: HandlerValidatorSet<TError, TInput, TOutput>,
  ): ValidatedHandler<TError, TInput, TOutput> {
    return async (input) => {
      const { inputValidator, outputValidator, errorValidator } = validatorSet;

      const inputValidationResult = inputValidator.Check(input);
      if (!inputValidationResult) {
        const errors = Array.from(inputValidator.Errors(input));
        return err(
          new Error(
            `Input validation error: ${JSON.stringify(errors, null, 2)}`,
          ),
        );
      }

      let output;
      try {
        output = await handler(input);
      } catch (error) {
        return err(new Error('Handler exception: ' + error));
      }

      if (output.isErr()) {
        const errorValue = output.error;
        const errorValidationResult = errorValidator.Check(errorValue);
        if (!errorValidationResult) {
          const errors = Array.from(errorValidator.Errors(errorValue));
          return err(
            new Error(
              `Handler Result.Error: ${JSON.stringify(errors, null, 2)}`,
            ),
          );
        }
        return ok(output);
      }

      const outputs = output.value;
      const outputValidationResult = outputValidator.Check(outputs);
      if (!outputValidationResult) {
        const errors = Array.from(outputValidator.Errors(outputs));
        return err(
          new Error(
            `Output validation error: ${JSON.stringify(errors, null, 2)}`,
          ),
        );
      }

      return ok(output);
    };
  }

  public constructor(
    public readonly contract: TContract,
    public readonly handler: Handler<
      TContract['errorSchema'],
      TContract['inputSchema'],
      TContract['outputSchema']
    >,
  ) {
    const handlerValidatorSet =
      OperationDefinition.buildHandlerValidatorSet(contract);

    this.handlerValidatorSet = handlerValidatorSet;
    this.validatedHandler = OperationDefinition.buildValidatedHandler(
      handler,
      handlerValidatorSet,
    );
  }
}
