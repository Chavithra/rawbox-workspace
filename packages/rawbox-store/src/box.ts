import { Type, type Static, type TSchema } from 'typebox';

import { StrictObject } from './schema.js';

const SizeMax = Type.Integer({ minimum: 1, maximum: 0x7fffffff });

// ---------------------------------------------------------------------------
// Strategies — authoring model
//
// These are what `storage.defaultStrategy` and every `storage.keys` entry's
// `strategy:` in a *user's document* parse into, so a stray field here
// is a silent misread of something a person or an assistant wrote: today's
// `queueSizeMax` on an `lmdb-kv` key is dropped, and the author gets a
// key-value cell where they asked for a queue. `StrictObject` is load-bearing
// on every one of them, and a new strategy MUST use it too.
//
// Because `BoxStrategy` is a union, the schema alone would report a stray field
// as a branch dump listing every variant, which `@rawbox/runner`'s FORMAT.md,
// "Validation", forbids: an unrecognised field is reported as that field, never
// as a list of the shapes the value failed to be. The runner's
// `collectStrategyFieldProblems` runs *before* the schema and names the field
// and the strategy it belongs to; these schemas close the hole, that one
// explains it. That diagnostic derives its field tables from
// `BoxStrategy.anyOf` (`@rawbox/runner`, `workflow/validation.ts`
// `STRATEGY_SHAPE_LIST`), so adding a member below is all that is needed for it
// to describe the new strategy — there is no second list to update.
// ---------------------------------------------------------------------------

export const LmdbKV = StrictObject({
  name: Type.Readonly(Type.Literal('lmdb-kv')),
  valueSizeMax: Type.Readonly(SizeMax),
});

export const LmdbFIFO = StrictObject({
  name: Type.Readonly(Type.Literal('lmdb-fifo')),
  queueSizeMax: Type.Readonly(Type.Integer({ minimum: 2 })),
  valueSizeMax: Type.Readonly(SizeMax),
});

/**
 * A single value cell held by a PostgreSQL database rather than by this
 * process's LMDB environment.
 */
export const PgKV = StrictObject({
  name: Type.Readonly(Type.Literal('pg-kv')),
  valueSizeMax: Type.Readonly(SizeMax),
  /**
   * Id of the entry in the workspace document's `backends:` map that says how
   * to reach the server.
   */
  backend: Type.Readonly(Type.String({ minLength: 1 })),
});

/**
 * A FIFO queue held by a PostgreSQL database (`rawbox_boxes` + `rawbox_fifo_items`).
 * Capacity is `queueSizeMax` exact (minimum 1, unlike `lmdb-fifo` which reserves one slot).
 */
export const PgFIFO = StrictObject({
  name: Type.Readonly(Type.Literal('pg-fifo')),
  queueSizeMax: Type.Readonly(Type.Integer({ minimum: 1 })),
  valueSizeMax: Type.Readonly(SizeMax),
  /**
   * Id of the entry in the workspace document's `backends:` map that says how
   * to reach the server.
   */
  backend: Type.Readonly(Type.String({ minLength: 1 })),
});

export const BoxStrategy = Type.Union([LmdbKV, LmdbFIFO, PgKV, PgFIFO]);
export type BoxStrategy = Static<typeof BoxStrategy>;

// ---------------------------------------------------------------------------
// Box locations — resolved runtime model
//
// Nothing parses a document into these: the resolver builds them from an
// authored binding plus the document's key table. Strictness is therefore an
// invariant on the resolver's own output rather than a guard on user input —
// useful, and not the live bug the strategies above are.
//
// It is not redundant with `validateStorageBoundaries`, which reads the same
// absent fields as a *boundary*: a write that carries `workflow` or `workspace`
// is a step reaching outside itself, and that gets a sentence saying so rather
// than an unknown-property error.
// ---------------------------------------------------------------------------

export const BoxLocation = StrictObject({
  key: Type.Readonly(Type.String()),
  workflow: Type.Readonly(Type.String()),
  workspace: Type.Readonly(Type.String()),
  strategy: Type.Readonly(BoxStrategy),
});
export type BoxLocation = Static<typeof BoxLocation>;

export const WriteBoxLocation = StrictObject({
  key: Type.Readonly(Type.String()),
  strategy: Type.Readonly(BoxStrategy),
});
export type WriteBoxLocation = Static<typeof WriteBoxLocation>;

export const ReadBoxLocation = StrictObject({
  key: Type.Readonly(Type.String()),
  strategy: Type.Readonly(BoxStrategy),
  workflow: Type.Optional(Type.Readonly(Type.String())),
});
export type ReadBoxLocation = Static<typeof ReadBoxLocation>;

export const Box = <T extends TSchema>(TValue: T) =>
  StrictObject({
    content: TValue,
    location: BoxLocation,
  });

export interface Box<TValue> {
  readonly content: TValue;
  readonly location: BoxLocation;
}

export const BoxLocationRecord = Type.Record(Type.String(), Type.Union([WriteBoxLocation, ReadBoxLocation]));
export type BoxLocationRecord = Static<typeof BoxLocationRecord>;
