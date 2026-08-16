// `import type`, not `import { type Database }`. With `verbatimModuleSyntax`
// on, the inline-modifier form is *not* elided — it emits `import {} from
// 'lmdb'`, a side-effect import that loads the native binding at runtime. That
// silently defeated the main entry's one structural promise (`index.ts`: the
// two LMDB-backed classes stay on their own subpaths "so importing the package
// for its types does not drag in an environment opener"), because `index.ts`
// re-exports this module. `box-peek.ts` already had it right.
import type { Database } from 'lmdb';
import { Packr } from 'msgpackr';
import { ok, err, type Result } from 'neverthrow';

import { type BoxStrategy } from './box.js';

// ---------------------------------------------------------------------------
// Rawbox's key-size contract — see `@rawbox/runner`'s FORMAT.md, "Storage
// keys", which states the 79-byte limit and the character set normatively.
//
// The two constants below are the only ones in this file that are **not** a
// reading of LMDB. Everything else here measures the backend that happens to be
// linked; these two say what *Rawbox* promises, across every backend it intends
// to support. The relationship they must always satisfy is
//
//     RAWBOX_KEY_SIZE_MAX + RAWBOX_KEY_DERIVATION_OVERHEAD_MAX
//         <= min(key limit of every supported backend)
//
// and `box-size.test.ts` asserts the LMDB instance of it.
// ---------------------------------------------------------------------------

/**
 * **Rawbox's own key ceiling — a portability contract, not an LMDB reading.**
 *
 * The maximum UTF-8 byte length of a storage key **as the author writes it**:
 * the key naming a `storage.keys` entry, or a key in a step binding. Not
 * the key the backend ends up storing — for `lmdb-fifo` that is the derived
 * `fifo:<key>:data:<n>`, which costs up to
 * {@link RAWBOX_KEY_DERIVATION_OVERHEAD_MAX} bytes more.
 *
 * **79 is a legibility choice, and should be defended as that rather than
 * dressed up as a physical constraint.** The limit exists so any workflow can
 * be known in advance to run on any backend Rawbox supports — a property of
 * *Rawbox*, not of LMDB, and one that cannot be derived by measuring whichever
 * backend happens to be linked, since the binding constraint will come from
 * whichever backend is tightest and that one does not exist yet. So the number
 * is stricter than every backend's own limit rather than taken from one: 255
 * for a filesystem path component, 255 for a MySQL `VARCHAR(255)` in ASCII, 511
 * for upstream LMDB, 1024 for an S3 object key. None of them fixes it; anything
 * in the 64-100 band would do. Keys appear in `verify` diagnostics, budget
 * output, log lines and database dumps, and a key that fits on one line with
 * its surrounding context makes a diagnostic easier to read than the fault it
 * reports. It starts tight because raising a limit later is non-breaking while
 * lowering one invalidates documents already written. The backend table in
 * rawbox-store/README.md, "Key and Value Sizes" carries those rows; adding a
 * backend means checking its own.
 *
 * **It bounds the author's key rather than the stored one** so that an author's
 * budget is one fixed number rather than one that shrinks as `queueSizeMax`
 * grows. Bounding the *derived* key against LMDB's own 1978 would move the
 * cutoff with the strategy — 1978 under `lmdb-kv`, 1964 at
 * `queueSizeMax: 1000`, less again for a bigger queue.
 *
 * **It is not configurable** because its only real power would be to raise the
 * ceiling — the exact failure it prevents. A per-document override makes the
 * answer per-document again, and a workspace's guarantee becomes the weakest
 * override in it. This is also why `keySizeMax` and `valueSizeMax` are shaped
 * differently: a value's size cannot be known from the document, so it MUST be
 * declared; a key is a literal, so its size is already exactly known and a
 * field would supply no missing information — only permission.
 *
 * **Headroom, measured.** The longest storage key anywhere in this repository
 * is `throttle_result_throttled_ms`, at **28 bytes**, so 79 clears the longest
 * real key by a factor of nearly three and no document has to change.
 */
export const RAWBOX_KEY_SIZE_MAX = 79;

/**
 * The most a strategy's key derivation can add to the author's key — what
 * separates {@link RAWBOX_KEY_SIZE_MAX} from the length a backend actually sees.
 *
 * `lmdb-kv` stores the author's key verbatim and adds 0. `lmdb-fifo` writes
 * three derived forms:
 *
 * ```
 * fifo:<key>:data:<n>   =  key + 5 + 6 + digits(queueSizeMax - 1)
 * fifo:<key>:head       =  key + 5 + 5
 * fifo:<key>:tail       =  key + 5 + 5
 * ```
 *
 * so the worst case is the data key, at `11 + digits(queueSizeMax - 1)`.
 *
 * **`digits` is bounded by JavaScript, not by the schema.** `queueSizeMax` has
 * no maximum, but a JS number stringifies in full decimal notation only up to
 * an exponent of 21 — `String(1e20)` is 21 characters, `String(1e21)` is the
 * *five* characters `1e+21` — so 21 is the longest decimal suffix any legal
 * `queueSizeMax` can produce, and the string gets shorter, not longer, past it.
 * 11 + 21 = 32, and `1e20` hits it exactly, so the bound is tight. Swept at
 * `queueSizeMax` 2, 1000, 2³⁰, `MAX_SAFE_INTEGER`, `1e20`, `1e21` and `1e300`:
 * none derives more than 32.
 */
export const RAWBOX_KEY_DERIVATION_OVERHEAD_MAX = 32;

// ---------------------------------------------------------------------------
// LMDB structural constants — see rawbox-store/README.md, "Key and Value
// Sizes" and "The Storage Budget".
//
// This module is the single place that knows how bytes are counted, so the
// runner and CLI report budgets with the same arithmetic.
//
// **Nothing here is enforced.** The budget answers "how big a volume or
// container does this workflow need?" so an operator can provision one before
// the run. Resource ceilings are applied outside the process, by the container
// runtime; no write path in this package consults these figures. The one size
// constraint the store does enforce is per item — `valueSizeMax` on `put` —
// which bounds a single value, not the store.
// ---------------------------------------------------------------------------

