import { type Result } from 'neverthrow';

import { type BoxLocation } from '../box.js';
import { type BoxInspection, type BoxQueueDepth } from './box-peek.js';

/**
 * A **read-only** view of one workspace, backend-agnostic: peek, enumerate,
 * measure. This is the seam a second backend (Redis, planned) implements
 * instead of the concrete {@link BoxObserverLmdb} — see that class's own doc
 * comment (`box-observer-lmdb.ts:29-105`) for the full rationale this one
 * condenses.
 *
 * ## Why every method here is synchronous
 *
 * This is a correctness requirement, not a style preference, and it is the
 * one constraint every future implementer of this interface must preserve.
 *
 * LMDB's implementation pins an MVCC snapshot for the duration of a read
 * transaction, and a pinned snapshot stops the *writer's* environment from
 * reclaiming the pages that snapshot still references. A `getRange` iterator
 * — or any handle — left alive across an `await` is exactly how a snapshot
 * gets parked: the transaction outlives the synchronous turn that was
 * supposed to release it. A parked observer therefore does not merely see
 * stale data, it makes a busy store grow without bound, in someone else's
 * process.
 *
 * An `async` method on this interface would readmit that hazard by
 * construction — a caller could `await` in the middle of a read, and nothing
 * would stop the underlying transaction from crossing that suspension point.
 * So every method is synchronous and returns fully materialised plain data
 * (arrays and records, never a cursor, iterator, or transaction handle),
 * exactly as {@link BoxObserverLmdb} already guarantees. A backend for which
 * this is inconvenient (Redis calls are inherently async) does not get to
 * loosen the interface; it has to solve that on its own side, out of scope
 * here.
 *
 * ## The resolution for Redis: a second, separate interface, not a widened one
 *
 * Task #13 is the "on its own side" referenced above, and this is the
 * decision it made. {@link BoxObserverAsync} (below, this file) is a
 * **distinct** interface — same five observation questions
 * (`listWorkflows`/`listKeys`/`peek`/`peekAll`/`depth`) plus `close`, every one
 * returning a `Promise` — implemented by {@link BoxObserverRedis}
 * (`box-observer-redis.ts`) and by nothing that also implements
 * `BoxObserver`. No type implements both, `BoxObserver` gained no optional or
 * default method, and no method on it was made to return `Promise<T> | T`.
 * The two rejected alternatives, and why each was worse:
 *
 * - **Widen `BoxObserver`'s methods to return `Promise<T>`.** This is exactly
 *   the hazard two paragraphs up, admitted for every implementer including
 *   {@link BoxObserverLmdb}: a `Promise<Result<T, string>>` return type does
 *   not forbid a caller from `await`ing mid-read, and TypeScript cannot
 *   express "this particular implementation's promise always resolves before
 *   the next microtask" as a type. The LMDB class would keep its synchronous
 *   *implementation*, but every caller — including `store watch`'s poll loop,
 *   the one place this package's own code holds an observer across many
 *   turns — would have to start treating it as async, and the one thing that
 *   made the hazard structurally unreachable (a `Result<T, string>` a caller
 *   holds before it can do anything else) would be gone.
 * - **One interface with a runtime capability flag** (e.g. `isSync: true`)
 *   that callers branch on. This turns a compile-time guarantee into a
 *   run-time promise instead: nothing stops a future edit to
 *   `BoxObserverLmdb` from returning a `Promise` while leaving the flag
 *   unchanged, and nothing at the type level catches it. A second interface
 *   makes the distinction the type checker's problem — a function that wants
 *   the synchronous guarantee accepts `BoxObserver` and receives a value it
 *   can call inline, full stop; nothing with `.peek()` returning a `Promise`
 *   can be passed there.
 *
 * The cost of the split is real and is paid deliberately: a caller that wants
 * to observe both an LMDB workspace and a Redis-backed one — `store list`
 * against a workspace whose `backends:` declares a Redis server — holds two
 * differently-shaped observers and merges their results itself, rather than
 * getting one polymorphic handle. `@rawbox/cli`'s `store/observers.ts` is
 * that merge, written once so the four call sites (`store list`, `store get`,
 * `store watch`, `workspace status`) do not each invent their own.
 *
 * `BoxObserverAsync` carries **no** correctness guarantee analogous to either
 * of {@link BoxObserverLmdb}'s two — see that interface's own doc comment and
 * {@link BoxObserverRedis}'s for exactly what is and is not promised in its
 * place (no server-side transaction pins a lock the way an MVCC snapshot
 * does, so there is nothing to park, but there is also no point-in-time
 * consistency across a multi-key read).
 *
 * ## What is deliberately absent
 *
 * `readerListSync` — LMDB's reader lock table — stays on
 * {@link BoxObserverLmdb} only. It dumps an implementation detail (LMDB's
 * `mdb_reader_list`) that has no meaning for a backend that is not LMDB, so
 * generalising it here would be a leaky abstraction rather than a seam.
 */
