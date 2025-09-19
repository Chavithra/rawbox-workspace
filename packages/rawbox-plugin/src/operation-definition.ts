import { err, ok } from "neverthrow";
import { TObject } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

import type { Definition, Handler, ValidatedHandler } from "./definition.js";
import type { Contract } from "./contracts-registry.js";
import { exportSetupContractsRegistry } from "./contracts-registry-utils.js";

// DEFINE OPERATION_CONTRACT
export const setupOperationContractsRegistry =
  exportSetupContractsRegistry<OperationContract>();

export function setupOperationContract<
  ErrorSchema extends TObject = TObject,
  InputSchema extends TObject = TObject,
  OutputSchema extends TObject = TObject,
>(
  operationContract: OperationContract<ErrorSchema, InputSchema, OutputSchema>
) {
  return operationContract;
}

export interface OperationContract<
  ErrorSchema extends TObject = TObject,
  InputSchema extends TObject = TObject,
  OutputSchema extends TObject = TObject,
> extends Contract {
  type: "operation";
  description: string;
  errorSchema: ErrorSchema;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  version: string;
}

export function operationContractGuard(
  contract: object
): contract is OperationContract {
  return (
    typeof contract === "object" &&
    contract !== null &&
    "type" in contract &&
    contract.type === "operation" &&
    "inputSchema" in contract &&
    "outputSchema" in contract &&
    "errorSchema" in contract &&
    "version" in contract
  );
}

// DEFINE OPERATION_DEFINITION
export type HandlerValidator<T extends TObject> = ReturnType<
  typeof TypeCompiler.Compile<T>
>;

export interface HandlerValidatorSet<
  TError extends TObject,
  TInput extends TObject,
  TOutput extends TObject,
> {
  inputValidator: HandlerValidator<TInput>;
  outputValidator: HandlerValidator<TOutput>;
  errorValidator: HandlerValidator<TError>;
}

export class OperationDefinition<TContract extends OperationContract>
  implements
    Definition<
      TContract,
      TContract["errorSchema"],
      TContract["inputSchema"],
      TContract["outputSchema"]
    >
{
  public readonly handlerValidatorSet: HandlerValidatorSet<
    TContract["errorSchema"],
    TContract["inputSchema"],
    TContract["outputSchema"]
  >;
  public readonly validatedHandler: ValidatedHandler<
    TContract["errorSchema"],
    TContract["inputSchema"],
    TContract["outputSchema"]
  >;

  public static buildHandlerValidatorSet<TContract extends OperationContract>(
    contract: TContract
  ): HandlerValidatorSet<
    TContract["errorSchema"],
    TContract["inputSchema"],
    TContract["outputSchema"]
  > {
    return {
      inputValidator: TypeCompiler.Compile(contract.inputSchema),
      outputValidator: TypeCompiler.Compile(contract.outputSchema),
      errorValidator: TypeCompiler.Compile(contract.errorSchema),
    };
  }

  public static buildValidatedHandler<
    TInput extends TObject,
    TOutput extends TObject,
    TError extends TObject,
  >(
    handler: Handler<TError, TInput, TOutput>,
    validatorSet: HandlerValidatorSet<TError, TInput, TOutput>
  ): ValidatedHandler<TError, TInput, TOutput> {
    return async (input) => {
      const { inputValidator, outputValidator, errorValidator } = validatorSet;

      const inputValidationResult = inputValidator.Check(input);
      if (!inputValidationResult) {
        const errors = Array.from(inputValidator.Errors(input));
        return err(
          new Error(
            `Input validation failed: ${JSON.stringify(errors, null, 2)}`
          )
        );
      }

      let output;
      try {
        output = await handler(input);
      } catch (error) {
        return err(new Error("Handler execution failed: " + error));
      }

      if (output.isErr()) {
        const errorValue = output.error;
        const errorValidationResult = errorValidator.Check(errorValue);
        if (!errorValidationResult) {
          const errors = Array.from(errorValidator.Errors(errorValue));
          return err(
            new Error(
              `Error validation failed: ${JSON.stringify(errors, null, 2)}`
            )
          );
        }
        return output;
      }

      const outputs = output.value;
      const outputValidationResult = outputValidator.Check(outputs);
      if (!outputValidationResult) {
        const errors = Array.from(outputValidator.Errors(outputs));
        return err(
          new Error(
            `Output validation failed: ${JSON.stringify(errors, null, 2)}`
          )
        );
      }

      return ok(output.value);
    };
  }

  public constructor(
    public readonly contract: TContract,
    public readonly handler: Handler<
      TContract["errorSchema"],
      TContract["inputSchema"],
      TContract["outputSchema"]
    >
  ) {
    this.handlerValidatorSet =
      OperationDefinition.buildHandlerValidatorSet(contract);
    this.validatedHandler = OperationDefinition.buildValidatedHandler(
      this.handler,
      this.handlerValidatorSet
    );
  }
}
