# @rawbox/store

Storage layer for the Rawbox Framework. Each key defines a **strategy** (`lmdb-kv`, `lmdb-fifo`, `pg-kv`, or `pg-fifo`) that controls how its data is stored locally in **LMDB** or remotely in **PostgreSQL**.

---

## 1. Usage

All methods return `neverthrow` `Result` values; nothing throws across the API boundary.

### Generic

Every stored item ("box") is addressed by a `BoxLocation`:

```typescript
import type { BoxLocation, BoxStrategy } from '@rawbox/store';

const strategy: BoxStrategy = {
  name: 'lmdb-kv',
  valueSizeMax: 1900,
};

const location: BoxLocation = {
  workspace: 'live-trading',
  workflow: 'market-maker',
  key: 'btc_usdt_ticker',
  strategy,
};
```

- **`BoxStore`** is the minimal async interface shared by all backends:
  - `get(boxLocation: BoxLocation): Promise<Result<unknown, string>>`
  - `put(box: Box<unknown>): Promise<Result<void, string>>`
  - `transact(batch: BoxTransactionBatch): Promise<Result<Record<string, unknown>, string>>`
- **Step binding shapes**: `ReadBoxLocation` (`{ key, strategy, workflow? }`) allows cross-workflow reads; `WriteBoxLocation` (`{ key, strategy }`) omits `workflow`, structurally preventing cross-workflow writes.

#### Entry Points

| Import | Contents |
| --- | --- |
| `@rawbox/store` | Core types (`Box`, `BoxLocation`, `BoxStrategy`, `BoxStore`, `BoxTransactionBatch`, `BoxObserver`, `BoxObserverAsync`), `StrictObject`, `buildBoxRecord`/`buildRecord`, sizing & budget utilities, strategy registry (`descriptorFor`, `STRATEGY_NAME_LIST`, etc.), and pure peek/ring helpers. |
| `@rawbox/store/box-store-lmdb` | `BoxStoreLmdb`, `LmdbEnvCache`, `LmdbDbiCache`, `LMDB_DBI_OPTIONS_DEFAULT`, `resolveEnvFolderUrl`. |
| `@rawbox/store/box-store-pg` | `BoxStorePg`, `PgPoolCache`, `ensurePgSchema`. |
| `@rawbox/store/box-observer-lmdb` | `BoxObserverLmdb`. |
| `@rawbox/store/box-observer-pg` | `BoxObserverPg`. |
| `@rawbox/store/box-peek` | Low-level peek/inspection functions, derived FIFO key helpers, and ring arithmetic (also re-exported from `@rawbox/store`). |

---

### LMDB

#### Open Store (`BoxStoreLmdb.create`)

```typescript
import { pathToFileURL } from 'node:url';
import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import type { Box, BoxLocation, BoxStrategy } from '@rawbox/store';

const workspace = 'live-trading';
const workflow = 'market-maker';
const rootDataPath = './data/';
const rootDataUrl = pathToFileURL(rootDataPath);

const storeResult = BoxStoreLmdb.create(workspace, rootDataUrl);
if (storeResult.isErr()) {
  const errorMessage = `Cannot open store: ${storeResult.error}`;
  throw new Error(errorMessage);
}
const store = storeResult.value;
```

#### Key-Value & Transactions (`lmdb-kv`)

```typescript
const kvStrategy: BoxStrategy = {
  name: 'lmdb-kv',
  valueSizeMax: 1900,
};
const kvLocation: BoxLocation = {
  workspace,
  workflow,
  key: 'risk_config',
  strategy: kvStrategy,
};
const kvContent = {
  maxPositionUsd: 50000,
  halted: false,
};
const kvBox: Box<typeof kvContent> = {
  location: kvLocation,
  content: kvContent,
};

await store.put(kvBox);
const value = await store.get(kvLocation);

// ACID transaction (use sync methods inside; returning Err rolls back)
const txCallback = (tx: BoxStoreLmdb) => {
  const putRes = tx.putSync(kvBox);
  if (putRes.isErr()) return putRes;
  return tx.getSync(kvLocation);
};
const txResult = store.transaction(txCallback);
```

#### FIFO Queue (`lmdb-fifo`)

```typescript
const queueStrategy: BoxStrategy = {
  name: 'lmdb-fifo',
  queueSizeMax: 1024,
  valueSizeMax: 1900,
};
const queueLocation: BoxLocation = {
  workspace,
  workflow,
  key: 'order_events',
  strategy: queueStrategy,
};
const queueContent = {
  orderId: 'ord-9041',
  side: 'buy',
  qty: 0.25,
};
const queueBox: Box<typeof queueContent> = {
  location: queueLocation,
  content: queueContent,
};

await store.put(queueBox);
const next = await store.get(queueLocation); // destructive dequeue
```

In-process non-destructive inspection is also available on `BoxStoreLmdb`: `peekSync`/`peek`, `peekAllSync`/`peekAll`, `depthSync`, and `inspectSync(workflow)`.

#### Out-of-Process Read-Only Observer (`BoxObserverLmdb`)

