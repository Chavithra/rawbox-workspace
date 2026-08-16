---
name: rawbox-workflow-creation
description: >-
  Provides the step-by-step procedure to define a workflow and workspace configuration, declare plugin dependencies, verify structures, lock resolved registries, and execute runner instances.
  Activate this skill when the user asks to create, modify, test, or run a Rawbox workflow/workspace.
---

# Creating and Executing Workflows and Workspaces

This guide details the procedure to define, configure, verify, and run **Workspaces** and
**Workflows** in the Rawbox Framework.

> [!IMPORTANT]
> Every document carries `kind:`, and every workflow also carries `formatVersion: "1.0"`.
> A file without `kind:` is not a Rawbox document and is rejected — the tooling identifies
> documents by that field and nothing else.

---

## 1. Concepts Overview

- **Workspace** (`kind: Workspace`) — the runtime environment a set of workflows executes
  in. It lists its workflows and owns the `rawbox.lock` beside it. Tooling finds a
  workflow's workspace by walking up the directory tree looking for this `kind:`.
- **Workflow** (`kind: Workflow`) — a declarative state machine: a `plugins:` map, a
  `storage:` table, and an ordered list of `steps:`.
- **Step** — one operation call. `plugin:` names a key of `plugins:`; `operation:` is the
  contract path inside that plugin. Its `inputs:` read storage, its `outputs:` and
  `errors:` write it.
- **Storage key (box)** — a persistent item in the LMDB database, addressed by a plain
  string key of at most 79 bytes matching `[A-Za-z0-9_.-]+`. Its **strategy** (KV or FIFO)
  is a property of the key, declared once under `storage:` and never repeated on a step.
- **The key table** (`storage.keys:`) — one entry per key holding everything the document
  says about it: `strategy:`, `seed:`, and `workflow:` when the box belongs to another
  workflow. It is the **only** way to declare a key: two earlier top-level blocks,
  `storage.strategies:` and `storage.seed:`, stated the first two facts one map per fact
  and have been removed. A document still writing either is refused, with the `keys:`
  entry that replaces it printed.
- **Control-flow step** — a step whose contract returns a jump label instead of an output
  record. The runner jumps to the step with that `label:`, or honours the reserved labels
  `__START__` (first step), `__END__` (last step), `__EXIT__` (terminate),
  `__FAIL__` (terminate as a failure).

> [!TIP]
> `@rawbox/rawbox-plugin-default` ships ready-made building blocks — control-flow
> (`branch`, `switch`, `loop-gate`, `halt`, `jump`), timing (`sleep`,
> `workflow-throttle`), data plumbing (`echo`, `compare`, `logic`, `increment`, `assert`),
> and `log`. Check it before writing a custom operation:
> `npx rawbox-cli plugin info <workflow file>` lists what a declared plugin provides.

**You do not compute registry hashes to author a workflow.** `npx rawbox-cli registry
hash` exists for inspecting a registry, but nothing in a workflow document references a
hash. Resolved versions and hashes belong to the generated `rawbox.lock`, which is why a
workflow file is never rewritten under you.

---

## 2. Step-by-Step Creation Procedure

### Step 1: Create the Workspace Configuration File

Create `workspace.yaml` at the root of your workspace directory.

> [!TIP]
> A workspace document is not required for a one-off run of a single workflow. Skip straight
> to "Setup and Execution", "Running without a workspace file at all" — `--workspace-name <name>` synthesizes one
> in memory instead.

```yaml
kind: Workspace
name: data-processing-workspace
# Optional. Where `workspace setup` installs the declared plugins, and the first
# place a run resolves them from. Resolved relative to this file; defaults to
# <this directory>/.rawbox, so most workspaces omit it entirely.
targetFolder: ./target
workflowPathList:
  - ./workflows/count-up.workflow.yaml
# Optional. What a workflow's keys start with HERE — keyed by the workflow's
# PATH, the same entry `workflowPathList` holds above, then by storage key. The
# path is matched after resolving it against this directory, so `./workflows/x`
# and `workflows/x` are one workflow. It may only replace a seed that workflow
# already declares, and it replaces the value and nothing else: never the
# strategy, the sizing, the owner or the backend. See "Setup and Execution".
seedOverrides:
  ./workflows/count-up.workflow.yaml:
    limit: 5
```

`kind: Workspace` is load-bearing: it is how `workflow verify` locates this file when you
do not pass `--workspace`.