/**
 * The page size LMDB allocates in, **for callers that have no open environment
 * to ask**.
 *
 * LMDB does not choose 4096: it takes the host's page size at environment
 * creation and reports it back as `getStats().pageSize`. So this is a reading
 * of the machine, not a constant of the format. Every consumer of the page
 * model below is static, though — `budgetForStorage` runs from `workflow
 * verify`, `workspace verify` and `workflow lock`, on a parsed document, with
 * no environment open, and creating an LMDB directory as a side effect of
 * *checking a file* would be a surprise in all three. `box-size.test.ts` pins
 * this against the live figure so a host or an lmdb-js bump that moves it fails
 * a test rather than silently making the printed budget disagree with the
 * machine.
 *
 * **Which way a stale value is wrong.** Both terms of the page model scale with
 * the page size, so a host with larger pages does not simply invalidate the
 * figure. Worked through for a 16 KiB-page host at `valueSizeMax: 1334`: real
 * pages hold 11 such nodes rather than 2, so the true footprint of a 2,000-entry
 * fill is ~5.4 MB where this model, reasoning in 4 KiB pages, predicts ~7.5 MB —
 * it over-states, which is the safe direction. The unsafe direction exists
 * (larger pages raise `me_nodemax`, so a value charged an overflow page here can
 * really share a leaf page there, and shared leaf pages settle less densely),
 * but it is bounded by the residual factor: the same arithmetic at
 * `valueSizeMax: 2022` under-states by 2.6%, well inside
 * {@link LMDB_BUDGET_RESIDUAL_FACTOR}.
 */
export const LMDB_PAGE_SIZE_DEFAULT = 4096;

/** Per-page header (`sizeof(MDB_page)`). */
export const LMDB_PAGE_HEADER = 16;

/** Per-entry node metadata (`sizeof(MDB_node)`). */
export const LMDB_NODE_HEADER = 8;

/** Per-entry slot in the page index. */
export const LMDB_INDEX_POINTER = 2;

/**
 * The maximum key size of the lmdb-js build this repository ships, for callers
 * that have **no open database to ask**.
 *
 * The real limit is a property of the linked LMDB, so every caller holding a
 * `Database` reads it from there instead — see {@link readMaxKeySize}, which is
 * what the store's write-side guard uses. Static verification has no
 * environment open and must not open one: `validateStorageSizes` runs on a
 * parsed document, from `workflow verify`, `workflow lock`, `workspace verify`
 * and `runWorkflow`, and creating an LMDB directory as a side effect of
 * *checking a file* would be a surprise in all four.
 *
 * Measured on the shipped `lmdb@3.5.6`, Node 24.15, x86-64 Linux:
 *
 * ```
 * db.maxKeySize                -> 1978
 * put with a 1978-byte key     -> ok
 * put with a 1979-byte key     -> throws
 *     "Key size is larger than the maximum key size (1978)"
 * ```
 *
 * lmdb-js reads the figure once at `open.js:200` (`env.getMaxKeySize()`, then
 * clamps it) and exposes it as `db.maxKeySize`; `keys.js:92` is where it throws
 * `Key was too large, max key size is <N>`.
 *
 * **A default, so it can drift.** `box-size.test.ts` pins it against a live
 * `db.maxKeySize`. Note the direction of a stale value: too *high* lets an
 * over-long key through verification and fail at the first write; too *low*
 * refuses keys LMDB would accept.
 */
export const LMDB_KEY_SIZE_MAX_DEFAULT = 1978;

/**
 * Usable bytes on a leaf page, once the page header is taken out — the divisor
 * of {@link leafPagesForEntries}.
 */
export const LMDB_PAGE_CAPACITY = LMDB_PAGE_SIZE_DEFAULT - LMDB_PAGE_HEADER;

/**
 * The in-page threshold: an entry shares a leaf page with its neighbours iff
 * **`keyBytes + packedValueBytes <= 2013`**. One byte more and LMDB pushes the
 * value onto a dedicated overflow page, leaving the leaf node holding only a
 * 64-bit page id.
 *
 * **It is a property of the key and the value together, not of the value
 * alone** — what LMDB compares against `me_nodemax` is the whole node, key
 * included — so no `valueSizeMax` on its own guarantees anything.
 *
 * **Measured on `lmdb@3.5.6` / `msgpackr@1.11.8` / Node 24.15, 4096-byte pages,
 * incompressible values.** Values were calibrated by binary search to an exact
 * packed length and swept one byte at a time against
 * `getStats().overflowPages`, across five key lengths:
 *
 * | key bytes | 2 | 3 | 8 | 25 | 40 |
 * | --- | --- | --- | --- | --- | --- |
 * | largest in-page value | 2011 | 2010 | 2005 | 1988 | 1973 |
 *
 * `key + value = 2013` in every case, and 2014 overflowed in every case.
 *
 * **Measured, not derived.** It is consistent with `me_nodemax` 2040 less an
 * 8-byte node header and ≈19 bytes of compression framing, but do not
 * re-derive it from those three numbers — re-measure it if lmdb-js is bumped.
 *
 * At `valueSizeMax: 1900` every key the format admits is guaranteed in-page:
 * the widest is 79 + 32 = 111, and 111 + 1900 = 2011 ≤ 2013. The two limits
 * were chosen independently, so that is a coincidence rather than a
 * derivation — re-check `111 + valueSizeMax <= 2013` before moving either.
 *
 * Consumers wanting a `valueSizeMax` that genuinely stays in-page should
 * subtract their **longest** key from this — for `lmdb-fifo` that is the
 * derived `fifo:<key>:data:<n>`, not the author's key, which is what
 * {@link budgetForKey} charges against.
 */
export const LMDB_INPAGE_KEY_PLUS_VALUE_MAX = 2013;

