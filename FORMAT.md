# Rawbox Document Format

**Format version `1.0`.** Normative. Where this and `@rawbox/runner`'s schemas disagree, the
schemas win and one of them is a bug.

This states what a **Workflow** and a **Workspace** document must contain. It states the
rules rather than arguing for them; where a rule exists for a reason that is not obvious from
the rule itself, the reason is recorded beside the code that implements it.

**Every document is closed.** An unrecognised field is an error, never ignored. The keys of a
map an author owns — `plugins`, `storage.keys`, `backends`, a step's bindings — are values,
not fields, and are unconstrained by that rule.

---

## 1. Identity

Every document declares `kind` at the root. Tooling identifies a file by that field alone,
never by shape.

| `kind` | Document |
| --- | --- |
| `Workflow` | An executable sequence of steps |
| `Workspace` | The runtime context a set of workflows executes in |

A document without `kind` is not a Rawbox document and MUST be rejected as such.

---

## 2. The Workflow document

```yaml
kind: Workflow
formatVersion: "1.0"
name: launch
description: "Optional, free text."

plugins:
  "@rawbox/rawbox-plugin-default": "^1.0.0"

storage:
  defaultStrategy: { name: lmdb-kv, valueSizeMax: 1900 }
  keys:
    tick_ms:
      seed: 500
    tick_queue:
      strategy: { name: lmdb-fifo, queueSizeMax: 1024, valueSizeMax: 1900 }
      seed: [first, second]

steps:
  - label: tick
    plugin: "@rawbox/rawbox-plugin-default"
    operation: time/sleep
    inputs:
      ms: tick_ms
    outputs:
      timestamp: slept_at
    errors:
      message: sleep_error
```

| Field | Required | Type |
| --- | --- | --- |
| `kind` | yes | `"Workflow"` |
| `formatVersion` | yes | `"1.0"` |
| `name` | yes | non-empty string |
| `description` | no | string |
| `plugins` | yes | map of package name → npm specifier (§2.1) |
| `storage` | yes | storage block (§2.2) |
| `steps` | yes | array of steps (§2.3) |

### 2.1. `plugins`

Package name → npm dependency specifier, exactly the shape of `dependencies` in a
`package.json`, handed to npm verbatim.

```yaml
plugins:
  "@rawbox/rawbox-plugin-default": "^1.0.0"                  # registry
  "@acme/rawbox-plugin-kraken": "file:../packages/kraken"    # local path
  "@acme/rawbox-plugin-exp": "git+https://…/exp.git#main"    # git
```

- Keys MUST be canonical package names.
- A package MAY appear at most once. A duplicate is a parse error, not a validation one.
- A relative `file:` specifier resolves against the **workspace directory**.
- No integrity hashes appear here; they live in the lock file.

### 2.2. `storage`

| Field | Required | Meaning |
| --- | --- | --- |
| `defaultStrategy` | yes | Strategy for any key that declares none |
| `keys` | no | Map of storage key → key entry |

A key resolves its strategy as **`keys[key].strategy ?? defaultStrategy`**. That one rule
serves seeds, step bindings and the budget alike.

#### The key entry

| Field | Required | Meaning |
| --- | --- | --- |
| `strategy` | no | This key's strategy (§2.2.1) |
| `seed` | no | Its value before the first step runs (§2.2.2) |
| `workflow` | no | The workflow that owns this box (§2.4) |

An entry stating nothing is legal: it declares the key, which resolves to `defaultStrategy`.

`keys` is the **only** way to declare a storage key. Two earlier blocks,
`storage.strategies` and `storage.seed`, stated the first two facts one map per fact; both
have been **removed** (§5).

#### 2.2.1. Strategies

| `name` | Fields | Meaning |
| --- | --- | --- |
| `lmdb-kv` | `valueSizeMax` | A value cell in the workspace's LMDB environment |
| `lmdb-fifo` | `queueSizeMax`, `valueSizeMax` | A ring-buffer queue in that environment |
| `redis-kv` | `valueSizeMax`, `backend` | A value cell on a Redis server |
| `redis-fifo` | `queueSizeMax`, `valueSizeMax`, `backend` | A native Redis list |

Every field listed is **required** for that strategy. A `name` outside this set MUST be
rejected, as MUST a field belonging to a different strategy.

- **`valueSizeMax`** — integer `1 … 2147483647`. Bounds **one stored value**, measured as its
  msgpack encoding before compression. Enforced on write by every strategy.
