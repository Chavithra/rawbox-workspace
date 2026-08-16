import {
  open,
  type Database,
  type DatabaseOptions,
  type Key,
  type RootDatabase,
  type RootDatabaseOptions,
  ABORT,
} from 'lmdb';
import { ok, err, Result } from 'neverthrow';

import { type Box, type BoxLocation, type BoxStrategy } from '../box.js';
import { type BoxStore } from './box-store.js';
import { fileURLToPath } from 'node:url';
import {
  measureKeySize,
  measureValueSize,
  readMaxKeySize,
} from '../box-size.js';
// `budgetForKey` lives with the strategy registry, not with the page model it
// dispatches to — see the module comment in `strategy/budget.ts`. This file is
// free to import either side; the one-way rule it must not break is
// `box-size.ts` importing `strategy/`.
import { budgetForKey } from '../strategy/budget.js';
import {
  depthStatic,
  fifoDataKey,
  fifoHeadKey,
  fifoTailKey,
  inspectStatic,
  peekAllStatic,
  peekStatic,
  type BoxInspection,
  type BoxQueueDepth,
} from './box-peek.js';

// ---------------------------------------------------------------------------
// What this store does and does not bound
// ---------------------------------------------------------------------------

/**
 * **The storage budget is a figure to provision with, not a runtime gate.**
 * `box-size.ts` computes how many bytes a `storage:` block can occupy so an
 * operator can size a container or a volume *before* a workflow runs. Nothing
 * in this file consults that figure: no write is ever refused because the
 * environment has grown, and `open()` is not given a `mapSize`. A resource
 * ceiling belongs to the container runtime, which can enforce it against the
 * whole process rather than against one library's accounting of one file.
 *
 * **An application-level ceiling has a hole a container's does not.** It binds
 * only writes made through this store, leaving a second process, a raw
 * `lmdb.open()` on the same directory, or any embedder touching the files
 * directly entirely unbounded.
 *
 * **And the number is more useful than the gate.** What an operator needs is
 * the size to give a volume, a disk quota or a tmpfs *before* the run, and
 * over-provisioning is close to free because the file is sparse and grows only
 * as pages are written — so the reported figure errs high on purpose.
 *
 * **Why `mapSize` could not have been that gate anyway.** Upstream LMDB refuses
 * to grow past `mapSize`; the copy lmdb-js vendors does not. It patches
 * `mdb_page_alloc` so the map is resized whenever the next page would run past
 * `me_maxpg`:
 *
 * ```c
 * // node_modules/lmdb/dependencies/lmdb/libraries/liblmdb/mdb.c:3044
 * if (pgno + num >= env->me_maxpg) {
 *     size_t new_size = ((size_t)(2 * (pgno + num) * env->me_psize / 0x40000 + 1)) * 0x40000;
 *     rc = mdb_env_set_mapsize(env, new_size);   // <lmdb-js addition>
 * }
 * ```
 *
 * The resize is unconditional — there is no flag that turns it off — so
 * `MDB_MAP_FULL` is unreachable through the normal write path. lmdb-js's own
 * typings agree, calling `mapSize` "the **initial** amount of ... virtual
 * memory address space" (`lmdb/index.d.ts:373`). Measured on `lmdb@3.5.6`: an
 * env opened with `mapSize: 1 MB` accepted 10,000 × 4 KB writes without an
 * error and left `data.mdb` at 41,766,912 bytes. `remapChunks: true` behaves
 * the same. So the one knob LMDB appears to offer is not a bound, and
 * reimplementing one above it duplicates, badly, what a container already does.
 *
 * The one size constraint this file *does* enforce is per item, on `put`:
 * `valueSizeMax` bounds a single encoded value (see {@link checkValueSize}).
 * That bounds one value, not the store, and is unrelated to the budget.
 */