/**
 * The 64-bit overflow page id a leaf node stores in place of the value once the
 * value has been pushed to an overflow page. The overflow case has to account
 * for the node that survives on the leaf page as well as for the overflow
 * pages themselves.
 */
export const LMDB_OVERFLOW_PAGE_ID = 8;

/**
 * Worst-case packed size of a FIFO head/tail cursor. These are msgpack numbers;
 * small integers pack to one byte, but a value that has to be emitted as a
 * float64 costs 1 tag byte + 8 payload bytes.
 */
export const LMDB_FIFO_CURSOR_BYTES = 9;

// ---------------------------------------------------------------------------
// The page model
//
// It counts whole LMDB pages rather than scaling a byte sum, because the gap
// between the flat byte sum and LMDB's allocation is **page quantisation**: a
// *sawtooth* in `valueSizeMax` and key length, not a slope in `dataBytesMax`.
// At `valueSizeMax: 1330` three nodes share a 4080-byte leaf page and a fill
// occupies 1.43× its `dataBytesMax`; four bytes later only two fit and the same
// declaration occupies 2.81×. No multiplier can see a discontinuity.
//
// Measured on the shipped stack — `lmdb@3.5.6`, `msgpackr@1.11.8`, Node 24.15,
// 4096-byte pages, incompressible values unless stated. Footprint was read from
// `db.getStats()` and the size of `data.mdb`; `getBinary` is never the
// instrument, because it decompresses transparently and so reports packed bytes
// rather than stored ones. The environment's high-water mark,
// `(lastPageNumber + 1) × pageSize`, equalled `stat data.mdb` to the byte in
// every one of ~250 fills, so either reading answers the question.
//
// Supporting figures behind the sawtooth: `data.mdb / dataBytesMax` over
// 2,000-entry fills was 1.70 at `valueSizeMax: 256`, 1.39 at 992, 1.43 at 1,330
// and 2.81 at 1,334. The teeth are scale-stable, so no additive term absorbs
// them — at 1,334 the ratio is 2.82 at 500 keys, 2.77 at 2,000, 2.73 at 8,000.
// Branch pages stay under 1% of the footprint everywhere, and rewrite churn does
// not accumulate: rewriting one key 10, 100, 1,000 or 10,000 times leaves the
// high-water mark at exactly 45,056, because the freelist returns the pages.
//
// The constants below are **fitted, not derived**; re-measure rather than
// recompute them on an lmdb-js bump.
// ---------------------------------------------------------------------------

/**
 * What a just-opened LMDB environment occupies, before any dbi exists: two meta
 * pages. Measured identically across every dbi count.
 */
export const LMDB_ENV_BASE_BYTES = 8_192;

/**
 * What each dbi adds to the environment's structural cost. **One dbi is one
 * workflow** — `LmdbDbiCache` opens a named database per workflow — so this
 * term is multiplied by the number of workflows sharing the environment.
 *
 * Fitted to this measured table (high-water mark, bytes, after writing and
 * rewriting values in every dbi):
 *
 * | dbis | 1 | 2 | 4 | 8 | 12 |
 * | --- | --- | --- | --- | --- | --- |
 * | high-water mark | 45,056 | 49,152 | 57,344 | 73,728 | 90,112 |
 *
 * `8,192 + 6,144 × dbis` lands on 81,920 at 12 dbis, and lmdb-js's default
 * `maxDbs` is 12 (`lmdb/open.js:101`), which the store does not raise — so the
 * whole term is capped at 81,920 however many workflows a workspace declares.
 *
 * That cap is why the modelled fixed cost does not stand alone:
 * {@link LMDB_ENV_OVERHEAD_BYTES} floors it, and the floor is what covers the
 * measured 90,112 the fit runs slightly under.
 */
export const LMDB_DBI_BYTES = 6_144;

/**
 * Bytes LMDB stores around a value on top of the value itself — the framing of
 * the compressed form, which lmdb-js does not document.
 *
 * **Measured from two sides and bracketed at 13-18; 18 is taken because erring
 * high on a provisioning figure is the safe direction.** One side swept
 * `valueSizeMax` against `getStats().overflowPages`; the key-and-value sweep
 * behind {@link LMDB_INPAGE_KEY_PLUS_VALUE_MAX} put the residual at ≈19 from
 * the other.
 *
 * It is why `valueSizeMax: 4080` is charged one overflow page by the flat byte
 * sum and really takes two — a 4,080-byte value plus 16 bytes of page header is
 * exactly one page, and the framing pushes it over.
 */
export const LMDB_VALUE_FRAMING_BYTES = 18;

/**
 * How full a leaf page settles once the tree has split — **0.55**, not 1.0.
 *
 * LMDB splits a full leaf in two and each half stays half full until it fills
 * again, so a settled tree does not pack pages to capacity. 0.55 is the fitted
 * occupancy at 2 nodes per page, which is the density that produces the worst
 * tooth; measured occupancy rises to 0.73-0.75 once 3 or more nodes fit, so
 * using the lower figure everywhere over-states the denser cases rather than
 * under-stating the sparse one.
 *
 * This is the single coefficient the whole model turns on. It is why a
 * declaration at `valueSizeMax: 1334` — where `floor(4080 / 1370) = 2` — is
 * charged `1 / (2 × 0.55) = 0.91` pages per entry rather than 0.5.
 */
export const LMDB_LEAF_FILL = 0.55;

/**
 * The one factor left over once the pages are counted: what the page model does
 * *not* model, as a fraction of what it does.
 *
 * It covers branch pages, the freelist, and transaction-granularity overshoot —
 * all of which are small and none of which is a function of the declared
 * strategies.
 *
 * **Fitted.** Across 14 fills spanning `valueSizeMax` 8 to 8,192 and 1,000 to
 * 100,000 entries the raw page model lands between 0.99 and 1.94 of the
 * measured footprint, so 1.15 makes it an upper bound on all of them with the
 * tightest case cleared by 16%; over-provisioning stays under ≈2.2× where the
 * model dominates.
 *
 * **Validated across 29 fills with no coefficient adjusted** — `valueSizeMax` 8
 * to 65,536, 1 to 100,000 entries, rewrite churn, FIFO rings and a 12-database
 * environment. No case under-provisioned; the worst over-provision is **2.04×**,
 * at `valueSizeMax: 992`, where LMDB packs denser than the model's occupancy
 * assumption.
 */
