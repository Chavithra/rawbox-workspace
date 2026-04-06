import { Box } from 'rawbox-store';

import { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';

const rootDirectoryUrl = new URL('../../../../data', import.meta.url);
const workspace = 'counting';

const boxStore = BoxStoreLmdb.create(workspace, rootDirectoryUrl);

export const inputBoxItemA: Box<number> = {
  content: 10,
  location: {
    key: 0,
    workflow: 'simple',
    workspace: 'counting',
  },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};

await boxStore.put(inputBoxItemA);

const value = await boxStore.get(inputBoxItemA);

console.log(value);