/**
 * Shared write-side guard: measures `content` against the live
 * encoder for `db` (falling back to a standalone `Packr` when `db` is
 * omitted or lacks one — see `measureValueSize`) and compares it against
 * `strategy.valueSizeMax`. Names the *key*, not just the strategy, because a
 * workflow declares many keys and the strategy object alone would not say
 * which value was rejected.
 *
 * Not applied on the read path: a value written under a larger
 * `valueSizeMax` must stay readable after the declaration shrinks.
 *
 * This is a bound on **one value**, not on the store. It is the only size
 * constraint the write path enforces; the workspace-level budget is a figure
 * to provision with (see the module comment above).
 */
function checkValueSize(
  content: unknown,
  strategy: BoxStrategy,
  key: string,
  db?: Database<unknown, string>,
): Result<void, string> {
  const valueSizeMax = strategy.valueSizeMax;

  const sizeResult = measureValueSize(content, db);

  if (sizeResult.isErr()) {
    return err(sizeResult.error);
  }

  const size = sizeResult.value;

  if (size > valueSizeMax) {
    return err(
      `Value for key '${key}' exceeds valueSizeMax: ${size} bytes encoded, limit ${valueSizeMax}`,
    );
  }

  return ok();
}

/**
 * Write-side key-length guard. Past LMDB's maximum key size a `put` throws —
 * from inside `transactionSync` for `lmdb-fifo`, where it escapes as a generic
 * `Transaction failed for put: …` that does not say why, and straight out of
 * `putSync` for `lmdb-kv`, where it would cross this package's API boundary as
 * an exception (rawbox-store/README.md, "API Reference": nothing throws across
 * the API boundary). Both become a named `Err` here.
 *
 * **The limit is read from the open database, never assumed.** `MDB_MAXKEYSIZE`
 * is compile-time (`mdb.c:672`) and the C API exposes only a getter, so the
 * figure is a property of whichever LMDB is linked — 511 upstream, 1978 in the
 * build lmdb-js vendors. Comparing against a hard-coded 511 refuses keys LMDB
 * accepts.
 *
 * **This guard is expected never to fire.** The runner refuses any workflow
 * whose author key exceeds `RAWBOX_KEY_SIZE_MAX`, so a key reaching here
 * through a verified document is at most 79 +
 * `RAWBOX_KEY_DERIVATION_OVERHEAD_MAX` = 111 bytes against a limit of 1978. It
 * stays exactly because of that: a backend backstop that trusts the caller's
 * contract is not a backstop. Two things can still reach it — a caller using
 * `@rawbox/store` directly, without a workflow or the runner's verification, and
 * the case the tripwire exists for, a derivation or a backend that has drifted
 * out from under the contract. Either is worth a named error rather than an
 * opaque LMDB throw.
 *
 * `budgetForKey` computes the widest key the declaration can produce
 * (`keySizeMax`) — the key itself for `lmdb-kv`, the widest derived
 * `fifo:<key>:data:<n>` for `lmdb-fifo`, as a function of `queueSizeMax` rather
 * than an assumed digit count. Reusing it keeps the store and the static
 * checker on one piece of arithmetic, and keeps this a pure function of `(db,
 * key, strategy)` with no read of the current head/tail, so it can still run
 * before any transaction opens.
 *
 * Fails closed when `db.maxKeySize` cannot be read, matching `checkValueSize`'s
 * posture on an unmeasurable value: the guard exists to replace an opaque
 * throw, and cannot do that by guessing.
 *
 * **And fails closed the same way on a strategy with no budget.** `budgetForKey`
 * can now answer `budgetable: false` — a strategy whose bytes are not modelled
 * from the document — which by construction cannot be one this LMDB store
 * routes: both strategies it opens databases for carry a budget, and a strategy
 * belonging to another backend would never reach this file. If one ever does,
 * the widest derived key is unknown, and an unknown width is exactly the case
 * this guard exists to refuse rather than wave through.
 */
