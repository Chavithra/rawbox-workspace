import { Database, DatabaseOptions, Key, open, RootDatabase } from "lmdb";
import { Mutex } from "async-mutex";
import { ok, err, Result } from "neverthrow";
import { Box, BoxLocation, BoxStore } from "./box-store.js";

export class LmdbDbiCache<TValue> {
  public constructor(
    public readonly env: RootDatabase,
    public readonly dbiOptions: DatabaseOptions = {},
    private readonly dbiMap: Map<string, Database<TValue, string>> = new Map<
      string,
      Database<TValue, string>
    >()
  ) {}

  public getOrCreateDbi(dbiIdentifier: string): Result<Database, string> {
    const env = this.env;
    const dbiOptions = this.dbiOptions;
    const dbiMap = this.dbiMap;

    const lookupKey = dbiIdentifier;
    let dbi = dbiMap.get(lookupKey);

    if (!dbi) {
      try {
        dbi = env.openDB<TValue, string>({
          ...dbiOptions,
          name: dbiIdentifier,
        });
        dbiMap.set(lookupKey, dbi);
      } catch (e: any) {
        return err(
          `Failed to open/create DBI '${dbiIdentifier}': ${e.message}`
        );
      }
    }

    return ok(dbi);
  }
}

export class LmdbEnvCache<TValue> {
  public constructor(
    public readonly folderPath: string,
    public readonly dbiOptions: DatabaseOptions = {},
    private readonly envMap: Map<
      string,
      RootDatabase<TValue, string>
    > = new Map<string, RootDatabase<TValue, string>>(),
    private readonly dbiCacheMap: Map<string, LmdbDbiCache<TValue>> = new Map<
      string,
      LmdbDbiCache<TValue>
    >(),
    private readonly envMutexMap: Map<string, Mutex> = new Map<string, Mutex>()
  ) {}

