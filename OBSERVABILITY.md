# Rawbox Observability

**Normative.** Where this and the code disagree, the code wins and one of them is a bug.

Three surfaces answer three questions: the **run-event stream** says what happened during a
run, the **run registry** says what ran and what is alive, and **store observation** says what
state the system holds now.

---

## 1. The run-event stream

One NDJSON object per line, under `<targetFolder>/logs/`. Append-only, never rewritten. The
terminal is a rendering of this stream, not a separate output.

A run's stream is **one or more segment files**, not necessarily one. `<run_id>.ndjson` is
segment 0 and the oldest; its successors are `<run_id>.1.ndjson`, `<run_id>.2.ndjson`, … A
segment is immutable once superseded, is never renamed or truncated, and always ends at a
line boundary. Rotation is on by default and its bounds are the workspace document's
`logs.rotate:` (FORMAT.md, §3.3.1). A reader of a run's stream MUST enumerate its segments,
starting at the lowest one that exists — the oldest is deleted once `logs.rotate.maxFiles`
is exceeded, so a gap at the low end is a normal retained window.

**Durability.** Writes are synchronous by default: each event is on disk before the run
continues, so a process killed mid-workflow keeps the lines that explain why.
`logs.async: true` (or `--log-async`) buffers instead, trading that for throughput; it is a
deliberate opt-in. `run.end` is flushed synchronously in both modes, because a stream ending
without one means "the process died", not "the run failed".

### 1.1. Envelope

Every event carries:

| Field | Required | Meaning |
| --- | --- | --- |
| `ts` | yes | ISO-8601 timestamp |
| `run_id` | yes | Identifies the run; stable for its lifetime |
| `event` | yes | One of the kinds below |
| `workspace` | no | Absent only before the workspace is known |
| `workflow` | no | Absent only before the workflow is known |
| `severity` | no | `warn` \| `error` — present only on the kinds that warrant an alarm (§1.3) |

Producers MUST NOT emit an event kind not listed here, and consumers MUST ignore kinds they do
not recognise rather than failing.

### 1.2. Event kinds

| `event` | Emitted |
| --- | --- |
| `run.start` | Once, when execution begins |
| `run.end` | Once, carrying `outcome`, `duration_ms`, `steps_total`, `steps_failed` |
| `step.start` | Before each step, carrying its identity and resolved `input` |
| `step.end` | After each step, carrying `outcome`, `duration_ms`, and `output` or `error` |
| `step.progress` | Opt-in, mid-step, by a handler that reports progress |
| `run.heartbeat` | While a step is in flight (§1.4) |
| `storage.seed` | Once, if seeds were written — one event for the whole pass |
| `seed.override.applied` | Once, if any seed override applied — key and source layer only, **never values** |
| `log` | A handler's own log line |
| `log.rotate` | Once per roll of the run's **main** log, as the first line of the new segment (§1.6) |
| `bootstrap.error` | A failure before or during startup, carrying `stage` (§1.5) |

A step's identity is `{ index, label?, plugin, operation, registry_hash, iteration }`. `index`
and `iteration` together identify one execution of one step inside a loop.

This table describes what the **producer** emits, which every sink — the terminal renderer,
the OTel bridge, `-v`/`-vv` — still observes in full. It does not describe what a given **sink**
writes to disk: `logs.steps:` (FORMAT.md, §3.3.3) lets the main NDJSON log omit
`step.start`/`step.end`'s `input`/`output` (`summary`) or the two kinds outright (`off`), as a
property of that one file. Two invariants hold under every value of that policy: `log.rotate`
remains the first line of every new segment, in every sink (§1.6), and `run.start`, `run.end`
and `bootstrap.error` are never filtered by it.

### 1.3. `severity`

`severity` classifies an event for alerting; it is not the log level a handler chose.

- `bootstrap.error` always carries `error`.
- A `step.end` or `run.end` whose `outcome` is an error carries `error`.
- A `log` event carries the level the handler used, projected onto this field: `error` →
  `error`, `warn` → `warn`, `info`/`debug` → absent.
- A `log.rotate` carries `warn` **exactly when it carries `deleted_segment`** — a routine
  roll is not an alarm, a roll that destroyed history is (§1.6).
