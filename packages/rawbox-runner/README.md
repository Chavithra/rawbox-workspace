# rawbox-runner

`@rawbox/runner` is the orchestration and execution engine of the Rawbox Framework. Powered
by **XState v5**, it validates a workflow document, resolves it into a runtime model, and
executes it as a state machine. It reads step inputs from and writes step outputs/errors to
[`@rawbox/store`](../rawbox-store/README.md) under strict storage boundary rules — today
through the LMDB store, the only one this package constructs (§2.3).

This package's TypeBox schemas define the document format — what they accept is the
format; there is no separate specification to drift from. §2 below is the tour.

---

## Features

- ⚙️ **State-Machine Orchestration**: Built on XState v5 for predictable, debuggable state transitions.
- 🧭 **Two-Model Architecture**: The *authoring* document (what you write) and the *resolved* runtime model (what the machine runs) are separate schemas, bridged by `resolveWorkflow`.
- 🔒 **Storage Boundaries**: Writes never leave their own workflow; nothing ever leaves its workspace.
- 🔍 **Preflight Verification**: Validates against TypeBox schemas and loads plugin contract registries before the first step runs.
- 📌 **Lock Verification**: When a `rawbox.lock` is present, every declared plugin's contract-registry hash is checked and a mismatch is a hard error naming the package.
- 🚀 **Result-Oriented (Neverthrow)**: Actors return `Result<T, E>` rather than throwing, so failures are routed, not crashed.
- 📡 **One Event Stream, N Sinks**: A typed run-event stream (§4) feeds the NDJSON logs, the terminal renderer and an optional OpenTelemetry bridge (§6) — spans, log records and two metrics from `@opentelemetry/api` alone, with no SDK dependency.

---

## Architectural Workflow

```mermaid
graph TD
    Start([Start]) --> Preflight[Preflight: validate, load plugins, resolve]
    Preflight -->|Success| SelectStep{Select Step}
    Preflight -->|Failure| Fail[Exit with Error]

    SelectStep -->|Has Next Step| SyncDB[Sync Input/Output Boxes]
    SelectStep -->|No More Steps / __EXIT__| Success[Exit Cleanly]
    SelectStep -->|__FAIL__| Fail

    SyncDB --> RunStep[Run Step Handler]
    RunStep -->|Success| SelectStep
    RunStep -->|Failure| Fail
```

### Orchestration Steps

1. **Preflight**: Validates the workspace and workflow documents, imports every declared
   plugin's contract registry, then resolves the document into the runtime model.
2. **Select Step**: Determines the next step from the step list or from the label a
   control-flow step returned.
3. **Sync DB**: Reads the step's input boxes out of LMDB into a record.
4. **Run Step**: Loads the addressed definition from the registry cache and executes its
   validated handler.
5. **Exit**: Persists terminal logs and tears down resources.

> [!IMPORTANT]
> The order is load-bearing: resolution turns `plugin:` into a `contractRegistryHash`, so
> plugin registries must be loaded **before** the document can be resolved.

---

## 1. Workspace Configuration

A workspace is the runtime context a set of workflows executes in. `kind:` is required —
it is the only thing tooling matches on when walking up from a workflow to find its
workspace.

```yaml
kind: Workspace
name: data-processing-workspace
# Optional. Where `workspace setup` installs plugins and where a run resolves
# them from, relative to this file. Defaults to <this directory>/.rawbox.
# targetFolder: ./target
workflowPathList:
  - ./workflows/throttle-ops.workflow.yaml
backends:                                     # optional — §1.3
  main:
    connection: redis://cache.internal:6379/${REDIS_PASSWORD}
seedOverrides:                                # optional — §1.4
  ./workflows/throttle-ops.workflow.yaml:     # the entry workflowPathList holds
    throttle_ms: 250
logs:                                         # optional — §1.5
  rotate: { maxBytes: 134217728, maxFiles: 8 }
  prune: { keep: 50, olderThanDays: 14 }
```

The document is **closed**: an unrecognised top-level field is an error, and a Workspace
carries no `formatVersion` — `kind:` identifies it. `backends:`, `seedOverrides:` and
`logs:` do not change that; only the *keys* of the first two maps are the author's own —
`logs:` is closed all the way down, so a misspelt `maxfiles` is reported rather than
ignored.

The install/resolution folder is picked by `resolveTargetFolder`, highest precedence first:
the `target-folder` CLI argument, then `targetFolder:` in this document (resolved against
the workspace directory), then `<workspace directory>/.rawbox` — a gitignored, machine-owned
folder that also holds the LMDB data directory the runner writes to. It is safe to delete:
`workspace setup` and a run's auto-setup regenerate it. `rawbox.lock` deliberately stays
outside it, next to `workspace.yaml`, because it is committed rather than ephemeral.

### 1.1. Implicit (workspace-less) workspaces

A workspace document on disk is not required to run a single workflow one-off
(the `ansible-playbook -i localhost,` equivalent).
The CLI's `run`/`workflow run`/`workflow verify` all accept `--workspace-name <name>`
instead of `--workspace <file>` or discovery:

```bash
npx rawbox-cli run workflows/one-off.workflow.yaml --workspace-name scratch
```

This synthesizes an **in-memory `Workspace`** — `name: <name>`, `workflowPathList: [that one
workflow]`, no `targetFolder:` — instead of reading or writing a document. Nothing is ever
written to disk as `workspace.yaml`. Because no `targetFolder:` is ever set, `.rawbox/` lands
under the *workflow's own directory* rather than a discovered workspace's: the workflow's
directory stands in as "the workspace directory" for every purpose that word has elsewhere in
this package (plugin resolution base, `rawbox.lock` location, the `.rawbox/` root).

**State-sharing semantics — read this before reaching for it in place of a real workspace.**
The LMDB store is still scoped `workspace/workflow/key`, and the workspace's name is exactly
what `BoxStoreLmdb.create(workspace.name, …)` keys its environment by
(`<target folder>/data/<name>/`). So:

- Two scratch runs passing the **same** `--workspace-name` **share** that environment — a
  second run against the same name sees whatever the first left behind, the same as re-running
  against a real, persisted workspace would.
- Two scratch runs passing **different** names are fully isolated from each other, each with
  its own environment.