export const LMDB_BUDGET_RESIDUAL_FACTOR = 1.15;

/**
 * **A floor on the whole recommendation** — not a term added to it. 256 KiB,
 * because the measurement behind it is the only one covering the case the page
 * model gets wrong.
 *
 * The model prices a *filled* environment. It prices an almost-empty one too
 * low, and the reason is MVCC: rewriting is free at scale — the freelist
 * returns the pages — but it is not free at the bottom. Measured on
 * `lmdb@3.5.6`, high-water mark (`(lastPageNumber + 1) × pageSize`, verified
 * equal to `stat data.mdb` to the byte):
 *
 * | dbis | at open | after `openDB` | + 1 value each | + 20 rewrites each |
 * | --- | --- | --- | --- | --- |
 * | 1  | 8,192 | 12,288 | 24,576 | 45,056 |
 * | 2  | 8,192 | 20,480 | 40,960 | 49,152 |
 * | 4  | 8,192 | 32,768 | 49,152 | 57,344 |
 * | 8  | 8,192 | 32,768 | 65,536 | 73,728 |
 * | 12 | 8,192 | 32,768 | 81,920 | 90,112 |
 *
 * One workflow holding one 1,900-byte key is one dbi and one page, which the
 * model prices at `(8,192 + 6,144 + 4,096) × 1.15` = 21,197 bytes. The fill
 * really reaches 24,576, and 45,056 once that single key is rewritten — the
 * high-water mark then stays at 45,056 for 10, 100, 1,000 or 10,000 rewrites,
 * so it is a settle, not a leak, but a volume sized at 21,197 would not hold it.
 * **This floor is what makes that case safe, and it was verified as
 * load-bearing rather than assumed**: with it removed, a 1-key / 1,000-rewrite
 * fill is the one case in 29 that under-provisions.
 *
 * 256 KiB clears the whole table — including the 90,112 the fitted
 * `8,192 + 6,144 × dbis` runs slightly under at `maxDbs` — with ~2.8× of
 * margin, and erring high costs nothing: LMDB's file is sparse, so this is a
 * ceiling to provision for, not bytes that get written.
 *
 * **A floor rather than a summand**, because adding it would charge LMDB's
 * structural cost twice — once as {@link LMDB_ENV_BASE_BYTES} +
 * {@link LMDB_DBI_BYTES}, once as this — and would put a flat 256 KiB on top of
 * a 30 MB figure that does not need it.
 */
export const LMDB_ENV_OVERHEAD_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * The shape `measureValueSize` probes for on a `Database`. lmdb-js's typings
 * declare `encoder` only as an *option* (`lmdb/index.d.ts:419`), never as a
 * property of the opened instance, so the property is reached for structurally
 * rather than by type.
 */
interface EncoderCarrier {
  readonly encoder?: {
    readonly pack?: (value: unknown) => { readonly length: number };
  };
}

/**
 * The shape {@link readMaxKeySize} probes for on a `Database`. Like `encoder`
 * above, `maxKeySize` is **undocumented in lmdb-js's typings** — it is set on
 * the instance at `lmdb/open.js:200` from `env.getMaxKeySize()` and never
 * declared in `lmdb/index.d.ts` — so it is reached for structurally rather than
 * by type.
 */
interface MaxKeySizeCarrier {
  readonly maxKeySize?: unknown;
}

/**
 * LMDB's maximum key size, **read from the open database** rather than assumed.
 *
 * `MDB_MAXKEYSIZE` is compile-time and unsettable at runtime, so the only
 * honest source for the figure is the build actually linked. Upstream's default
 * is 511; the build lmdb-js vendors reports 1978. A guard hard-coded to the
 * former refuses keys the latter accepts.
 *
 * **This is a backstop, and since {@link RAWBOX_KEY_SIZE_MAX} it is expected
 * never to fire.** A key that passed static verification is at most 79 bytes
 * plus at most {@link RAWBOX_KEY_DERIVATION_OVERHEAD_MAX} of derivation, so it
 * cannot reach any figure this returns. It stays because a backend guard that
 * trusts the caller's contract is not a guard: if it ever does fire, either a
 * derivation grew or a backend is tighter than the contract assumed, and both
 * are worth hearing about by name rather than as an opaque LMDB throw.
 *
 * **Fails closed**, matching `measureValueSize`: a guard that cannot determine
 * the limit refuses the write rather than waving it through, because the
 * alternative is the opaque LMDB throw the guard exists to prevent. The
 * difference from `measureValueSize`'s encoder probe is deliberate — a
 * standalone `Packr` is a faithful stand-in for `db.encoder`, but there is no
 * stand-in for a compile-time constant of a library that stopped reporting it.
 */
export function readMaxKeySize(
  db: Database<unknown, string>,
): Result<number, string> {
  const reported = (db as MaxKeySizeCarrier).maxKeySize;

  if (typeof reported !== 'number' || !Number.isInteger(reported) || reported <= 0) {
    return err(
      `Failed to read LMDB's maximum key size: this lmdb-js build does not ` +
        `report db.maxKeySize (the property is undocumented in its typings)`,
    );
  }

  return ok(reported);
}

/**
 * Fallback encoder, used only when `db.encoder` is absent.
 *
 * `copyBuffers: true` mirrors how lmdb-js constructs its own encoder when
 * `sharedStructuresKey` is unset (`lmdb/open.js:381-384`). It affects decoding
 * of embedded buffers only, never packed length, but keeping the two
 * constructions identical means the fallback cannot drift for a reason nobody
 * wrote down.
 *
 * Created lazily and reused: msgpackr allocates an internal arena per instance.
 * Reuse is safe because packed length is a pure function of the value — see the
 * note on `measureValueSize`.
 */
