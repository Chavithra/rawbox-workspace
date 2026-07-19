# rawbox-store

`rawbox-store` provides the storage engine and data-persistence abstraction layer for the Rawbox Framework. It wraps **LMDB** (Lightning Memory-Mapped Database) to deliver fast, transactional, and type-safe storage for both key-value properties and queue structures.

---

## 1. Core Concepts

### A. Box Location (`BoxLocation`)
Every storage item (a "box") is addressed using a hierarchical coordinates object composed of:
1. **Workspace / Environment**: Maps to the name of the workspace context.
2. **Workflow (`workflow`)**: Maps to the identifier of the workflow definition.
3. **Key (`key`)**: A unique string key indexing the box.
4. **Strategy (`strategy`)**: Defines how the box persists and is retrieved (`lmdb-kv` or `lmdb-fifo`).

```typescript
const location = {
  workflow: 'market-maker',
  workspace: 'live-trading',
  key: 'btc_usdt_ticker',
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022
  }
};
```

### B. Storage Strategies
The store supports two primary data structuring strategies:
- **`lmdb-kv` (Key-Value)**: Overwrites and reads static coordinates (ideal for states, variables, and parameters).
- **`lmdb-fifo` (First-In-First-Out Queue)**: Appends items to the end of a queue and shifts them from the front (ideal for messaging, ticks, and pipelines).

### C. Performance & Page Size Optimization (`valueSizeMax`)

When using the `lmdb-kv` or `lmdb-fifo` strategies, you configure a `valueSizeMax` parameter. For maximum throughput and efficiency under both strategies, **2022 bytes** is the optimum value size threshold.

#### Why 2022 Bytes?
LMDB operates on virtual memory pages (typically **4096 bytes**). To keep a B+ tree leaf page balanced and prevent underflow, LMDB requires that every leaf page must be able to hold at least **2 entries** (records).

Each entry on a page incurs structural metadata overhead:
* **Page Header**: 16 bytes (`sizeof(MDB_page)`).
* **Index Pointers**: 2 bytes per entry.
* **Node Metadata Header**: 8 bytes per entry (`sizeof(MDB_node)`).
* **Key Encoding**: 4 bytes for standard integer-based keys.

The maximum size of a single record (including key, value, and metadata) to fit two records on a single page is:
$$\text{MaxRecordSize} \le \frac{4096 - 16}{2} = 2040 \text{ bytes}$$

Subtracting node and key overhead (14 bytes):
$$\text{MaxValueSize} \le 2040 - 14 = 2026 \text{ bytes}$$

Allowing 4 bytes for memory alignment and MsgPack serialization padding, keeping the value size at or below **2022 bytes** ensures that all writes stay directly inside leaf pages (**in-page** data).

#### Impact of Exceeding 2022 Bytes
When a stored value exceeds 2022 bytes:
1. **Overflow Page Allocation**: LMDB can no longer fit 2 keys on the leaf page and automatically pushes the value to a dedicated **overflow page** (costing at least `4096` bytes of disk/memory space).
2. **Double Lookup Latency**: The B+ tree leaf node only stores a 64-bit overflow page ID pointer, requiring an extra page pointer resolution to fetch the value.
3. **Queue Fragmentation**: For high-throughput `lmdb-fifo` pipelines with constant push/pop operations, allocating and deallocating overflow pages increases OS memory pagination faults and fragments the database file.

---

## 2. API Reference

### `BoxStoreLmdb`
The primary database connector, exposing the `BoxStore` interface.

#### Static Factory
* **`BoxStoreLmdb.create(workspace: string, rootDirectoryUrl: URL): BoxStoreLmdb`**
  Creates and initializes a new LMDB-backed store instance for the specified workspace context.

#### Instance Methods
* **`put(box: Box<unknown>): Promise<Result<void, string>>`**: Persists a single box.
* **`get(boxLocation: BoxLocation): Promise<Result<unknown, string>>`**: Retrieves a box's content.
* **`transaction<T>(callback: (boxStore: BoxStoreLmdb) => Result<T, string>): Result<T, string>`**: Wraps multiple operations in a synchronous, ACID-compliant database transaction. If the callback returns an `Err` result, the transaction is automatically aborted.

---

## 3. Example Usage

Here is how to instantiate the store, persist a value using the key-value strategy, and retrieve it back:

```typescript
import { pathToFileURL } from 'node:url';
import { BoxStoreLmdb } from './box-store/box-store-lmdb.js';

// 1. Instantiate the store
const rootDbUrl = pathToFileURL('./data/db/');
const store = BoxStoreLmdb.create('live-trading', rootDbUrl);

// 2. Define location and box content
const location = {
  workspace: 'live-trading',
  workflow: 'example-workflow',
  key: 'btc_usdt_data',
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022
  }
};

const box = {
  location,
  content: { price: 105.4, ticker: 'BTC/USDT' }
};

// 3. Put data into the store
const putRes = await store.put(box);
if (putRes.isOk()) {
  console.log('Box saved successfully.');
}

// 4. Retrieve data from the store
const getRes = await store.get(location);
if (getRes.isOk()) {
  console.log('Retrieved Data:', getRes.value); // { price: 105.4, ticker: 'BTC/USDT' }
}
```

### Transaction Example

You can execute multiple reads and writes inside a transaction:

```typescript
const txResult = store.transaction((txStore) => {
  // Put a box
  txStore.putSync(box);

  // Retrieve it back synchronously
  const result = txStore.getSync(location);
  return result;
});
```
