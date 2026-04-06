import {
  open,
  type Database,
  type DatabaseOptions,
  type Key,
  type RootDatabase,
  type RootDatabaseOptions,
} from 'lmdb';
import { ok, err, Result } from 'neverthrow';

import { type Box, type BoxEmpty } from '../box.js';
import { type BoxStore } from './box-store.js';

export class LmdbDbiCache<TValue = any, TKey extends Key = number> {
  public constructor(
    public readonly env: RootDatabase,
    public readonly dbiOptions: DatabaseOptions = {},
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
      } catch (e: any) {
        result = err(
          `Failed to open/create DBI '${dbiIdentifier}': ${e.message}`,
        );
      }
    }

    return result;
  }
}

export class LmdbEnvCache<TValue, TKey extends Key> {
  public constructor(
    public readonly rootDirectoryPath: string,
    public readonly envOptions: RootDatabaseOptions = {},
    private readonly envMap: Map<string, RootDatabase<TValue, TKey>> = new Map<
      string,
      RootDatabase<TValue, TKey>
    >(),
  ) {}

  public getOrCreateEnv(
    envIdentifier: string,
  ): Result<RootDatabase<TValue, TKey>, string> {
    const rootDirectoryPath = this.rootDirectoryPath;
    const dbiOptions = this.envOptions;
    const envMap = this.envMap;

    let env = envMap.get(envIdentifier);
    let result: Result<RootDatabase<TValue, TKey>, string>;

    if (env) {
      result = ok(env);
    } else {
      env = open<TValue, TKey>({
        ...dbiOptions,
        path: `${rootDirectoryPath}/${envIdentifier}`,
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

  public static async getStatic(
    dbi: Database<any, number>,
    boxEmpty: BoxEmpty,
  ): Promise<Result<any, string>> {
    let result: Result<any, string>;

    const key = boxEmpty.location.key;
    const strategyName = boxEmpty.strategy.name;

    if (strategyName == 'lmdb-kv') {
      const dbiKey = BoxStoreLmdbKv.buildDbiKey(key)._unsafeUnwrap();

      const value = await dbi.get(dbiKey);

      result = value !== undefined ? ok(value) : err('Value not found');
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public static async putStatic(
    dbi: Database<any, number>,
    box: Box<any>,
  ): Promise<Result<void, string>> {
    let result: Result<void, string>;

    const content = box.content;
    const key = box.location.key;
    const strategyName = box.strategy.name;

    if (strategyName == 'lmdb-kv') {
      const dbiKey = BoxStoreLmdbKv.buildDbiKey(key)._unsafeUnwrap();

      await dbi.put(dbiKey, content);

      result = ok();
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public constructor(public readonly dbiCache: LmdbDbiCache<any, number>) {}

  public async put(box: Box<any>): Promise<Result<void, string>> {
    const dbiCache = this.dbiCache;

    const workflow = box.location.workflow;
    const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();

    return BoxStoreLmdbKv.putStatic(dbi, box);
  }

  public async get(boxEmpty: BoxEmpty): Promise<Result<any, string>> {
    const dbiCache = this.dbiCache;

    const workflow = boxEmpty.location.workflow;

    const dbi = dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();

    return BoxStoreLmdbKv.getStatic(dbi, boxEmpty);
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

  public static async getStatic(
    dbiCache: LmdbDbiCache<any, number>,
    boxEmpty: BoxEmpty,
  ): Promise<Result<any, string>> {
    const key = boxEmpty.location.key;
    const strategyName = boxEmpty.strategy.name;
    const workflow = boxEmpty.location.workflow;

    let result: Result<any, string> = err('Unknown error');

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
      const queueSizeMax = boxEmpty.strategy.queueSizeMax;
      const tailDbiKey = (key << FIFO_OFFSET_BIT_NUMBER) | FIFO_TAIL_OFFSET;

      if ((queueSizeMax & (queueSizeMax - 1)) !== 0) {
        result = err(`queueSizeMax must be a power of 2, got ${queueSizeMax}`);
      } else {
        try {
          dbiCache.env.transactionSync(() => {
            const maxOffset = queueSizeMax - 1;
            let head = dbi.get(headDbiKey) || 0;
            let tail = dbi.get(tailDbiKey) || 0;

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
        } catch (e: any) {
          result = err(`Transaction failed for get: ${e.message}`);
        }
      }
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public static async putStatic(
    dbiCache: LmdbDbiCache<any, number>,
    box: Box<any>,
  ): Promise<Result<void, string>> {
    const content = box.content;
    const key = box.location.key;
    const strategyName = box.strategy.name;
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
      const queueSizeMax = box.strategy.queueSizeMax;
      const tailDbiKey = (key << FIFO_OFFSET_BIT_NUMBER) | FIFO_TAIL_OFFSET;

      if ((queueSizeMax & (queueSizeMax - 1)) !== 0) {
        result = err(`queueSizeMax must be a power of 2, got ${queueSizeMax}`);
      } else {
        try {
          dbiCache.env.transactionSync(() => {
            const maxOffset = queueSizeMax - 1;
            let head = dbi.get(headDbiKey) || 0;
            let tail = dbi.get(tailDbiKey) || 0;

            const nextHead = (head + 1) & maxOffset;

            if (nextHead !== tail) {
              const headDataDbiKey = dataDbiKey + head;

              dbi.put(headDataDbiKey, content);
              dbi.put(headDbiKey, nextHead);
              result = ok();
            } else {
              result = err(`Queue is full '${strategyName}'`);
            }
          });
        } catch (e: any) {
          result = err(`Transaction failed for put: ${e.message}`);
        }
      }
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }

  public constructor(public readonly dbiCache: LmdbDbiCache<any, number>) {}

  public async get(boxEmpty: BoxEmpty): Promise<Result<any, string>> {
    return BoxStoreLmdbFifo.getStatic(this.dbiCache, boxEmpty);
  }

  public async put(box: Box<any>): Promise<Result<void, string>> {
    return BoxStoreLmdbFifo.putStatic(this.dbiCache, box);
  }
}

export class BoxStoreLmdb implements BoxStore {
  public readonly boxStoreLmdbFifo: BoxStoreLmdbFifo;
  public readonly boxStoreLmdbKv: BoxStoreLmdbKv;

  public constructor(public readonly dbiCache: LmdbDbiCache<any, number>) {
    this.boxStoreLmdbFifo = new BoxStoreLmdbFifo(dbiCache);
    this.boxStoreLmdbKv = new BoxStoreLmdbKv(dbiCache);
  }

  public async put(box: Box<any>): Promise<Result<void, string>> {
    const strategyName = box.strategy.name;

    switch (strategyName) {
      case 'lmdb-kv':
        return this.boxStoreLmdbKv.put(box);
      case 'lmdb-fifo':
        return this.boxStoreLmdbFifo.put(box);
      default:
        return err(`Unsupported strategy: '${strategyName}'`);
    }
  }

  public async get(boxEmpty: BoxEmpty): Promise<Result<any, string>> {
    const strategyName = boxEmpty.strategy.name;

    switch (strategyName) {
      case 'lmdb-kv':
        return this.boxStoreLmdbKv.get(boxEmpty);
      case 'lmdb-fifo':
        return this.boxStoreLmdbFifo.get(boxEmpty);
      default:
        return err(`Unsupported strategy: '${strategyName}'`);
    }
  }
}