export interface BoxObserver {
  /** Databases (workflows) that exist in this workspace, sorted. */
  listWorkflowsSync(): Result<string[], string>;

  /** Every logical key in one workflow, classified. */
  listKeysSync(workflow: string): Result<BoxInspection[], string>;

  /** The value a `get` would return, without consuming it. */
  peekSync(boxLocation: BoxLocation): Result<unknown, string>;

  /** Every queued element, oldest first, across the wrap. */
  peekAllSync(boxLocation: BoxLocation): Result<unknown[], string>;

  /** `{used, capacity}` for a queue-shaped box. */
  depthSync(boxLocation: BoxLocation): Result<BoxQueueDepth, string>;

  /**
   * Releases whatever resources this observer holds (handles, connections,
   * reader slots). Idempotent, and never throws: closing an observer is
   * cleanup, and cleanup that can fail loudly is worse than cleanup that
   * cannot.
   */
  closeSync(): void;
}

// ---------------------------------------------------------------------------
// The async sibling — see the class doc comment above, "The resolution for
// Redis", for why this is a second interface rather than a widened one.
// ---------------------------------------------------------------------------

/**
 * The async counterpart of {@link BoxObserver} — the same five observation
 * questions plus `close`, every one returning a `Promise`. See this file's
 * own doc comment above for the decision that produced it and the two
 * alternatives rejected.
 *
 * Implemented by {@link BoxObserverRedis} (`box-observer-redis.ts`) and by
 * nothing that also implements {@link BoxObserver} — no type carries both
 * shapes, so a caller holding a `BoxObserver` can never be handed a `Promise`
 * where it expects a `Result`, and vice versa.
 *
 * **Carries no analogue of either of {@link BoxObserverLmdb}'s two
 * guarantees.** There is no server-side transaction for a network round trip
 * to pin, so there is nothing here to "park" the way an LMDB read
 * transaction can be — but that also means there is no MVCC snapshot backing
 * a multi-key read, so nothing stops one key changing between this method's
 * first command and its second. {@link BoxObserverRedis}'s own doc comment
 * states exactly what that costs a caller (a torn view, possible duplicates
 * or omissions from `SCAN`) rather than leaving it implied.
 */
export interface BoxObserverAsync {
  /** Databases (workflows) that exist in this workspace, sorted. See {@link BoxObserver.listWorkflowsSync}. */
  listWorkflows(): Promise<Result<string[], string>>;

  /** Every logical key in one workflow, classified. See {@link BoxObserver.listKeysSync}. */
  listKeys(workflow: string): Promise<Result<BoxInspection[], string>>;

  /** The value a `get` would return, without consuming it. See {@link BoxObserver.peekSync}. */
  peek(boxLocation: BoxLocation): Promise<Result<unknown, string>>;

  /** Every queued element, oldest first, across the wrap. See {@link BoxObserver.peekAllSync}. */
  peekAll(boxLocation: BoxLocation): Promise<Result<unknown[], string>>;

  /** `{used, capacity}` for a queue-shaped box. See {@link BoxObserver.depthSync}. */
  depth(boxLocation: BoxLocation): Promise<Result<BoxQueueDepth, string>>;

  /**
   * Releases whatever resources this observer holds (connections it owns,
   * subscriptions). Idempotent, and never throws — the same contract as
   * {@link BoxObserver.closeSync}, for the same reason.
   */
  close(): Promise<void>;
}