- **`queueSizeMax`** — the queue's capacity in entries. `lmdb-fifo` requires `≥ 2` and holds
  `queueSizeMax - 1` (one slot distinguishes full from empty); `redis-fifo` requires `≥ 1`
  and holds `queueSizeMax`. No power-of-two constraint.
- **`backend`** — a non-empty id naming an entry of the **workspace's** `backends` map
  (§3.1). Never a connection string.

**The strategy decides what every operation on the key means:**

| Operation | `*-kv` | `*-fifo` |
| --- | --- | --- |
| write (a step output, or a seed) | overwrites the cell | enqueues one entry |
| read (a step input) | reads the cell, leaving it | **dequeues** one entry |

A step input bound to a queue therefore receives **one entry per read**, not the queue.

**Every key a workflow names MUST resolve to one store.** A step's write and the next step's
read share a transaction, and a transaction does not span two stores. `lmdb-*` keys share the
workspace's environment; a `redis-*` key's store is the server its `backend` id names, so two
ids are two stores.

#### 2.2.2. `seed`

The key's value before the first step runs, applied on **every** run.

- For a strategy whose writes **append** (`lmdb-fifo`, `redis-fifo`), `seed` MUST be a
  **list**: each element becomes one entry, in order. `[]` seeds an empty queue.
- `valueSizeMax` bounds **one element**, not the list.
- The element count MUST NOT exceed the strategy's capacity (§2.2.1).
- For a cell, `seed` is the value, stored as written. Any YAML value is legal.

A key that declares `workflow` MUST NOT declare `seed`.

### 2.3. `steps`

Steps execute in order until a control-flow step redirects or the list ends.

| Field | Required | Meaning |
| --- | --- | --- |
| `label` | no | Non-empty name, addressable as a jump target |
| `plugin` | yes | A package named in `plugins` |
| `operation` | yes | `segment/segment…`, e.g. `time/sleep` |
| `inputs` | no | Map of handler field → storage key |
| `outputs` | no | Map of handler field → storage key |
| `errors` | no | Map of handler field → storage key |
| `timeoutMs` | no | Positive integer bound on this step |

An operation beginning `control-flow/` is a **control-flow step** and MUST NOT declare
`outputs`. Any other operation MUST NOT be treated as one.

#### Bindings

**A binding names a storage key. No binding form carries a value.** A constant is declared as
a key and seeded:

```yaml
storage:
  keys:
    then_label: { seed: sleep-step }
steps:
  - inputs:
      thenLabel: then_label
```

A binding of the form `{ value: … }` MUST be rejected.

An `inputs` binding MAY use the long form to read another workflow's box:

```yaml
inputs:
  ms: { key: shared_state, workflow: other-flow }
```

`outputs` and `errors` have **no** such form: a step cannot write outside its own workflow.

### 2.4. Cross-workflow reads

A key may name the workflow that owns its box, either on the key entry (`workflow:`) or on an
`inputs` binding. If both, they MUST agree.

A key that declares `workflow`:

- MUST NOT appear in any step's `outputs` or `errors`;
- MUST NOT declare `seed`;
- MUST NOT name the declaring workflow itself;
- is excluded from this workflow's storage budget — those bytes belong to the owner.

### 2.5. Storage keys

**A storage key MUST be at most 79 bytes (UTF-8) and match `[A-Za-z0-9_.-]+`.** The limit
applies to the key **as written**, not to anything a strategy derives from it. Neither rule is
configurable.

**A key read by an `inputs` binding MUST be written by something** — some step's `outputs` or
`errors`, or a `seed`. A cross-workflow read is exempt; its owner writes it. Order is not
analysed: a step may read what a later step writes.

---

## 3. The Workspace document

```yaml
kind: Workspace
name: my-workspace
workflowPathList:
  - ./workflows/launch.workflow.yaml
targetFolder: .rawbox
backends:
  main:
    connection: "redis://cache.internal:6379/${REDIS_PASSWORD}"
seedOverrides:
  ./workflows/launch.workflow.yaml:
    tick_ms: 250
logs:
  rotate:
    maxBytes: 134217728
    maxFiles: 8
  prune:
    keep: 50
    olderThanDays: 14
```

| Field | Required | Meaning |
| --- | --- | --- |
| `kind` | yes | `"Workspace"` |
| `name` | yes | string |
| `workflowPathList` | yes | Paths to the workflow documents, relative to this file |
| `targetFolder` | no | Where installed plugins and data live. Defaults to `.rawbox` |
| `backends` | no | Map of backend id → connection (§3.1) |
| `seedOverrides` | no | Map of workflow path → seed replacements (§3.2) |
| `logs` | no | How this workspace's run logs are written, rotated and pruned (§3.3) |

