import { Type, type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import { BoxRecord, Step } from './step-types.js';

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

export const MachineContext = Type.Object({
  doneStep: Type.Optional(DoneStep),
  instanceId: Type.String(),
  stepList: Type.Array(Step),
  todoStep: Type.Optional(TodoStep),
  workspace: Type.String(),
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
