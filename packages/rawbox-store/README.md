# rawbox-store

## Overview

**rawbox-store** provides a modular, type-safe storage abstraction for the Rawbox Framework. It enables storing, retrieving, and deleting structured data ("boxes") using LMDB as the backend, with strong typing and error handling via [neverthrow](https://github.com/supermacro/neverthrow).

## Features

- **Boxed Storage:** Store items as `Box<TValue>` with unique locations (`BoxLocation`).
- **LMDB Integration:** Efficient, transactional storage using LMDB.
- **Type Safety:** Schemas via [TypeBox](https://github.com/sinclairzx81/typebox).
- **Error Handling:** All operations return `Result` types for robust error management.
- **Identifiable Keys:** Use `Identifiable` objects for environment, database, and key separation.

## API

### Core Types

- `BoxLocation`: Identifies a box by environment, database, and key.
- `Box<TValue>`: Contains a location and content.
- `BoxStore<TValue>`: Interface for set, get, and delete operations.
- `LmdbBoxStore<TValue>`: LMDB-backed implementation of `BoxStore`.
- `Identifiable`: Utility for generating and validating unique identifiers.

### Example Usage

```ts
import { Type } from "@sinclair/typebox";
import { encode } from "msgpackr";
import { LmdbBoxStore, LmdbBoxEnvCache } from "./lmdb-box-store.js";
import { Identifiable } from "./identifiable.js";

// Define schema and item
const schema = Type.Object({ price: Type.Number(), ticker: Type.String() });
const item = { schema, data: { price: 100, ticker: "SOL/USDT" } };
const content = encode(item);

// Define location
const location = {
  env: { alias: "Env", identifier: "env1" },
  dbi: { alias: "DBI", identifier: "dbi1" },
  key: { alias: "Key", identifier: "k1" },
};

// Create box and store
const box = { location, content };
const envCache = new LmdbBoxEnvCache<Buffer>("./data");
const boxStore = new LmdbBoxStore<Buffer>(envCache);

await boxStore.setMany([box]);
const result = await boxStore.getMany([location]);
```
