import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import { Workflow } from '../workflow/workflow-types.js';

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
  workflow: Workflow,
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
  error: Type.Optional(
    Type.Union([
      Type.Object({
        message: Type.String(),
        stack: Type.Optional(Type.String()),
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
