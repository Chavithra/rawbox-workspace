import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import { ResolvedWorkflow } from '../workflow/workflow-types.js';

export const DoneStep = Type.Object({
  errorRecord: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  index: Type.Number(),
  inputRecord: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  outputRecord: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type DoneStep = Static<typeof DoneStep>;

export const TodoStep = Type.Object({
  index: Type.Number(),
  inputRecord: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type TodoStep = Static<typeof TodoStep>;

export const MachineParams = Type.Object({
  runId: Type.String(),
  workflow: ResolvedWorkflow,
  workspace: Type.String(),
});

export type MachineParams = Static<typeof MachineParams>;

export const MachineExecution = Type.Object({
  doneStep: Type.Union([DoneStep, Type.Null()]),
  todoStep: Type.Union([TodoStep, Type.Null()]),
});

export type MachineExecution = Static<typeof MachineExecution>;

export const MachineContext = Type.Object({
  params: MachineParams,
  execution: MachineExecution,
  /**
   * Why the run is failing, as a plain record rather than an `Error`: the
   * context is snapshot data, and a thrown value's identity does not survive
   * being carried through XState's event payloads.
   *
   * `timeoutMs` is present only when the failure was a **runner bound**
   * expiring: a bounded step's (`StepTimeoutError` in `actors/run-actor.ts`) or
   * preflight's (`PreflightTimeoutError` in `actors/start-actor.ts`). It rides
   * here, on the machine's own error, rather than inside the step's error
   * record, because that record is the plugin's namespace by contract — the
   * runner does not add keys to it. `producer.ts` reads this field to put
   * `timed_out` / `timeout_ms` on the `step.end`, and `run-workflow.ts` reads
   * it to put the same pair on the `run.end` — which is the *only* signal a
   * preflight timeout has, since it never reaches a step. It is never folded
   * into the error object itself: `RunEventError` is a `StrictObject` that
   * would reject a third field.
   *
   * This schema is type-only — it is never `Compile`d — so adding an optional
   * property here is a pure widening of `MachineContext`, not a new runtime
   * check anything has to pass.
   */
  error: Type.Optional(
    Type.Union([
      Type.Object({
        message: Type.String(),
        stack: Type.Optional(Type.String()),
        timeoutMs: Type.Optional(Type.Number()),
      }),
      Type.Null(),
    ]),
  ),
});

export type MachineContext = Static<typeof MachineContext>;

export const MachineInput = Type.Intersect([
  MachineContext,
  Type.Object({
    boxStoreLmdb: BoxStoreLmdb,
  }),
]);

export type MachineInput = Static<typeof MachineInput>;

const StopEvent = Type.Object({
  type: Type.Literal('STOP'),
});

export const MachineEvent = Type.Union([StopEvent]);

export type MachineEvent = Static<typeof MachineEvent>;

export const MachineEventValidator = Compile(MachineEvent);