- Everything else is absent, `run.heartbeat`, `step.progress` and an `interrupted` `run.end`
  included: none of those is ever an alarm.

A consumer alerting on `severity: "error"` MUST see every failure, and MUST NOT see a
successful run.

### 1.4. `run.heartbeat`

Emitted on an interval while a step is in flight, carrying `in_flight_ms`. It exists so a
**blocked** run is distinguishable from a **dead** one: a long step still emits heartbeats, a
crashed process stops.

The interval is configurable and MAY be disabled. A run that disables it forfeits that
distinction.

### 1.5. `bootstrap.error` and `stage`

A failure before the first step names the stage it failed at, so "your document is wrong" is
distinguishable from "your install is wrong":

`workspace` · `workflow` · `lock` · `resolve` · `seed-validation` · `seed-override` · `store` ·
`seed`

`lock`, `resolve`, `seed-validation`, `seed-override`, `store` and `seed` fail **after**
`run.start` has been emitted, so a run may end with `bootstrap.error` and no `step.start`.
`workspace` and `workflow` fail before a run has an identity at all.

### 1.6. `log.rotate`

Rotation destroys history — the oldest segment is unlinked once `logs.rotate.maxFiles` is
exceeded — and this kind is what keeps that fact in the stream, so a reader can tell
"nothing was logged before this" from "the log was trimmed".

| Field | Required | Meaning |
| --- | --- | --- |
| `sealed_segment` | yes | The segment just closed |
| `live_segment` | yes | The segment now live — this event is its first line |
| `deleted_segment` | no | The segment unlinked to honour `maxFiles` |
| `max_bytes`, `max_files` | yes | The `logs.rotate` bounds in force for this sequence |

- The event MUST be the first line of `live_segment`, in every sink.
- `deleted_segment` is present **only when a segment was actually unlinked**. A roll that
  retired nothing, and a retirement that was attempted and failed, both leave it absent: the
  field never claims a removal that did not happen.
- `severity: "warn"` is carried exactly when `deleted_segment` is (§1.3).
- Emitted for the **main** log only, never for the filtered error log's own independent
  rotation.

### 1.7. Versioning

**Additive only.** A new event kind or a new field MAY be added; an existing field MUST NOT
change meaning, type, or be removed. `run.start` carries `format` for consumers that need to
branch.

`logs.steps: summary` does not conflict with this. `input` and `output` are optional fields on
`step.start`/`step.end`; omitting one is indistinguishable, to a reader, from a run that simply
had nothing to record there. No event's shape changes — a line either carries the field or it
does not, and both are already legal under the schema.

---

## 2. The run registry

One JSON file per run, outside the store, under `<targetFolder>/runs/`. It answers "what ran,
what is alive, what crashed" without reading any log.

| Field | Meaning |
| --- | --- |
| `run_id`, `workspace`, `workflow` | Identity |
| `pid`, `pid_started_at` | The process, and enough to detect PID reuse |
| `started_at`, `ended_at?` | Lifecycle timestamps |
| `log_path`, `error_log_path` | Where this run's event stream is. Each names **segment 0**, and keeps that name for the life of the run; the run's stream may be several files (§1) |
| `status` | `bootstrapping` \| `running` \| `ok` \| `error` \| `interrupted` |
| `steps_total?`, `steps_failed?` | Present once the run has ended |

### 2.1. Lifecycle and crash detection

A run writes `bootstrapping`, then `running`, then exactly one terminal status. A file left in
`running` whose process is gone is reported as **`crashed`** — a status the file never
contains, computed at read time by probing the PID.

`pid_started_at` is what makes that safe: a recycled PID belonging to some other process MUST
NOT be read as the run still being alive.

### 2.2. Retention

Retention is two independent levels: **rotation** bounds one run's log (§1, and FORMAT.md
§3.3.1), **pruning** bounds how many runs are kept at all. Both are declared on the
workspace document, and a CLI flag overrides either, per field.

Pruning composes three bounds — `olderThanDays` → `keep` → `maxBytes` (FORMAT.md §3.3.2) —
and runs both as `runs prune` and opportunistically at the start of every run.