`targetFolder:` is the one thing that keeps `workspace setup` and `workflow run` in
agreement. Whatever it resolves to is the first directory the runner resolves a plugin
from, ahead of the workspace directory and the process cwd — so a plugin installed only
into a separate folder is still found, from any cwd. Omit it and the target is
`<workspace directory>/.rawbox` — gitignored, machine-owned, and safe to delete — which is
what the default has always relied on.

---

### Step 2: Declare the Plugins Your Workflow Uses

`plugins:` maps a **package name** to an **npm dependency specifier** — exactly the shape
of `dependencies` in a `package.json`. The specifier carries the source, so there is no
separate source or path field:

| Specifier | Meaning |
| --- | --- |
| `"^0.1.0"` | from the npm registry |
| `"file:../../packages/my-plugin"` | a local directory |
| `"git+https://host/repo.git#v1.2.3"` | a git repository, pinned to a tag |

A relative `file:` specifier resolves against the **workspace directory** — the one holding
`workspace.yaml` — not against the workflow file.

---

### Step 3: Write the Workflow File

Create the file at the path `workflowPathList` advertises. This example counts to a limit
and records each pass; it exercises every shape you are likely to need.

#### `workflows/count-up.workflow.yaml`

```yaml
kind: Workflow
formatVersion: "1.0"
name: count-up
description: Counts to a limit, recording each pass.

plugins:
  "@rawbox/rawbox-plugin-default": "^0.1.0"

storage:
  # Applies to every key the key table gives no strategy of its own. `valueSizeMax`
  # bounds ONE stored value — its msgpack encoding, before compression — and is
  # the one storage limit the runtime enforces: an oversized `put` is rejected
  # before anything is written. It is required, never inferred; 1900 is the
  # value to declare unless you know better, because it keeps an entry under
  # any legal key on a shared LMDB page.
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900

  # THE KEY TABLE — one entry per key, holding everything this document says
  # about that key: `strategy:`, `seed:`, and `workflow:` for a box another
  # workflow owns. Every field is optional; an entry stating nothing still
  # declares the key, which then resolves to `defaultStrategy`.
  #
  # `pass_log` is a queue rather than a single cell, so each pass appends
  # instead of overwriting. Every step naming this key picks the strategy up,
  # so two steps can never disagree about it.
  #
  # `queueSizeMax` is any integer >= 2 — there is NO power-of-two rule — and one
  # slot is reserved to tell a full queue from an empty one, so 1024 holds 1023
  # entries. A strategy takes no fields beyond the ones below: an unknown field
  # is an error, and so is one belonging to the *other* strategy (`queueSizeMax`
  # under `name: lmdb-kv`), which is rejected rather than quietly ignored.
  #
  # `seed:` on a key is its initial value, written before the first step runs
  # — on EVERY run, not just the first. This is where a *constant* goes: an
  # input reads from storage and from nowhere else, so a value known at
  # authoring time — a log level, a comparison operand, a jump target — is
  # seeded here and bound by key like any other.
  #
  # `keys:` is the ONLY way to declare a key. `storage.strategies:` and
  # `storage.seed:` stated these two facts one map per fact and have been
  # REMOVED — a document still writing either is refused by name, with the
  # `keys:` entry that replaces it printed. `defaultStrategy:` is unaffected.
  keys:
    pass_log:
      strategy:
        name: lmdb-fifo
        queueSizeMax: 1024
        valueSizeMax: 1900
      # A seed for an lmdb-fifo key MUST be a list, and each element becomes
      # one queue entry: [a, b, c] seeds three entries, [[a, b, c]] seeds one
      # entry holding the list, [] seeds an empty queue, and a non-list is an
      # error. So this starts the queue empty.
      seed: []
    counter:
      seed: 0
    log_level:
      seed: info
    log_message:
      seed: counted one pass
    limit:
      seed: 3
    compare_operator:
      seed: lt
    loop_label:
      seed: count-up
    exit_label:
      seed: __EXIT__

steps:
  - label: count-up
    plugin: "@rawbox/rawbox-plugin-default"
    operation: value-ops/increment
    inputs:
      value: counter        # short form: just the storage key
    outputs:
      value: counter        # reads and writes the same box
    errors:
      message: increment_error

  - label: record-pass
    plugin: "@rawbox/rawbox-plugin-default"
    operation: observability/log
    inputs:
      level: log_level                       # a constant, seeded above
      message: log_message
      data: counter
    outputs:
      timestamp: pass_log                    # appended to the FIFO box
    errors:
      message: log_error

  - label: check-limit
    plugin: "@rawbox/rawbox-plugin-default"
    operation: value-ops/compare
    inputs:
      a: counter
      b: limit
      operator: compare_operator
    outputs:
      result: under_limit
    errors:
      message: compare_error

  # A control-flow step steers execution instead of producing data. It takes
  # `inputs:` and `errors:` but NEVER `outputs:` — the schema rejects them.
  - label: loop-or-finish
    plugin: "@rawbox/rawbox-plugin-default"
    operation: control-flow/branch
    inputs:
      condition: under_limit
      thenLabel: loop_label      # seeded "count-up" — jump back to that label
      elseLabel: exit_label      # seeded "__EXIT__" — reserved label: terminate
    errors:
      message: branch_error
```