### 3.1. `backends`

| Field | Required | Meaning |
| --- | --- | --- |
| `connection` | yes | Non-empty connection string |

`${NAME}` in a connection is replaced from the environment. A bare `$NAME` is a literal.

- A referenced variable that is unset or empty MUST be an error at verify time.
- A `backend` id named by a strategy but absent from this map MUST be an error.

### 3.2. `seedOverrides`

Replaces seed **values** in the workflows this workspace runs. Nothing else: not a strategy,
a size, an owner or a backend.

Keyed by **workflow path** — the same entry `workflowPathList` holds, compared after
resolution against the workspace directory, so `./a.yaml`, `a.yaml` and `x/../a.yaml` name one
workflow.

- A path matching no `workflowPathList` entry MUST be an error.
- Two keys resolving to one path MUST be an error.
- An override MAY only replace a seed the workflow **already declares**. Overriding a key that
  is undeclared, unseeded, or owned by another workflow MUST be an error.
- A value replaces the workflow's whole seed. It is never merged into it.
- The replacement is re-validated against the key's declared strategy — list shape, element
  count, and `valueSizeMax` — exactly as the workflow's own seed is.

`--seed key=<json>` on `workflow run` and `workflow verify` is the same override one layer
higher. Precedence is **CLI > workspace > workflow**.

### 3.3. `logs`

How this workspace's run-event files are written, rotated and pruned. A log bound is a
property of the deployment, not of a workflow, so it is declared once here.

| Field | Required | Meaning |
| --- | --- | --- |
| `async` | no | Buffer the run's log writes instead of writing each line before continuing. Defaults to `false` |
| `steps` | no | How much of a `step.start` / `step.end` reaches the main log: `full`, `summary`, or `off`. Defaults to `full` (§3.3.3) |
| `rotate` | no | When one segment of a run's log ends, and how many are kept (§3.3.1) |
| `prune` | no | The `runs prune` bounds across runs (§3.3.2) |

Every field is optional and so is the block: `logs: {}` is legal and means what omitting it
means. The block is **closed**, like every other object in this format — an unrecognised
field inside it, or inside `rotate`/`prune`, MUST be reported as that field.

A CLI flag overrides what is declared here. Precedence is **CLI > workspace.yaml >
built-in default**, decided **per field**: a workspace declaring `prune.keep` and an
invocation passing `--max-bytes` compose — neither replaces the other's whole block.

`async: false` writes each event before the run continues, so a run killed mid-workflow
keeps its last lines. `async: true` trades that for throughput. `run.end` is made durable
synchronously in both modes.

#### 3.3.1. `logs.rotate`

| Field | Required | Meaning |
| --- | --- | --- |
| `maxBytes` | no | Bytes one segment reaches before the next begins. Integer, minimum `4096` |
| `maxFiles` | no | How many segments of one run are kept. Integer, minimum `1` |

One run's log is a sequence of **segments**. `<run_id>.ndjson` is segment 0 **and the
oldest**; its successors are `<run_id>.1.ndjson`, `<run_id>.2.ndjson`, … The error log
rotates identically, as `<run_id>.error.N.ndjson`.

- **Rotation is on by default.** Both fields absent means the built-in pair, `134217728`
  bytes × `8` segments — 1 GiB per run. There is no field that turns rotation off; a
  workspace wanting more history raises `maxFiles`.
- Declaring one of the two fields without the other MUST be an error at verify time. The
  missing half is never defaulted on its own.
- A segment is written once, is immutable the moment it is superseded, and is never renamed
  and never truncated. Numbering runs forward, so the highest-numbered segment is the live
  one.
- The bound is checked between events, so a segment always ends at a line boundary and MAY
  exceed `maxBytes` by the length of its last event.
- When a roll would exceed `maxFiles`, the **oldest** surviving segment is deleted. A gap at
  the low end of a run's segments is therefore an ordinary retained window, not damage: a
  reader MUST start at the lowest segment that exists rather than assume segment 0 does.
- A run occupies at most `maxBytes * maxFiles`.

#### 3.3.2. `logs.prune`

