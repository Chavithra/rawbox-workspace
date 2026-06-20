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

import { type Box, type BoxLocation } from '../box.js';
import { type BoxStore } from './box-store.js';
import { fileURLToPath } from 'node:url';

export class LmdbDbiCache<TValue = unknown, TKey extends Key = number> {
  public constructor(
    public readonly env: RootDatabase,
    public readonly dbiOptions: DatabaseOptions = {
      compression: true,
      encoding: 'msgpack',
      keyEncoding: 'uint32',
    },
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
        dbiMap.set(dbiIdentifier, dbi);
        result = ok(dbi);
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
    public readonly envOptions: RootDatabaseOptions = {},
    private readonly envMap: Map<string, RootDatabase<TValue, TKey>> = new Map<
      string,
      RootDatabase<TValue, TKey>
    >(),
  ) {}

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
      const folderUrl = rootDirectoryUrl.pathname.endsWith('/')
        ? rootDirectoryUrl
        : `${rootDirectoryUrl}/`;
      const envFolderUrl = new URL(`./${envIdentifier}/`, folderUrl);
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
  public static buildDbiKey(key: number): Result<number, string> {
    /** Creates a binary:
     * - with 0x000 at the first 12 bits
     * - with key in the last 20 bits (max 1,048,575 elements)
     */
    let result: Result<number, string>;

    if (key <= 0xfffff && key >= 0) {
      result = ok((0x00 << 20) | (key & 0xfffff));
    } else {
      result = err(`CRITICAL: key '${key}' should be between 0 and 1,048,575`);
    }

    return result;
  }

