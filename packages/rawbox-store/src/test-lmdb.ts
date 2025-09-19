import { Database, open, RootDatabase } from "lmdb";
import path from "node:path";

async function putData<TValue>(
  dbi: Database<TValue, string>,
  key: string,
  value: TValue
): Promise<boolean> {
  return dbi.put(key, value);
}

function getData<TValue>(
  dbi: Database<TValue, string>,
  key: string
): TValue | undefined {
  return dbi.get(key);
}

async function main() {
  const folderPath = path.resolve("./data/my-db");

  const env = open<object>({
    path: folderPath,
    compression: true,
  });
  const dbi = env.openDB<Uint8Array, string>({
    name: "users",
    encoding: "binary",
  });

  const key = "myUniqueBinaryKey";
  const originalString =
    "Hello, LMDB! This is a test string converted to a Buffer.";
  const originalBuffer = Buffer.from(originalString, "utf8");
  const originalUint8Array = new Uint8Array(originalBuffer.buffer);

  let result;

  result = await putData(dbi, key, originalUint8Array);
  console.log("putData result:", result);

  result = getData(dbi, key);

  console.log("getData result:", result);

  if (result instanceof Buffer) {
    console.log("getData result:", result.toString("utf8"));
  }
}

main();