---

## 3. Binding Reference

Each entry under `inputs:`, `outputs:`, or `errors:` maps a **contract field name** to a
storage location.

| Form | Where legal | Meaning |
| --- | --- | --- |
| `ms: sleep_ms` | inputs, outputs, errors | short form — the storage key |
| `ms: { key: sleep_ms }` | inputs, outputs, errors | the same thing, spelled out |
| `ms: { key: shared, workflow: other-flow }` | **inputs only** | read another workflow's box |

Two boundaries the schema enforces, so do not try to work around them:

- **A step never writes outside its own workflow.** `workflow:` is legal on inputs only.
- **No binding may name another workspace.** Cross-workspace reads do not exist.

### Reading another workflow's box

Ownership is a property of the box, so declare it **once, on the key** — then every binding
of that key is a cross-workflow read, including the plain short form:

```yaml
storage:
  keys:
    shared_state:
      workflow: other-flow     # the owner's NAME, never a path — see "Setup and Execution"
steps:
  - inputs:
      data: shared_state       # short form; the key table already said whose box it is
```

Three rules, all reported by `workflow verify`:

- **A key that declares `workflow:` may never appear in `outputs:` or `errors:`.** A write is
  always resolved against the running workflow's own store, so such a binding would not
  write the box the key names — it would create a *second* box of the same name here, which
  nothing else reads.
- **It may not be seeded either.** A seed is a write into this workflow's store, so it
  cannot reach another workflow's box. Let the owning workflow supply the value.
- **It may not name the workflow it is written in.** That is an error, not a no-op: `workflow:`
  exists to name a *different* workflow.

The binding long form `{ key, workflow }` still exists and is not deprecated — it is the
only way to read the same key *name* from two different workflows. Where both are written
for one key they must **agree**: a restatement is legal, a disagreement is an error naming
both sites.

A key another workflow owns is not charged to this workflow's storage budget, and needs no
writer and no seed here — those are the owning workflow's job.

### Storage keys: two rules, and neither is configurable

Every key the document names — as a `keys:` entry or in any binding — obeys both:

- **At most 79 bytes**, measured as UTF-8.
- **`[A-Za-z0-9_.-]+`** — ASCII letters, digits, and `_`, `.`, `-`, and nothing else. No
  `/`, no `:`, no space, no accented character, and not the empty string.

Both limits are Rawbox's own rather than the backend's, and there is **no `keySizeMax`
field** anywhere to raise them. `verify` names the key, where you named it, and the exact
characters that put it outside the set — so do not go looking for a storage setting to
change.

A key another workflow owns is the one exemption: it belongs to the workflow that owns it, so
it is charged there rather than here. Its *name* is still checked wherever this document
declares it, because the name is what addresses the box.

### A key you read must be written by something

A key named by an `inputs:` binding MUST carry a `seed:` in its `storage.keys` entry, or be
written by some step's `outputs:` or `errors:`. Otherwise the read is a guaranteed run-time failure —
`Value not found` on an `lmdb-kv` key, `Queue empty` on an `lmdb-fifo` one — so `verify`
rejects the document rather than letting the run reach it. Either fix is complete; only you
know which was meant.

A write by *any* step counts, whatever the order: reading at step 1 what step 5 writes
fails on the first run and works on every one after it, which is how state that accumulates
across runs is expressed. Nothing is reordered and no order analysis is performed.
Declaring the key — a `keys:` entry with no `seed:`, whether or not it states a
`strategy:` — does **not** satisfy the rule: a strategy says how a key stores, not that anything ever put
something in it. Keys another workflow owns are exempt here too, and a key that is written
and never read is perfectly legal.