let fallbackPackr: Packr | undefined;

function packWithFallback(content: unknown): { readonly length: number } {
  fallbackPackr ??= new Packr({ copyBuffers: true });

  return fallbackPackr.pack(content);
}

/**
 * Packed size of a value, in bytes, **before compression** — the quantity
 * `valueSizeMax` bounds. Nothing is compressed here: this calls `pack()` and
 * reads `.length`. LZ4 still runs exactly once, inside lmdb-js.
 *
 * `db` supplies the encoder. `db.encoder` is the very `Packr` lmdb-js will
 * encode the value with, so measured bytes and stored bytes are one computation
 * rather than two kept in agreement by a test. When the property is absent — a
 * future lmdb-js could move it, since it is undocumented — this falls back to a
 * standalone `Packr`, measured byte-identical over 3000 generated values.
 *
 * Returns a `Result` rather than throwing: msgpack encoding fails on cycles,
 * out-of-range `BigInt` and `Symbol`, and that failure must surface as an `Err`
 * at the `put` boundary like every other error in this package
 * (rawbox-store/README.md, "API Reference": nothing throws across the API
 * boundary).
 *
 * Calling this is side-effect-free, which is what makes it safe to measure a
 * value that is about to be *rejected*. That holds only because
 * `sharedStructuresKey` is unset on `LmdbDbiCache.dbiOptions`: with it enabled,
 * packing a novel shape alone — value never stored — grew `data.mdb` from
 * 24,576 to 36,864 bytes, so a rejected value would permanently consume one of
 * the encoder's 32 registration slots on its way out. **Do not add
 * `sharedStructuresKey`** without re-measuring that.
 */
export function measureValueSize(
  content: unknown,
  db?: Database<unknown, string>,
): Result<number, string> {
  const encoder = (db as EncoderCarrier | undefined)?.encoder;

  const pack =
    typeof encoder?.pack === 'function'
      ? (value: unknown) => encoder.pack!.call(encoder, value)
      : packWithFallback;

  let result: Result<number, string>;

  try {
    // Read `.length` and let `packed` go. It is a view into msgpackr's shared
    // arena — `p1.buffer === p2.buffer` — so the next pack overwrites it.
    // Nothing must retain it.
    const packed = pack(content);
    const length = packed?.length;

    result =
      typeof length === 'number' && Number.isFinite(length)
        ? ok(length)
        : err(
            `Failed to measure value size: encoder returned no byte length for the packed value`,
          );
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    result = err(`Failed to measure value size: ${error}`);
  }

  return result;
}

/** Encoded size of a key. Keys are strings here, so UTF-8 byte length. */
export function measureKeySize(key: string): number {
  return Buffer.byteLength(key, 'utf8');
}

/**
 * Per-entry cost of one (key, value) pair, excluding the value itself: the
 * page-index slot plus the node header plus the key bytes.
 */
export function entryOverhead(keySize: number): number {
  return LMDB_INDEX_POINTER + LMDB_NODE_HEADER + keySize;
}

// ---------------------------------------------------------------------------
// The budget formula
// ---------------------------------------------------------------------------

/**
 * Whether an entry of this shape is pushed onto a dedicated overflow page.
 *
 * The test is on the **sum**, not on the value alone
 * ({@link LMDB_INPAGE_KEY_PLUS_VALUE_MAX}): LMDB compares the whole node
 * against `me_nodemax`, so a value that shares a leaf page under a short key
 * overflows under a long one. `keySize` must therefore be the longest key the
 * declaration actually produces — for `lmdb-fifo`, the derived
 * `fifo:<key>:data:<n>` rather than the author's key.
 */
function overflowsLeafPage(keySize: number, valueSizeMax: number): boolean {
  return keySize + valueSizeMax > LMDB_INPAGE_KEY_PLUS_VALUE_MAX;
}

/**
 * Bytes one (key, value) entry costs, including the value.
 *
 * While `keySize + valueSizeMax` stays inside
 * {@link LMDB_INPAGE_KEY_PLUS_VALUE_MAX} this is `overhead(keySize) +
 * valueSizeMax`. Past it the value no longer shares a leaf page and the figure
 * is page-rounded: the leaf node survives holding a 64-bit page id, and the
 * value takes whole 4096-byte overflow pages.
 */
function entryDataBytes(keySize: number, valueSizeMax: number): number {
  let bytes: number;

  if (!overflowsLeafPage(keySize, valueSizeMax)) {
    bytes = entryOverhead(keySize) + valueSizeMax;
  } else {
    const overflowPageCount = Math.ceil(
      (LMDB_PAGE_HEADER + valueSizeMax) / LMDB_PAGE_SIZE_DEFAULT,
    );

    bytes =
      entryOverhead(keySize) +
      LMDB_OVERFLOW_PAGE_ID +
      overflowPageCount * LMDB_PAGE_SIZE_DEFAULT;
  }

  return bytes;
}

// ---------------------------------------------------------------------------
// The page model
//
// `dataBytesMax` above is a flat byte sum. What follows is a *second*,
// independent accounting of the same entries in whole LMDB pages, and it is the
// only input to `recommendedVolumeBytes`. The two figures are different
// computations, not one number multiplied.
//
// **The overflow test here is the measured one.** A node-size test derived from
// `8 + even(k) + even(v + FRAMING) > 2040` looks equivalent and is not: it
// disagrees with the measured {@link LMDB_INPAGE_KEY_PLUS_VALUE_MAX} for an
// even key length and an even `valueSizeMax` summing to exactly 2014, where it
// says in-page and the measurement says overflow — the unsafe direction. So
// this model applies the same test as `entryDataBytes` and
// `KeyBudget.usesOverflowPages`, and there is deliberately no second answer to
// "does this entry overflow?" defined anywhere in this file.
// ---------------------------------------------------------------------------