```typescript
import { BoxObserverLmdb } from '@rawbox/store/box-observer-lmdb';

const observerRes = BoxObserverLmdb.openSync(workspace, rootDataUrl);
if (observerRes.isOk()) {
  const observer = observerRes.value;
  try {
    const workflows = observer.listWorkflowsSync();
    const keys = observer.listKeysSync(workflow);
    const head = observer.peekSync(queueLocation);
    const all = observer.peekAllSync(queueLocation);
    const depth = observer.depthSync(queueLocation);
  } finally {
    observer.closeSync();
  }
}
```

---

## 2. Technical Details

### Generic

#### Storage Strategies & Extensibility

| Strategy | Backend | Parameters | Capacity / Semantics |
| --- | --- | --- | --- |
| `lmdb-kv` | LMDB | `valueSizeMax` | Single key-value cell. |
| `lmdb-fifo` | LMDB | `queueSizeMax` (≥ 2), `valueSizeMax` | Ring buffer; holds **`queueSizeMax - 1`** entries (1 slot reserved). |
| `pg-kv` | PostgreSQL | `backend`, `valueSizeMax` | Single key-value cell in `rawbox_boxes`. |
| `pg-fifo` | PostgreSQL | `backend`, `queueSizeMax` (≥ 1), `valueSizeMax` | Bounded FIFO queue in `rawbox_fifo_items`; holds **`queueSizeMax`** entries exact. |

- **Adding a strategy**: Add a member to `BoxStrategy` (`src/box.ts`) and a corresponding row in `STRATEGY_DESCRIPTOR_TABLE` (`src/strategy/descriptor.ts`). The table is exhaustively keyed by `BoxStrategy['name']`, declaring seed expansion/capacity, empty-read message, depth support, store identity, and optional byte budget.

#### Key & Value Size Contracts

- **Keys**: Max **79 UTF-8 bytes** (`RAWBOX_KEY_SIZE_MAX`), matching `[A-Za-z0-9_.-]+`. This is a cross-backend portability contract checked both at verify time and on write.
- **Values (`valueSizeMax`)**: Enforced on every `put` against the **uncompressed msgpack-encoded** byte length before writing. Not enforced on `get`.
- **Encoding failures**: `measureValueSize` returns a `Result` (never throws); cyclic structures, `Symbol`, and out-of-range `BigInt` (> 64-bit) return `Err`.

#### Observation — `peek` is not `get`

> [!WARNING]
> **On a FIFO queue, `get` is a destructive dequeue.** Observers, CLIs, and monitors must always use `peek`, never `get`.

Two deliberately separate observer interfaces exist in `box-observer.ts`:
- **`BoxObserver`** (strictly synchronous, implemented by `BoxObserverLmdb`).
- **`BoxObserverAsync`** (promise-based sibling interface for future async backends).

---

### LMDB

- **Storage Layout**: One LMDB environment per `workspace`; one database (`dbi`) per `workflow`. `BoxStoreLmdb.create` returns `Err` on open failures (`ENOTDIR`, `EACCES`, `MDB_*`) and propagates `getOrCreateDbi` errors (e.g., `MDB_DBS_FULL` past lmdb-js's default 12 DBs) as `Result`.
- **Ring Buffer (`lmdb-fifo`)**:
  - Uses derived keys (`fifo:<key>:head`, `:tail`, `:data:<n>`), adding at most **32 bytes** (`RAWBOX_KEY_DERIVATION_OVERHEAD_MAX`) so derived keys stay ≤ 111 bytes.
  - Keeps 1 slot free (`queueSizeMax - 1` capacity) to distinguish full from empty.
  - Dequeue (`get`) deletes the consumed `:data:<n>` entry in the same transaction so on-disk footprint tracks current depth.
  - `inspectSync` / `listKeysSync` folds derived keys into one logical record per queue.
- **In-Page Cutoff**: An LMDB entry stays on a leaf page iff `keyBytes + packedValueBytes ≤ 2013` (`LMDB_INPAGE_KEY_PLUS_VALUE_MAX`); larger entries spill onto 4096-byte overflow pages. The default `valueSizeMax: 1900` keeps every contract-compliant key (`≤ 111` bytes) in-page.
- **The Storage Budget**: `budgetForKey` and `budgetForStorage` compute two figures from a `BoxStorage` descriptor (built via `@rawbox/runner`'s `boxStorageFor` + `collectBoundStorageKeys`):
  - `dataBytesMax`: Logical upper bound for declared + bound keys (page-rounded above the in-page cutoff).
  - `recommendedVolumeBytes`: Provisioning estimate counting fractional LMDB leaf shares, overflow pages, and environment/DBI overhead (× 1.15 residual, 256 KiB floor, page-rounded).
  - **Reported, not enforced**: `BoxStoreLmdb.create` takes no budget and `lmdb-js` auto-grows `mapSize`. Enforce disk limits at the container/volume level.
- **MVCC Snapshot Safety (`BoxObserverLmdb`)**:
  - Opens environments `readOnly: true` and checks for `data.mdb` first (never creates directories or databases).
  - Every method is synchronous, returns plain materialized data (never an iterator or transaction), and resets the shared read transaction in `finally`. This prevents parked readers from pinning MVCC snapshots and causing unbounded writer store growth.
  - `readerListSync()` dumps LMDB's reader lock table for diagnostics.

---

## 3. Development

```bash
npm run build       # tsc
npm test            # vitest run tests
npm run type-check  # tsc --noEmit
```