### Constants: seed them, then bind the key

There is **no inline-literal form**. A binding names a storage key; a handler's inputs are
built from storage reads and from nothing else. So a value you know while writing the
document — a log level, a comparison operand, a jump target — is declared as a
key's `seed:` and bound by key:

```yaml
storage:
  keys:
    then_label:
      seed: sleep-step
steps:
  - inputs:
      thenLabel: then_label
```

`{ value: … }` is rejected. If you have an older example that uses it, `workflow verify`
names the step and field and prints the seed plus binding that replaces it.

A seed is validated against the `inputSchema` of the field that consumes it, so a wrong
type is caught by `workflow verify` rather than at run time — exactly as a literal was.
One difference to know: a seeded key can be overwritten by a later step's `outputs:`, so a
jump target is mutable at run time in a way an inline literal was not.

### Control-flow steps

`operation:` values beginning `control-flow/` may not carry `outputs:`. Adding them fails
validation with two messages — the operation path pattern and `"/steps/N/outputs" : must
not be valid` — because a control-flow contract returns only a label.

### Ending a run as a failure

A step whose handler fails writes its `errors:` bindings and the workflow **continues** — a
failed step is not a failed run. To stop the run *and* report it as a failure (non-zero
exit, `run.end` with `outcome: "error"`), halt with `fail: true`:

```yaml
storage:
  keys:
    refusal_fail:
      seed: true
    refusal_reason:
      seed: preconditions not met, refusing to trade

steps:
  - label: refuse
    plugin: "@rawbox/rawbox-plugin-default"
    operation: control-flow/halt
    inputs:
      reason: refusal_reason   # becomes the run's error message
      fail: refusal_fail
```

Use it for the conditions a supervisor must notice. A plain `halt` (no `fail`) still ends
the run cleanly, which is right for a workflow that simply has nothing left to do.

---

## 4. Verification

Verify early and often. The errors name the field that is wrong and list the values that
would be right.

### Verify the workspace
Checks the structure, every workflow it lists, that no two workflows declare conflicting
specifiers for the same package, and that every path under `seedOverrides:` is one this
workspace lists in `workflowPathList`:
```bash
npx rawbox-cli workspace verify workspace.yaml
```

### Verify a workflow
Checks the schema, resolves every `plugin:` against the installed packages, confirms each
`operation:` exists in that plugin's contract registry, applies any seed overrides ("Setup and Execution") and
validates the resulting seeds against the input schema of the field that consumes them, and
enforces the storage boundaries:
```bash
npx rawbox-cli workflow verify workflows/count-up.workflow.yaml
```
The workspace is auto-discovered by walking up for a `kind: Workspace` document; pass
`--workspace <file>` to override.

It also reports the **storage budget** — `dataBytesMax` per key and per workflow, and a
separately labelled `recommendedVolumeBytes`. The two are different computations, not one
scaled from the other: size a volume or container with the second. Both are **reported and
neither is enforced**; nothing in the runtime refuses a write for exceeding them. The one
storage limit that *is* enforced is per item, on `put`, against that key's `valueSizeMax`.
Keys a step binds but `storage:` never declares are counted too, and the report says which
is which.

### Inspect plugin resolution
When a plugin will not resolve, this reports each declared package — specifier, resolved
version, install status, registry hash with lock agreement, and the operations your
workflow references from it:
```bash
npx rawbox-cli plugin info workflows/count-up.workflow.yaml
```

---

## 5. Locking

`rawbox.lock` records what each declared package resolved to, keyed by package name at the
**workspace** level, so every workflow in the workspace shares one entry per package.

```bash
npx rawbox-cli workflow lock workflows/count-up.workflow.yaml
```

- **Absent lock** — resolve whatever is installed. Convenient while developing; no
  integrity guarantee.
- **Present and matching** — the registry a step binds to is the one that was locked.
- **Present and mismatched** — a hard error naming the package. Re-run `workflow lock`
  after deliberately changing a plugin.

`workflow lock` never modifies the workflow file; that is the point of a separate lock.

---

## 6. Setup and Execution

