import {
  open,
  type Database,
  type DatabaseOptions,
  type RootDatabase,
} from 'lmdb';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ok, err, type Result } from 'neverthrow';

import { type BoxLocation } from '../box.js';
import { type BoxObserver } from './box-observer.js';
import {
  LMDB_DBI_OPTIONS_DEFAULT,
  resolveEnvFolderUrl,
} from './box-store-lmdb.js';
import {
  depthStatic,
  inspectStatic,
  peekAllStatic,
  peekStatic,
  type BoxInspection,
  type BoxQueueDepth,
} from './box-peek.js';

// ---------------------------------------------------------------------------
// The observer, and the one hazard it exists to avoid
// ---------------------------------------------------------------------------

/**
 * A **read-only** view of one workspace environment: peek, enumerate, measure.
 * Nothing here writes; see `box-peek.ts` for why a FIFO `get` cannot be used
 * for any of it.
 *
 * ## Two guarantees, one structural and one operational
 *
 * **1. It cannot write.** The environment is opened `readOnly: true`, which
 * sets `MDB_RDONLY` (`lmdb/open.js:180`) and — more usefully — makes lmdb-js
 * skip `addWriteMethods` entirely (`lmdb/open.js:541`). On the resulting
 * store `putSync`, `remove`, `removeSync`, `drop` and `transactionSync` are
 * not merely refused, they are `undefined`. `openDB` likewise omits
 * `MDB_CREATE` (`lmdb/open.js:276`), so observing a workflow that does not
 * exist yet returns an error rather than creating an empty database. The one
 * remaining way to touch the filesystem is `open()` itself, which `mkdir`s
 * its path before it fails (`lmdb/open.js:138`); {@link BoxObserverLmdb.openSync}
 * therefore checks for `data.mdb` *before* calling it, so an observer pointed
 * at a workspace that has never run creates nothing.
 *
 * **2. It never parks an MVCC snapshot.** This is the hazard the plan was
 * amended for, and it is not about staleness. An LMDB read transaction pins a
 * snapshot, and a pinned snapshot stops the **writers'** environment from
 * reclaiming the pages that snapshot still references. A parked observer
 * therefore does not merely see old data — it makes a busy store grow without
 * bound, in someone else's process. An observability tool that silently
 * unbounds production storage is worse than no observability tool.
 *
 * ### How the second guarantee is arranged, verified against lmdb-js source
 *
 * lmdb-js keeps **one shared read transaction per environment**. The first
 * read of an event-loop turn calls `renewReadTxn`, which acquires the
 * transaction and, in the same breath, schedules its release:
 *
 * ```js
 * // node_modules/lmdb/read.js:1056-1058
 * // we actually don't renew here, we let the renew take place in the next
 * // lmdb native read/call so as to avoid an extra native call
 * readTxnRenewed = setTimeout(resetReadTxn, 0);
 * ```
 *
 * `resetReadTxn` calls `resetTxn(readTxn.address)` — `mdb_txn_reset` — which
 * releases the snapshot while keeping the process's slot in the reader table
 * (`lmdb/read.js:1062-1086`). So in the default flow a snapshot lives at most
 * one macrotask.
 *
 * Two things defeat that default, and this class is shaped so a caller cannot
 * reach either:
 *
 * - **`useReadTransaction()`** hands out a refcounted transaction that stays
 *   pinned until `.done()` (`lmdb/read.js:948-959`, `Txn.prototype.done`).
 *   It is never called here, and no transaction object is ever returned.
 * - **Suspending inside a read.** A `getRange` iterator left alive across an
 *   `await` holds its cursor, and `resetReadTxn` then marks the transaction
 *   `notCurrent` and hands the snapshot on rather than releasing it
 *   (`lmdb/read.js:1064-1069`). So **every method on this class is
 *   synchronous and returns fully materialised plain data** — arrays and
 *   records, never a `RangeIterable`. There is no `await` a caller can put in
 *   the middle of an observer read, because there is no asynchronous observer
 *   read.
 *
 * On top of that, every method resets the shared read transaction in a
 * `finally` (see {@link BoxObserverLmdb.read}), rather than waiting for the
 * scheduled macrotask. That buys two things: a snapshot is released before
 * the call even returns, and the *next* call necessarily starts from a fresh
 * snapshot instead of an accidentally reused one. Both are observable —
 * `readerList()` reports the slot's `txnid` as a number while a snapshot is
 * held and as `-` once it is reset — and `box-observer-lmdb.test.ts` asserts
 * exactly that, alongside a sustained polling run whose data-directory growth
 * is compared against a no-observer control.
 *
 * ### What is *not* guaranteed
 *
 * Holding the observer open for hours is fine; that costs one reader slot,
 * not a snapshot. What is not safe, and cannot be made safe from inside this
 * class, is a caller that reaches past it — `open({readOnly: true})`
 * directly, or `useReadTransaction()` on some other handle to the same
 * environment. The reader table is the place to look when a store grows for
 * no reason: {@link BoxObserverLmdb.readerListSync} dumps it.
 */