/** LMDB aligns node sizes to two bytes (`EVEN` in `mdb.c`). */
function even(value: number): number {
  return value + (value % 2);
}

/**
 * Bytes one entry occupies on a shared leaf page: the page-index slot, the node
 * header, the 2-byte-aligned key, and the 2-byte-aligned value *including the
 * framing LMDB wraps it in* ({@link LMDB_VALUE_FRAMING_BYTES}).
 *
 * The framing is the difference between this and {@link entryOverhead} + value,
 * and it is not decoration: it is why a `valueSizeMax` of 4,080 takes two
 * overflow pages rather than the one the flat byte sum charges.
 */
function leafNodeBytes(keySize: number, valueSizeMax: number): number {
  return (
    LMDB_INDEX_POINTER +
    LMDB_NODE_HEADER +
    even(keySize) +
    even(valueSizeMax + LMDB_VALUE_FRAMING_BYTES)
  );
}

/**
 * A key's share of the **shared** leaf pages, as a fraction rather than a whole
 * number — `entries / (nodesPerPage × LMDB_LEAF_FILL)`.
 *
 * **Fractional on purpose.** A leaf page belongs to the *dbi*, not to a key:
 * entries of different declared keys share it. Rounding up per key charges
 * every `lmdb-kv` declaration a whole 4096-byte page of its own, which
 * over-provisions by up to **70×** — 2,000 small keys are charged 2,000 pages
 * where the fill really occupies 46. Accumulating the shares and rounding once
 * is what the coefficients were fitted under (0.99 to 1.94 across 14 fills).
 *
 * The `LMDB_LEAF_FILL` divisor is what makes this an *upper* bound rather than
 * a capacity calculation — a settled B+tree does not pack its leaves full.
 */
function leafPagesForEntries(
  keySize: number,
  valueSizeMax: number,
  entries: number,
): number {
  if (entries <= 0) {
    return 0;
  }

  // An overflowed entry leaves only a 64-bit page id behind on the leaf, so its
  // leaf node is small and nearly free; the value's own pages are counted by
  // `overflowPagesForEntries`.
  const nodeBytes = overflowsLeafPage(keySize, valueSizeMax)
    ? LMDB_INDEX_POINTER +
      LMDB_NODE_HEADER +
      even(keySize) +
      LMDB_OVERFLOW_PAGE_ID
    : leafNodeBytes(keySize, valueSizeMax);

  const nodesPerPage = Math.max(1, Math.floor(LMDB_PAGE_CAPACITY / nodeBytes));

  return entries / (nodesPerPage * LMDB_LEAF_FILL);
}

/**
 * Whole overflow pages a key's entries own outright — zero while the entry
 * stays in-page, and otherwise one *per entry* times however many pages the
 * value plus its page header and framing spans.
 *
 * Unlike the leaf share these are not fractional and not shared: an overflow
 * page holds one value and nothing else.
 */
function overflowPagesForEntries(
  keySize: number,
  valueSizeMax: number,
  entries: number,
): number {
  if (entries <= 0 || !overflowsLeafPage(keySize, valueSizeMax)) {
    return 0;
  }

  return (
    entries *
    Math.ceil(
      (LMDB_PAGE_HEADER + valueSizeMax + LMDB_VALUE_FRAMING_BYTES) /
        LMDB_PAGE_SIZE_DEFAULT,
    )
  );
}

/** Decimal digit count of a non-negative integer. */
function digits(value: number): number {
  return String(value).length;
}

/**
 * Where a budgeted key came from.
 *
 * - `declared` — named in this function's `strategies` or `seed` input, which
 *   `@rawbox/runner`'s `boxStorageFor` fills from the document's `storage.keys`
 *   entries.
 * - `bound` — named by a step binding only, and legal: the format resolves it
 *   through `strategies[key] ?? defaultStrategy` exactly like a declared one,
 *   and the runtime writes it. It is counted for that reason.
 *
 * Reported so a reader who wrote three declarations and sees a budget over
 * eight keys can see where the other five came from instead of assuming the
 * figure is wrong.
 */
export type KeyBudgetSource = 'declared' | 'bound';

/** Upper bound on bytes for one storage key. */
export interface KeyBudget {
  /**
   * **The discriminant**, always `true` here: this record carries real byte
   * figures. Its counterpart is `UnbudgetableKey` in `strategy/budget.ts`,
   * whose `budgetable` is `false` and which carries no numbers at all.
   *
   * It is a literal rather than an absent field because the alternative —
   * `KeyBudget | undefined` — lets a caller write `.filter(Boolean)` and then
   * present the surviving sum as a total, silently dropping the keys it could
   * not charge. A discriminated union makes the excluded keys something a
   * caller has to name (see `partitionKeyBudgetOutcomeList`), not something it
   * can lose.
   *
   * It lives on the *budgeted* half rather than only on the other one so that
   * neither variant is the default: an author of a third variant has to state
   * which side it is on.
   */
  readonly budgetable: true;
  /**
   * The key, as written — in the `storage:` block for a `declared` key, in a
   * step's `inputs`/`outputs`/`errors` for a `bound` one.
   */
  readonly key: string;
  /** Whether the key was declared in `storage:` or only bound by a step. */
  readonly source: KeyBudgetSource;
  /** Which strategy the budget was computed under. */
  readonly strategyName: BoxStrategy['name'];
  /** Number of LMDB entries this key can occupy at once. */
  readonly entryCount: number;
  /**
   * Longest LMDB key this declaration produces — the key itself for `lmdb-kv`,
   * the widest derived `fifo:<key>:data:<n>` for `lmdb-fifo`. Compare against
   * whatever the linked LMDB reports ({@link readMaxKeySize}), or against
   * {@link LMDB_KEY_SIZE_MAX_DEFAULT} with no database in hand.
   *
   * **Not the quantity {@link RAWBOX_KEY_SIZE_MAX} bounds.** That limit is on
   * the author's key, so it does not move with `queueSizeMax`; this field is
   * what the *backend* stores, and it is still needed because the budget
   * charges real derived key bytes per entry.
   */
  readonly keySizeMax: number;
  /** Upper bound on data bytes for this key. */
  readonly dataBytesMax: number;
  /**
   * Whether this declaration forces values onto dedicated overflow pages —
   * true when `keySizeMax + valueSizeMax` exceeds
   * {@link LMDB_INPAGE_KEY_PLUS_VALUE_MAX}.
   */
  readonly usesOverflowPages: boolean;
  /**
   * This key's share of the dbi's **shared** leaf pages — a fraction, and
   * deliberately not a whole number.
   *
   * A leaf page belongs to the database, not to a key: entries of different
   * keys sit on it side by side. Rounding each key up to a whole page would
   * charge a workflow with 2,000 small `lmdb-kv` keys 2,000 pages where the
   * fill really occupies 46. So the shares accumulate across keys and
   * `StorageBudget.pageCountMax` (`strategy/budget.ts`) rounds the total once.
   *
   * Read it as "how much of a leaf page this key needs", not as a page count.
   */
  readonly leafPageShare: number;
  /**
   * Whole overflow pages this key's entries own outright — `0` unless
   * {@link usesOverflowPages}. Unlike {@link leafPageShare} these are not
   * shared: an overflow page holds one value and nothing else.
   */
  readonly overflowPageCount: number;
}