- **Pruning MUST NOT remove an entry whose run is still alive.** Liveness is the same
  `pid` + `pid_started_at` probe §2.1 uses, and an inconclusive or failing probe counts as
  alive: wrongly believing a run dead deletes a file still being written, wrongly believing
  it alive only defers some bytes to the next pass. A live entry is exempt from all three
  bounds, and its bytes are still charged against `maxBytes` — so live runs alone MAY leave
  a directory over budget, which is correct: the only way to honour the bound against a live
  writer would be to delete the file it is writing.
- **Pruning MUST NOT delete a log file a surviving entry points at**, segments included.
- Pruning a run removes **every segment** of both its logs, not only the two paths the
  registry names. Sizing measures the same set of files.
- `keep` is the bound always in effect — it defaults to `20` with nothing configured. There
  is **no built-in `maxBytes` fallback**: `maxBytes` remains the primary bound when a flag or
  the workspace document sets one, but an unconfigured workspace is bounded by `keep` alone,
  because rotation already gives each run a ceiling of its own.
- At least one entry always survives a pass.

---

## 3. Store observation

### 3.1. Peek is not get

**A `get` on a queue is a consumer operation: it removes the entry it returns.** Every
observation surface — `peek`, `peekAll`, `depth`, enumeration — MUST leave the store byte-
identical.

This is the one place a bug is dangerous rather than merely wrong: an inspection command wired
to `get` would silently eat a running system's data.

### 3.2. Enumeration

Enumeration reports **logical** keys as their author wrote them. A backend's derived entries —
a queue's cursors, its per-element keys — MUST NOT appear as keys, and a real key MUST NOT be
hidden by being mistaken for one.

`depth` reports `{ used, capacity }`. `capacity` is what the strategy declares it can hold, not
its declared ceiling restated: an `lmdb-fifo` ring reserves one slot and reports
`queueSizeMax - 1`; a `redis-fifo` list reserves none and reports `queueSizeMax`.

### 3.3. The out-of-process observer

Inspection from outside a run opens storage **read-only** and MUST create nothing — no
environment, no database, no key. "Nothing has run yet" is a normal answer for an inspection
command, reported as such rather than by creating an empty store.

### 3.4. Snapshot hygiene

**An observer MUST NOT hold a read snapshot open across an `await`.**

On LMDB a pinned read transaction stops the *writer's* environment reclaiming pages, so a
parked observer makes a busy store grow without bound — in another process. The LMDB observer
is therefore synchronous throughout and returns fully materialised data, never a live iterator,
and it resets its shared read transaction after every call.

A backend that cannot offer a point-in-time snapshot MUST say so rather than imply parity: a
Redis-backed observation is a `SCAN` plus per-key reads, so a multi-key listing may be torn,
may repeat a key, and may miss one written during the sweep. It MUST use `SCAN`, never `KEYS`.

### 3.5. Polling

The supported way to watch storage is one observer, opened once, whose synchronous methods are
called again on an interval. Nothing is held between polls, and the environment is not
reopened per poll.

---

## 4. CLI surfaces

Rules common to every observability command:

- **Read-only.** No command here writes to the store or the registry, except `runs prune`,
  which deletes only what §2.2 permits.
- **Three output shapes.** Human-readable by default; `--output json` emits machine-readable
  records. On `workflow run` there is a third: `--output ndjson` puts the raw event stream on
  stdout, byte-for-byte the log file's own lines, through the same synchronous writer — and
  `--output json` is an accepted alias for exactly that, not a second shape. The JSON shape
  is the contract — additive only, per §1.7.
- **Every reader spans segments.** A command reading a run's log — `runs tail`, `runs show`,
  `workspace logs` (`-f` included), `workspace status`, and pruning's own sizing —
  enumerates that run's segments rather than opening the registry's `log_path` alone, so a
  rotated run is never shown as its oldest segment only.
- **An empty result is not an error.** No runs, no keys, or a workspace never written are
  reported as such, with exit code 0.
- **Every figure names its source.** A command reports what it observed, never a value it
  inferred from a document it did not read.

| Command | Answers |
| --- | --- |
| `runs list` / `runs tail` | What ran, what is alive, what crashed |
| `store list` / `store get` / `store watch` | What state is held now |
| `workspace status` | One snapshot of every workflow and its storage |
| `workspace logs` | The merged event stream across workflows |