### Step 1: Run the workflow
No separate install step is needed first. The workspace is auto-discovered from the
workflow path, the same way `workflow verify` does it (`--workspace` overrides it); log
paths default under `<target folder>/logs/<workflow name>/<run-id>.ndjson`, with the
error log at `<run-id>.error.ndjson` next to it (`--log-file`/`--error-log` override
both). Each of those names **segment 0**: both files rotate, on by default at 128 MiB per
segment and 8 segments kept, with successors named `<run-id>.1.ndjson`, `.2`, … and the
*oldest* unlinked once the count is exceeded — so a long run's surviving segments may start
above 0. Nothing is ever renamed or truncated, and every reader below spans the whole
sequence. `logs.rotate:` in `workspace.yaml` sets both bounds (declare both or neither).
Before attempting the run,
every plugin declared under `plugins:` is checked against the resolved target folder, the
workspace directory, and the process cwd — the same bases the run itself resolves from —
and if one does not resolve, it is installed first (the equivalent of `workspace setup`
into the resolved target folder), reported with one info line, and the run proceeds.
Starting several workflows of this workspace at once ("Watching a Run") is safe: auto-setup takes an
exclusive per-target-folder lock, so only one process ever installs and the rest wait, then
join in without installing again.
```bash
npx rawbox-cli run workflows/count-up.workflow.yaml

# Or with explicit overrides
npx rawbox-cli run workflows/count-up.workflow.yaml --workspace workspace.yaml --log-file ./run-logs.txt --error-log ./run-errors.txt

# Skip auto-setup — a missing plugin fails instead of being installed
npx rawbox-cli run workflows/count-up.workflow.yaml --no-setup

# Force a reinstall before running, even though everything already resolves
npx rawbox-cli run workflows/count-up.workflow.yaml --setup
```

### Step 2: Install the declared plugins explicitly (optional)
Reach for `workspace setup` directly for explicit control over *when* the install happens
(e.g. as its own CI step, ahead of `workflow lock`) or *how* (a non-default target folder,
`--install-links`). It splices `plugins:` into a generated `package.json` and runs a single
`npm install`. The target folder is optional — the argument wins, then `targetFolder:` in
`workspace.yaml`, then `<workspace directory>/.rawbox` (gitignored, machine-owned, safe to
delete) — the same folder `run`'s auto-setup installs into:
```bash
npx rawbox-cli workspace setup workspace.yaml                  # -> targetFolder:, or <workspace directory>/.rawbox
npx rawbox-cli workspace setup workspace.yaml ./target-run-dir # -> an explicit override
```

npm treats a `file:` dependency as a **link**: it symlinks the package and does not install
that package's own dependencies into the target. That is the default because it keeps a
locally developed plugin live — rebuild it and the next run picks it up, with no second
setup. Pass `--install-links` when the target folder has to be portable; npm then copies
the package and installs its dependencies, at the cost of the copy being a snapshot.

### Changing what a key starts with, without editing the workflow

Two layers can replace a **seed** the workflow already declares. Neither can change anything
else about the key — not its strategy, its sizing, its owner or its backend — so what an
operation on that key *means* is always what the workflow document says.

```yaml
# workspace.yaml — for every run of this workspace
seedOverrides:
  ./workflows/count-up.workflow.yaml:   # the workflow's PATH, as workflowPathList spells it
    limit: 5
```

```bash
# --seed key=<json>, repeatable — for this run only
npx rawbox-cli run workflows/count-up.workflow.yaml --seed limit=5
npx rawbox-cli workflow verify workflows/count-up.workflow.yaml --seed limit=5
```

**Precedence is `CLI > workspace > workflow`**, applied key by key. Three rules hold for
both layers:

1. **Only a key the workflow already seeds.** Not an unseeded key, not an undeclared one,
   not one another workflow owns. Seeding happens on *every* run, so an override on an
   unseeded key would not initialise it — it would reset it every run and destroy whatever
   accumulated there.
2. **The whole value is replaced.** There is no deep merge: `{a: 1}` over `{a: 0, b: 2}`
   gives `{a: 1}`.
3. **The value is re-checked against the strategy the workflow declares** — the mandatory
   list for a FIFO key, the queue capacity, `valueSizeMax` — with the same diagnostics the
   workflow's own seed would get.

`--seed`'s value is **JSON**, so a string needs its own quotes: `--seed limit=5`,
`--seed name='"Ada"'`, never `--seed name=Ada`, which is refused rather than silently stored
as the string `"Ada"`. Applied overrides are echoed by key and source — by `workflow verify`
before a run starts, and into the run's NDJSON log — but **never with their values**.