/** Knobs on the volume recommendation. Both default; neither is usually passed. */
export interface VolumeRecommendationOptions {
  /**
   * How many workflows share the environment — one dbi each
   * ({@link LMDB_DBI_BYTES}). Defaults to `1`.
   *
   * **Why this is a parameter here and nowhere else.** A `storage:` block
   * belongs to exactly one workflow, so for `budgetForStorage`
   * (`strategy/budget.ts`) the answer is always 1. The only caller holding a
   * different number is the one summing
   * a *workspace* — `rawbox-cli workspace verify` — so the count is a parameter
   * of the aggregation function and of nothing else. Putting it on `BoxStorage`
   * would invite `budgetForStorage(oneBlock, { workflowCount: 12 })`, which has
   * no meaning.
   */
  readonly workflowCount?: number | undefined;
  /** Override {@link LMDB_BUDGET_RESIDUAL_FACTOR}. Rarely useful. */
  readonly residualFactor?: number | undefined;
}

/**
 * What a budget is computed over: a `storage:` block, plus the storage keys the
 * document's steps bind.
 *
 * Declared structurally rather than imported, because the authoring schema
 * lives in `@rawbox/runner`, which depends on this package — the dependency
 * cannot be reversed, so this file can never take a `Workflow`. `boundKeyList`
 * follows the same reasoning one step further: rather than teach this package
 * how to walk `steps[].inputs/outputs/errors` (three ref shapes, two of them
 * unions, one of which must be *excluded*), the caller that already owns the
 * step schema does the walk and hands over the resulting key names.
 * `@rawbox/runner` exports `collectBoundStorageKeys` for exactly that, and it
 * is the only place the exclusion rules live.
 */
export interface BoxStorage {
  readonly defaultStrategy: BoxStrategy;
  readonly strategies?: Readonly<Record<string, BoxStrategy>> | undefined;
  readonly seed?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Storage keys named by a step binding, in binding order. Each is resolved by
   * `strategies[key] ?? defaultStrategy` and charged like any other key; those
   * already in `strategies` or `seed` are deduplicated away rather than counted
   * twice.
   *
   * **Cross-workflow reads must not appear here.** A `{ key, workflow }` input
   * reads another workflow's box, and those bytes belong to the *owning*
   * workflow's budget — counting them here would double-count them in a
   * workspace total, which is a plain sum over workflows.
   *
   * Optional, but omitting it makes the budget an *under-estimate* of what the
   * workflow can write, which is the one property the number exists not to
   * have. Callers with a document in hand should always pass it.
   */
  readonly boundKeyList?: readonly string[] | undefined;
}

/**
 * Upper bound on bytes for one `lmdb-kv` key: one entry, the author's key
 * stored verbatim, one value of at most `valueSizeMax`.
 *
 * **Exported for `strategy/descriptor.ts`, which is the only caller that is not
 * in this file.** It is the `budget` field of the `lmdb-kv` descriptor. The body
 * has to stay here because it reaches four helpers this module deliberately
 * keeps private — `entryDataBytes`, `overflowsLeafPage`, `leafPagesForEntries`
 * and `overflowPagesForEntries` — which are the page model itself and are not a
 * surface anything outside this file should compute against. Exporting the two
 * finished budget functions instead of the model that computes them is what
 * lets the descriptor registry hold LMDB budget behaviour **without this file
 * ever importing the registry**; see the note on {@link budgetForKey}.
 */
export function budgetForKvKey(
  key: string,
  strategy: Extract<BoxStrategy, { name: 'lmdb-kv' }>,
  source: KeyBudgetSource = 'declared',
): KeyBudget {
  const valueSizeMax = strategy.valueSizeMax;
  const keySize = measureKeySize(key);

  return {
    budgetable: true,
    key,
    source,
    strategyName: strategy.name,
    entryCount: 1,
    keySizeMax: keySize,
    dataBytesMax: entryDataBytes(keySize, valueSizeMax),
    usesOverflowPages: overflowsLeafPage(keySize, valueSizeMax),
    leafPageShare: leafPagesForEntries(keySize, valueSizeMax, 1),
    overflowPageCount: overflowPagesForEntries(keySize, valueSizeMax, 1),
  };
}

/**
 * Upper bound on bytes for one `lmdb-fifo` key: `queueSizeMax - 1` data slots —
 * one is reserved to distinguish full from empty — plus the `head` and `tail`
 * bookkeeping entries. The slot count is exact: a declared 100 buys 99 usable
 * slots and is charged for 99. Verified by counting live `fifo:<key>:data:*`
 * keys through fill / drain / five wrap-crossing cycles / refill at
 * `queueSizeMax: 8` — peak 7, never 8, because the `put` guard
 * (`nextHead !== tail`) caps them.
 *
 * This is the **peak** figure, not the steady-state one: `getStatic` removes
 * the data key it consumes, so a queue's live footprint tracks its depth rather
 * than sitting permanently at the declared maximum.
 *
 * Exported for the same reason as {@link budgetForKvKey}, and with the same
 * boundary: the page model stays private to this file.
 */