function checkKeySize(
  db: Database<unknown, string>,
  strategy: BoxStrategy,
  key: string,
): Result<void, string> {
  const maxKeySizeResult = readMaxKeySize(db);

  if (maxKeySizeResult.isErr()) {
    return err(`Key '${key}' could not be checked: ${maxKeySizeResult.error}`);
  }

  const budget = budgetForKey(key, strategy);

  if (!budget.budgetable) {
    return err(
      `Key '${key}' could not be checked: strategy '${strategy.name}' declares no ` +
        `key or byte model, so the widest key it stores is unknown`,
    );
  }

  const maxKeySize = maxKeySizeResult.value;
  const keySizeMax = budget.keySizeMax;

  if (keySizeMax <= maxKeySize) {
    return ok();
  }

  // Whether the strategy derives an on-disk key wider than the one the
  // author wrote, expressed as a size comparison rather than as
  // `strategy.name === 'lmdb-fifo'`. `keySizeMax` above already is
  // `StrategyDescriptor.keySizeMax`'s answer for `strategy` (`budgetForKey`
  // dispatches through the descriptor's `budget` field, which points at the
  // same per-strategy functions — see the module comment in
  // `strategy/budget.ts`). `lmdb-kv`
  // stores the author's key verbatim, so its `keySizeMax` always equals
  // `measureKeySize(key)`; a strategy whose declared key is wider than that
  // is, by construction, one that derives something — whatever it is named,
  // and however many derived forms it produces.
  const derived =
    keySizeMax > measureKeySize(key) ? ` produces a derived key that` : '';

  return err(
    `Key '${key}'${derived} exceeds LMDB's maximum key size: ${keySizeMax} bytes, limit ${maxKeySize}`,
  );
}

/**
 * The options every workflow database is opened with.
 *
 * Extracted to a shared constant because it is a **compatibility contract,
 * not a preference**: `BoxObserverLmdb` has to open the same databases with
 * the same `encoding` and `compression` or a value a workflow wrote would
 * decode to garbage — or throw — on the inspection path. Two copies of this
 * object literal would be two things to keep in agreement by hand.
 *
 * `sharedStructuresKey` is deliberately absent; see the note on
 * `measureValueSize` in `box-size.ts` for what enabling it would cost.
 */
export const LMDB_DBI_OPTIONS_DEFAULT: DatabaseOptions = Object.freeze({
  cache: false,
  compression: true,
  encoding: 'msgpack',
});

/**
 * The directory of one workspace environment, under the root directory.
 *
 * Shared by the read-write `LmdbEnvCache` and the read-only
 * `BoxObserverLmdb` so the two cannot disagree about where a workspace lives
 * — an observer resolving a *different* path from the runner would report an
 * empty or stale workspace with no error at all.
 */
export function resolveEnvFolderUrl(
  rootDirectoryUrl: URL,
  envIdentifier: string,
): URL {
  const folderUrl = rootDirectoryUrl.pathname.endsWith('/')
    ? rootDirectoryUrl
    : new URL(`${rootDirectoryUrl.href}/`);

  return new URL(`./${envIdentifier}/`, folderUrl);
}

export class LmdbDbiCache<TValue = unknown, TKey extends Key = string> {
  public constructor(
    public readonly env: RootDatabase,
    public readonly dbiOptions: DatabaseOptions = LMDB_DBI_OPTIONS_DEFAULT,
    private readonly dbiMap: Map<string, Database<TValue, TKey>> = new Map<
      string,
      Database<TValue, TKey>
    >(),
  ) {}

  public getOrCreateDbi(
    dbiIdentifier: string,
  ): Result<Database<TValue, TKey>, string> {
    const dbiMap = this.dbiMap;
    const dbiOptions = this.dbiOptions;
    const env = this.env;

    let dbi = dbiMap.get(dbiIdentifier);
    let result: Result<Database<TValue, TKey>, string>;

    if (dbi) {
      result = ok(dbi);
    } else {
      try {
        dbi = env.openDB<TValue, TKey>({
          ...dbiOptions,
          name: dbiIdentifier,
        });

        if (dbi) {
          dbiMap.set(dbiIdentifier, dbi);
          result = ok(dbi);
        } else {
          // Unreachable on a read-write environment, where `openDB` passes
          // `MDB_CREATE`. Named rather than cached-as-`undefined` because
          // every caller unwraps this, and an `ok(undefined)` would surface
          // three frames later as `Cannot read properties of undefined`.
          result = err(`DBI '${dbiIdentifier}' does not exist`);
        }
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        result = err(`Failed to open/create DBI '${dbiIdentifier}': ${error}`);
      }
    }

    return result;
  }
}

