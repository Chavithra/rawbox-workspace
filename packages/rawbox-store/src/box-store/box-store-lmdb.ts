import {
  open,
  type Database,
  type DatabaseOptions,
  type Key,
  type RootDatabase,
  type RootDatabaseOptions,
} from 'lmdb';
import { ok, err, Result } from 'neverthrow';

import { type Box, type BoxEmpty, type BoxStore } from './index.js';

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
  public constructor(public readonly dbiCache: LmdbDbiCache<any, number>) {}

  public async put(box: Box<any>): Promise<Result<boolean, string>> {
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

  public static buildDbiKey(locationKey: number): Result<number, string> {
    /** Store the key:
     * - in the binary starting with 0x000
     * - in the last 20 bits (max 1,048,575 elements)
     */
    let result: Result<number, string>;

    if (locationKey <= 0xfffff && locationKey >= 0) {
      result = ok((0x00 << 20) | (locationKey & 0xfffff));
    } else {
      result = err(
        `CRITICAL: locationKey '${locationKey}' should be between 0 and 1,048,575`,
      );
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
  ): Promise<Result<boolean, string>> {
    let result: Result<boolean, string>;

    const content = box.content;
    const key = box.location.key;
    const strategyName = box.strategy.name;

    if (strategyName == 'lmdb-kv') {
      const dbiKey = BoxStoreLmdbKv.buildDbiKey(key)._unsafeUnwrap();

      const value = await dbi.put(dbiKey, content);

      result = ok(value);
    } else {
      result = err(`Invalid strategyName '${strategyName}'`);
    }

    return result;
  }
}

class BoxStoreLmdbFifo implements BoxStore {
  public constructor(public readonly dbiCache: LmdbDbiCache<any, number>) {}

  public async put(_box: Box<any>): Promise<Result<boolean, string>> {
    return err('BoxStoreLmdbFifo.put() is not implemented yet.');
  }

  public async get(_boxEmpty: BoxEmpty): Promise<Result<any, string>> {
    return err('BoxStoreLmdbFifo.get() is not implemented yet.');
  }
}

export class BoxStoreLmdb implements BoxStore {
  public readonly boxStoreLmdbFifo: BoxStoreLmdbFifo;
  public readonly boxStoreLmdbKv: BoxStoreLmdbKv;

  public constructor(public readonly dbiCache: LmdbDbiCache<any, number>) {
    this.boxStoreLmdbFifo = new BoxStoreLmdbFifo(dbiCache);
    this.boxStoreLmdbKv = new BoxStoreLmdbKv(dbiCache);
  }

  public async put(box: Box<any>): Promise<Result<boolean, string>> {
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