There are deliberately **no guardrails** here beyond that: the storage budget is informational
everywhere in this package (see
[rawbox-store README §1.D](../rawbox-store/README.md#d-the-storage-budget)), and a scratch
run does not get a special exception that gates writes on it. What
ships instead is a printed notice on every scratch run —
`state persisted under workspace "<name>" — reruns with the same name share it.` — plus a
`--fresh` convenience flag that deletes the named environment (precisely
`<target folder>/data/<name>/`, nothing else under `data/`) before the run starts, for when
"share it" is not what was wanted this time.

### 1.2. The `WorkspaceSource` seam

`runWorkflowInstance`'s first parameter accepts either shape — see §5.1:

```typescript
type WorkspaceSource = string | { workspace: Workspace; dir: string };
```

A `string` is the on-disk path, read and schema-validated exactly as it always was. The object
form is what `--workspace-name` uses: an **already-validated** in-memory `Workspace`, paired
with the directory that stands in for the workspace directory. Nothing on this branch touches
disk for the workspace document itself. A caller building one is responsible for constructing
a `Workspace` that already satisfies the schema — `runWorkflowInstance` does not validate it a
second time on this path, the way it does for the string path.

### 1.3. `backends` — where a strategy's store lives

Some strategies hold their data somewhere this process does not own. `backends:` maps a
**backend id** to a connection descriptor, and a strategy names one with its own `backend:`
field (§2). The map is optional and absent from every workspace whose workflows are LMDB-only;
the LMDB environment is not an entry here and never will be, its location being derived from
`targetFolder`.

```yaml
backends:
  main:
    connection: redis://cache.internal:6379/0
  session:
    connection: rediss://app:${SESSION_REDIS_PASSWORD}@sessions.internal:6380/1
```

`connection` is the only field. **Credentials come from the environment, not from this
document**, which is committed: any `${VARIABLE}` is substituted from the process environment
at verify time and at run time by `resolveBackendConnection`. The reference form is `${NAME}`
and only that — a bare `$NAME` is a literal, because a URL password may legitimately contain a
`$` and `redis://u:pa$$w0rd@h:6379` would otherwise resolve in the dangerous direction.

Two things are errors rather than fallbacks, both at verify time:

| Problem | Why it is not tolerated |
| --- | --- |
| An **unset or empty** variable (`collectBackendEnvProblems`) — names the variable and the backend id | `redis://:@localhost:6379` is a syntactically valid URL, so an empty expansion opens a connection to the wrong server with no error anywhere. A store that answers the wrong questions is worse than one that will not open. |
| An **id naming no entry** (`collectUnknownBackendProblems`) — names the id and lists the ids that exist | A mistyped id is caught here, before anything runs; a mistyped hostname is caught by a connection timeout, if at all. This is the whole reason `backend:` is an id and not a connection string. |

**Which command checks what follows from which document is being verified.**
`workspace verify` checks **every** declared backend, referenced or not — that document is
what it is verifying. `workflow verify` checks only the ids *that workflow* references, so a
workflow touching none of them does not fail because a colleague's `prod` password is not on
this machine.

### 1.4. `seedOverrides` — what a workflow's keys start with here

A workflow declares what its keys start with (§2). `seedOverrides:` is how the workspace
running it says those values are different **here** — this deployment, this checkout — without
editing the workflow document.

```yaml
workflowPathList:
  - ./workflows/my-flow.yaml
seedOverrides:
  ./workflows/my-flow.yaml:     # the workflow's PATH, not the `name:` inside it
    sleep_ms: 500
    queue_items: [a, b]
```

**Nested, and keyed by path.** Nested because `sleep_ms` in two workflows is two boxes, so a
flat map would hit both. Keyed by path because `workflowPathList` — in the same file — is what
makes the reference checkable; a `name:` lives in a different file, so "does this block name a
workflow that exists" would be answerable only by a command holding every workflow document.
Paths are compared **resolved** against the workspace directory (`workflow-path.ts`), so
`./workflows/a.yaml` and `workflows/./a.yaml` are one workflow; two keys resolving to the same
path are rejected rather than one being silently dropped. Note the deliberate asymmetry with
`storage.keys.<key>.workflow` (§2.3), which holds a *name*: each document refers to a workflow
by the identifier it can check for itself.

**One invariant governs the rest: an override can never change where a key lives or what an
operation on it means — only what it starts with.** `seed:` is the one overridable fact;
`name` (the strategy), `valueSizeMax`, `queueSizeMax`, `workflow` and `backend` are all
excluded. `backend` in particular is excluded because it is the one that could change *which
store* a key resolves to, letting a workspace break the one-store rule (§2.3) from outside the
document that has to satisfy it — and because a `backend:` names a role the `backends:` map
already binds, so dev-vs-prod needs no override at all. The field is named `seedOverrides`
rather than `overrides` for the same reason: the day somebody wants to override a strategy,
the field's own name is the argument against it.

Three rules, all checked before a run starts, all refusals rather than warnings
(`applySeedOverrides`):

1. **An override MUST only replace a seed the workflow already declares.** Not tidiness:
   seeding is unconditional on every run, so an override on a deliberately unseeded key would
   not supply a starting value, it would **reset that key on every run**, destroying whatever a
   step accumulated in it, with nothing in the workflow document saying so. A key another
   workflow owns is refused twice over — it cannot carry a seed at all.
2. **A replacement replaces the whole value; it is never deep-merged.** A seed is arbitrary
   data, so a merge would have to tell structure from content. `{a: 1}` over `{a: 0, b: 2}`
   yields `{a: 1}`.
3. **Every replacement is re-validated against the strategy the workflow declares** — the same
   checks that workflow's own seed goes through (§2.3). This is well defined precisely because
   the strategy is not overridable: the value is the override's, every bound it is held to
   stays the workflow's.

The merged workflow is what every later stage reads, so seeds are type-checked against the
consuming field's `inputSchema` **after** merging — a run never checks one value and writes
another.

**`--seed key=<json>` is one more layer of exactly this**, supplied by `@rawbox/cli` on
`workflow run` and `workflow verify` and passed in as `runWorkflowInstance`'s
`seedOverrideLayerList`. Precedence is **`CLI > workspace > workflow`**, applied key by key: a
key only the workspace names keeps the workspace's value even when `--seed` names other keys.
Applied overrides are reported by **key and source layer, never by value**
(`summarizeAppliedSeedOverrides`) — echoed before a run starts and emitted once into the event
stream as `seed.override.applied` (§4). The value is deliberately absent: a run log is a file
routinely attached to bug reports, and a value typed on a command line is already in the
shell's history without also being persisted there.

A failure in any of this is a `bootstrap.error` of stage `seed-override`, distinct from
`workspace` because the failing layer may be the CLI's rather than the document's.

### 1.5. `logs` — how this deployment's run logs are written, rotated and pruned

A log bound is a property of the deployment, not of a workflow: the same workflow runs on a
laptop with a 500 MB budget and on a box that keeps a fortnight of history, and nothing about
its steps differs between them. So it is declared once on the workspace, exactly as
`backends:` and `seedOverrides:` are. The full grammar and every bound is in FORMAT.md,
"`logs`"; what matters here is what the runner does with it.

```yaml
logs:
  async: false                                # default — write each line before continuing
  steps: full                                 # default — every field of step.start/step.end
  rotate: { maxBytes: 134217728, maxFiles: 8 }  # default pair — 1 GiB per run
  prune: { keep: 50, olderThanDays: 14 }        # keep defaults to 20 with nothing set
```

- **`async`** picks the file sink's writer mode. `false` (the default) writes each event
  before the run continues; `true` buffers. `run.end` is flushed synchronously either way.
  `@rawbox/cli` exposes the same knob as `--log-async` / `--no-log-async`.
- **`steps`** bounds how much of a `step.start`/`step.end` the **main** log keeps — `full`
  (the default), `summary` (drops `input`/`output`), or `off` (drops the two kinds outright).
  See §4.8. `@rawbox/cli` exposes the same knob as `--log-steps`.
- **`rotate`** bounds one run's log, which is a **sequence of segments** — see §4.7.
  Rotation is **on by default**; declaring one of `maxBytes`/`maxFiles` without the other is
  a verify-time error, since a stated number paired with a guessed one would silently decide
  how much of a run's history survives.
- **`prune`** is `runs prune`'s cross-run retention, applied by `@rawbox/cli`.

`resolveLogsConfig` is the one place these are decided, and it resolves **per field**:
**CLI override > `workspace.logs` > built-in default**. A workspace-less run (§1.1) simply
has no document to read, so every field falls straight through to the override or the
default. Consumers read a fully-populated `ResolvedLogsConfig` — there is no second `??`
anywhere that could drift from this one.

These bounds previously lived in an untyped `rawbox.config.json`, whose reader silently
dropped anything of the wrong type: `"maxBytes": "50mb"` was not an error, it was the
default and no diagnostic anywhere. That file is gone, and the `logs:` block is closed at
every level so a mistyped or misspelt bound is reported as the unknown property it is.

---

## 2. Workflow Definition

A workflow is a **format 1.0** document. Steps name a **package** and an **operation
path**; they never carry a registry hash. The hash lives in the generated `rawbox.lock`
(§3), which is why a contract change does not require rewriting workflows.

```yaml
kind: Workflow
formatVersion: "1.0"
name: throttle-ops
description: "Throttle a loop to a fixed rate."

# Package name -> npm dependency specifier, exactly the shape of `dependencies`
# in a package.json. A relative `file:` specifier resolves against the
# workspace directory, not against this file.
plugins:
  "@rawbox/rawbox-plugin-default": "^0.1.0"

# A strategy describes a box, so it is declared once per key and never repeated
# on a step. A key resolves as
#   keys[key].strategy ?? defaultStrategy
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:                                # the key table: one key's facts in one entry
    tick_queue:
      strategy: { name: lmdb-fifo, queueSizeMax: 1024, valueSizeMax: 1900 }
      seed: [first, second]            # a queue's seed is a list: one entry per element
    shared_state:
      workflow: other-flow             # another workflow's box — this one only reads it
    throttle_ms:
      seed: 500                        # a constant: declared as a key, bound by name

steps:
  - label: throttle-step
    plugin: "@rawbox/rawbox-plugin-default"
    operation: time/workflow-throttle    # -> ./time/workflow-throttle.definition.js
    inputs:
      ms: throttle_ms                    # short form: just the storage key
    outputs:
      throttledMs: throttle_result_throttled_ms
      timestamp: throttle_result_timestamp
    errors:
      message: throttle_error_message
```

**`storage.keys:` is the only way to declare a key.** An entry is
`{ strategy?, seed?, workflow? }`, every field optional, and an entry stating none of them
still *declares* the key — which then resolves to `defaultStrategy` like any other.
`resolveKeyTable` (`workflow/key-table.ts`) is the one place it is read, and every per-key
rule — the size checks, the resolver's `strategyFor`, the budget, the CLI's key report — is
expressed against its `ResolvedStorageKey` output rather than against the block.

Two earlier top-level maps, `strategies:` and `seed:`, stated the first two facts one map per
fact. Both have been **removed**: understanding one key meant reading two blocks, adding a key
meant editing two, and every reader had to merge them. The one thing the removal costs is the
bare constant, which was two lines and is now three — there is no scalar shorthand inside
`keys:` that recovers it, because `throttle_ms: 500` under `keys:` would have to mean "the
seed", which then makes `throttle_ms: { name: lmdb-kv }` ambiguous between a strategy block
and a literal object seed. `Storage` is a `StrictObject`, so the schema rejects either block —
but as "unknown property", which says nothing about the field having existed or having a
replacement. `formatVersion` did not move for the removal, so
`collectRemovedStorageBlockProblems` runs **before the schema** and answers each by name,
printing the `keys:` entries that replace it, built from the document's own keys and values.
`defaultStrategy` is unaffected — it is what a key with no `strategy:` resolves to, not a
shorthand for an entry.

`workflow:` was never expressible outside `keys:` and could not have been: a strategy block
has nowhere to put a fact that is not part of how a box stores, and widening `BoxStrategy`
would put a workflow name into `WriteBoxLocation`, the one shape that must stay incapable of
naming another workflow. **Ownership is a property of the key** (§2.3).

### 2.1. Binding Forms

| Role | Short form | Long form |
| --- | --- | --- |
| `inputs` | `ms: throttle_ms` | `ms: { key: throttle_ms, workflow: other-wf }` |
| `outputs` | `timestamp: ts_key` | `timestamp: { key: ts_key }` |
| `errors` | `message: err_key` | `message: { key: err_key }` |

A write binding has no `workflow:` field at all — that is how the "writes never leave their
own workflow" boundary is enforced structurally rather than by a runtime check. An input
may carry `workflow:`, which is the permitted cross-workflow read.

**Every binding names a storage key; none carries a value.** A constant is declared as a
`keys:` entry with a `seed:` and bound by key like any other input, so a handler's inputs
come from storage reads and from nothing else. A `{ value: … }` binding is rejected by
`validateWorkflowType`, with a diagnostic naming the step and field and showing the entry
plus binding that replace it. Seeds are type-checked against the consuming field's
`inputSchema` by `validateSeedData`, on the resolved model.

### 2.2. Control-Flow Steps

A step whose `operation:` starts with `control-flow/` is a control-flow step. It takes
`inputs:` and `errors:` but **never** `outputs:` — control-flow contracts declare no output
schema, and the schema rejects the field rather than letting it fail at runtime. The
resolver additionally cross-checks the prefix against the contract's real `type`.

Control-flow handlers return a jump target: a step's `label`, or one of the reserved labels
`__START__` (first step), `__END__` (last step), `__EXIT__` (terminate), `__FAIL__`
(terminate as a **failure**). See the built-ins in
[rawbox-plugin-default](../rawbox-plugin-default/README.md).

`__FAIL__` is the document's own way to end a run as a failure: the selector turns it into
the run's error — using the `reason` the handler returned beside it, or a default naming
the step — which is the same path a failed step actor takes, so the `run.end` reports
`outcome: "error"` and the CLI exits non-zero. The step that returned it is still reported
`ok`; what failed is the run (FORMAT.md, "`steps`").

### 2.3. Storage Rules a Schema Cannot Express

`validateWorkflowType` checks these alongside the schema, and reports all of them together
rather than one per run. Every one reaches **every key the workflow names** — every `keys:`
entry and every step binding — except another workflow's box, which is that workflow's to
check. That exemption is read off the **key**, not only off the binding: `keys.<key>.workflow`
says it once for every binding of that key, including a bare `inputs: { ms: shared_state }`
that carries no marker of its own.

| Rule | Diagnostic |
| --- | --- |
| A key is at most **79 bytes** (UTF-8, on the key as written) | Names the key, where it was named, its length and the limit. It is Rawbox's limit, not the backend's, and there is no setting to change. |
| A key matches **`[A-Za-z0-9_.-]+`** | Names the offending characters, rendered visibly so a space, tab or control character is not invisible. The empty key is reported as empty. |
| Neither **removed** `storage:` block appears — `strategies:`, `seed:` | Runs ahead of the schema, so the answer is the migration rather than "unknown property": names the block, says it was removed, and prints the `keys:` entries that replace it, built from the document's own keys and its own values. A key named in both is told, in each message, that it becomes one entry. |
| A key read by an `inputs:` binding is **written by something** — some step's `outputs:`/`errors:`, or its own entry's `seed:` | Offers both fixes, and quotes the runtime failure it prevents *verbatim from the key's own strategy* (`Value not found` for a cell, `Queue empty` for a queue — `StrategyDescriptor.emptyReadMessage`). A write by *any* step counts, whatever the order; merely declaring a key does not. |
| A seed for a key whose writes **append** is a list, each element one entry, at most the capacity **that strategy** declares | Names the key, the strategy and where it was declared, and shows the list that would be right. The capacity is not `queueSizeMax - 1` in general: it is that for `lmdb-fifo`, whose ring reserves a slot, and `queueSizeMax` exactly for `redis-fifo`, which reserves none — so the message explains a reserved slot only where there is one, and the ceiling it tells the author to raise to follows the same figure. |
| A seed fits its key's `valueSizeMax` and msgpack can encode it | Names the value's document path and the declaration that bounds it; for a queue seed, the offending **element**. |
| A key declaring `workflow:` is **not written and not seeded**, and does not name its own workflow | `collectStorageOwnershipProblems`. A write binding has no `workflow` field at all, so resolved, `outputs: { result: shared_state }` would silently become a *second* box of that name in this workflow. A seed would create the same second box. Naming one's own workflow is an error rather than a no-op, so that "declares `workflow:`" and "is another workflow's" stay the same question. |
| A `{ key, workflow }` binding and a key table entry for that key **agree** | Disagreement is rejected, naming both sites; agreement is a legal restatement. The binding long form is **not** deprecated: it is the only way to read `metrics` from two genuinely different workflows in one document. |
| Every key resolves to **one store** | `collectStoreSplitProblems`, over `StrategyDescriptor.storeIdentity`. One step's outputs are written and the next step's inputs read in a *single* transaction, and no transaction spans two stores. "One store" is the concrete store, never the kind: the two LMDB strategies are one environment, while two `redis-*` keys are one store only when their `backend:` ids match. Another workflow's keys are excluded — its box is its own to store. |
| No field is unrecognised, anywhere | Every object schema in the format is built with `StrictObject`, so `additionalProperties` is `false` throughout. A stray field on a `strategy` is answered by naming the strategy that does take it. |

Both storage-budget figures — `dataBytesMax` and `recommendedVolumeBytes` — are computed
from the document alone and **reported, never enforced**; `collectBoundStorageKeys` supplies
the step-bound keys that `@rawbox/store` cannot walk to itself, and `boxStorageFor`
(`workflow/key-table.ts`) supplies the declared ones — **every** budget call site must route
through it, because an authoring `storage:` block still type-checks as a `BoxStorage` and
charges nothing
([rawbox-store README §1.D](../rawbox-store/README.md#d-the-storage-budget)). A strategy that
declares no byte model — both Redis ones — has its keys **named and excluded** from the
totals rather than charged `0`.

> [!IMPORTANT]
> **A verifying document is not necessarily a runnable one, and that gap is checked on the run
> path.** `redis-kv` and `redis-fifo` are valid strategies: the schema accepts them, the seed
> rules check them, the budget reports what it can, and `workflow verify` passes. What this
> package does not yet do is *construct* a Redis store — `runWorkflowInstance` builds a
> `BoxStoreLmdb` and nothing else — so a run declaring one is refused at bootstrap, before the
> environment is opened and before any seed is written (`workflow/store-support.ts`). The
> refusal names the strategy and the declaration site, states that nothing was written and
> nothing fell back to another strategy, and lists the strategies this version does
> implement — a silent fallback to LMDB would put a workflow's data somewhere its author
> did not ask for.
>
> The list of unwired strategies is **derived** (`UNWIRED_STRATEGY_NAME_LIST`, every union
> member minus the hand-kept wired list), so it empties itself the day a store is wired, and a
> newly wired store missing from the hand-kept half fails closed — refusing loudly — rather
> than passing silently. Verification is deliberately *not* made to reject these documents:
> they become runnable with no change to the file.

---

## 3. `rawbox.lock`

`npx rawbox-cli workflow lock <workflow>` resolves every declared package and writes
`rawbox.lock` next to `workspace.yaml`. It is keyed by package name at the **workspace**
level, so workflows sharing a plugin share one entry, and the workflow file is never
modified.

```yaml
version: "1"
plugins:
  "@rawbox/rawbox-plugin-default":
    resolved: "0.1.0"
    registryHash: "92837f61c312…"
```

An absent lock means "resolve whatever is installed". A present entry is enforced at load:
a hash mismatch fails the run, naming the package and telling you to re-lock.

---

## 4. The Run-Event Stream

A run emits one **typed event stream**, and every observer reads the same stream:
the NDJSON log files, `@rawbox/cli`'s terminal renderer, and the OpenTelemetry
bridge of §6. One producer, N sinks. The normative definition is the module doc of
[`src/events/event-types.ts`](src/events/event-types.ts); this section is the tour.

Every line of a log file is one event, sharing one envelope:

```jsonc
{"ts":"2026-08-09T10:11:12.345Z","run_id":"run-…","workspace":"my-workspace","workflow":"example","event":"run.start","format":1}
{"ts":"…","run_id":"…","workspace":"…","workflow":"…","event":"storage.seed","seed_count":2,"key_count":2,"keys":["sleep_ms","halt_reason"],"duration_ms":1}
{"ts":"…","run_id":"…","workspace":"…","workflow":"…","event":"step.start","step":{"index":0,"iteration":0,"label":"sleep-step","plugin":"@rawbox/rawbox-plugin-default","operation":"time/sleep","registry_hash":"92837f…"},"input":{"ms":500}}
{"ts":"…","run_id":"…","workspace":"…","workflow":"…","event":"step.end","step":{"index":0,"iteration":0,…},"outcome":"ok","duration_ms":502,"output":{"timestamp":1786294175846}}
{"ts":"…","run_id":"…","workspace":"…","workflow":"…","event":"run.end","outcome":"ok","duration_ms":812,"steps_total":2,"steps_failed":0}
```

| `event` | Payload | Notes |
| --- | --- | --- |
| `run.start` | `format: 1` | First event of every run that got as far as knowing what it runs. |
| `run.end` | `outcome`, `duration_ms`, `steps_total`, `steps_failed`, `timed_out?`, `timeout_ms?`, `error?`, `severity?` | Last event, on success and failure alike. `outcome` is `ok \| error \| interrupted` — `interrupted` is a graceful operator stop, and is never a `step.end` outcome. `steps_total` counts step *executions*. `timed_out`/`timeout_ms` mean a runner bound ended the run — a bounded step's, or the preflight one of §4.6. |
| `step.start` | `step`, `input?` | Opens the step's span. |
| `step.end` | `step`, `outcome`, `duration_ms`, `output?`, `error?`, `severity?` | `error` is the contract's own error record. |
| `seed.override.applied` | `overrides` | Once, right after `run.start`, and **only** when a workspace `seedOverrides:` block or a `--seed` flag replaced a seed (§1.4). Each entry carries the storage `key` and the `source` layer that supplied it — **never the value**. |
| `storage.seed` | `seed_count`, `key_count`, `keys`, `duration_ms` | One summary event: seeding is one transaction, and a FIFO seed expands to many writes of one key. |
| `bootstrap.error` | `stage`, `message`, `severity` | A preflight stage failed; the machine never started. Replaces the old `[Bootstrap Error]` strings. |
| `log` | `level`, `message`, `data?`, `step?`, `severity?` | A line the workflow author asked for, via `observability/log`. |
| `run.heartbeat` | `step`, `in_flight_ms` | Emitted on an interval while a step is in flight — see §4.3. |
| `step.progress` | `message?`, `data?`, `step?` | Opt-in mid-step progress, via the same channel as `log` — see §4.4. |
| `log.rotate` | `sealed_segment`, `live_segment`, `deleted_segment?`, `max_bytes`, `max_files`, `severity?` | The **main** log crossed a segment boundary, and this is the new segment's first line — see §4.7. |

Three properties are load-bearing:

- **`run_id` correlates the run.** It is on every event and is what an OTel trace
  is keyed by.
- **`(run_id, step.index, step.iteration)` identifies one step execution.**
  `iteration` counts executions of that step index from `0`, so the repeated
  sibling spans a `loop-gate` produces stay distinguishable under one label.
- **`format: 1`** on `run.start` declares the schema, mirroring the workflow
  document's own `formatVersion` discipline.

`workspace` and `workflow` are on every event except a `bootstrap.error` raised
while loading the very documents that name them.

**`severity`** (`"warn" | "error"`, optional) is an alarm classification,
present only on the kinds that warrant it:
`bootstrap.error` always carries `severity: "error"`; an error-outcome
`step.end`/`run.end` carries `severity: "error"`; a `log` event inherits its
level (`error` → `"error"`, `warn` → `"warn"`, `info`/`debug` → absent); a
`log.rotate` carries `severity: "warn"` **exactly when it carries
`deleted_segment`** — a routine roll is not an alarm, a roll that destroyed
history is. `run.heartbeat` and `step.progress` never carry one — neither is
ever an alarm. An **interrupted** `run.end` never carries one either — an operator
stop is intent, not an alarm. `@rawbox/cli`'s `--output quiet` and the OTel
bridge's log-record severity are both driven by this one field (§4.5, §6.2).

**Graceful shutdown.** `runWorkflowInstance` takes an optional `AbortSignal`
(`options.signal`). Aborting it while a run is live starts no new step,
abandons any step handler still in flight (its promise is dropped — no
`step.end` is written for it, and the run does not wait on it), and concludes
the run promptly with a `run.end` of `outcome: "interrupted"` as the stream's
final event, followed by the normal sink flush/close. The result is an ok
`Result` carrying `{ outcome: "interrupted" }` — the run did what it was told.
`@rawbox/cli` wires SIGTERM/SIGINT to this seam, so an operator stopping a
long-looping workflow leaves an honest record instead of a truncated stream —
and an `interrupted` status in the run registry ([rawbox-cli README
§1.4](../rawbox-cli/README.md#14-observability-the-run-registry-runs)).

**Versioning is additive-only, and this is a normative rule, not a
convention:** `run.heartbeat`, `step.progress` and `severity` shipped under
`format: 1` — a new kind and a new optional envelope field are exactly what
`format: 1`'s own discipline permits without a bump. The corollary binds every
reader, not just this package's own: **a reader MUST ignore an event kind it
does not recognise and an envelope field it does not know**, the same posture
`@rawbox/cli`'s log-merge, log-summary and terminal-sink already take (they
parse event-shaped JSON generically rather than against a closed schema). A
stream from a newer runner therefore never breaks an older reader, and an
older stream (no `severity`, no `run.heartbeat`) renders in a newer reader
exactly as it always did. A `format` bump is reserved for a change that would
make an existing reader's *interpretation* of a field wrong — nothing here
does that.

### 4.1. Sinks

```typescript
import { runWorkflowInstance, MemoryRunEventSink, type RunEventSink } from '@rawbox/runner';

const collector = new MemoryRunEventSink();

await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
  sinkList: [collector],
});

console.log(collector.ofKind('step.end').map((event) => event.duration_ms));
```

A sink is `{ emit(event): void; flush?(): Promise<void>; close?(): Promise<void> }`.
`emit` is synchronous and must not throw — a sink needing I/O buffers there and
drains in `flush`. After the run's last event the runner awaits `flush()` then
`close()` on each sink, exactly once; both are best-effort, and a sink that
throws is reported and isolated so it cannot cost you the other sinks or the
run's result.

The NDJSON file sink built from the two log paths is always registered first, so
`sinkList` adds observers rather than replacing the files. The error log is a
**filtered view of the same schema** — every `bootstrap.error` and every
`outcome: "error"` event — never a third format.

That file sink implements `flush` and `close` like any other, in **both** writer
modes. Buffered (`logs.async: true`) it has bytes to drain; synchronous it has
none — but it holds an open file descriptor per live segment either way, and a
descriptor is a thing to release, so an embedder that skips the runner's own
flush/close (or calls `process.exit()` ahead of them) is leaving a handle open
and, in buffered mode, the tail of the stream unwritten.

### 4.2. Where workflow-authored `log` lines come from

`observability/log` in `@rawbox/rawbox-plugin-default` does not write to
`console` when it has a host. It calls `emitRunEvent({ event: 'log', … })` from
`@rawbox/plugin`, which hands the payload to whatever channel the host installed
— an ambient, process-wide slot addressed by a `Symbol.for` key, so a plugin
resolved from a workspace's `.rawbox/node_modules` reaches the same slot as the
runner. `runWorkflowInstance` installs a channel for the duration of a run and
removes it afterwards.

The runner recognises **the event kind it owns** (`log`), never the plugin that
sent it: any definition of any package may emit that kind and be routed
identically, and kinds the runner does not own are dropped. With no host
installed — a unit test, a different embedder — the operation falls back to
`console.<level>` so the line is never simply lost.

### 4.3. `run.heartbeat` — blocked vs. dead

A workflow blocked in a long step — a websocket feed waiting for a tick — emits
nothing for minutes, which looks identical to a hung process from outside. The
producer closes that gap on its own: while a step is in flight it emits
`run.heartbeat` on a configurable interval, carrying the same `step` shape
`step.start` does and `in_flight_ms` — wall-clock time since that step began.

```typescript
await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
  heartbeatMs: 15_000, // default ~10s; 0 disables heartbeats entirely
});
```

`@rawbox-cli`'s `workflow run` exposes the same knob as `--heartbeat <ms>`. The
timer is `unref()`d, so it can never keep a process alive on its own, and it is
started and stopped in lockstep with the step it describes: it cannot fire
between steps or after `run.end`. It rides the normal sink fan-out like
everything else — the file log, the terminal renderer (an ephemeral, dimmed
line in `pretty` mode), and the OTel bridge (a span event on the step's own
span) all get it for free. It never carries `severity`: a heartbeat is
evidence of life, not an alarm.

### 4.4. `step.progress` — opt-in mid-step progress

An operation with real work to report partway through a long step — "4200 of
10000 processed" — can say so through the same ambient channel `log` uses,
without inventing a side channel of its own:

```typescript
import { emitRunEvent } from '@rawbox/plugin';

emitRunEvent({
  event: 'step.progress',
  message: 'processed 4200 of 10000 rows',
  data: { processed: 4200, total: 10000 },
});
```

The runner's channel host validates and stamps this exactly as it does `log`:
`message` is checked (a non-string one is dropped, an absent one is fine —
unlike `log`, a progress line may carry only `data`), and the envelope plus the
current step's correlation are stamped on the way in, so the caller never
constructs those fields itself. It is opt-in — nothing calls it unless an
operation chooses to — and, like `run.heartbeat`, it never carries `severity`:
progress is informational by definition.

### 4.5. Alarms — `severity` and `--output quiet`

The events that should page someone — a run ending in error, a bootstrap
failure, an `error`-level `log` — already existed and were already
distinguishable one kind at a time. `severity` (§4's table, above) is the
classification that lets a generic consumer agree on which those are without
re-deriving "is this bad" per kind: `@rawbox/cli`'s `--output quiet` shows
exactly the `RECAP` line plus every severity-bearing event, and §6.2 shows
the OTel bridge's mirror of the same field.

### 4.6. The preflight bound — a hang before the first step

§4.3's heartbeat only fires while a step is in flight, and there is one thing a
run does before it has any step: preflight imports every step's definition
module. A module that blocks at import — a top-level `await` that never settles,
a socket opened at evaluation — hangs there, emitting `run.start` and then
nothing at all: no heartbeat, no `step.start`, no `run.end`. A step's own
`timeoutMs` cannot cover it, because that bound is declared *inside* the
contract and the contract is unreadable until the module has loaded.

```typescript
await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
  preflightTimeoutMs: 120_000, // default 30_000; 0 disables the bound entirely
});
```

`@rawbox/cli`'s `workflow run` exposes it as `--preflight-timeout <ms>`. **It
defaults to a real bound where a step defaults to none**, and the asymmetry is
the design rather than an inconsistency: a step blocking for hours can be the
product working (a feed waiting for a tick), whereas evaluating a module is
defining a handler and compiling a schema — there is no legitimate plugin that
takes 30 seconds to *load*, so the default is a backstop against a hang, not a
budget. One deadline covers the whole pass rather than each step, since the loop
is sequential and the number an operator picks is a limit on preflight.

An expired bound ends the run the way any other preflight failure does — an
error `run.end`, no new event kind — with a message naming the step and the
definition path the preload was on, plus `timed_out`/`timeout_ms` on that event.
Those two fields are the only marker a preflight timeout has (no step ever
started, so there is no `step.end` to mark), and they are what tells "your plugin
hung at import" from "your plugin failed to import". The timer is deliberately
**not** `unref()`d, unlike the heartbeat's: a one-shot timer whose firing is what
concludes the run must not be conditional on something else keeping the loop
alive — and a hung module evaluation keeps nothing alive at all.

### 4.7. Segments — one run's log is a sequence of files

Both files the file sink writes **rotate**, each on its own bytes, under the
`logs.rotate:` bounds of §1.5. The path handed to `runWorkflowInstance` names
**segment 0**, which is also the **oldest**; successors are `<name>.1.ndjson`,
`<name>.2.ndjson`, … (and `<name>.error.1.ndjson`, … for the filtered log). The
path keeps its name for the life of the run, which is what lets the run registry
record it once.

Four properties are load-bearing, and every reader depends on them:

- **Numbering runs forward and nothing is ever renamed or truncated.** The
  alternative — logrotate's shift-everything-up-by-one — rewrites N files to
  retire one and breaks any reader holding a path, `workspace logs -f` among
  them. Here a segment is written once and is immutable the moment it is
  superseded.
- **A segment ends at a line boundary.** The bound is checked *between* events,
  so a segment may exceed `maxBytes` by the length of its last line and never
  splits one. A single event larger than `maxBytes` is written **whole**, into a
  segment of its own, rather than split or dropped.
- **A successor exists only once its predecessor is complete on disk.** That is
  what lets a reader conclude "segment N+1 exists, so segment N is final".
- **The oldest segment is deleted, never the live one.** `maxFiles: 1` therefore
  keeps the live segment alone, and a gap at the low end of a run's segments is
  an ordinary retained window rather than damage.

Rotation is **on by default** — 128 MiB × 8 segments, 1 GiB per run — so a
workspace declaring no `logs:` still rotates. There is no `enabled` flag on
purpose: a deployment wanting more history raises `maxFiles`, which states the
ceiling it wants rather than removing the concept of one. Only a file target
rotates; `--output ndjson`'s fd-1 stream is somebody else's stream, with no size
to bound and no successor to open.

Each roll of the **main** log emits a `log.rotate` event (§4's table) through the
normal producer, so every sink sees it — the file, the terminal renderer, the
OTel bridge — and it is by construction the **first line of the new segment**.
`deleted_segment` appears only when a segment was genuinely unlinked; a failed
retirement is reported on `console.error` and leaves the field absent rather than
claiming a removal that did not happen, and `severity: "warn"` tracks that field
exactly. The error log's own rolls are silent: it is a filtered *view* of the
main log, and it is the main log's segments that readers enumerate.

Everything about the sink stays **best-effort**: a failed write, a failed unlink
or an unwritable directory disables that file and reports once, and never fails
the run. Losing a log line must not change a run's outcome.

### 4.8. Step detail — `logsSteps`

`step.start`/`step.end` carry `input` and `output` — the records a workflow read and
produced — and those grow with whatever state the workflow accumulates. In a measured
workspace of four looping workflows they were **91% of all log bytes**, one payload growing
from ~1 KB to ~120 KB as a retention window filled. Rotation (§4.7) bounds that only by
deleting: at the default pair a workflow writing at that rate loses its history to
`maxFiles` in hours. `options.logsSteps` — `logs.steps:` in the workspace document,
`--log-steps` on the CLI — is the dial that keeps the day instead.

```typescript
await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
  logsSteps: 'summary', // 'full' (default) | 'summary' | 'off'
});
```

- **`full`** (default) — every field, unchanged from before this option existed.
- **`summary`** — `step.start`/`step.end` reach the main log with `input`/`output` omitted;
  `step`, `outcome`, `duration_ms`, `error` and the rest of the envelope are kept.
- **`off`** — `step.start`/`step.end` do not reach the main log at all.

Reaches the file sink's **main route only**. The error log keeps full `input`/`output` on a
failed step under every value — losing the record of a *successful* step is the trade this
option offers, losing the diagnostics for the step that actually failed is not. `run.end`'s
`steps_total`/`steps_failed` are unaffected, so a run's step counts stay correct even under
`off`. The caller's own sinks (`options.sinkList` — a terminal renderer, the OTel bridge)
never see this at all: they observe the producer's events, which are unchanged, which is why
`-v`/`-vv` on `@rawbox/cli` keep printing `input`/`output` regardless of this setting — that
is a different axis, what is *rendered*, not what the *stream* contains.

**Resolved by the caller**, for the same reason `logsAsync`/`logsRotate` are (§4.7): the sink
must exist before the workspace document is read, since a `bootstrap.error` about that
document is itself an event the sink has to write. `full` costs no extra encoding work; `off`
skips encoding the payload it would otherwise have to throw away.

---

## 5. Programmatic API

Everything below is exported from the package root.

### 5.1. Running

```typescript
import { runWorkflowInstance, createRunId } from '@rawbox/runner';

const result = await runWorkflowInstance(
  './workspaces/live/workspace.yaml',
  './workspaces/live/workflows/throttle-ops.workflow.yaml',
  './run-logs.txt',
  './run-errors.txt', // optional; defaults to a path derived from the log file
);

if (result.isErr()) {
  console.error(result.error);
}
```

`runWorkflowInstance` takes explicit log paths — it is the low-level seam, with no
opinion on where files live. Each path names **segment 0** of its sequence: the run
rotates under `logs.rotate:` (§1.5, §4.7) and may leave `<name>.1.ndjson` and up
beside it, so an embedder reading a run's stream back must enumerate segments rather
than open the path it passed in. The CLI's
`.rawbox/logs/<workflow name>/<run-id>.ndjson`
default is built one layer up: generate the run id with `createRunId()` *before*
constructing the paths, then pass it back in as `options.runId` so the filename
and every event's `run_id` name the same run:

```typescript
const runId = createRunId();
await runWorkflowInstance(
  workspacePath,
  workflowPath,
  `.rawbox/logs/example/${runId}.ndjson`,
  `.rawbox/logs/example/${runId}.error.ndjson`,
  { runId },
);
```

`options.seedOverrideLayerList` is the embedder's half of §1.4: extra layers appended
**after** the workspace's own block, so one of them wins any key the workspace also names.
It is not selected by workflow path the way a `seedOverrides:` block is — a layer supplied
here is already scoped to the one workflow this call runs. `@rawbox/cli`'s `--seed` builds
exactly one such layer.

The first parameter is a `WorkspaceSource` (§1.2): a path, as above, or an
already-validated in-memory workspace for a workspace-less run (§1.1) — this is the same
seam `--workspace-name` calls into:

```typescript
await runWorkflowInstance(
  {
    workspace: { kind: 'Workspace', name: 'scratch', workflowPathList: [workflowPath] },
    dir: path.dirname(workflowPath),
  },
  workflowPath,
  './run-logs.ndjson',
);
```

### 5.2. Validation

```typescript
import {
  validateWorkflowType,
  validateResolvedWorkflow,
  validateStorageBoundaries,
  validateSeedData,
} from '@rawbox/runner';

// 1. Authoring model: identity (`kind`, `formatVersion`), then the TypeBox schema,
//    then the `storage:` rules the schema cannot express — every key's length and
//    character set, every seed's size and shape against the strategy its key
//    resolves to, and every `inputs:` binding reading a key nothing ever writes.
//    A file with no `kind:` is rejected by name, not as a wall of missing fields.
const typeResult = validateWorkflowType(workflowDocument, './example.workflow.yaml');

// 2. Resolved model: the shape the machine layer consumes.
const resolvedResult = validateResolvedWorkflow(resolvedWorkflow);

// 3. Storage boundaries, checked on the *resolved* model — the layer where the
//    authoring schema's `additionalProperties: false` no longer applies.
const boundaryResult = validateStorageBoundaries(resolvedWorkflow, 'live-trading');

// 4. Seeds type-check against the `inputSchema` of every step that consumes them.
const seedResult = validateSeedData(resolvedWorkflow, contractRegistryCache);
```

Each returns `Result<void, Error>`.

### 5.3. Resolution

`resolveWorkflow` is pure — it reads no files, and the caller supplies the lock. It reports
every problem it finds rather than the first, because these documents are typically authored
by agents iterating against `workflow verify`.

```typescript
import { resolveWorkflow } from '@rawbox/runner';

const resolved = resolveWorkflow(
  authoredWorkflow,      // schema-valid `Workflow`
  registryCache,         // ContractRegistryCache, already populated
  registryHashByPlugin,  // package name -> contract-registry hash
  lock,                  // optional RawboxLock to verify against
);
```

### 5.4. Other Exports

| Export | Purpose |
| --- | --- |
| `setupWorkspace`, `loadAndValidateWorkspace`, `loadAndValidateWorkflows` | Workspace setup: splice every workflow's `plugins:` into a generated `package.json` and install. |
| `resolveTargetFolder`, `RAWBOX_DOT_FOLDER`, `workspaceKindError` | Workspace document helpers. |
| `lockWorkspacePlugins`, `readRawboxLock`, `writeRawboxLock`, `verifyRawboxLock`, `rawboxLockPath` | Lock file lifecycle. |
| `PluginDiscoverer`, `loadPluginContractRegistry`, `contractRegistrySpecifier` | Plugin discovery and registry import. |
| `createWorkflowMachine`, `machineSetup` | The XState machine, for embedding the runner directly. |
| `collectStorageBindingList`, `collectBoundStorageKeyList`, `collectBoundStorageKeys` | The one traversal behind both the storage-key rules (§2.3) and the budget's key sweep. |
| `resolveKeyTable`, `boxStorageFor` | The one reading of `storage.keys` into one resolved entry per key (§2), and the seam that hands those entries to `@rawbox/store`'s budget in the shape it sums. |
| `resolveBackendConnection`, `collectBackendEnvProblems`, `collectUnknownBackendProblems`, `collectBackendReferenceList`, `BackendMap` | The `backends:` map (§1.3): id → connection, its `${VARIABLE}` interpolation, and the two verify-time diagnostics. |
| `applySeedOverrides`, `seedOverrideLayerFor`, `summarizeAppliedSeedOverrides`, `collectSeedOverridePathProblems`, `SeedOverrideLayer`, `SeedOverrideMap` | The `seedOverrides:`/`--seed` layers (§1.4): the merge, its diagnostics, and the key-plus-source summary that is echoed and logged. |
| `createOtelSink`, `OTEL_ATTRIBUTE`, `OTEL_METRIC`, `RUN_SPAN_NAME` | The OpenTelemetry bridge (§6) and the `rawbox.*` names it writes. |
| `parseConfig` | YAML/JSON document parsing (returns `any`; validate the result). |
| `Workflow`, `Workspace`, `Step`, `ResolvedWorkflow`, `ResolvedStep`, `RawboxLock`, `DOCUMENT_KIND`, `FORMAT_VERSION` | Schemas and constants. |
| `WorkspaceSource`, `setupNpmPackage` | Workspace-less ("scratch") runs (§1.1): the `runWorkflowInstance` seam, and the bare install step `setupWorkspace` composes from — useful directly when the caller has a single workflow's `plugins:` map rather than a workspace document to merge. |

---

## 6. OpenTelemetry

The run-event stream has a third consumer: an OpenTelemetry bridge that turns
the same events into spans, log records and two metrics. It lives in
[`src/events/otel-sink.ts`](src/events/otel-sink.ts) and is **API-only** — this
package depends on `@opentelemetry/api` and `@opentelemetry/api-logs`, never on
an SDK. Both are no-ops until something registers a provider, so a user who
never turns telemetry on pays for two small dependency trees and a handful of
calls into no-op objects.

### 6.1. Turning it on

The SDK wiring lives in `@rawbox/cli`, and nothing OTel-shaped is loaded until
it activates:

```bash
# Explicit: exports to the OTLP default, http://localhost:4318
npx rawbox-cli run workflows/example.workflow.yaml --otel

# Implicit: an endpoint in the environment is enough, no flag needed
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
npx rawbox-cli run workflows/example.workflow.yaml

# Opt back out on a machine that has the env vars set
npx rawbox-cli run workflows/example.workflow.yaml --no-otel
```

| `--otel` | `OTEL_EXPORTER_OTLP_ENDPOINT` or `…_TRACES_ENDPOINT` | Result |
| --- | --- | --- |
| `--otel` | anything | Exports. |
| `--no-otel` | anything | Does not export — an explicit opt-out beats an inherited environment. |
| *(omitted)* | set | Exports. |
| *(omitted)* | unset | Does not export, and no SDK package is even imported. |

Everything else is configured through the **standard `OTEL_*` environment
variables**, which the exporters and the SDK read for themselves — endpoints,
`OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_TIMEOUT`, `OTEL_SERVICE_NAME`,
`OTEL_TRACES_SAMPLER`, `OTEL_RESOURCE_ATTRIBUTES`. No rawbox-specific knob is
invented, so this composes with whatever you already run: point it at a local
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/), at
[Jaeger](https://www.jaegertracing.io/docs/latest/getting-started/)'s built-in
OTLP receiver, at [Grafana Tempo](https://grafana.com/docs/tempo/latest/), or at
a vendor endpoint, by following that project's own OTLP quickstart. The exporter
speaks OTLP over HTTP.

Embedding the runner directly? Register the sink yourself — it is a
`RunEventSink` like any other, and safe to register unconditionally:

```typescript
import { runWorkflowInstance, createOtelSink } from '@rawbox/runner';

await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath, {
  sinkList: [createOtelSink()],
});
```

With no SDK registered every call inside it lands on a no-op span, a no-op
logger and a no-op instrument. `createOtelSink({ tracer, logger, meter })`
overrides the API globals when you have providers of your own.

### 6.2. The mapping

| Event | OTel |
| --- | --- |
| `run.start` | Root span `rawbox.workflow.run` opens — one trace per run |
| `run.end` | Root span closes; status `OK`/`ERROR` from `outcome` — an `interrupted` run leaves the status UNSET (neither would be honest) |
| `step.start` | Child span opens, named by the step's `label:` (or `step-<index>`) |
| `step.end` | That child closes; status from `outcome` |
| `storage.seed` | Span event `storage.seed` on the root span |
| `bootstrap.error` | Exception event on the root span — or a log record, when the failure predates `run.start` and no root span exists |
| `log` | Log record, correlated to the span of the step in flight |
| `run.heartbeat` | Span event `run.heartbeat` on the in-flight step's span |
| `step.progress` | Span event `step.progress` on the in-flight step's span |
| `log.rotate` | Span event `log.rotate` on the root span, carrying the `rawbox.log_rotate.*` attributes |

A `step.start`/`step.end` pair is matched on `(run_id, step.index,
step.iteration)`, the same triple that identifies a step execution in the NDJSON
file. **Spans carry the events' own `ts` as explicit start/end times**, so a step
whose log line says 502 ms shows 502 ms in the trace no matter how long the
exporter or the terminal renderer sat in between.

**`severity` drives log-record severity** (§4.5) wherever this bridge already
produces a log record — `bootstrap.error`'s pre-`run.start` case — rather than
a hardcoded literal, so the mapping is one small function fed by the field
instead of a second place a "what counts as an alarm" decision could drift
from the producer's own. It changes nothing about span *status*: a
severity-bearing `step.end`/`run.end` still only sets the span's status, exactly
as it did before `severity` existed — the field classifies for `--output
quiet` and alarms, it does not invent a second telemetry signal for a failure
that already has one.

### 6.3. The `rawbox.*` attribute namespace

There is no OTel semantic convention for workflow engines, so rawbox documents
a small, closed namespace — the move Temporal's and Airflow's integrations make.
Conventional attributes are used where they exist: `error.type` on a failing
span, and the `exception.*` set `recordException` writes. The names are exported
as `OTEL_ATTRIBUTE` so a query or a dashboard need not re-type them.

| Attribute | Type | Where | Meaning |
| --- | --- | --- | --- |
| `rawbox.run.id` | string | Root span, log records | The run's `run_id` — the same value on every NDJSON line. |
| `rawbox.workspace.name` | string | Root span, log records | Workspace name. |
| `rawbox.workflow.name` | string | Root span, log records, both metrics | Workflow name. |
| `rawbox.run.outcome` | `ok`/`error`/`interrupted` | Root span, `rawbox.run.count` | How the run ended. |
| `rawbox.run.steps.total` | int | Root span | Step *executions* the run performed. |
| `rawbox.run.steps.failed` | int | Root span | How many of those failed. |
| `rawbox.step.label` | string | Step span, log records, `rawbox.step.duration` | The authored `label:`, falling back to `step-<index>`. |
| `rawbox.step.index` | int | Step span, log records | Position in the workflow's `steps:` list. |
| `rawbox.step.iteration` | int | Step span, log records | Which execution of that index this is, from `0`. |
| `rawbox.step.outcome` | `ok`/`error` | Step span, `rawbox.step.duration` | How the step execution ended. |
| `rawbox.plugin.name` | string | Step span, log records | The authored `plugin:` — an npm package name. |
| `rawbox.operation.path` | string | Step span, log records | The authored `operation:` — e.g. `time/sleep`. |
| `rawbox.registry.hash` | string | Step span, log records | The resolved contract-registry hash the step was bound to. |
| `rawbox.bootstrap.stage` | string | Root span, log records | Which preflight stage a `bootstrap.error` failed in. |
| `rawbox.seed.count` / `rawbox.seed.key_count` / `rawbox.seed.keys` | int / int / string[] | `storage.seed` span event | Writes performed, distinct keys, and those keys. |
| `rawbox.seed_override.keys` / `rawbox.seed_override.sources` | string[] / string[] | `seed.override.applied` span event | Index-aligned: each replaced key and the layer that supplied it. No values, for the reason given in §1.4. |
| `rawbox.log_rotate.sealed_segment` / `.live_segment` / `.deleted_segment` / `.max_bytes` / `.max_files` | int | `log.rotate` span event | The segment just closed, the one now live, the one unlinked to honour `maxFiles` (**present only when one actually was**), and the bounds in force. |
| `rawbox.duration_ms` | int | Root span, step span, `storage.seed` event | The event's own `duration_ms`, mirrored. |
| `rawbox.error.record` | string (JSON) | Failing span | The contract's own error record, verbatim — its shape is the plugin's to declare. |
| `rawbox.log.level` / `rawbox.log.data` | string / string (JSON) | Log records | The workflow-authored `log` event's level and `data` payload. |
| `error.type` | string | Failing span | `rawbox.run.error`, `rawbox.step.error` or `rawbox.bootstrap.error`. |

Two metrics, and deliberately no more:

| Instrument | Kind | Unit | Attributes |
| --- | --- | --- | --- |
| `rawbox.step.duration` | Histogram | `ms` | `rawbox.workflow.name`, `rawbox.step.label`, `rawbox.step.outcome` |
| `rawbox.run.count` | Counter | `{run}` | `rawbox.workflow.name`, `rawbox.run.outcome` |

### 6.4. Sampling long-running and looping workflows

One span per step execution is the right granularity, but a throttled polling
workflow built on `increment` + `loop-gate` can run for hours and produce a
sibling span per iteration — thousands of children under one root span, in one
trace that no backend enjoys receiving. Loop iterations are *siblings*
distinguished by `rawbox.step.iteration`, not nested spans, so the trace stays
flat; it simply gets wide.

Sample it, using the standard SDK env vars — the bridge itself has no sampling
knob, on purpose:

```bash
# Keep 5% of runs, whole traces at a time: a sampled run keeps every step,
# an unsampled one costs nothing. This is the right shape for rawbox, because
# a half-sampled run is a trace with holes in it.
export OTEL_TRACES_SAMPLER=parentbased_traceidratio
export OTEL_TRACES_SAMPLER_ARG=0.05
```

Head sampling at the *run* level is the recommendation: `parentbased_*` samplers
decide once, at the root span, and every step span inherits that decision through
the parent context, so runs are kept or dropped whole. If you need "all failures,
a sample of successes", that is a **tail sampling** policy on a collector, keyed
on `rawbox.run.outcome` / `error.type` — a collector-side concern rawbox does not
try to own.

Two smaller levers for very long runs: keep the NDJSON file as the complete
record (it is never sampled) and treat traces as the sampled view, and prefer
`OTEL_BSP_SCHEDULE_DELAY` / `OTEL_BSP_MAX_QUEUE_SIZE` tuning over turning the
bridge off, since spans are only exported once their span *ends* — a run whose
process is killed mid-flight still exports what the sink can close.

### 6.5. Not built (yet)

Context propagation *into* plugin handlers is out of scope for this phase:
an HTTP-calling plugin does not yet join the trace. The hook is
documented in `otel-sink.ts` on the per-step context map, which already holds
exactly the `Context` such an extension would need. Dashboards and a bundled
collector are likewise out of scope — the NDJSON logs plus any OTLP backend
cover the near-term need.

---

## 7. Development

```bash
npm run build     # tsc
npm test          # vitest run tests
```
