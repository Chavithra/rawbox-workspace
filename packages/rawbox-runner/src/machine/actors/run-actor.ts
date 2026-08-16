/**
 * The step actor: load the step's definition, hand the input record to its
 * validated handler, report what came back — and, for a **bounded step**, stop
 * waiting when the step's `timeoutMs` expires.
 *
 * ## Two exits, and why a timeout takes the second one
 *
 * This function has two shapes of return and they mean different things to the
 * machine:
 *
 * - **`ok({ doneStep: { errorRecord } })`** — the *handler declared a logical
 *   failure*. That record was validated against the plugin's `errorSchema`
 *   inside `validatedHandler`, so it is contract-shaped; the machine writes the
 *   step's `errors:` bindings from it and **continues to the next step**.
 * - **`err(Error)`** — the *step itself failed*. `context.error` is assigned,
 *   `doneStep` stays `null`, `exitFunc` writes nothing, and the run ends
 *   `outcome: "error"`.
 *
 * A timeout is the second kind, and the choice is not stylistic. A record the
 * runner minted is not contract-shaped, so pushing one through the first exit
 * would reach `buildBoxRecord` (`@rawbox/store`'s `box-utils.ts`) and fail there
 * with an unrelated "Field <x> not found in the values record" for any step
 * declaring `errors:` — while a step declaring none would silently *continue the
 * workflow*. One event, two behaviours, selected by an authoring choice that has
 * nothing to do with timeouts. Hence: **`errors:` bindings cannot catch a
 * timeout, and that is intended.** A bound is the operator's statement that the
 * run should stop, not a control-flow construct the document can handle.
 *
 * ## Known limitations of the bound
 *
 * These are the honest edges of "stop waiting", recorded here rather than fixed:
 *
 * - **The orphaned handler keeps running.** A bound limits the *wait*, not the
 *   *execution*: nothing here is an abort signal. No late store write is
 *   possible — handlers never touch the store, and every write happens from
 *   `doneStep`, which is `null` on this path — but a side effect outside the
 *   store (an HTTP POST already in flight, a file already opened) is not undone.
 * - **Log lines from an abandoned handler are misattributed.** The run-event
 *   channel `emitRunEvent` writes to is a process-wide `Symbol.for` global, and
 *   the producer stamps a `log`/`step.progress` event with whichever step is in
 *   flight *when it arrives*. An orphaned handler that logs after its step was
 *   abandoned therefore lands under a later step. This is pre-existing on the
 *   SIGTERM path (an interrupted run abandons its in-flight handler the same
 *   way); a timeout makes it reachable without an operator.
 * - **A pending timer survives an interrupt.** See {@link startDeadline} and
 *   `RunWorkflowOptions.signal`.
 * - **The bound covers this actor only.** `preloadStepDefinitions` in
 *   `start-actor.ts` imports every step's definition module during preflight,
 *   which is where a definition module's top-level `await` actually hangs. A
 *   per-step bound cannot cover a preflight that runs before any step is
 *   selected — the bound is declared *inside* the contract, which is not
 *   readable until the module has loaded. That gap is closed by a separate,
 *   runner-level bound (`RunWorkflowOptions.preflightTimeoutMs`), built on the
 *   same {@link startDeadline} primitive; see `start-actor.ts` for why the two
 *   have opposite defaults.
 */

import { fromPromise } from 'xstate';
import { ok, err, type Result } from 'neverthrow';
import { loadDefinition } from '@rawbox/plugin/core';

import type { ContractRegistryCache } from '@rawbox/plugin/core';
import type { DoneStep, MachineExecution } from '../machine-types.js';
import type { ResolvedWorkflow } from '../../workflow/workflow-types.js';
import { TIMED_OUT, startDeadline } from './deadline.js';

// ---------------------------------------------------------------------------
// The bound
// ---------------------------------------------------------------------------

/**
 * The failure a bounded step reports when its bound expired.
 *
 * A named class rather than a bare `Error` so a caller — the machine's error
 * assigner, an embedder, a test — can tell "the bound expired" apart from "the
 * handler threw" without parsing the message. The assigner nevertheless reads
 * {@link timeoutMs} *structurally* rather than via `instanceof`: two copies of
 * this package in one dependency tree would give the class two identities, and a
 * timeout that stopped being reported as one because of a duplicated install
 * would be a very hard thing to see.
 */
