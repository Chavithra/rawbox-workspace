import { err, ok } from 'neverthrow';
// `Type` stays on typebox: it builds the framework's own fixed `{ label }`
// output schema below, which is never a plugin-supplied schema and so never
// crosses a copy boundary.
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import type { ObjectSchemaLike } from '../../core/contracts/contract-registry-types.js';
import type {
  Definition,
  Handler,
  ValidatedHandler,
} from '../../core/definition/definition-types.js';
import type { ControlFlowContract } from '../contract/control-flow-contract-types.js';

/**
 * The output every control-flow handler returns, fixed by the framework.
 *
 * `label` is the jump target. `reason` is the **one** payload the framework
 * carries out of a control-flow handler besides the target, and it exists for
 * {@link ReservedLabel.FAIL}: a run ending as a failure has to be able to say
 * why, and a control-flow contract declares no `outputSchema` of its own — so
 * without a field here the reason could not leave the handler at all. A
 * control-flow step may not declare `outputs:` (FORMAT.md, "`steps`"),
 * so neither field is ever written to storage; both travel with the step's
 * result and are read by the runner.
 */
export const OutputSchema = Type.Object({
  label: Type.String(),
  reason: Type.Optional(Type.String()),
});

export const ReservedLabel = {
  START: '__START__',
  END: '__END__',
  EXIT: '__EXIT__',
  /**
   * Terminate the run **as a failure**: the runner turns this label into the
   * run's error, exactly as a failed step actor does, so the `run.end` reports
   * `outcome: "error"` and the CLI exits non-zero.
   *
   * The counterpart of {@link EXIT}, which terminates the run successfully.
   * The failure's message is the handler's `reason` when it returns one
   * (see {@link OutputSchema}); the runner supplies a default naming the step
   * when it does not.
   */
  FAIL: '__FAIL__',
} as const;

export type ReservedLabel =
  (typeof ReservedLabel)[keyof typeof ReservedLabel];

export type HandlerValidator<T extends ObjectSchemaLike> = ReturnType<
  typeof Compile<T>
>;

export interface HandlerValidatorSet<
  TError extends ObjectSchemaLike,
  TInput extends ObjectSchemaLike,
  TOutput extends ObjectSchemaLike,
> {
  inputValidator: HandlerValidator<TInput>;
  outputValidator: HandlerValidator<TOutput>;
  errorValidator: HandlerValidator<TError>;
}

export class ControlFlowDefinition<
  TContract extends ControlFlowContract<ObjectSchemaLike, ObjectSchemaLike>,
> implements Definition<
  TContract,
  TContract['errorSchema'],
  TContract['inputSchema'],
  typeof OutputSchema
> {
  public readonly handlerValidatorSet: HandlerValidatorSet<
    TContract['errorSchema'],
    TContract['inputSchema'],
    typeof OutputSchema
  >;
  public readonly validatedHandler: ValidatedHandler<
    TContract['errorSchema'],
    TContract['inputSchema'],
    typeof OutputSchema
  >;

  public static buildHandlerValidatorSet<
    TContract extends ControlFlowContract<ObjectSchemaLike, ObjectSchemaLike>,
  >(
    contract: TContract,
  ): HandlerValidatorSet<
    TContract['errorSchema'],
    TContract['inputSchema'],
    typeof OutputSchema
  > {
    return {
      inputValidator: Compile(contract.inputSchema),
      outputValidator: Compile(OutputSchema),
      errorValidator: Compile(contract.errorSchema),
    };
  }

  public static buildValidatedHandler<
    TError extends ObjectSchemaLike,
    TInput extends ObjectSchemaLike,
    TOutput extends ObjectSchemaLike,
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
      typeof OutputSchema
    >,
  ) {
    const handlerValidatorSet =
      ControlFlowDefinition.buildHandlerValidatorSet(contract);

    this.handlerValidatorSet = handlerValidatorSet;
    this.validatedHandler = ControlFlowDefinition.buildValidatedHandler(
      handler,
      handlerValidatorSet,
    );
  }
}