| Field | Required | Meaning |
| --- | --- | --- |
| `keep` | no | Keep only the `keep` most recently started runs. Integer, minimum `0`. Defaults to `20` |
| `olderThanDays` | no | Delete anything started more than this many days ago. Integer, minimum `0` |
| `maxBytes` | no | Delete oldest-first until the surviving set's total bytes are at or under this. Integer, minimum `0` |

- The three bounds compose, in the order `olderThanDays` → `keep` → `maxBytes`, against a
  newest-first ordering.
- `maxBytes` is the **primary bound when it is set**, and MAY cut an entry the other two
  would have kept. It has no built-in default: left undeclared it is no bound of that kind,
  not zero. The same is true of `olderThanDays`.
- `keep` is the bound always in effect: it resolves to `20` even when `logs.prune`, or the
  whole `logs:` block, is omitted.
- A run whose process is still alive is exempt from all three bounds. Its bytes are still
  charged against `maxBytes`, so live runs alone MAY leave a directory over budget.
- At least one entry always survives a pass.
- A pass removes **every segment** of a pruned run's logs, and MUST NOT unlink a file a
  surviving entry still points at.

The worst case a workspace's run and log directories reach is
`prune.keep * rotate.maxBytes * rotate.maxFiles` — 20 GiB at the built-in defaults, and
under a megabyte for short runs, which never open a second segment.

#### 3.3.3. `logs.steps`

| Value | Meaning |
| --- | --- |
| `full` | Every field of `step.start` / `step.end`, exactly as emitted. The default |
| `summary` | `step.start` / `step.end` reach the main log with `input` / `output` omitted. Every other field — `step`, `outcome`, `duration_ms`, `error`, and the whole envelope — is kept |
| `off` | `step.start` / `step.end` do not reach the main log at all |

- Governs the **main** log only, and only `step.start` / `step.end`. Every other kind —
  `step.progress`, `log`, `run.start`, `run.end`, `storage.seed`, `seed.override.applied`,
  `run.heartbeat`, `log.rotate`, `bootstrap.error` — is unaffected by every value.
- **The error log is never affected.** A failed `step.end` keeps its full `input`/`output` in
  `<run_id>.error.ndjson` under every value, including `off`. Losing the record of a
  *successful* step is the trade this field offers; losing the diagnostics for the step that
  actually failed is not.
- `run.end`'s `steps_total` / `steps_failed` are unaffected by every value, so a run's step
  counts are still correct even when no `step.end` reaches the main log at all.
- This is not a log level: `step.start` / `step.end` carry no `level` field to threshold on,
  under any value. The three values are a detail policy, not a severity filter.
- A closed set of three string literals, not a boolean pair or an integer scale — there is no
  fourth point on the line. An unrecognised value (`steps: sumary`) MUST be an error at verify
  time, never a silent `full`.
- `--output ndjson` on `workflow run` is written by the same route as the main log file, so it
  honours this policy too — the raw stdout stream and the log file agree under all three
  values.

`step.start` / `step.end` carry `input` and `output` — the records a workflow read and
produced — and those grow with whatever state the workflow accumulates. In one measured
workspace of four looping workflows they were 91% of all log bytes; `summary` cut that
workspace's daily total by 39%, `off` by 91%.

---

## 4. Validation

Every rule above is checked before a run starts, and by `workflow verify` / `workspace verify`
without running anything.

A diagnostic names the offending thing, the document path it was declared at, and what to do.
An unrecognised field is reported as that field — never as a list of the shapes the value
failed to be.

Two strategies, `redis-kv` and `redis-fifo`, are **declarable and verifiable but not
runnable** in this release: no Redis store is wired into the run path, so a run declaring one
is refused by name before anything is opened or written.

## 5. Removed forms

`formatVersion` stays `"1.0"`: these are forms the format never had a second version of, so
there is no version to read a document against. Each MUST therefore be rejected **by name**,
with the replacement shown — an "unknown property" error tells an author working from an older
example nothing about what to write instead.

| Removed | Replaced by |
| --- | --- |
| `storage.strategies` — key → strategy | `storage.keys.<key>.strategy` (§2.2) |
| `storage.seed` — key → value | `storage.keys.<key>.seed` (§2.2.2) |
| `{ value: … }` on an input | a seeded key, bound by name (§2.3) |

`storage.defaultStrategy` is **not** one of them. It is the strategy a key with no `strategy`
of its own resolves to, not a shorthand for a `keys` entry, and it is unchanged.

The first two are refused before the schema runs, so the diagnostic is the migration rather
than a closed-object error: it names the block, says it was removed, and prints the `keys`
entries that replace it — built from the document's own keys and its own values.