  public static getStatic(
    dbi: Database<unknown, number>,
    boxLocation: BoxLocation,
  ): Result<unknown, string> {
    let result: Result<unknown, string>;

    const key = boxLocation.key;
    const strategyName = boxLocation.strategy.name;

    if (strategyName == 'lmdb-kv') {
      const dbiKey = BoxStoreLmdbKv.buildDbiKey(key)._unsafeUnwrap();

      const value = dbi.get(dbiKey);

      result = value !== undefined ? ok(value) : err('Value not found');
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public static putStatic(
    dbi: Database<unknown, number>,
    box: Box<unknown>,
  ): Result<void, string> {
    let result: Result<void, string>;

    const content = box.content;
    const key = box.location.key;
    const strategyName = box.location.strategy.name;

    if (strategyName == 'lmdb-kv') {
      const dbiKey = BoxStoreLmdbKv.buildDbiKey(key)._unsafeUnwrap();

      dbi.putSync(dbiKey, content);

      result = ok();
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public constructor(public readonly dbiCache: LmdbDbiCache<unknown, number>) {}

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
const FIFO_DATA_OFFSET = 2;
const FIFO_HEAD_OFFSET = 0;
const FIFO_OFFSET_BIT_NUMBER = 20;
const FIFO_TAIL_OFFSET = 1;

class BoxStoreLmdbFifo implements BoxStore {
  /**
   * QueueSizeMax must be a power of 2.
   * BoxLocation.key > 0 (to not intersect with BoxStoreLmdbKv key space).
   *
   * Maximum item storable = `QueueSizeMax` - 3:
   * - 1 bit to store queue tail.
   * - 1 bit to store queue head.
   * - 1 bit left empty to distinguish empty state vs full state.
   */

  public static getStatic(
    dbiCache: LmdbDbiCache<unknown, number>,
    boxLocation: BoxLocation,
  ): Result<unknown, string> {
    const key = boxLocation.key;
    const strategyName = boxLocation.strategy.name;
    const workflow = boxLocation.workflow;

    let result: Result<unknown, string> = err('Unknown error');

    if (key === 0) {
      result = err('Key 0 is reserved for lmdb-kv strategy');
    } else if (key >= 4096) {
      result = err(
        'Key too large: must be < 4096 for lmdb-fifo strategy to avoid bitwise overflow',
      );
    } else if (strategyName == 'lmdb-fifo') {
      const dataDbiKey = (key << FIFO_OFFSET_BIT_NUMBER) | FIFO_DATA_OFFSET;
      const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
      const headDbiKey = (key << FIFO_OFFSET_BIT_NUMBER) | FIFO_HEAD_OFFSET;
      const queueSizeMax = boxLocation.strategy.queueSizeMax;
      const tailDbiKey = (key << FIFO_OFFSET_BIT_NUMBER) | FIFO_TAIL_OFFSET;

      if ((queueSizeMax & (queueSizeMax - 1)) !== 0) {
        result = err(`queueSizeMax must be a power of 2, got ${queueSizeMax}`);
      } else {
        try {
          dbiCache.env.transactionSync(() => {
            const maxOffset = queueSizeMax - 1;
            const head = (dbi.get(headDbiKey) as number) || 0;
            const tail = (dbi.get(tailDbiKey) as number) || 0;

            if (head !== tail) {
              const tailDataDbiKey = dataDbiKey + tail;
              const content = dbi.get(tailDataDbiKey);
              const nextTail = (tail + 1) & maxOffset;

              dbi.put(tailDbiKey, nextTail);
              result = ok(content);
            } else {
              result = err(`Queue empty`);
            }
          });
        } catch (e: unknown) {
          const error = e instanceof Error ? e.message : String(e);
          result = err(`Transaction failed for get: ${error}`);
        }
      }
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public static putStatic(
    dbiCache: LmdbDbiCache<unknown, number>,
    box: Box<unknown>,
  ): Result<void, string> {
    const content = box.content;
    const key = box.location.key;
    const strategyName = box.location.strategy.name;
    const workflow = box.location.workflow;

    let result: Result<void, string> = err('Unknown error');

    if (key === 0) {
      result = err('Key 0 is reserved for lmdb-kv strategy');
    } else if (key >= 4096) {
      result = err(
        'Key too large: must be < 4096 for lmdb-fifo strategy to avoid bitwise overflow',
      );
    } else if (strategyName == 'lmdb-fifo') {
      const dataDbiKey = (key << FIFO_OFFSET_BIT_NUMBER) | FIFO_DATA_OFFSET;
      const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
      const headDbiKey = (key << FIFO_OFFSET_BIT_NUMBER) | FIFO_HEAD_OFFSET;
      const queueSizeMax = box.location.strategy.queueSizeMax;
      const tailDbiKey = (key << FIFO_OFFSET_BIT_NUMBER) | FIFO_TAIL_OFFSET;

      if ((queueSizeMax & (queueSizeMax - 1)) !== 0) {
        result = err(`queueSizeMax must be a power of 2, got ${queueSizeMax}`);
      } else {
        try {
          dbiCache.env.transactionSync(() => {
            const maxOffset = queueSizeMax - 1;
            const head = (dbi.get(headDbiKey) as number) || 0;
            const tail = (dbi.get(tailDbiKey) as number) || 0;

            const nextHead = (head + 1) & maxOffset;

            if (nextHead !== tail) {
              const headDataDbiKey = dataDbiKey + head;

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
      }
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public constructor(public readonly dbiCache: LmdbDbiCache<unknown, number>) {}

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

export class BoxStoreLmdb implements BoxStore {
  public readonly boxStoreLmdbFifo: BoxStoreLmdbFifo;
  public readonly boxStoreLmdbKv: BoxStoreLmdbKv;

  public static create(workspace: string, rootDirectoryUrl: URL): BoxStoreLmdb {
    const envCache = new LmdbEnvCache<unknown, number>(rootDirectoryUrl);

    const env = envCache.getOrCreateEnv(workspace)._unsafeUnwrap();

    const dbiCache = new LmdbDbiCache<unknown, number>(env);

    const boxStore = new BoxStoreLmdb(dbiCache);

    return boxStore;
  }

  public constructor(public readonly dbiCache: LmdbDbiCache<unknown, number>) {
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
        return err(`Unsupported strategy: '${strategyName}'`);
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
        return err(`Unsupported strategy: '${strategyName}'`);
    }
  }

  public async get(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    return this.getSync(boxLocation);
  }

  public transaction<T>(
    callback: (store: BoxStoreLmdb) => Result<T, string>,
  ): Result<T, string> {
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