export class BoxObserverLmdb implements BoxObserver {
  /**
   * Opens the workspace environment read-only.
   *
   * The environment is `<rootDirectoryUrl>/<workspace>/`, resolved through the
   * same {@link resolveEnvFolderUrl} the writer uses, so an observer and a
   * runner cannot disagree about where a workspace lives.
   *
   * Returns an `Err` — never a throw, and never a created directory — when
   * the workspace has never been written. "Nothing has run yet" is a normal
   * answer for an inspection command, not an exception.
   */
  public static openSync(
    workspace: string,
    rootDirectoryUrl: URL,
  ): Result<BoxObserverLmdb, string> {
    const envFolderUrl = resolveEnvFolderUrl(rootDirectoryUrl, workspace);
    const envFolderPath = fileURLToPath(envFolderUrl);
    const dataFileUrl = new URL('./data.mdb', envFolderUrl);

    // Checked before `open()`, which would `mkdir -p` the path on its way to
    // failing (lmdb/open.js:138). An observer must not create anything.
    if (!existsSync(fileURLToPath(dataFileUrl))) {
      return err(
        `No LMDB environment for workspace '${workspace}': ${envFolderPath} has no data.mdb (nothing has been written to this workspace yet)`,
      );
    }

    let env: RootDatabase<unknown, string> | undefined;

    try {
      env = open<unknown, string>({
        cache: false,
        readOnly: true,
        path: envFolderPath,
      });
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);

      return err(
        `Failed to open workspace '${workspace}' read-only at ${envFolderPath}: ${error}`,
      );
    }

    if (!env) {
      return err(
        `Failed to open workspace '${workspace}' read-only at ${envFolderPath}`,
      );
    }