export class StepTimeoutError extends Error {
  /** The bound that expired, in milliseconds — the step's effective `timeoutMs`. */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'StepTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The one sentence a human reads for a timeout — in the terminal, in
 * `run.end.error.message`, and in the `step.end` error record.
 *
 * It names the step the way the document does (index, plus the authored label
 * when there is one), states the bound rather than the elapsed time, and says in
 * words what "timed out" means here: the handler did not return. That last
 * clause is what stops a reader concluding the work was cancelled — it was not
 * (see this module's "Known limitations").
 */
function describeTimeout(
  stepIndex: number,
  label: string | undefined,
  timeoutMs: number,
): string {
  const named = label === undefined || label === '' ? '' : ` "${label}"`;
  return (
    `Step ${stepIndex}${named} timed out after ${timeoutMs} ms ` +
    `(the handler did not return).`
  );
}

// ---------------------------------------------------------------------------
// The actor
// ---------------------------------------------------------------------------

export const runFunc = async ({
  input: { contractRegistryCache, workflow, execution },
}: {
  input: {
    contractRegistryCache: ContractRegistryCache;
    workflow: ResolvedWorkflow;
    execution: MachineExecution;
  };
}): Promise<Result<{
  doneStep: DoneStep;
}, Error>> => {
  const todoStep = execution.todoStep;
  if (!todoStep || !todoStep.inputRecord) {
    return err(new Error('todoStep is required to execute runFunc'));
  }

  const stepList = workflow.stepList;
  const handlerInput: Record<string, unknown> = todoStep.inputRecord;
  const stepIndex = todoStep.index;
  const step = stepList[stepIndex];

  if (!step) {
    return err(new Error(`Step at index ${stepIndex} not found in stepList`));
  }

  // Armed here — as early as the step's own `timeoutMs` is readable, and before
  // the definition load — so the bound spans the *whole* actor body rather than
  // only the handler call. Two reasons it is drawn this wide:
  //
  //   1. A definition module's dynamic `import()` is itself something that can
  //      hang (a module with a top-level `await`), and a bound that did not
  //      cover it would leave the one blocking await in this function
  //      unbounded.
  //   2. `step.end.duration_ms` is measured by the producer from `step.start`,
  //      which precedes this call. Measuring the bound from any *later* point
  //      would let a timed-out `step.end` report a `duration_ms` smaller than
  //      its own `timeout_ms` — a log line that reads as a bug in the runner
  //      even though nothing went wrong.
  const timeoutMs = step.timeoutMs;
  const deadline = startDeadline(timeoutMs);

  /**
   * The `err` a lost race returns. `timeoutMs` is a real bound on every path
   * that reaches this — an unbounded deadline never resolves with
   * {@link TIMED_OUT} — so the `?? 0` is unreachable; it is here only because
   * that invariant lives inside {@link startDeadline} rather than in a type
   * this function can narrow.
   */
  const timedOut = (): Result<never, Error> => {
    const bound = timeoutMs ?? 0;
    return err(
      new StepTimeoutError(describeTimeout(stepIndex, step.label, bound), bound),
    );
  };

  try {
    const definitionResult = await deadline.race(
      loadDefinition(step.definitionLocation, contractRegistryCache),
    );

    if (definitionResult === TIMED_OUT) {
      return timedOut();
    }

    if (definitionResult.isErr()) {
      return err(new Error(definitionResult.error));
    }

    const definition = definitionResult.value;

    const handlerResult = await deadline.race(
      definition.validatedHandler(handlerInput),
    );

    if (handlerResult === TIMED_OUT) {
      return timedOut();
    }

    if (handlerResult.isErr()) {
      return err(handlerResult.error instanceof Error ? handlerResult.error : new Error(String(handlerResult.error)));
    }

    const logicResult = handlerResult.value;

    if (logicResult.isErr()) {
      return ok({
        doneStep: {
          index: stepIndex,
          errorRecord: logicResult.error,
        },
      });
    }

    return ok({
      doneStep: {
        index: stepIndex,
        outputRecord: logicResult.value,
      },
    });
  } finally {
    // Every exit above disarms the timer, so a step that finished well within
    // its bound leaves nothing behind holding the event loop open. The one path
    // that skips this is an interrupt: a stopped actor's promise is abandoned
    // without ever resuming, so this `finally` never runs and the timer stays
    // armed for the remainder of the bound (see `RunWorkflowOptions.signal`).
    deadline.cancel();
  }
};

export const runActor = fromPromise(runFunc);