export class LmdbEnvCache<TValue, TKey extends Key> {
  public constructor(
    public readonly rootDirectoryUrl: URL,
    public readonly envOptions: RootDatabaseOptions = {
      cache: false,
    },
    private readonly envMap: Map<string, RootDatabase<TValue, TKey>> = new Map<
      string,
      RootDatabase<TValue, TKey>
    >(),
  ) {}

  /**
   * Opens an environment, or returns the one already cached under
   * `envIdentifier`.
   *
   * No `mapSize` is passed to `open()`. The storage budget is a provisioning
   * figure, not a ceiling this layer applies (see the module comment), and
   * `mapSize` would not be a ceiling even if it were passed — lmdb-js grows the
   * map rather than failing the write.
   */
  public getOrCreateEnv(
    envIdentifier: string,
  ): Result<RootDatabase<TValue, TKey>, string> {
    const rootDirectoryUrl = this.rootDirectoryUrl;

    const dbiOptions = this.envOptions;
    const envMap = this.envMap;

    let env = envMap.get(envIdentifier);
    let result: Result<RootDatabase<TValue, TKey>, string>;

    if (env) {
      result = ok(env);
    } else {
      const envFolderUrl = resolveEnvFolderUrl(rootDirectoryUrl, envIdentifier);
      const envFolderPath = fileURLToPath(envFolderUrl);
      env = open<TValue, TKey>({
        ...dbiOptions,
        path: envFolderPath,
      });
      if (env) {
        envMap.set(envIdentifier, env);
        result = ok(env);
      } else {
        result = err(`Failed to open environment '${envIdentifier}'`);
      }
    }

    return result;
  }
}