export function budgetForFifoKey(
  key: string,
  strategy: Extract<BoxStrategy, { name: 'lmdb-fifo' }>,
  source: KeyBudgetSource = 'declared',
): KeyBudget {
  const valueSizeMax = strategy.valueSizeMax;
  const queueSizeMax = strategy.queueSizeMax;
  const slotCount = queueSizeMax - 1;

  const dataKeyPrefixSize = measureKeySize(`fifo:${key}:data:`);
  const dataKeySize = dataKeyPrefixSize + digits(queueSizeMax - 1);
  const headKeySize = measureKeySize(`fifo:${key}:head`);
  const tailKeySize = measureKeySize(`fifo:${key}:tail`);

  const dataBytesMax =
    slotCount * entryDataBytes(dataKeySize, valueSizeMax) +
    entryOverhead(headKeySize) +
    LMDB_FIFO_CURSOR_BYTES +
    entryOverhead(tailKeySize) +
    LMDB_FIFO_CURSOR_BYTES;

  return {
    budgetable: true,
    key,
    source,
    strategyName: strategy.name,
    entryCount: slotCount + 2,
    keySizeMax: Math.max(dataKeySize, headKeySize, tailKeySize),
    dataBytesMax,
    // The *data* key, not `keySizeMax` and not the author's key: head and
    // tail hold 9-byte cursors and never overflow, so what determines a
    // queue's page behaviour is the derived `fifo:<key>:data:<n>` — which is
    // also the longest of the three, and the one `dataBytesMax` above
    // charges `valueSizeMax` against.
    usesOverflowPages: overflowsLeafPage(dataKeySize, valueSizeMax),
    // The two cursors are charged as a leaf share of their own rather than
    // ignored. They are 9-byte values under a ~20-byte key, so together they
    // come to a small fraction of one page — but a queue whose ring is empty
    // still has them, and a figure that omitted them would be an under-bound
    // in exactly the case where nothing else is there to absorb it.
    leafPageShare:
      leafPagesForEntries(dataKeySize, valueSizeMax, slotCount) +
      leafPagesForEntries(
        Math.max(headKeySize, tailKeySize),
        LMDB_FIFO_CURSOR_BYTES,
        2,
      ),
    overflowPageCount: overflowPagesForEntries(
      dataKeySize,
      valueSizeMax,
      slotCount,
    ),
  };
}

// ---------------------------------------------------------------------------
// Where the per-strategy choice went
//
// `budgetForKey` and `budgetForStorage` used to live here, and the choice
// between the two functions above was a `strategy.name === 'lmdb-fifo'`
// ternary whose `else` charged **LMDB page arithmetic to every other
// strategy** — so a backend with no page model at all would have been handed
// invented provisioning numbers rather than reported as unprovisionable.
//
// Both moved to `strategy/budget.ts`, together, because the fix requires
// consulting `StrategyDescriptor.budget` (optional by design: absent means
// "not provisionable from the document") and **this file must never import
// `strategy/`**. The dependency runs descriptor → box-size and never back:
// `strategy/descriptor.ts` imports `budgetForKvKey` / `budgetForFifoKey` from
// here, so an import in the other direction closes a cycle. Moving only the
// dispatcher would not have been enough — `budgetForStorage` calls it once per
// key — which is exactly the condition the old comment here named.
//
// What stays here is the page model and the two concrete budget functions;
// what left is the choice between them and the sum over a `storage:` block.
// The public names are unchanged: `src/index.ts` re-exports both from their new
// home.
// ---------------------------------------------------------------------------

/**
 * Bytes of storage to provision for an environment, given the **pages** its
 * declared entries occupy.
 *
 * ```
 * max(
 *   (LMDB_ENV_BASE_BYTES + LMDB_DBI_BYTES × workflowCount
 *      + LMDB_PAGE_SIZE_DEFAULT × pageCountMax) × residualFactor,
 *   LMDB_ENV_OVERHEAD_BYTES,
 * )                                              rounded up to a whole page
 * ```
 *
 * **It takes pages, not `dataBytesMax`**, because page quantisation is a
 * sawtooth in `valueSizeMax` and key length and therefore invisible to any
 * factor applied to a byte sum. At `valueSizeMax: 1330` three nodes share a
 * leaf page and a fill costs 1.43× its `dataBytesMax`; at 1334 only two fit and
 * the identical declaration costs 2.81×.
 *
 * The {@link LMDB_ENV_OVERHEAD_BYTES} floor matters because the model prices an
 * almost-empty environment too low: MVCC's settle is a fixed cost that the
 * freelist reclaims at scale but not at the bottom.
 *
 * The result is a recommendation, applied by whoever sizes the volume or the
 * container. Nothing in this package enforces it, so erring high costs a
 * reservation, not a refused write. Err high.
 */
export function recommendedVolumeBytesFor(
  pageCountMax: number,
  options?: VolumeRecommendationOptions,
): number {
  const workflowCount = options?.workflowCount ?? 1;
  const residualFactor =
    options?.residualFactor ?? LMDB_BUDGET_RESIDUAL_FACTOR;

  const modelled =
    (LMDB_ENV_BASE_BYTES +
      LMDB_DBI_BYTES * workflowCount +
      LMDB_PAGE_SIZE_DEFAULT * pageCountMax) *
    residualFactor;

  return (
    Math.max(1, Math.ceil(Math.max(modelled, LMDB_ENV_OVERHEAD_BYTES) / LMDB_PAGE_SIZE_DEFAULT)) *
    LMDB_PAGE_SIZE_DEFAULT
  );
}