    return ok(new BoxObserverLmdb(workspace, envFolderUrl, env));
  }

  private closed = false;

  private constructor(
    public readonly workspace: string,
    public readonly envFolderUrl: URL,
    /**
     * `private` on purpose. Handing this out would hand out
     * `useReadTransaction()` and `getRange()`, and with them the ability to
     * park a snapshot — the one thing this class exists to prevent.
     */
    private readonly env: RootDatabase<unknown, string>,
    /**
     * Must match what `LmdbDbiCache` opens databases with, or a value written
     * by a workflow would decode to garbage here. Shared constant, not a copy.
     */
    private readonly dbiOptions: DatabaseOptions = LMDB_DBI_OPTIONS_DEFAULT,
    private readonly dbiMap: Map<string, Database<unknown, string>> = new Map<
      string,
      Database<unknown, string>
    >(),
  ) {}

  /** Databases (workflows) that exist in this workspace environment, sorted. */
  public listWorkflowsSync(): Result<string[], string> {
    return this.read(() => {
      const workflowList: string[] = [];

      // The unnamed main database of an LMDB environment holds one entry per
      // named sub-database, so its keys *are* the workflow names. Only
      // `getKeys` is used: the values are LMDB's own `MDB_db` records, and
      // `getRange` would try to msgpack-decode them and throw.
      for (const name of this.env.getKeys()) {
        if (typeof name === 'string') {
          workflowList.push(name);
        }
      }

      workflowList.sort();

      return ok(workflowList);
    });
  }

  /**
   * Every logical key in one workflow, classified — see {@link inspectStatic}.
   * Derived `fifo:…` entries are folded into one record per queue and never
   * surface as user keys.
   */
  public listKeysSync(workflow: string): Result<BoxInspection[], string> {
    return this.read(() => {
      const dbiResult = this.getDbi(workflow);

      return dbiResult.isErr()
        ? err(dbiResult.error)
        : inspectStatic(dbiResult.value);
    });
  }

  /** The value a `get` would return, without consuming it. {@link peekStatic} */
  public peekSync(boxLocation: BoxLocation): Result<unknown, string> {
    return this.read(() =>
      this.withDbi(boxLocation, (dbi) => peekStatic(dbi, boxLocation)),
    );
  }

  /** Every queued element, oldest first, across the wrap. {@link peekAllStatic} */
  public peekAllSync(boxLocation: BoxLocation): Result<unknown[], string> {
    return this.read(() =>
      this.withDbi(boxLocation, (dbi) => peekAllStatic(dbi, boxLocation)),
    );
  }

  /** `{used, capacity}` for an `lmdb-fifo` box. {@link depthStatic} */
  public depthSync(boxLocation: BoxLocation): Result<BoxQueueDepth, string> {
    return this.read(() =>
      this.withDbi(boxLocation, (dbi) => depthStatic(dbi, boxLocation)),
    );
  }

  /**
   * LMDB's reader lock table, verbatim from `mdb_reader_list`: one line per
   * slot with pid, thread and the `txnid` of the snapshot it pins, or `-`
   * when it pins none.
   *
   * This is the diagnostic for the growth hazard described on the class. A
   * store growing with no matching write volume, and a reader here holding an
   * old `txnid`, is that hazard rather than a coincidence. Between calls,
   * this observer's own slot always reads `-`.
   */
  public readerListSync(): Result<string, string> {
    return this.read(() => ok(this.env.readerList()));
  }

  /**
   * Releases the environment handle and this process's reader slot.
   *
   * Idempotent, and never throws: closing an observer is cleanup, and cleanup
   * that can fail loudly in a `finally` is worse than cleanup that cannot.
   */
  public closeSync(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.dbiMap.clear();

    try {
      // `close()` returns a promise for the root store. Swallowed rather than
      // ignored: an unhandled rejection out of a cleanup call would take down
      // a supervisor that was only trying to stop watching.
      void Promise.resolve(this.env.close()).catch(() => undefined);
    } catch {
      void 0;
    }
  }

  /**
   * The read discipline, in one place so no method can forget it: refuse once
   * closed, convert any throw into an `Err` (nothing crosses this package's
   * API boundary as an exception — rawbox-store/README.md, "API Reference"),
   * and **release the MVCC snapshot before returning**, on the error path as
   * much as the success path. A read that threw halfway through is exactly
   * the read most likely to leave a snapshot pinned, which is why the reset
   * is in a `finally` rather than after the call.
   */
  private read<TValue>(
    operation: () => Result<TValue, string>,
  ): Result<TValue, string> {
    if (this.closed) {
      return err(`Observer for workspace '${this.workspace}' is closed`);
    }

    try {
      return operation();
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);

      return err(
        `Read-only observation of workspace '${this.workspace}' failed: ${error}`,
      );
    } finally {
      try {
        this.env.resetReadTxn();
      } catch {
        // The environment can only be closed under us by a caller racing
        // `closeSync`; there is no snapshot left to release in that case.
        void 0;
      }
    }
  }

  /**
   * Resolves the database for a location, refusing a location addressed at a
   * different workspace. An observer is scoped to the environment it opened,
   * and silently reading `workspace: 'staging'` out of the `live` environment
   * would be a wrong answer rather than an error.
   */
  private withDbi<TValue>(
    boxLocation: BoxLocation,
    operation: (dbi: Database<unknown, string>) => Result<TValue, string>,
  ): Result<TValue, string> {
    if (boxLocation.workspace !== this.workspace) {
      return err(
        `Location addresses workspace '${boxLocation.workspace}' but this observer is open on '${this.workspace}'`,
      );
    }

    const dbiResult = this.getDbi(boxLocation.workflow);

    return dbiResult.isErr() ? err(dbiResult.error) : operation(dbiResult.value);
  }

  /**
   * Opens a workflow database, or returns the cached handle.
   *
   * `openDB` on a read-only environment returns `undefined` for a database
   * that does not exist — it cannot create one, since `MDB_CREATE` is omitted
   * (`lmdb/open.js:276`). Measured, not assumed: an `openDB` of a missing
   * name on a read-only env yields `undefined`, and the naive
   * `dbi.getKeys()` that follows fails with an unrelated
   * `Cannot read properties of undefined`. Named here instead.
   */
  private getDbi(workflow: string): Result<Database<unknown, string>, string> {
    const cached = this.dbiMap.get(workflow);

    if (cached !== undefined) {
      return ok(cached);
    }

    let dbi: Database<unknown, string> | undefined;

    try {
      dbi = this.env.openDB<unknown, string>({
        ...this.dbiOptions,
        name: workflow,
      });
    } catch (e: unknown) {
      const error = e instanceof Error ? e.message : String(e);

      return err(
        `Failed to open workflow database '${workflow}' in workspace '${this.workspace}': ${error}`,
      );
    }

    if (!dbi) {
      return err(
        `Workflow '${workflow}' has no database in workspace '${this.workspace}'`,
      );
    }

    this.dbiMap.set(workflow, dbi);

    return ok(dbi);
  }
}
