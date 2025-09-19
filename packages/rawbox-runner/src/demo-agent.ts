import { LmdbBoxEnvCache, LmdbBoxStore } from "rawbox-store/lmdb-box-store";
import { workflow, inputBoxList } from "./workflow-data.js";
import { decodeBoxList } from "./workflow-utils.js";

function buildLmdbBoxStore(): LmdbBoxStore<Uint8Array> {
  const folderPath =
    "/home/dtp2/code/javascript/real/rawbox-workspace/packages/data";
  const boxEnvCache = new LmdbBoxEnvCache<Uint8Array>(folderPath);
  const boxStore = new LmdbBoxStore<Uint8Array>(boxEnvCache);

  return boxStore;
}

// SETUP STORE
const lmdbBoxStore = buildLmdbBoxStore();

// SAVE INPUT
const resultOfSetMany = await lmdbBoxStore.setMany(inputBoxList);
console.log(JSON.stringify(resultOfSetMany, null, 2));

const runItemList = workflow.stepList;
const inputLocationRecord = runItemList[0].inputLocationRecord;
const inputBoxLocationList = Object.values(inputLocationRecord);

const resultOfGetMany = await lmdbBoxStore.getMany(inputBoxLocationList);
const boxList = resultOfGetMany
  .filter((result) => result.isOk())
  .map((result) => result.value);
const data = decodeBoxList(boxList);
console.log(JSON.stringify(data, null, 2));
