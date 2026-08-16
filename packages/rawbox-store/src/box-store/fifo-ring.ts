// ---------------------------------------------------------------------------
// The FIFO ring's names and arithmetic — a leaf module, and deliberately so
//
// These functions describe `lmdb-fifo`'s physical layout: how a logical key
// becomes the entries actually stored, and how the two cursors turn into a
// depth and an ordering. Three places need them, and they must all agree:
// `box-store-lmdb.ts` (which writes), `box-peek.ts` (which observes), and
// `strategy/descriptor.ts` (which states the strategy's capacities for the
// verifier).
//
// **Why they live here rather than in `box-peek.ts`, where they started.**
// `box-peek.ts` now reads `descriptorFor(strategy).emptyReadMessage`, and
// `strategy/descriptor.ts` needs `fifoDataKey` and `ringCapacity` — so leaving
// them in `box-peek.ts` makes those two modules import each other. That cycle
// resolves at run time today, but only because `descriptorFor` is a hoisted
// function declaration and nothing reads `STRATEGY_NAME_LIST` at either
// module's top level. Both are accidents of the current code: a single
// top-level `STRATEGY_NAME_LIST.map(...)` added to `box-peek.ts` later would
// hit the temporal dead zone of a `const` in a half-initialised module, and
// the failure would arrive as an unrelated-looking `undefined` at import time.
//
// Extracting the shared half is the fix that removes the cycle rather than
// documenting it. This module imports nothing from either side, so the graph
// is `descriptor -> fifo-ring` and `box-peek -> {descriptor, fifo-ring}`, with
// no back edge. It matches the direction already enforced between
// `strategy/descriptor.ts` and `box-size.ts`.
//
// `box-peek.ts` re-exports everything here, so existing importers and the
// package's public surface are unchanged.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Derived key names — the single definition every half shares
// ---------------------------------------------------------------------------

/**
 * The derived-key builders. `BoxStoreLmdbFifo` writes through these and the
 * observer reads through them, so the two cannot drift: a peek that read
 * `fifo:<key>:data:<n>` while the writer had moved to some other spelling
 * would report a stale or absent element with no error, which is exactly the
 * class of silent bug this surface exists to avoid.
 */
export function fifoHeadKey(key: string): string {
  return `fifo:${key}:head`;
}

export function fifoTailKey(key: string): string {
  return `fifo:${key}:tail`;
}

export function fifoDataKey(key: string, index: number): string {
  return `fifo:${key}:data:${index}`;
}

/** A physical key recognised as part of a logical `lmdb-fifo` box. */
export type DerivedFifoKey =
  | { readonly kind: 'head' | 'tail'; readonly key: string }
  | { readonly kind: 'data'; readonly key: string; readonly index: number };

/**
 * The author-key character class from `@rawbox/runner`'s FORMAT.md, "Storage
 * keys": `[A-Za-z0-9_.-]+`. **It excludes `:`**, which is what makes the
 * derived-key grammar unambiguous — no author key can contain the separator, so
 * `fifo:x:head` cannot be a user key that merely looks derived.
 *
 * `:` is excluded for a reason particular to this store, and it is the only
 * character excluded for a reason that is not portability: it is the separator
 * in the derivation below. Nothing would actually break if it were admitted —
 * the derivation is built, never parsed back apart — but an author key
 * containing one produces stored keys that read as though they had a structure
 * they do not have, and a key is a thing people read.
 *
 * The index is matched as a canonical decimal (`0`, or no leading zero)
 * because that is what `` `${n}` `` produces; `fifo:x:data:007` is therefore
 * *not* recognised as derived and is reported as an ordinary key. That
 * asymmetry is deliberate. A key the writer cannot have produced is not
 * silently folded into a FIFO record — where it would vanish from the
 * listing — it is surfaced verbatim.
 */
const DERIVED_FIFO_KEY_PATTERN =
  /^fifo:([A-Za-z0-9_.-]+):(?:(head|tail)|data:(0|[1-9][0-9]*))$/;

/**
 * Classifies a physical key. Returns `undefined` for anything that is not a
 * derived FIFO entry — that is, for an ordinary `lmdb-kv` key.
 *
 * Enumeration must never leak `fifo:<key>:head` to a caller as a user key
 * (`@rawbox/runner`'s OBSERVABILITY.md, "Enumeration"), and must never hide a
 * real key by
 * mistaking it for a derived one. This function is the whole of that
 * decision.
 */
export function parseDerivedFifoKey(dbiKey: string): DerivedFifoKey | undefined {
  const match = DERIVED_FIFO_KEY_PATTERN.exec(dbiKey);

  if (match === null) {
    return undefined;
  }

  const key = match[1];

  if (key === undefined) {
    return undefined;
  }

  const cursor = match[2];

  if (cursor === 'head' || cursor === 'tail') {
    return { kind: cursor, key };
  }

  const index = match[3];

  if (index === undefined) {
    return undefined;
  }

  return { kind: 'data', key, index: Number(index) };
}

// ---------------------------------------------------------------------------
// Ring arithmetic
// ---------------------------------------------------------------------------

/**
 * Entries between `tail` and `head` going forward around the ring.
 *
 * Written with the `((a % n) + n) % n` guard rather than a bare `%` so a
 * `head` behind `tail` — the normal state of a queue that has wrapped —
 * cannot produce a negative depth.
 */
export function ringUsed(
  head: number,
  tail: number,
  queueSizeMax: number,
): number {
  return (((head - tail) % queueSizeMax) + queueSizeMax) % queueSizeMax;
}

/**
 * See `BoxQueueDepth.capacity`: one slot is always kept free.
 *
 * This is the single statement of `lmdb-fifo`'s reserved slot. `lmdb-fifo`'s
 * descriptor row points `seedCapacity` here rather than restating `- 1`, so
 * the verifier's idea of how many entries a seed may enqueue and the ring's
 * own idea of how many it can hold are one function. A queue strategy without
 * a reserved slot — a Redis native list, say — states its own capacity in its
 * own row and does not come through here.
 */
export function ringCapacity(queueSizeMax: number): number {
  return queueSizeMax - 1;
}

/**
 * Ring indices holding queued entries, **oldest first** — `tail`, then
 * forward, wrapping at `queueSizeMax`, stopping before `head`. That is FIFO
 * order: index `tail` is the element the next `get` would dequeue.
 */
export function ringIndexList(
  head: number,
  tail: number,
  queueSizeMax: number,
): number[] {
  const used = ringUsed(head, tail, queueSizeMax);
  const indexList: number[] = [];

  for (let offset = 0; offset < used; offset += 1) {
    indexList.push((tail + offset) % queueSizeMax);
  }

  return indexList;
}
