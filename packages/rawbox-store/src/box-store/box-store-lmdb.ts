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

export class LmdbDbiCache<TValue = unknown, TKey extends Key = string> {
  public constructor(
    public readonly env: RootDatabase,
    public readonly dbiOptions: DatabaseOptions = {
      cache: false,
      compression: true,
      encoding: 'msgpack',
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
    public readonly envOptions: RootDatabaseOptions = {
      cache: false,
    },
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
      dbi.putSync(key, content);

      result = ok();
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
   * QueueSizeMax must be a power of 2.
   * Queue head, tail, and data items are stored using namespaced string keys.
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
      const headDbiKey = `fifo:${key}:head`;
      const tailDbiKey = `fifo:${key}:tail`;
      const queueSizeMax = boxLocation.strategy.queueSizeMax;

      if ((queueSizeMax & (queueSizeMax - 1)) !== 0) {
        result = err(`queueSizeMax must be a power of 2, got ${queueSizeMax}`);
      } else {
        try {
          dbiCache.env.transactionSync(() => {
            const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
            const maxOffset = queueSizeMax - 1;
            const head = (dbi.get(headDbiKey) as number) || 0;
            const tail = (dbi.get(tailDbiKey) as number) || 0;

            if (head !== tail) {
              const tailDataDbiKey = `fifo:${key}:data:${tail}`;
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
    dbiCache: LmdbDbiCache<unknown, string>,
    box: Box<unknown>,
  ): Result<void, string> {
    const content = box.content;
    const key = box.location.key;
    const strategyName = box.location.strategy.name;
    const workflow = box.location.workflow;

    let result: Result<void, string> = err('Unknown error');

    if (strategyName == 'lmdb-fifo') {
      const headDbiKey = `fifo:${key}:head`;
      const tailDbiKey = `fifo:${key}:tail`;
      const queueSizeMax = box.location.strategy.queueSizeMax;

      if ((queueSizeMax & (queueSizeMax - 1)) !== 0) {
        result = err(`queueSizeMax must be a power of 2, got ${queueSizeMax}`);
      } else {
        try {
          dbiCache.env.transactionSync(() => {
            const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
            const maxOffset = queueSizeMax - 1;
            const head = (dbi.get(headDbiKey) as number) || 0;
            const tail = (dbi.get(tailDbiKey) as number) || 0;

            const nextHead = (head + 1) & maxOffset;

            if (nextHead !== tail) {
              const headDataDbiKey = `fifo:${key}:data:${head}`;

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

export class BoxStoreLmdb implements BoxStore {
  public readonly boxStoreLmdbFifo: BoxStoreLmdbFifo;
  public readonly boxStoreLmdbKv: BoxStoreLmdbKv;

  public static create(workspace: string, rootDirectoryUrl: URL): BoxStoreLmdb {
    const envCache = new LmdbEnvCache<unknown, string>(rootDirectoryUrl);

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
    callback: (boxStore: BoxStoreLmdb) => Result<T, string>,
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
