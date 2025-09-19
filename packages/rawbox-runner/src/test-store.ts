// import { TSchema, Type, type Static } from "@sinclair/typebox";
// import { mkdtempSync, rmSync } from "node:fs";
// import { tmpdir } from "node:os";
// import path from "node:path";
// import { ok, err, Result } from "neverthrow";

// import { decode, encode } from "msgpackr";
// import { Value } from "@sinclair/typebox/value";
// import { Box, BoxLocation, Identifiable } from "rawbox-store";
// import { Item } from "./agent.js";
// import { LmdbBoxStore, LmdbBoxEnvCache } from "rawbox-store/lmdb-box-store";
// import { v4 as uuidv4 } from "uuid";
// import { createSimpleBoxLocation } from "rawbox-store/box-store-utils";
// import { decodeBoxList, encodeBoxList } from "./agent-utils.js";

// function getTemporaryFolderPath(): string {
//   const uuid = uuidv4();
//   const tmpFolderPath = path.resolve(tmpdir(), `test-box-store-${uuid}`);
//   rmSync(tmpFolderPath, { recursive: true, force: true });
//   mkdtempSync(tmpFolderPath);
//   return tmpFolderPath;
// }

// function displayAllEnvEntries(
//   envIdentifier: string,
//   envCache: LmdbBoxEnvCache<any>
// ) {
//   const resultEnv = envCache.getOrCreateEnv(envIdentifier);

//   if (resultEnv.isOk()) {
//     const env = resultEnv.value;
//     env.getRange().forEach(({ key, value }) => {
//       console.log(`Key: ${String(key)}, Value: ${value}`);
//     });
//   }
// }

// // 1. DEFINE ITEM
// // 2. SERIALIZE+BOX ITEM
// // 4. STORE BOX
// // 5. FETCH BOX
// // 6. DESERIALIZE ITEM

// const RealtimePriceSchema = Type.Object({
//   price: Type.Number(),
//   ticker: Type.String(),
// });

// const data = {
//   price: 100,
//   ticker: "SOL/USDT",
// };

// const item: Item<typeof RealtimePriceSchema> = {
//   schema: RealtimePriceSchema,
//   data: data,
// };

// const content1: Buffer = encode(item);

// const boxItem: Box<Item<typeof RealtimePriceSchema>> = {
//   location: createSimpleBoxLocation("env1", "dbi1", "key1"),
//   content: item,
// };

// const boxList = encodeBoxList([boxItem]);

// const folderPath =
//   "/home/dtp2/code/javascript/real/rawbox-workspace/packages/data";
// const boxEnvCache = new LmdbBoxEnvCache<Uint8Array>(folderPath);
// const boxStore = new LmdbBoxStore<Uint8Array>(boxEnvCache);

// const resultOfSetMany = await boxStore.setMany(boxList);
// // console.log(JSON.stringify(resultOfSetMany, null, 2));

// const resultOfGetMany = await boxStore.getMany([boxItem.location]);
// console.log(JSON.stringify(resultOfGetMany, null, 2));

// const fetchedBoxList = decodeBoxList(
//   resultOfGetMany
//     .filter((result) => result.isOk())
//     .map((result) => result.value)
// );
// console.log(JSON.stringify(fetchedBoxList, null, 2));

// // const resultOfDeleteMany = await boxStore.deleteMany([location1]);
// // console.log(resultOfDeleteMany);

// // displayAllEnvEntries(location1.env.id, boxEnvCache);

// // const resultOfGetOrCreateEnv = boxEnvCache.getOrCreateEnv(
// //   location1.env.id
// // );

// // if (resultOfGetOrCreateEnv.isOk()) {
// //   const env = resultOfGetOrCreateEnv.value;
// //   const dbi = env.openDB<Box<Buffer>, string>({
// //     name: location1.dbi.id,
// //   });

// //   dbi.put(location1.key.id, box);
// //   const v = dbi.get(location1.key.id)!;
// //   console.log(v);
// // }

// // import { asBinary, Database, open, RootDatabase } from "lmdb";

// // const env = open<Box<Buffer>>({
// //   path: path.join(folderPath, "data"),
// //   compression: true,
// // });

// // const dbi = env.openDB<Box<Buffer>, string>({
// //   name: location1.dbi.id,
// // });

// // dbi.put(location1.key.id, box);
// // const v = dbi.get(location1.key.id)!;
// // console.log(v);
