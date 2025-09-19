import { err, ok } from "neverthrow";
import { Type, type TObject } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

import { Contract } from "rawbox-plugin/contracts-registry";
import { exportSetupContractsRegistry } from "rawbox-plugin/contracts-registry-utils";
import {
  Definition,
  Handler,
  ValidatedHandler,
} from "rawbox-plugin/definition";

// DEFINE CONTROL_FLOW_CONTRACT
export interface ControlFlowContract<
  TInputSchema extends TObject = TObject,
  TErrorSchema extends TObject = TObject,
> extends Contract {
  type: "control-flow";
  description: string;
  errorSchema: TErrorSchema;
  inputSchema: TInputSchema;
  version: string;
}

export function setupControlFlowContract<
  TErrorSchema extends TObject = TObject,
  TInputSchema extends TObject = TObject,
>(controlFlowContract: ControlFlowContract<TErrorSchema, TInputSchema>) {
  return controlFlowContract;
}

export const setupControlFlowContractsRegistry =
  exportSetupContractsRegistry<ControlFlowContract>();

export function controlFlowContractGuard(
  contract: object
): contract is ControlFlowContract<TObject, TObject> {
  return (
    typeof contract === "object" &&
    contract !== null &&
    "type" in contract &&
    contract.type === "control-flow" &&
    "inputSchema" in contract &&
    "errorSchema" in contract &&
    "version" in contract
  );
}

// DEFINE CONTROL_FLOW_DEFINITION
export type DefaultRunItemLabel =
  | "__CONTINUE__"
  | "__TOP__"
  | "__BOTTOM__"
  | "__STOP__";

export const OutputSchema = Type.Object({
  runItemLabel: Type.String(),
});

export type HandlerValidator<T extends TObject> = ReturnType<
  typeof TypeCompiler.Compile<T>
>;

export interface HandlerValidatorSet<
  TError extends TObject,
  TInput extends TObject,
  TOutput extends TObject,
> {
  errorValidator: HandlerValidator<TError>;
  inputValidator: HandlerValidator<TInput>;
  outputValidator: HandlerValidator<TOutput>;
}

export class ControlFlowDefinition<TContract extends ControlFlowContract>
  implements
    Definition<
      TContract,
      TContract["errorSchema"],
      TContract["inputSchema"],
      typeof OutputSchema
    >
{
  public readonly handlerValidatorSet: HandlerValidatorSet<
    TContract["errorSchema"],
    TContract["inputSchema"],
    typeof OutputSchema
  >;
  public readonly validatedHandler: ValidatedHandler<
    TContract["errorSchema"],
    TContract["inputSchema"],
    typeof OutputSchema
  >;

  public static buildHandlerValidatorSet<TContract extends ControlFlowContract>(
    contract: TContract
  ): HandlerValidatorSet<
    TContract["errorSchema"],
    TContract["inputSchema"],
    typeof OutputSchema
  > {
    return {
      errorValidator: TypeCompiler.Compile(contract.errorSchema),
      inputValidator: TypeCompiler.Compile(contract.inputSchema),
      outputValidator: TypeCompiler.Compile(OutputSchema),
    };
  }

  public static buildValidatedHandler<
    TError extends TObject,
    TInput extends TObject,
    TOutput extends TObject,
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
      typeof OutputSchema
    >
  ) {
    this.handlerValidatorSet =
      ControlFlowDefinition.buildHandlerValidatorSet(contract);
    this.validatedHandler = ControlFlowDefinition.buildValidatedHandler(
      this.handler,
      this.handlerValidatorSet
    );
  }
}