class BoxStoreLmdbKv implements BoxStore {
  public static getStatic(
    dbi: Database<unknown, string>,
    boxLocation: BoxLocation,
  ): Result<unknown, string> {
    let result: Result<unknown, string>;

    const key = boxLocation.key;
    const strategyName = boxLocation.strategy.name;

    if (strategyName == 'lmdb-kv') {
      const value = dbi.get(key);

      result = value !== undefined ? ok(value) : err('Value not found');
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public static putStatic(
    dbi: Database<unknown, string>,
    box: Box<unknown>,
  ): Result<void, string> {
    let result: Result<void, string>;

    const content = box.content;
    const key = box.location.key;
    const strategyName = box.location.strategy.name;

    if (strategyName == 'lmdb-kv') {
      // Key length first: `dbi.putSync` with an over-long key throws, and an
      // exception out of `putSync` would cross this package's API boundary.
      const keySizeCheckResult = checkKeySize(dbi, box.location.strategy, key);
      const sizeCheckResult = keySizeCheckResult.isErr()
        ? keySizeCheckResult
        : checkValueSize(content, box.location.strategy, key, dbi);

      if (sizeCheckResult.isErr()) {
        result = err(sizeCheckResult.error);
      } else {
        dbi.putSync(key, content);

        result = ok();
      }
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public constructor(public readonly dbiCache: LmdbDbiCache<unknown, string>) {}

  public async get(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    return this.getSync(boxLocation);
  }

  public getSync(boxLocation: BoxLocation): Result<unknown, string> {
    const dbiCache = this.dbiCache;

    const workflow = boxLocation.workflow;

    const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();

    return BoxStoreLmdbKv.getStatic(dbi, boxLocation);
  }

  public async put(box: Box<unknown>): Promise<Result<void, string>> {
    return this.putSync(box);
  }

  public putSync(box: Box<unknown>): Result<void, string> {
    const dbiCache = this.dbiCache;

    const workflow = box.location.workflow;
    const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();

    return BoxStoreLmdbKv.putStatic(dbi, box);
  }
}

class BoxStoreLmdbFifo implements BoxStore {
  /**
   * Queue head, tail, and data items are stored using namespaced string keys,
   * built by `fifoHeadKey` / `fifoTailKey` / `fifoDataKey` in `box-peek.ts`.
   *
   * **The names live next to the observer on purpose.** The peek path reads
   * the very entries this class writes; if the two spelled them separately,
   * a change here would make peek report a stale element — silently, with no
   * error anywhere — which is the precise failure `@rawbox/runner`'s
   * OBSERVABILITY.md, "Peek is not get", calls the one place a bug is
   * dangerous rather than merely wrong. One definition, two callers.
   */

  public static getStatic(
    dbiCache: LmdbDbiCache<unknown, string>,
    boxLocation: BoxLocation,
  ): Result<unknown, string> {
    const key = boxLocation.key;
    const strategyName = boxLocation.strategy.name;
    const workflow = boxLocation.workflow;

    let result: Result<unknown, string> = err('Unknown error');

    if (strategyName == 'lmdb-fifo') {
      const headDbiKey = fifoHeadKey(key);
      const tailDbiKey = fifoTailKey(key);
      const queueSizeMax = boxLocation.strategy.queueSizeMax;

      try {
        dbiCache.env.transactionSync(() => {
          const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
          const head = (dbi.get(headDbiKey) as number) || 0;
          const tail = (dbi.get(tailDbiKey) as number) || 0;

          if (head !== tail) {
            const tailDataDbiKey = fifoDataKey(key, tail);
            const content = dbi.get(tailDataDbiKey);
            const nextTail = (tail + 1) % queueSizeMax;

            dbi.put(tailDbiKey, nextTail);
            dbi.remove(tailDataDbiKey);
            result = ok(content);
          } else {
            result = err(`Queue empty`);
          }
        });
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        result = err(`Transaction failed for get: ${error}`);
      }
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public static putStatic(
    dbiCache: LmdbDbiCache<unknown, string>,
    box: Box<unknown>,
  ): Result<void, string> {
    const content = box.content;
    const key = box.location.key;
    const strategyName = box.location.strategy.name;
    const workflow = box.location.workflow;

    let result: Result<void, string> = err('Unknown error');

    if (strategyName == 'lmdb-fifo') {
      // Guarded before the transaction opens: an oversized value
      // or an over-long derived key is a caller error, not a storage
      // failure, and must not take a write lock only to abort.
      // `getOrCreateDbi` is a cache lookup, safe to call outside a
      // transaction.
      const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();

      const keySizeCheckResult = checkKeySize(dbi, box.location.strategy, key);

      if (keySizeCheckResult.isErr()) {
        return err(keySizeCheckResult.error);
      }

      const valueSizeCheckResult = checkValueSize(
        content,
        box.location.strategy,
        key,
        dbi,
      );

      if (valueSizeCheckResult.isErr()) {
        return err(valueSizeCheckResult.error);
      }

      const headDbiKey = fifoHeadKey(key);
      const tailDbiKey = fifoTailKey(key);
      const queueSizeMax = box.location.strategy.queueSizeMax;

      try {
        dbiCache.env.transactionSync(() => {
          const head = (dbi.get(headDbiKey) as number) || 0;
          const tail = (dbi.get(tailDbiKey) as number) || 0;

          const nextHead = (head + 1) % queueSizeMax;

          if (nextHead !== tail) {
            const headDataDbiKey = fifoDataKey(key, head);

            dbi.putSync(headDataDbiKey, content);
            dbi.putSync(headDbiKey, nextHead);

            result = ok();
          } else {
            result = err(`Queue is full '${strategyName}'`);
          }
        });
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        result = err(`Transaction failed for put: ${error}`);
      }
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public constructor(public readonly dbiCache: LmdbDbiCache<unknown, string>) {}

  public async get(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    return this.getSync(boxLocation);
  }

  public getSync(boxLocation: BoxLocation): Result<unknown, string> {
    return BoxStoreLmdbFifo.getStatic(this.dbiCache, boxLocation);
  }

  public async put(box: Box<unknown>): Promise<Result<void, string>> {
    return this.putSync(box);
  }

  public putSync(box: Box<unknown>): Result<void, string> {
    return BoxStoreLmdbFifo.putStatic(this.dbiCache, box);
  }
}

/**
 * The `default:` arm of this store's two strategy switches.
 *
 * **A backstop, not the diagnostic.** `BoxStrategy` is open to strategies this
 * class does not route — `redis-kv` is one — and a run declaring one is refused
 * before it starts, by `collectUnwiredStrategyProblems` in `@rawbox/runner`'s
 * `workflow/store-support.ts`, which names the declaration site and says the
 * store is missing from this build. Reaching *here* means that check was
 * bypassed: a caller using `@rawbox/store` directly, with no workflow and no
 * runner. So the message says what such a caller needs — this class routes LMDB
 * and only LMDB, whatever the name turns out to be.
 *
 * It deliberately does **not** claim the name is valid, because this arm is also
 * where an unvalidated `BoxLocation` lands: `BoxStrategy` is what a document
 * parses into, but a caller building a location by hand can put any string in
 * `strategy.name`. The two cases share one remedy and one guarantee, so they
 * share one sentence.
 *
 * An `Err` and never a throw: nothing may cross this package's API boundary as
 * an exception (`packages/rawbox-store/README.md`, "API Reference"). And never
 * a fall-through to `lmdb-kv`, which would put a caller's data in a file when
 * they asked for a server, with nothing anywhere saying so.
 */
function unsupportedStrategyError(strategyName: string): string {
  return (
    `Unsupported strategy: '${strategyName}' — BoxStoreLmdb routes 'lmdb-kv' and ` +
    `'lmdb-fifo' only. Nothing was written and nothing fell back to LMDB: a strategy ` +
    `this store does not route is either stored by a different backend or is not a ` +
    `strategy at all, and neither one's data may land in this file. Open a store for ` +
    `that backend, or declare an LMDB strategy for this key.`
  );
}

export class BoxStoreLmdb implements BoxStore {
  public readonly boxStoreLmdbFifo: BoxStoreLmdbFifo;
  public readonly boxStoreLmdbKv: BoxStoreLmdbKv;

  /**
   * Opens the workspace environment and returns a store over it.
   *
   * There is no budget parameter. The figure `box-size.ts` computes is for
   * sizing a volume or a container before the run; the store neither receives
   * it nor consults it on any write (see the module comment).
   */
  public static create(
    workspace: string,
    rootDirectoryUrl: URL,
  ): BoxStoreLmdb {
    const envCache = new LmdbEnvCache<unknown, string>(rootDirectoryUrl);

    // Safe to unwrap: the cache was created one line above, so the only way
    // this fails is `open()` returning nothing.
    const env = envCache.getOrCreateEnv(workspace)._unsafeUnwrap();

    const dbiCache = new LmdbDbiCache<unknown, string>(env);

    const boxStore = new BoxStoreLmdb(dbiCache);

    return boxStore;
  }

  public constructor(public readonly dbiCache: LmdbDbiCache<unknown, string>) {
    this.boxStoreLmdbFifo = new BoxStoreLmdbFifo(dbiCache);
    this.boxStoreLmdbKv = new BoxStoreLmdbKv(dbiCache);
  }

  public putSync(box: Box<unknown>): Result<void, string> {
    const strategyName = box.location.strategy.name;

    switch (strategyName) {
      case 'lmdb-kv':
        return this.boxStoreLmdbKv.putSync(box);
      case 'lmdb-fifo':
        return this.boxStoreLmdbFifo.putSync(box);
      default:
        return err(unsupportedStrategyError(strategyName));
    }
  }

  public async put(box: Box<unknown>): Promise<Result<void, string>> {
    return this.putSync(box);
  }

  public getSync(boxLocation: BoxLocation): Result<unknown, string> {
    const strategyName = boxLocation.strategy.name;

    switch (strategyName) {
      case 'lmdb-kv':
        return this.boxStoreLmdbKv.getSync(boxLocation);
      case 'lmdb-fifo':
        return this.boxStoreLmdbFifo.getSync(boxLocation);
      default:
        return err(unsupportedStrategyError(strategyName));
    }
  }

  public async get(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    return this.getSync(boxLocation);
  }

  // -------------------------------------------------------------------------
  // Observation — reads that are not dequeues
  //
  // `getSync` on an `lmdb-fifo` box is a **consumer** API: it removes the
  // entry it returns and advances the tail. The four methods below are the
  // **observer** API, and they mutate nothing — see `box-peek.ts`.
  //
  // These are the *in-process* form, for a workflow reading its own or a
  // sibling's state, as `@rawbox/rawbox-plugin-default`'s
  // `observability/snapshot` does. They run against this store's read-write
  // environment and share its database lifecycle: like `getSync`, a peek at a
  // workflow with no database yet will create the (empty) database, because
  // `getOrCreateDbi` passes `MDB_CREATE`. That is a database handle, never a
  // key — no `head`, `tail` or `data:` entry is touched on any path here.
  //
  // For inspection from *outside* the run — a CLI, a supervisor, another
  // process — use `BoxObserverLmdb`, which opens the environment `readOnly:
  // true` and therefore cannot create even that.
  // -------------------------------------------------------------------------

  /** {@link peekStatic} — the value a `get` would return, left in place. */
  public peekSync(boxLocation: BoxLocation): Result<unknown, string> {
    return this.withDbi(boxLocation.workflow, (dbi) =>
      peekStatic(dbi, boxLocation),
    );
  }

  public async peek(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    return this.peekSync(boxLocation);
  }

  /** {@link peekAllStatic} — every queued element, oldest first. */
  public peekAllSync(boxLocation: BoxLocation): Result<unknown[], string> {
    return this.withDbi(boxLocation.workflow, (dbi) =>
      peekAllStatic(dbi, boxLocation),
    );
  }

  public async peekAll(
    boxLocation: BoxLocation,
  ): Promise<Result<unknown[], string>> {
    return this.peekAllSync(boxLocation);
  }

  /** {@link depthStatic} — `{used, capacity}` for an `lmdb-fifo` box. */
  public depthSync(boxLocation: BoxLocation): Result<BoxQueueDepth, string> {
    return this.withDbi(boxLocation.workflow, (dbi) =>
      depthStatic(dbi, boxLocation),
    );
  }

  /** {@link inspectStatic} — every logical key in one workflow, classified. */
  public inspectSync(workflow: string): Result<BoxInspection[], string> {
    return this.withDbi(workflow, (dbi) => inspectStatic(dbi));
  }

  private withDbi<TValue>(
    workflow: string,
    operation: (dbi: Database<unknown, string>) => Result<TValue, string>,
  ): Result<TValue, string> {
    const dbiResult = this.dbiCache.getOrCreateDbi(workflow);

    if (dbiResult.isErr()) {
      return err(dbiResult.error);
    }

    try {
      return operation(dbiResult.value);
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);

      return err(`Observation failed for workflow '${workflow}': ${error}`);
    }
  }

  /**
   * Runs `callback` inside one LMDB write transaction and resolves with its
   * `Result`.
   *
   * ## The signature is deliberately asymmetric — read this before "fixing" it
   *
   * The method is `async`. **The callback is not, and must never be made so.**
   * That asymmetry is the whole point of this shape, and it is load-bearing on
   * both halves.
   *
   * **Why the boundary is a Promise.** Every storage write in the runner goes
   * through here, from call sites that are already `async` — `syncData`
   * (`rawbox-runner/src/machine/actors/sync-db-actor.ts`), `exitFunc`
   * (`.../exit-actor.ts`) and the seeding pass
   * (`rawbox-runner/src/tool/run-workflow.ts`). A store whose operations are
   * network calls — Redis — cannot answer synchronously, and a run loop that
   * *calls* synchronously cannot be pointed at one without being rewritten
   * around every write. Awaiting here means the swap is a change of binding,
   * not a change of control flow. This mirrors {@link BoxStoreLmdb.get} and
   * {@link BoxStoreLmdb.put}, which are async wrappers over `getSync`/`putSync`
   * for the same reason.
   *
   * Note what this does *not* cost: because the body contains no `await`, an
   * `async` method still executes `transactionSync` — and therefore the whole
   * callback, commit included — synchronously before it returns its Promise.
   * The only thing deferred to a microtask is the caller's observation of the
   * outcome. The transaction is never open across a suspension point.
   *
   * **Why the callback stays synchronous.** Two independent reasons, either one
   * sufficient:
   *
   * 1. **`transactionSync` commits when its callback returns.** JavaScript
   *    cannot block on a Promise, so an `async` callback would return a pending
   *    Promise immediately, lmdb-js would see a truthy non-`ABORT` value, and
   *    the transaction would commit *before any of the intended work ran* — a
   *    silent empty commit, with the writes landing afterwards outside any
   *    transaction, if at all. There is no error to observe; the atomicity a
   *    step's write-then-read depends on simply evaporates.
   * 2. **Suspending inside an LMDB transaction is the MVCC hazard.** An open
   *    transaction pins a snapshot, and a pinned snapshot stops the *writers'*
   *    environment reclaiming the pages it references — so an `await` inside
   *    the callback makes a busy store grow without bound, in another process.
   *    That failure mode, and the lmdb-js source behind it, is documented at
   *    length on {@link BoxObserverLmdb} (`box-observer-lmdb.ts:29-105`).
   *
   * This is also why `getSync`/`putSync` must continue to exist alongside the
   * Promise-returning `get`/`put`: they are the forms the callback calls.
   *
   * **A note for the backend that comes next.** A callback that must be
   * synchronous on LMDB and asynchronous on Redis cannot be one interface —
   * which is why `transaction` is *not* on the {@link BoxStore} interface. All
   * three runner call sites do the same shape of work (write a set of boxes,
   * optionally read a set of locations, atomically), so the portable primitive
   * is likely that work expressed as **data** — `{writes, reads}` — which each
   * backend executes its own way: `transactionSync` here, `MULTI` or a Lua
   * script there. That change belongs with the Redis store, not here.
   *
   * ## Abort semantics
   *
   * An `Err` from the callback aborts the transaction and is returned
   * **unchanged**. The specific error matters: it is what every storage
   * diagnostic in the runner reports — which key, which strategy, which size
   * limit. `'Transaction aborted'` is a fallback for the unreachable case where
   * lmdb-js returned `ABORT` but the callback's `Result` was somehow never
   * recorded, and must not become the general answer.
   */
  public async transaction<T>(
    callback: (boxStore: BoxStoreLmdb) => Result<T, string>,
  ): Promise<Result<T, string>> {
    let methodResult: Result<T, string>;

    try {
      let callbackResult: Result<T, string> | undefined;

      const txResult = this.dbiCache.env.transactionSync(() => {
        callbackResult = callback(this);

        if (callbackResult.isErr()) {
          return ABORT;
        }

        return callbackResult;
      });

      if (txResult === ABORT) {
        methodResult =
          callbackResult && callbackResult.isErr()
            ? callbackResult
            : err('Transaction aborted');
      } else {
        methodResult = txResult as Result<T, string>;
      }
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      methodResult = err(`Transaction failed: ${errorMsg}`);
    }

    return methodResult;
  }
}