  public getOrCreateEnv(
    envIdentifier: string
  ): Result<RootDatabase<TValue, string>, string> {
    const folderPath = this.folderPath;
    const dbiOptions = this.dbiOptions;
    const envMap = this.envMap;

    let result: Result<RootDatabase<TValue, string>, string>;
    let env = envMap.get(envIdentifier);

    if (env) {
      result = ok(env);
    } else {
      env = open<TValue, string>({
        ...dbiOptions,
        path: `${folderPath}/${envIdentifier}`,
        compression: true,
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

  private getOrCreateEnvMutex(envIdentifier: string): Mutex {
    let mutex = this.envMutexMap.get(envIdentifier);
    if (!mutex) {
      mutex = new Mutex();
      this.envMutexMap.set(envIdentifier, mutex);
    }

    return mutex;
  }

  private getOrCreateDbiCache(
    envIdentifier: string
  ): Result<LmdbDbiCache<TValue>, string> {
    const resultEnv = this.getOrCreateEnv(envIdentifier);
    const dbiCacheMap = this.dbiCacheMap;
    const dbiOptions = this.dbiOptions;

    let result: Result<LmdbDbiCache<TValue>, string>;
    if (resultEnv.isOk()) {
      const env = resultEnv.value;
      let dbiCache = dbiCacheMap.get(envIdentifier);
      if (!dbiCache) {
        dbiCache = new LmdbDbiCache<TValue>(env, dbiOptions);
        dbiCacheMap.set(envIdentifier, dbiCache);
      }

      result = ok(dbiCache);
    } else {
      result = err(
        `Failed to get or create environment '${envIdentifier}': ${resultEnv.error}`
      );
    }

    return result;
  }

  public async runExclusive<TResultT>(
    envIdentifier: string,
    callback: (
      env: RootDatabase,
      dbiCache: LmdbDbiCache<TValue>
    ) => Promise<TResultT>
  ): Promise<Result<TResultT, string>> {
    let envMutex = this.getOrCreateEnvMutex(envIdentifier);
    let result: Result<TResultT, string>;

    try {
      result = await envMutex.runExclusive(async () => {
        let resultMutex: Result<TResultT, string>;

        const resultEnv = this.getOrCreateEnv(envIdentifier);
        if (resultEnv.isOk()) {
          const env = resultEnv.value;
          const resultDbiCache = this.getOrCreateDbiCache(envIdentifier);

          if (resultDbiCache.isOk()) {
            const dbiCache = resultDbiCache.value;
            try {
              const callbackResult = await callback(env, dbiCache);
              resultMutex = ok(callbackResult);
            } catch (e: any) {
              resultMutex = err(
                e.message || "Callback function threw an error."
              );
            }
          } else {
            resultMutex = err(resultDbiCache.error);
          }
        } else {
          resultMutex = err(resultEnv.error);
        }

        return resultMutex;
      });
    } catch (e: any) {
      result = err(
        e.message || "An unexpected error occurred during mutex execution."
      );
    }

    return result;
  }
}

export class LmdbBoxEnvCache<TValue> extends LmdbEnvCache<Box<TValue>> {}

export class LmdbBoxStore<TValue> implements BoxStore<TValue> {
  public constructor(private readonly envCache: LmdbBoxEnvCache<TValue>) {}

  public static async deleteManyOneEnv<TValue>(
    envCache: LmdbBoxEnvCache<TValue>,
    envIdentifier: string,
    boxLocationList: BoxLocation[]
  ): Promise<Result<BoxLocation, string>[]> {
    let result: Result<BoxLocation, string>[];

    if (boxLocationList.length === 0) {
      result = [];
    } else {
      const resultOfRunExclusive = await envCache.runExclusive<
        Result<BoxLocation, string>[]
      >(envIdentifier, async (env, dbiCache) => {
        const resultOfTransaction = await env.transaction(async () => {
          const resultInTransaction: Result<BoxLocation, string>[] = [];
          const groupedByDbi = Map.groupBy(
            boxLocationList,
            (boxLocation) => boxLocation.dbi.id
          );

          for (const [
            dbiIdentifier,
            OneDbiboxLocationList,
          ] of groupedByDbi.entries()) {
            const resultDbi = dbiCache.getOrCreateDbi(dbiIdentifier);
            let resultOneDbi: Result<BoxLocation, string>[];

            if (resultDbi.isOk()) {
              const dbi = resultDbi.value;
              for (const [_, boxLocation] of OneDbiboxLocationList.entries()) {
                const key = `${envIdentifier}:${dbiIdentifier}:${boxLocation.key.id}`;
                await dbi.remove(key);
              }
              resultOneDbi = OneDbiboxLocationList.map((box) => ok(box));
            } else {
              resultOneDbi = OneDbiboxLocationList.map((boxLocation) =>
                err(`Can't load DBI for boxLocation ${boxLocation.toString()}`)
              );
            }

            resultInTransaction.push(...resultOneDbi);
          }

          return resultInTransaction;
        });

        return resultOfTransaction;
      });

      if (resultOfRunExclusive.isOk()) {
        result = resultOfRunExclusive.value;
      } else {
        const errorList = boxLocationList.map((boxLocation) =>
          err(
            `Failed to execute delete on env '${envIdentifier}' for item '${boxLocation.toString()}': ${
              resultOfRunExclusive.error
            }`
          )
        );

        result = errorList;
      }
    }

    return result;
  }

  public static async deleteMany<TValue>(
    envCache: LmdbBoxEnvCache<TValue>,
    boxLocationList: BoxLocation[]
  ): Promise<Result<BoxLocation, string>[]> {
    const result: Result<BoxLocation, string>[] = [];
    const groupedByEnv = Map.groupBy(
      boxLocationList,
      (boxLocation) => boxLocation.env.id
    );

    for (const [
      envIdentifier,
      OneEnvboxLocationList,
    ] of groupedByEnv.entries()) {
      if (OneEnvboxLocationList.length === 0) {
        continue;
      }
      const resultListOneEnv = await LmdbBoxStore.deleteManyOneEnv<TValue>(
        envCache,
        envIdentifier,
        OneEnvboxLocationList
      );

      result.push(...resultListOneEnv);
    }

    return result;
  }
  public static async getManyOneEnv<TValue>(
    envCache: LmdbBoxEnvCache<TValue>,
    envIdentifier: string,
    boxLocationList: BoxLocation[]
  ): Promise<Result<Box<TValue>, string>[]> {
    let result: Result<Box<TValue>, string>[];

    if (boxLocationList.length === 0) {
      result = [];
    } else {
      const resultOfRunExclusive = await envCache.runExclusive<
        Result<Box<TValue>, string>[]
      >(envIdentifier, async (env, dbiCache) => {
        const resultOfTransaction = await env.transaction(async () => {
          const resultInTransaction: Result<Box<TValue>, string>[] = [];

          const groupedByDbi = Map.groupBy(
            boxLocationList,
            (boxLocation) => boxLocation.dbi.id
          );

          for (const [
            dbiIdentifier,
            OneDbiboxLocationList,
          ] of groupedByDbi.entries()) {
            let resultInFor: Result<Box<TValue>, string>[];

            const resultOfGetOrCreateDbi =
              dbiCache.getOrCreateDbi(dbiIdentifier);

            if (resultOfGetOrCreateDbi.isOk()) {
              const dbi = resultOfGetOrCreateDbi.value;
              const keyList = OneDbiboxLocationList.map(
                (boxLocation) =>
                  `${envIdentifier}:${dbiIdentifier}:${boxLocation.key.id}`
              );

              const resultOfGetMany = await dbi.getMany(keyList);
              resultInFor = resultOfGetMany.map((result) => ok(result));
            } else {
              resultInFor = OneDbiboxLocationList.map((boxLocation) =>
                err(`Can't load DBI for boxLocation ${boxLocation.toString()}`)
              );
            }

            resultInTransaction.push(...resultInFor);
          }

          return resultInTransaction;
        });

        return resultOfTransaction;
      });

      if (resultOfRunExclusive.isOk()) {
        result = resultOfRunExclusive.value;
      } else {
        const errorList = boxLocationList.map((boxLocation) =>
          err(
            `Failed to execute get on env '${envIdentifier}' for item '${boxLocation.toString()}': ${
              resultOfRunExclusive.error
            }`
          )
        );

        result = errorList;
      }
    }

    return result;
  }

  public static async getMany<TValue>(
    envCache: LmdbBoxEnvCache<TValue>,
    boxLocationList: BoxLocation[]
  ): Promise<Result<Box<TValue>, string>[]> {
    const result: Result<Box<TValue>, string>[] = [];
    const groupedByEnv = Map.groupBy(
      boxLocationList,
      (boxLocation) => boxLocation.env.id
    );

    for (const [
      envIdentifier,
      OneEnvboxLocationList,
    ] of groupedByEnv.entries()) {
      if (OneEnvboxLocationList.length === 0) {
        continue;
      }
      const resultListOneEnv = await LmdbBoxStore.getManyOneEnv<TValue>(
        envCache,
        envIdentifier,
        OneEnvboxLocationList
      );

      result.push(...resultListOneEnv);
    }

    return result;
  }

  public static async setManyOneEnv<TValue>(
    envCache: LmdbBoxEnvCache<TValue>,
    envIdentifier: string,
    itemList: Box<TValue>[]
  ): Promise<Result<Box<TValue>, string>[]> {
    let result: Result<Box<TValue>, string>[];

    if (itemList.length === 0) {
      result = [];
    } else {
      const resultRunExclusive = await envCache.runExclusive<
        Result<Box<TValue>, string>[]
      >(envIdentifier, async (env, dbiCache) => {
        const resultCallback = await env.transaction(async () => {
          const resultTransaction: Result<Box<TValue>, string>[] = [];
          const groupedByDbi = Map.groupBy(
            itemList,
            (box) => box.location.dbi.id
          );

          for (const [
            dbiIdentifier,
            OneDbiItemList,
          ] of groupedByDbi.entries()) {
            const resultDbi = dbiCache.getOrCreateDbi(dbiIdentifier);
            let resultOneDbi: Result<Box<TValue>, string>[];

            if (resultDbi.isOk()) {
              const dbi = resultDbi.value;
              const keyList = OneDbiItemList.map(
                (box) =>
                  `${envIdentifier}:${dbiIdentifier}:${box.location.key.id}`
              );
              for (const [index, box] of OneDbiItemList.entries()) {
                const key = keyList[index];
                await dbi.put(key, box);
              }
              resultOneDbi = OneDbiItemList.map((box) => ok(box));
            } else {
              resultOneDbi = OneDbiItemList.map((box) =>
                err(`Can't load DBI for boxLocation ${box.location.toString()}`)
              );
            }

            resultTransaction.push(...resultOneDbi);
          }

          return resultTransaction;
        });

        return resultCallback;
      });

      if (resultRunExclusive.isOk()) {
        result = resultRunExclusive.value;
      } else {
        const errorList = itemList.map((box) =>
          err(
            `Failed to execute set on env '${envIdentifier}' for item '${box.location.toString()}': ${
              resultRunExclusive.error
            }`
          )
        );

        result = errorList;
      }
    }

    return result;
  }

  public static async setMany<TValue>(
    envCache: LmdbBoxEnvCache<TValue>,
    itemList: Box<TValue>[]
  ): Promise<Result<Box<TValue>, string>[]> {
    const result: Result<Box<TValue>, string>[] = [];
    const groupedByEnv = Map.groupBy(itemList, (box) => box.location.env.id);

    for (const [envIdentifier, OneEnvItemList] of groupedByEnv.entries()) {
      if (OneEnvItemList.length === 0) {
        continue;
      }
      const resultListOneEnv = await LmdbBoxStore.setManyOneEnv<TValue>(
        envCache,
        envIdentifier,
        OneEnvItemList
      );

      result.push(...resultListOneEnv);
    }

    return result;
  }

  public async deleteMany(
    boxLocationList: BoxLocation[]
  ): Promise<Result<BoxLocation, string>[]> {
    const envCache = this.envCache;
    const result = LmdbBoxStore.deleteMany(envCache, boxLocationList);

    return result;
  }

  public async getMany(
    boxLocationList: BoxLocation[]
  ): Promise<Result<Box<TValue>, string>[]> {
    const envCache = this.envCache;
    const result = LmdbBoxStore.getMany<TValue>(envCache, boxLocationList);

    return result;
  }

  public async setMany(
    itemList: Box<TValue>[]
  ): Promise<Result<Box<TValue>, string>[]> {
    const envCache = this.envCache;
    const result = LmdbBoxStore.setMany<TValue>(envCache, itemList);

    return result;
  }
}