> [!IMPORTANT]
> `--seed` is not a channel for secrets: the value lands in the shell's history like any
> other argument. Connection credentials belong in `backends:` entries, which interpolate
> `${ENV_VAR}` references from the environment.

A `seedOverrides:` block whose path is in no `workflowPathList` entry is an error from
`workspace verify`, `workflow verify` **and** `run` alike — each lists the paths that do
exist, and what yours resolved to — because a misspelling would otherwise sit there looking
applied while every run used the workflow's own value. Every command can say so because the
key is a path: `workflowPathList` is in the same file, so nothing else has to be read. That
is also why the two documents differ on purpose:

| Where | Names a workflow by | Because |
| --- | --- | --- |
| `seedOverrides:` in `workspace.yaml` | **path** | It is what `workflowPathList` holds, so the reference is checkable inside the one file |
| `storage.keys.<key>.workflow` in a workflow | **name** | A workflow must not depend on a workspace's directory layout — the same workflow may be listed at different relative paths from different workspaces |

### Running without a workspace file at all (`--workspace-name`)

A `workspace.yaml` document is not required to run — or verify — a single workflow one-off.
Pass `--workspace-name <name>` instead of `--workspace <file>` (and instead of relying on
auto-discovery):

```bash
npx rawbox-cli run workflows/count-up.workflow.yaml --workspace-name scratch
npx rawbox-cli workflow verify workflows/count-up.workflow.yaml --workspace-name scratch
```

This synthesizes an in-memory workspace — named `scratch`, scoped to just this workflow —
instead of reading or writing a document; no `workspace.yaml` ever appears. Because that
implicit workspace declares no `targetFolder:`, `.rawbox/` lands *next to the workflow file*
rather than anywhere a discovered `workspace.yaml` would have put it. `--workspace` and
`--workspace-name` are mutually exclusive, and `--workspace-name` requires a value — there is
no default; pass the workflow's own `name:` if that's what you want.

**Know the state-sharing rule before relying on this for more than a one-off.** The LMDB store
is still keyed by workspace name, so two runs passing the *same* `--workspace-name` **share**
whatever the first left behind, and two different names are fully isolated. Every scratch run
prints that rule as one line before it runs. There is no guardrail beyond the notice — Rawbox's
storage budget is informational everywhere, and a scratch run is not a special case that gates
writes on it. `--fresh` is the opt-out: it deletes that one name's LMDB environment before the
run starts, so this run gets a clean slate instead of sharing:

```bash
npx rawbox-cli run workflows/count-up.workflow.yaml --workspace-name scratch --fresh
```

---

## 7. Watching a Run

A single `run` already narrates itself (`--output pretty|ndjson|quiet`, `-v/-vv/-vvv`;
`json` is an accepted alias of `ndjson`, and `ndjson` puts the raw event stream on stdout
byte-for-byte as the log file receives it) and writes its NDJSON log under
`<target folder>/logs/<workflow name>/`. Once more than one
workflow is involved, or a run outlives the terminal that started it, reach for the
workspace-wide views instead of tailing a log file by hand:

```bash
# Which runs exist, and are they alive? A dead pid is reported `crashed`, never
# silently missing.
npx rawbox-cli runs list workspace.yaml

# One snapshot of every workflow this workspace lists — liveness, last event, step
# counts, and a storage panel — refreshed on an interval with --watch.
npx rawbox-cli workspace status workspace.yaml --watch

# Every selected run's log merged by timestamp: live by default, or reconstructed
# after the fact with --since/--run, even once every run involved has finished.
npx rawbox-cli workspace logs workspace.yaml --since 15m
```

`store list` / `store get` / `store watch` read a workspace's LMDB state directly and
non-destructively — even peeking an `lmdb-fifo` key never dequeues it — without needing a
workflow to be running:

```bash
npx rawbox-cli store list workspace.yaml
npx rawbox-cli store get workspace.yaml count-up counter
```

For a system built from several cooperating workflows, a read-only **monitor workflow**
built on `@rawbox/rawbox-plugin-default`'s `observability/snapshot` operation is usually
the fastest way to see all of it from one terminal: bind the keys that matter to
`value1`..`value8`, loop it on `time/workflow-throttle`, and it logs a structured snapshot
on the same channel as everything else — no bespoke operation needed. `run.heartbeat`,
emitted while a step is in flight, is what lets `workspace status` render a step blocked
for minutes as `in <step> for <duration>` instead of looking exactly like a hung process.
