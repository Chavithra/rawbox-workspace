# rawbox-store

`@rawbox/store` provides the storage engine and data-persistence abstraction layer for the
Rawbox Framework. A **strategy**, declared once per key, decides how that key stores. Four
ship today, behind one box model and one strategy registry: two wrapping **LMDB** (Lightning
Memory-Mapped Database), which is what delivers fast, transactional, type-safe key-value and
queue storage, and two holding their data in a **Redis** server instead.

> [!NOTE]
> **This package ships a Redis store; the runner does not construct one.** A run declaring
> `redis-kv` or `redis-fifo` is refused at bootstrap, by name, before anything is opened or
> written ([rawbox-runner README §2.3](../rawbox-runner/README.md#23-storage-rules-a-schema-cannot-express)).
> Everything below describes the half of that gap this package has closed — read it as the
> API that exists, not as a strategy you can run.

The document-level rules this package serves — what a strategy means, what a key may be,
what the budget is for — are defined by `@rawbox/runner`'s document schemas
([rawbox-runner README §2](../rawbox-runner/README.md#2-workflow-definition)). This README
is the API and the package-level detail; where it summarises a document rule, those
schemas are the authority.

---

## 1. Core Concepts

### A. Box Location (`BoxLocation`)
Every storage item (a "box") is addressed by a hierarchical coordinates object:

1. **`workspace`**: The name of the workspace context — one LMDB environment per workspace,
   or the first segment of the `rawbox:` key namespace on Redis.
2. **`workflow`**: The workflow identifier — one database (dbi) per workflow, or the second
   namespace segment on Redis.
3. **`key`**: A unique string key indexing the box.
4. **`strategy`**: How the box persists and is retrieved. `BoxStoreLmdb` routes `lmdb-kv`
   and `lmdb-fifo`; `BoxStrategy` is an open union and also admits strategies stored by
   another backend (`redis-kv`, `redis-fifo`), for which this store returns a named `Err`
   rather than falling back.

```typescript
const location = {
  workspace: 'live-trading',
  workflow: 'market-maker',
  key: 'btc_usdt_ticker',
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 1900,
  },
};
```

Two narrower shapes exist for the runner's step bindings, and the asymmetry between them is
the storage boundary:

| Type | Fields | Meaning |
| --- | --- | --- |
| `ReadBoxLocation` | `key`, `strategy`, `workflow?` | An input. May read another workflow's box. |
| `WriteBoxLocation` | `key`, `strategy` | An output/error. Has no `workflow` field, so a step structurally cannot write outside its own workflow. |

`buildBoxRecord(boxLocationRecord, lookupRecord, workflow, workspace)` expands either shape
into fully-qualified `Box` objects; `buildRecord(boxLocationRecord, boxList)` is the inverse,
collapsing fetched boxes back into a plain field record.

### B. Storage Strategies

| Strategy | Parameter | Behavior |
| --- | --- | --- |
| `lmdb-kv` | `valueSizeMax` (bytes) | Overwrites and reads a static coordinate — states, variables, parameters. |
| `lmdb-fifo` | `queueSizeMax` (entries), `valueSizeMax` (bytes) | A ring buffer over LMDB: `put` appends at the head, `get` shifts from the tail — messaging, ticks, pipelines. |
| `redis-kv` | `valueSizeMax` (bytes), `backend` (id) | The same cell, held by the Redis server the `backend:` id names. |
| `redis-fifo` | `queueSizeMax` (entries), `valueSizeMax` (bytes), `backend` (id) | The same queue, held as a **native Redis list**: `put` is an `RPUSH`, `get` an `LPOP`, depth an `LLEN`. |

```yaml
storage:
  defaultStrategy: { name: lmdb-kv, valueSizeMax: 1900 }
  keys:
    tick_queue:
      strategy: { name: lmdb-fifo, queueSizeMax: 1024, valueSizeMax: 1900 }
```

**`backend:` is an id, never a connection string** — it names an entry of the *workspace*
document's `backends:` map, which is where the address and its `${VARIABLE}` credential
references live. Turning one into the other is `@rawbox/runner`'s `resolveBackendConnection`;
`BoxStoreRedis.create` takes the string that produces, so this package never reads a
workspace document.

> [!IMPORTANT]
> **`lmdb-fifo`'s ring keeps one slot free** to distinguish full from empty, so a
> `queueSizeMax` of 1024 holds 1023 entries — `put` on a full queue returns `Queue is full`,
> and `get` on an empty one returns `Queue empty`. `queueSizeMax` may be **any integer ≥ 2**
> — the ring wraps with `%`, not a bitmask, so there is no power-of-two requirement.
>
> **The reserved slot is that ring's property, not every queue's.** `redis-fifo` is a native
> list: `LLEN` reports the depth outright and an empty queue is a key that does not exist, so
> nothing is held back — a `queueSizeMax` of 1024 holds **1024**, and 1 is a legal one-entry
> queue. Each strategy states its own figure in the registry (`seedCapacity` below), and
> nothing here may be read as "every queue reserves a slot".
>
> **Consumed slots are freed** — an `lmdb-fifo` property. `get` removes the data key it
> dequeues in the same transaction that advances the tail, so a queue's on-disk footprint
> tracks its current depth rather than sitting permanently at its declared maximum once
> filled. This costs a small amount of extra write work per dequeue, which is judged worth
> the footprint it releases.

`valueSizeMax` is **enforced** by every strategy that declares it, which is all four: a `put`
whose content encodes larger than the declared limit is rejected before anything is written —
and, on Redis, before anything reaches the wire — naming the key and both sizes,
`Value for key 'ticker' exceeds valueSizeMax: 3184 bytes encoded, limit 1900`. It
is not checked on `get`: a value written under a since-shrunk `valueSizeMax` stays readable.

#### Adding a strategy — `StrategyDescriptor` is the extension point

The set above is what this package ships, not a closed list. A strategy is one member of the
`BoxStrategy` union (`box.ts`) plus one row in the registry (`strategy/descriptor.ts`), and
the row is where it says what it *does* — everything that used to be a
`strategy.name === 'lmdb-fifo'` branch scattered across three packages:

| Field | What the strategy is stating |
| --- | --- |
| `seedExpandsList` | Whether one key's `seed:` is N writes rather than one — a list-valued seed, one element per stored entry |
| `seedCapacity?` | How many entries such a seed may carry. **Absent means unbounded, not unknown**. `lmdb-fifo` answers `queueSizeMax - 1`, `redis-fifo` answers `queueSizeMax` |
| `seedCapacityNote?` | Why that capacity is *below* the declared ceiling, as one clause the verifier prints. **Absent when capacity IS the ceiling** — `redis-fifo` declares none, and telling its author about a reserved slot would be the verifier asserting a falsehood |
| `emptyReadMessage` | The exact sentence a read of an empty box fails with, quoted verbatim by the verifier. A strategy MAY reuse another's, and is then bound to producing that exact string |
| `hasDepth` | Whether `{used, capacity}` means anything. `false` is not "depth is zero" |
| `budget?` | The byte model. **Absent means not provisionable from the document** (§1.D) |
| `storeIdentity` | **Which concrete store** the boxes live in — the equality the co-transactional rule compares. Required: every strategy stores somewhere. Both LMDB strategies return one shared identity; a Redis strategy derives its own from its `backend:` id, so two ids are two stores whatever the strategy is called |
| `keySizeMax?` | The widest key this declaration can derive, when it derives one |

The table is keyed by `BoxStrategy['name']`, so **a new union member is a compile error here
until it answers all of them**. It cannot be silently omitted, and it cannot fall through to
a default that happens to describe some other strategy. That last part is not hypothetical
caution: before the registry existed, the budget dispatched with a catch-all `else`, so any
strategy that was not `lmdb-fifo` — including one on a backend with no pages at all — would
have been charged LMDB leaf-page and overflow-page arithmetic and reported as a confident
byte figure.

There is deliberately **no `kind`/`backend` taxonomy**. The reasoning is in the module header
of `strategy/descriptor.ts`; the short form is that a `kind: 'kv' | 'fifo'` crossed with a
`backend` is a coincidence of today's set that breaks on the fifth strategy, and that no
branch site ever asked the taxonomy's question — each asked one of the capability questions
above.

**The module graph is acyclic, and stays that way by construction:** `fifo-ring.ts` is a leaf
(the derived-key builders and ring arithmetic, imported by both sides); `box-size.ts` →
`box.js`; `strategy/descriptor.ts` → `{box-size, fifo-ring}`; `strategy/budget.ts` →
`{box-size, descriptor}`. The two rules that keep it so are that **`box-size.ts` must never
import `strategy/`** — the budget dispatch lives in `strategy/budget.ts` precisely so it can
consult the registry — and that anything the descriptor needs from the observation path lives
in `fifo-ring.ts` rather than in `box-peek.ts`, which reads the descriptor back.

**What is measured** is the msgpack encoding of the value, **before compression**. Nothing
is compressed to perform the check; LZ4 still runs exactly once, inside LMDB, as part of the
actual write. Bounding the *compressed* length would make acceptance a function of how well
a payload happens to compress rather than of how big it is, so the same object could pass
against fixture data and fail against real data of identical logical size. Below LZ4's
1000-byte threshold packed and stored lengths are equal, so the check is exact; above it,
stored ≤ packed, so it is conservative.

**What actually fails to encode** is exactly three things — measured, not assumed, and not
"BigInt and functions": a **cyclic** object or array (stack exhaustion during encoding), a
**`BigInt` outside the 64-bit range**, and a **`Symbol`**. An in-range `BigInt` encodes
natively, and a function-valued property is accepted with the function silently dropped.
`measureValueSize` returns the failure as a `Result` rather than throwing, so an unencodable
seed is a diagnostic rather than a crash.

### C. Key and Value Sizes

The two limits are shaped differently on purpose: a value's size cannot be known from the
document, so it is declared; a key is a literal, so its size is already known and a field
would supply only permission.

> [!NOTE]
> **Two kinds of statement live in this section and the next, and they are not
> interchangeable.** The key rule and `valueSizeMax` are **Rawbox's**, and hold on any
> backend: the 79 bytes is a portability contract chosen to sit under every backend's own
> limit, and `valueSizeMax` is msgpack bytes before compression, measurable with no database
> open at all. Everything below about **pages** — the 2013-byte in-page threshold, 4096-byte
> overflow pages, leaf fill, `MDB_MAXKEYSIZE` — is a reading of **LMDB specifically**, and
> describes the strategies backed by it rather than storage in general. A strategy on another
> backend inherits the first kind and states its own answer to the second, or declares no
> byte model at all (§1.D).

#### Keys

**A storage key is at most 79 bytes and matches `[A-Za-z0-9_.-]+`.** Both rules are
**Rawbox's, not LMDB's**, and neither is configurable — there is no `keySizeMax` field
anywhere. `RAWBOX_KEY_SIZE_MAX` is a *portability contract*: the ceiling every backend
Rawbox intends to support can honour, so it has to be stricter than any one backend's own
limit rather than derived from one. It is measured in UTF-8 bytes on the key **as the author
writes it** — as a `storage.keys` entry or in a step binding —
and it is the same number under every strategy. The same rules are checked document-side at verify
time by `@rawbox/runner`
([rawbox-runner README §2.3](../rawbox-runner/README.md#23-storage-rules-a-schema-cannot-express)).

The backend limits the contract has to clear. Every row but the last two is a design input
from documentation rather than a measurement here — confirm the relevant row before adopting
a backend that depends on it:

| Backend | Key-length constraint |
| --- | --- |
| Filesystem, file-per-key | 255 bytes per path component (`NAME_MAX`, ext4/APFS/NTFS) |
| MySQL, indexed `VARCHAR(255)` ASCII | 255 bytes |
| Amazon S3 object key / DynamoDB sort key | 1024 bytes |
| LMDB, upstream `MDB_MAXKEYSIZE` | 511 bytes |
| **LMDB, the lmdb-js build here** | **1978 bytes** — measured, `db.maxKeySize` |

**The derivation is Rawbox's problem, not the author's.** For `lmdb-fifo` the key the
backend actually stores is `fifo:<key>:data:<n>`, at most 32 bytes over the author's key —
`RAWBOX_KEY_DERIVATION_OVERHEAD_MAX`. So the widest key any backend can be handed is
79 + 32 = 111 bytes, comfortably inside every row above. The store still guards the write
side, reading the real limit from the open database (`readMaxKeySize`, pinned in tests
against `LMDB_KEY_SIZE_MAX_DEFAULT` = 1978) rather than hard-coding upstream's 511: it is a
backstop expected never to fire, and it stays because a backend guard that trusts the
caller's contract is not a guard.

Budgeting works the other way round: `budgetForKey().keySizeMax` reports the **derived**
key, because that is what really occupies bytes per entry.

#### Values

**1900 is the shipped default** for `valueSizeMax` in every template, fixture and example
here, and it is a guarantee rather than a round number. LMDB stores a value on a dedicated
**overflow page** — at least 4096 bytes, plus an extra page resolution on every read — once
its entry no longer fits alongside its neighbours on a leaf page:

**An entry shares a leaf page iff `keyBytes + packedValueBytes ≤ 2013`**
(`LMDB_INPAGE_KEY_PLUS_VALUE_MAX`). The **key counts**: LMDB sizes the *node*, key and value
together, so no `valueSizeMax` on its own guarantees anything. For `lmdb-fifo` the key that
counts is the derived one. At 1900 the widest contract-compliant key still fits —
111 + 1900 = 2011 — so every legal key stays in-page.

The two limits were chosen independently, so this is a coincidence rather than a derivation:
**re-check `111 + valueSizeMax ≤ 2013` before moving either.** Crossing the cutoff is legal
and sometimes unavoidable; it is a cost, not a defect, and `budgetForKey` charges the
overflow page rather than warning about it. The 2013 and the default were measured rather
than derived — re-measure them on an lmdb-js bump rather than recomputing them.

### D. The Storage Budget

`@rawbox/store` exports `budgetForKey` / `budgetForStorage` (from `strategy/budget.ts`,
which dispatches to the page model in `box-size.ts`), which turn a `storage:` block into two
byte figures — deliberately two, never collapsed into one:

| Figure | Meaning |
| --- | --- |
| `dataBytesMax` | Upper bound on the **logical** bytes a workflow's storage keys can hold — key overhead plus `valueSizeMax` per entry, page-rounded above the in-page cutoff (§1.C). Not a file-size bound: branch pages, the freelist and MVCC's live copies are real and none of them is a function of the declared strategies. |
| `recommendedVolumeBytes` | **How much storage to provision** for this workspace — the **pages** those entries occupy, plus LMDB's environment and per-workflow cost, × a residual factor, floored and page-rounded. Size the volume, the container's disk quota, or the tmpfs with this. |

> [!IMPORTANT]
> **Both figures are reported; neither is enforced.** No budget is passed to the store, and
> no write path consults either — `BoxStoreLmdb.create` takes no budget argument at all. The
> ceiling belongs to the container or volume the run is given, where it bounds the whole
> process rather than one library's accounting of one file.
> The one limit this package *does* enforce is per item: `valueSizeMax` on `put`, for both
> strategies. That bounds one value, not the store.

`recommendedVolumeBytes` is **not `dataBytesMax` scaled** — the two are separate
computations over the same entries, because page packing is a sawtooth in `valueSizeMax` and
key length rather than a slope, and a multiplier cannot see a discontinuity. It counts pages:

```
even(x)          = x rounded up to a multiple of 2      (LMDB aligns nodes to 2 bytes)
leafNode(k, v)   = 2 + 8 + even(k) + even(v + 18)       (the 18 is compression framing;
                                                         an overflowed entry leaves an
                                                         8-byte page id here instead)
nodesPerPage     = floor(4080 / leafNode(k, v))
leafShare(k,v,n) = n / (nodesPerPage × 0.55)            (0.55 = settled post-split fill)
overflow(k,v,n)  = n × ceil((16 + v + 18) / 4096)       when k + v > 2013, else 0

pageCountMax     = ceil(Σ leafShare + Σ overflow)  over every key
recommended      = max((8192 + 6144 × workflowCount + 4096 × pageCountMax) × 1.15,
                       262144)                          rounded up to a whole page
```

Every coefficient is an exported constant (`LMDB_LEAF_FILL`, `LMDB_VALUE_FRAMING_BYTES`,
`LMDB_BUDGET_RESIDUAL_FACTOR`, `LMDB_ENV_BASE_BYTES`, `LMDB_DBI_BYTES`,
`LMDB_ENV_OVERHEAD_BYTES`, `LMDB_PAGE_SIZE_DEFAULT`), and each was measured rather than
chosen. Two properties are worth knowing when reading the output: leaf shares are
**fractional and round once, at the
total**, because a leaf page belongs to the database rather than to a key — 2,000 small
`lmdb-kv` keys share a few dozen pages, and rounding each one up to a whole page would
over-provision by up to 70×; and the 256 KiB floor is load-bearing rather than decoration,
since the model prices an almost-empty environment too low.

`LMDB_PAGE_SIZE_DEFAULT` is 4096 as a documented default, not a reading: LMDB takes the
host's page size at environment creation, but `verify` runs on a parsed document with no
environment open and must not create one as a side effect of checking a file. A test pins it
against a live `getStats().pageSize`, the same arrangement as `LMDB_KEY_SIZE_MAX_DEFAULT`.

**Which keys are counted.** Every key in `strategies`, every key in `seed`, and every key a
step *binds* — deduplicated, each resolved by `strategies[key] ?? defaultStrategy`. Missing
the third source is structural rather than approximate: a workflow that declared no keys at
all would report `dataBytesMax: 0` while writing one key per output and error binding.

**`BoxStorage` is this package's input type, not the authoring format.** The format declares
a key in one place, `storage.keys`, whose schema lives in `@rawbox/runner` — the far side of
a dependency that never runs backward, so it cannot be read here. That package flattens a key
table into the `strategies`/`seed` pair this function sums (`boxStorageFor`,
`workflow/key-table.ts`), and **every caller must route through it**: an authoring
`{ defaultStrategy, keys }` still type-checks as a `BoxStorage` — every field past the first
is optional — and charges nothing at all, so passing `workflow.storage` straight in reports a
budget of zero rather than an error.

`@rawbox/store` cannot walk a workflow's steps — the authoring schema lives in
`@rawbox/runner`, which depends on this package — so the caller does the walk and passes the
result as `BoxStorage.boundKeyList`. `@rawbox/runner` exports `collectBoundStorageKeys` for
it, and that package is where the exclusion rule lives, on both sides of the call:
**another workflow's keys are excluded**, because those bytes belong to the owning workflow's
budget and a workspace total is a plain sum over workflows. Ownership is what is excluded,
not a binding shape — a `{ key, workflow }` read is dropped from `boundKeyList`, and a key
whose table entry declares `workflow:` is dropped by `boxStorageFor` even when no step binds
it at all. `KeyBudget.source` labels each key `declared` or `bound`, which is what lets
`verify` explain why five declarations produced ten budgeted keys.

One other kind of key is left out of the figures, and it is **named rather than dropped**. A
strategy states its byte model in the registry (`StrategyDescriptor.budget`,
`strategy/descriptor.ts`) and that field is *optional*: a backend whose storage is somebody
else's server to provision has no honest figure to derive from a `storage:` block. Keys of
such a strategy come back as `budgetable: false` records carrying the key, its source and its
strategy — `StorageBudget.unbudgetableKeyList` — and are excluded from `dataBytesMax`,
`entryCount` and `pageCountMax` rather than charged `0`, because a zero would be summed and a
summed zero says "this key costs nothing" in a figure an operator sizes a volume with. A
report prints those keys as *not applicable* alongside the ones it could charge, and says the
totals cover fewer keys than the document declares.

**Both Redis strategies are that case.** A Redis key's footprint is bounded by the server's
`maxmemory`, its eviction policy and whoever operates it — none of it written in, or derivable
from, a `storage:` block, and `queueSizeMax × valueSizeMax` would be a figure nobody measured.
So `redis-kv` and `redis-fifo` declare no `budget`, and a document declaring them reports an
empty total with every one of its keys named beneath it. Their `valueSizeMax` is still
declared and still enforced per write; that bounds one value, not the store. An LMDB-only
document has an empty `unbudgetableKeyList` and figures identical to what it had before these
strategies existed.

Apart from those two cases nothing is excluded — every key a workflow writes is named in its
document, since the format has no binding form carrying a value and resolution generates no
keys.

> [!NOTE]
> **`mapSize` is not a ceiling, and the store passes none.** Upstream LMDB refuses to grow
> past `mapSize`; the copy lmdb-js vendors patches `mdb_page_alloc` to auto-resize the map
> unconditionally, so an environment opened at 1 MB grows straight past it. Reimplementing
> the missing check above the library would bind only writes made through `BoxStoreLmdb`,
> leaving a second process or a raw `lmdb.open()` on the same directory unbounded. Provision
> from `recommendedVolumeBytes` and let the container enforce it.

### E. Observation — `peek` is not `get`

> [!WARNING]
> **`getSync` on an `lmdb-fifo` box is a consumer API. `peekSync` is the observer API.**
>
> A FIFO `get` is a *destructive dequeue*: it reads the entry at `tail`, **deletes it**, and
> advances the cursor, all in one transaction. That is exactly right for the workflow that
> owns the queue and catastrophic for anything looking on. A `store get` CLI command, a
> dashboard, a monitor workflow or a debugging session wired to `get` would silently eat a
> running system's data — no error, no log line, just a queue that is one element shorter
> every time somebody looked at it.
>
> Anything that inspects rather than consumes must use `peek`. There is no case where an
> observer should call `get` on a FIFO.

The rule holds on every backend: a `redis-fifo` `get` is an `LPOP`, equally destructive, and
`BoxObserverRedis` reads the list with `LINDEX`/`LRANGE` instead. The rest of this section
describes the LMDB surface, which is where the hazard that shaped the API lives.

The peek surface is non-destructive on **both LMDB strategies**. On `lmdb-kv` it is a plain
`get`; on `lmdb-fifo` it reads `fifo:<key>:data:<tail>` directly and leaves `head`, `tail`
and every data entry untouched. The element `peekSync` returns is exactly the one the next
real `get` will dequeue.

| Method | Answers |
| --- | --- |
| `peekSync(location)` | The value a `get` would return. `Err('Value not found')` / `Err('Queue empty')`, the same strings the consumer path uses. |
| `peekAllSync(location)` | Every queued element, **oldest first**, across the ring wrap — the order a consumer would drain them in. A one-element list on `lmdb-kv`. |
| `depthSync(location)` | `{used, capacity}`. For `lmdb-fifo`, `capacity` is `queueSizeMax - 1`, because the ring keeps one slot free (§1.B): it is the number of entries `put` accepts before returning `Queue is full`, not the declared figure restated. (`redis-fifo` reserves nothing, so its `capacity` is the declared figure.) |
| `inspectSync(workflow)` | Every **logical** key in a workflow, with its strategy, byte size and FIFO depth. |

Enumeration classifies the derived `fifo:<key>:head`, `:tail` and `:data:<n>` entries into
one record per logical queue; **a derived key is never reported as a user key**. Strategy is
inferred from the layout, not from a declaration, so it also answers "what is actually on
disk" when a document has changed. Two details worth knowing:

- Sizes are the **uncompressed, encoder-measured** bytes — the same quantity `valueSizeMax`
  is checked against (§1.C) — never on-disk bytes. `compression: true` makes those differ;
  disk sizing stays `recommendedVolumeBytesFor`'s job. For a FIFO, `valueSizeBytes` sums the
  elements while `valueSizeMaxBytes` is the largest single one, because `valueSizeMax`
  bounds an element and not a queue.
- `queueSizeMax` lives in the workflow document, not in LMDB, so enumeration cannot compute
  `(head - tail) mod queueSizeMax`. It reports `fifo.depth` from the **count of data entries
  that exist**, which is exact — `get` removes the entry it dequeues — and needs no
  declaration. `depthSync`, which is handed a strategy, reports `used`/`capacity` from the
  cursors instead.

#### The observer opener, and the hazard that shapes it

`BoxObserverLmdb` is the out-of-process form: it opens a workspace environment with
`readOnly: true` and offers peek, enumeration and nothing else. Two properties, and the
second is the one that dictated the API's shape.

**It cannot write.** lmdb-js skips `addWriteMethods` entirely under `readOnly`, so on the
underlying store `put`, `putSync`, `remove`, `removeSync`, `drop`, `transaction` and
`transactionSync` are `undefined` rather than merely refused, and `openDB` omits
`MDB_CREATE`, so observing a workflow that does not exist is an error rather than a created
database. `open()` itself would `mkdir -p` its path on the way to failing, so
`BoxObserverLmdb.openSync` checks for `data.mdb` first: pointing an observer at a workspace
that has never run creates nothing and returns an `Err`.

> [!IMPORTANT]
> **A parked reader makes the writers' store grow without bound.** This is the reason the
> observer API looks the way it does, and it is not about staleness.
>
> An LMDB read transaction pins an MVCC snapshot. A pinned snapshot stops the **writers'**
> environment from reclaiming the pages that snapshot still references — so an observer left
> holding one does not merely see old data, it silently unbounds someone else's storage.
> Measured in `box-observer-lmdb.test.ts`, against 20 seconds of identical write work on a
> churned ring: **no observer, 0 bytes of growth; `BoxObserverLmdb` polling every 50 ms
> (396 polls), 236 KB; one deliberately pinned read transaction, 96 MB in a quarter of the
> time.**
>
> An observability tool that quietly does the third thing is worse than no observability
> tool.

The mechanism relied on, verified against the vendored lmdb-js rather than assumed:

- lmdb-js keeps **one shared read transaction per environment**. The first read of an
  event-loop turn calls `renewReadTxn`, which acquires it and in the same breath schedules
  its release — `readTxnRenewed = setTimeout(resetReadTxn, 0)` (`lmdb/read.js:1058`).
  `resetReadTxn` calls `mdb_txn_reset`, releasing the snapshot while keeping the process's
  slot in the reader table for reuse (`lmdb/read.js:1062-1086`).
- Two things defeat that default. `useReadTransaction()` hands out a refcounted transaction
  that stays pinned until `.done()`; and a `getRange` iterator left alive across an `await`
  keeps its cursor, at which point `resetReadTxn` passes the snapshot on instead of
  releasing it.

So the API is built to make both unreachable: **every method is synchronous and returns
fully materialised plain data** — arrays and records, never a `RangeIterable`, never a
transaction. There is no `await` a caller can put in the middle of an observer read, because
there is no asynchronous observer read. On top of that each method resets the shared read
transaction in a `finally`, so a snapshot is released before the call returns and the next
call necessarily starts from a fresh one. `readerListSync()` dumps LMDB's reader lock table
(`pid`, thread, `txnid`) if you ever need to confirm it: this observer's slot reads `-`
between calls.

Holding an observer open for hours is fine — that costs a reader slot, which pins nothing.
What cannot be made safe from inside the class is a caller that reaches past it, with a raw
`lmdb.open()` or `useReadTransaction()` on the same environment. `readerListSync()` is where
to look when a store grows for no reason.

#### Two observer interfaces, deliberately not one

The same five questions — `listWorkflows`, `listKeys`, `peek`, `peekAll`, `depth`, plus a
`close` — are declared twice, in `box-observer.ts`:

| Interface | Shape | Implemented by |
| --- | --- | --- |
| `BoxObserver` | Every method **synchronous**, returning a `Result` of fully materialised data | `BoxObserverLmdb` |
| `BoxObserverAsync` | Every method returning a `Promise<Result<…>>` | `BoxObserverRedis` |

**No type implements both**, `BoxObserver` gained no optional method, and nothing on it
returns `Promise<T> | T`. Widening the one interface would have readmitted the hazard above
for LMDB: a promise-returning read is a read a caller may `await` in the middle of, and no
type can express "this implementation's promise always settles before the next microtask".
A runtime capability flag would have turned a compile-time guarantee into a convention.

The cost is paid by the caller and is real: something observing an LMDB workspace *and* a
Redis-backed one holds two differently shaped observers and merges the results itself.
`@rawbox/cli`'s `store/observers.ts` is that merge, written once for `store list`/`get`/
`watch` and `workspace status`, resolving one `BoxObserverRedis` per entry of the workspace's
`backends:` map. `BoxObserverAsync` carries **no** analogue of either LMDB guarantee: nothing
server-side is pinned by a round trip, so there is nothing to park — but there is also no
snapshot behind a multi-key read, so `BoxObserverRedis` can report a torn view, and its `SCAN`
sweep may repeat or miss a key that changes mid-walk. Its own doc comment states that
explicitly rather than leaving it implied. `readerListSync` stays on `BoxObserverLmdb` alone:
it dumps LMDB's reader lock table, which means nothing on another backend.

---

## 2. API Reference

### `BoxStore` (interface)
The minimal async contract the runner depends on:
* **`get(boxLocation: BoxLocation): Promise<Result<unknown, string>>`**
* **`put(box: Box<unknown>): Promise<Result<void, string>>`**

### `BoxStoreLmdb`
The LMDB implementation, dispatching each call to the strategy named on the location.

#### Static Factory
* **`BoxStoreLmdb.create(workspace: string, rootDirectoryUrl: URL): BoxStoreLmdb`**
  Opens (or reuses) the LMDB environment for the workspace under `rootDirectoryUrl`. There
  is no budget parameter: the storage budget is a figure to provision with, not one the
  store applies (§1.D).

#### Instance Methods
* **`put(box)` / `get(location)`**: The async `BoxStore` surface. Both delegate straight to
  their sync counterparts — LMDB reads are memory-mapped, so there is no I/O to await.
* **`putSync(box)` / `getSync(location)`**: The synchronous forms. **Use these inside a
  transaction**, since the callback must return a `Result`, not a promise.
* **`transaction<T>(callback: (boxStore: BoxStoreLmdb) => Result<T, string>): Result<T, string>`**:
  Wraps multiple operations in a synchronous, ACID transaction. Returning an `Err` from the
  callback aborts the transaction and propagates that error.

#### Observation Methods (non-destructive — see §1.E)

* **`peekSync(location)` / `peek(location)`**: The value `get` would return, left in place.
  **On a FIFO this is not `get`** — `get` dequeues, this does not.
* **`peekAllSync(location)` / `peekAll(location)`**: Every queued element, oldest first,
  across the ring wrap.
* **`depthSync(location)`**: `{used, capacity}` for an `lmdb-fifo` box; an `Err` for
  `lmdb-kv`, which has no depth.
* **`inspectSync(workflow)`**: Every logical key in a workflow — strategy, uncompressed byte
  size, FIFO depth — with derived `fifo:…` entries folded into one record per queue.

These are the **in-process** form, for a workflow reading its own or a sibling's state. They
run against this store's read-write environment and share its database lifecycle: like
`getSync`, peeking at a workflow with no database yet creates the (empty) database. That is
a database handle, never a key — no `head`, `tail` or `data:` entry is touched on any path.
For inspection from outside the run, use `BoxObserverLmdb`, which cannot create even that.

### `BoxStoreRedis`

The Redis implementation of the same two-method `BoxStore` contract, for `redis-kv` and
`redis-fifo`. **Nothing in `@rawbox/runner` constructs one yet** — see the note at the top of
this README.

* **`BoxStoreRedis.create(connection, clientCache): Promise<Result<BoxStoreRedis, string>>`**
  Takes a resolved **connection string**, not a `backend:` id: turning an id into a string
  means reading a workspace document's `backends:` map, which is `@rawbox/runner`'s
  `resolveBackendConnection` and would otherwise invert this package's dependency direction.
  `clientCache` is a required `RedisClientCache` rather than a hidden module default, so
  sharing a connection across several `create` calls is something a caller states.
* **`get(location)` / `put(box)`** — `GET`/`SET` for a cell, `LPOP`/`RPUSH` for a queue. There
  are **no sync forms and no `transaction`**: `BoxStore` is the whole surface.
  `queueSizeMax` is enforced inside a Lua script, so the `LLEN` and the conditional `RPUSH`
  cannot be interleaved by a concurrent writer the way a check-then-act pair could.
* Physical keys are `rawbox:<workspace>:<workflow>:<key>` (`redisKeyFor`, exported so the
  observer builds the identical string). A `redis-fifo` box occupies the **same** key a
  `redis-kv` box of that name would — one list is one key, and Redis carries the type
  intrinsically, so no `fifo:` prefix is derived. Changing a key's strategy between runs
  therefore meets a string where a list is expected, and Redis answers `WRONGTYPE`; that is
  translated into a named diagnostic rather than designed away, because the alternative is a
  silent empty queue beside the author's abandoned data.

### `BoxObserverLmdb`

The out-of-process, read-only inspection surface. Read §1.E before using it — the API's
shape is dictated by the page-reclamation hazard described there.

* **`BoxObserverLmdb.openSync(workspace, rootDirectoryUrl): Result<BoxObserverLmdb, string>`**
  Opens the workspace environment `readOnly: true`. Resolves the environment directory
  through the same helper `LmdbEnvCache` uses, so an observer and a runner cannot disagree
  about where a workspace lives. An `Err` — never a throw, never a created directory — when
  the workspace has never been written.
* **`listWorkflowsSync(): Result<string[], string>`** — the databases of the environment.
* **`listKeysSync(workflow): Result<BoxInspection[], string>`** — as `inspectSync` above.
* **`peekSync` / `peekAllSync` / `depthSync`** — as above, refusing a location addressed at
  a different workspace.
* **`readerListSync(): Result<string, string>`** — LMDB's reader lock table, verbatim.
* **`closeSync(): void`** — releases the environment and the reader slot. Idempotent, and
  never throws.

Every method is synchronous by design, and none returns an iterator or a transaction; see
§1.E for why.

All methods return `neverthrow` `Result` values; nothing throws across the API boundary.

---

## 3. Example Usage

```typescript
import { pathToFileURL } from 'node:url';
import { BoxStoreLmdb } from '@rawbox/store/box-store-lmdb';
import type { BoxLocation } from '@rawbox/store';

// 1. Instantiate the store
const rootDataUrl = pathToFileURL('./data/');
const store = BoxStoreLmdb.create('live-trading', rootDataUrl);

// 2. Define location and box content
const location: BoxLocation = {
  workspace: 'live-trading',
  workflow: 'example-workflow',
  key: 'btc_usdt_data',
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 1900,
  },
};

const box = {
  location,
  content: { price: 105.4, ticker: 'BTC/USDT' },
};

// 3. Put data into the store
const putRes = await store.put(box);
if (putRes.isErr()) {
  console.error('Write failed:', putRes.error);
}

// 4. Retrieve data from the store
const getRes = await store.get(location);
if (getRes.isOk()) {
  console.log('Retrieved Data:', getRes.value); // { price: 105.4, ticker: 'BTC/USDT' }
}
```

### Transaction Example

Reads and writes inside a transaction use the **sync** methods, and returning an `Err`
rolls the whole thing back:

```typescript
const txResult = store.transaction((txStore) => {
  const putResult = txStore.putSync(box);
  if (putResult.isErr()) {
    return putResult; // aborts the transaction
  }

  return txStore.getSync(location);
});
```

### FIFO Example

```typescript
const queueLocation: BoxLocation = {
  workspace: 'live-trading',
  workflow: 'example-workflow',
  key: 'tick_queue',
  strategy: { name: 'lmdb-fifo', queueSizeMax: 1024, valueSizeMax: 1900 },
};

await store.put({ location: queueLocation, content: { price: 105.4 } });

const next = await store.get(queueLocation); // shifts the oldest entry — CONSUMES it
```

### Observation Example

```typescript
import { BoxObserverLmdb } from '@rawbox/store/box-observer-lmdb';

const observerResult = BoxObserverLmdb.openSync('live-trading', rootDataUrl);

if (observerResult.isErr()) {
  console.error(observerResult.error); // e.g. the workspace has never run
  return;
}

const observer = observerResult._unsafeUnwrap();

try {
  for (const workflow of observer.listWorkflowsSync()._unsafeUnwrap()) {
    for (const entry of observer.listKeysSync(workflow)._unsafeUnwrap()) {
      console.log(workflow, entry.key, entry.strategy, entry.valueSizeBytes,
                  entry.fifo?.depth);
    }
  }

  // Non-destructive: the queue is byte-identical afterwards, and the next
  // real `get` still dequeues `head`.
  const head = observer.peekSync(queueLocation);
  const all = observer.peekAllSync(queueLocation);   // oldest first
  const depth = observer.depthSync(queueLocation);   // { used, capacity }
} finally {
  observer.closeSync();
}
```

To poll, call the observer again on an interval — do **not** hold anything between calls.
Each call takes a fresh snapshot and releases it before returning, which is both what keeps
the reading current and what keeps the writers' store from growing (§1.E).

---

## 4. Entry Points

| Import | Contents |
| --- | --- |
| `@rawbox/store` | **Box model**: `Box`, `BoxLocation`, `BoxStrategy`, `ReadBoxLocation`, `WriteBoxLocation`, `BoxLocationRecord`, `BoxStore`, `buildBoxRecord`, `buildRecord`. **Schema**: `StrictObject` — `Type.Object` with `additionalProperties: false`, which every schema of the workflow format is built with, since an unrecognised field is an error everywhere in a document; it lives here because this is the one package both halves of that schema graph can see. **Budget** (§1.D): `budgetForKey`, `budgetForStorage`, `partitionKeyBudgetOutcomeList`, `recommendedVolumeBytesFor`, `measureValueSize`, `measureKeySize`, `entryOverhead`, `readMaxKeySize`, the `LMDB_*` structural constants, the `RAWBOX_KEY_SIZE_MAX` / `RAWBOX_KEY_DERIVATION_OVERHEAD_MAX` contract constants (§1.C), and the `BoxStorage` / `KeyBudget` / `KeyBudgetOutcome` / `KeyBudgetPartition` / `KeyBudgetSource` / `StorageBudget` / `UnbudgetableKey` / `VolumeRecommendationOptions` types. **Strategy registry** (§1.B): `STRATEGY_NAME_LIST`, `descriptorFor`, `seedCapacityOf`, `storeIdentityOf`, `keyBudgetOf`, and the `StrategyDescriptor` / `StoreIdentity` types. **Observation seams** (§1.E): the `BoxObserver` and `BoxObserverAsync` interfaces — types only, so importing them drags in no environment opener and no Redis client |
| `@rawbox/store/box-store-lmdb` | `BoxStoreLmdb` and its `LmdbEnvCache` / `LmdbDbiCache` internals, plus `LMDB_DBI_OPTIONS_DEFAULT` and `resolveEnvFolderUrl` — the two things the read-write and read-only paths must agree on |
| `@rawbox/store/box-store-redis` | `BoxStoreRedis`, the `RedisClientCache` that hands it a connection, and `redisKeyFor` — the physical key scheme the write and read sides must agree on |
| `@rawbox/store/box-observer-lmdb` | `BoxObserverLmdb` — the read-only, out-of-process inspection surface (§1.E) |
| `@rawbox/store/box-observer-redis` | `BoxObserverRedis` — the `BoxObserverAsync` counterpart, one per `backends:` entry (§1.E) |
| `@rawbox/store/box-peek` | The backend-facing peek/enumeration functions (`peekStatic`, `peekAllStatic`, `depthStatic`, `inspectStatic`), the derived-key grammar (`fifoHeadKey`, `fifoTailKey`, `fifoDataKey`, `parseDerivedFifoKey`) and the ring arithmetic (`ringUsed`, `ringCapacity`, `ringIndexList`). Also re-exported from `@rawbox/store`, along with the `BoxInspection` / `BoxFifoInspection` / `BoxQueueDepth` / `BoxReadDbi` / `DerivedFifoKey` types |

---

## 5. Development

```bash
npm run build       # tsc
npm test            # vitest run tests
npm run type-check  # tsc --noEmit
```
