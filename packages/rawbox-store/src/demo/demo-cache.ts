import {
  LmdbDbiCache,
  LmdbEnvCache,
  BoxStoreLmdb,
} from '../box-store/box-store-lmdb.js';
import type { Database, DatabaseOptions } from 'lmdb';
import type { Box, LmdbKV } from '../box-store/index.js';

const workspace = 'martingale-bot';
const workflow = 'price-fetcher';

const ticker = { data: { price: 100, ticker: 'SOL/USDT' } };
type Ticker = typeof ticker;

export const box1: Box<Ticker> = {
  content: ticker,
  location: { workspace, workflow, key: 0 },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};

const rootDirectoryPath = './data';
const envCache = new LmdbEnvCache<object, number>(rootDirectoryPath);

const env = envCache.getOrCreateEnv(workspace)._unsafeUnwrap();
const dbiCacheOptions: DatabaseOptions = {
  compression: true,
  encoding: 'msgpack',
  keyEncoding: 'uint32',
};
const dbiCache = new LmdbDbiCache<any, number>(env, dbiCacheOptions);

const boxStore = new BoxStoreLmdb(dbiCache);

await boxStore.put(box1);

const v = await boxStore.get(box1);

console.log('Value', v);
