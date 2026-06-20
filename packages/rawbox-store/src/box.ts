import { Type, type Static, type TSchema } from 'typebox';

export const LmdbKV = Type.Object({
  name: Type.Readonly(Type.Literal('lmdb-kv')),
  valueSizeMax: Type.Readonly(Type.Number()),
});

export const LmdbFIFO = Type.Object({
  name: Type.Readonly(Type.Literal('lmdb-fifo')),
  queueSizeMax: Type.Readonly(Type.Number()),
});

export const BoxStrategy = Type.Union([LmdbKV, LmdbFIFO]);
export type BoxStrategy = Static<typeof BoxStrategy>;

export const BoxLocation = Type.Object({
  key: Type.Readonly(Type.Number()),
  workflow: Type.Readonly(Type.String()),
  workspace: Type.Readonly(Type.String()),
  strategy: Type.Readonly(BoxStrategy),
});

export type BoxLocation = Static<typeof BoxLocation>;

export const Box = <T extends TSchema>(TValue: T) =>
  Type.Object({
    content: TValue,
    location: BoxLocation,
  });

export interface Box<TValue> {
  readonly content: TValue;
  readonly location: BoxLocation;
}

export const BoxLocationRecord = Type.Record(Type.String(), BoxLocation);
export type BoxLocationRecord = Static<typeof BoxLocationRecord>;


