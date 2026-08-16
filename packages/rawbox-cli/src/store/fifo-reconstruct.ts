/**
 * Reconstructing a `queueSizeMax` sufficient to peek an `lmdb-fifo` box
 * correctly, from nothing but what `BoxObserverLmdb.listKeysSync` already
 * reports — no workflow document required.
 *
 * `store get`/`store watch` build a `BoxLocation` to call `peekSync`/
 * `peekAllSync`, and both need a `strategy.queueSizeMax` to do it — but the
 * real declared figure lives in a workflow document these commands are not
 * guaranteed to have resolved (a bare workspace name has none). The good news
 * is that `BoxInspection.fifo` already carries `head`, `tail` and the exact
 * `depth` (counted from surviving `data:<n>` entries, not derived from the
 * cursors — see `box-peek.ts`), and that is enough to solve for a
 * `queueSizeMax` that reproduces the *same* ring arithmetic
 * (`ringUsed`/`ringIndexList`) the real one would, even though it may not be
 * the exact number a document declares:
 *
 * - **Wrapped** (`head < tail`): `ringUsed(head, tail, n) = n - (tail -
 *   head)` for any `n > tail`, so `depth = n - (tail - head)` has exactly one
 *   solution, `n = tail - head + depth`.
 * - **Not wrapped** (`head >= tail`): `ringUsed(head, tail, n) = head - tail`
 *   for *every* `n > head`, and `ringIndexList` never wraps for such an `n`
 *   either, so any value bigger than every cursor and the depth itself
 *   reproduces the same index range `[tail, head)`. The smallest is used.
 *
 * Not the declared figure, and never presented as one — `store get`/`store
 * watch` never print a "capacity" derived from this, only `store list` does
 * that, and only when a workflow document is actually resolvable
 * (`../commands/store/list.ts`).
 */

import type { BoxFifoInspection } from '@rawbox/store';

/** `queueSizeMax`'s schema floor (`BoxStrategy`'s `lmdb-fifo` variant: a ring needs two slots to
    distinguish full from empty). */
const QUEUE_SIZE_MAX_MIN = 2;

export function reconstructQueueSizeMax(
  fifo: Pick<BoxFifoInspection, 'head' | 'tail' | 'depth'>,
): number {
  const { head, tail, depth } = fifo;

  const reconstructed =
    head < tail ? tail - head + depth : Math.max(head, tail, depth) + 1;

  return Math.max(QUEUE_SIZE_MAX_MIN, reconstructed);
}
