import { Type, type Static, type TSchema } from '@sinclair/typebox';

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
});

export type BoxLocation = Static<typeof BoxLocation>;

export const BoxEmpty = Type.Object({
  location: Type.Readonly(BoxLocation),
  strategy: Type.Readonly(BoxStrategy),
});
export type BoxEmpty = Static<typeof BoxEmpty>;

export const Box = <T extends TSchema>(TValue: T) =>
  Type.Object({
    content: TValue,
    location: BoxLocation,
    strategy: BoxStrategy,
  });

export interface Box<TValue> {
  readonly content: TValue;
  readonly location: BoxLocation;
  readonly strategy: BoxStrategy;
}
