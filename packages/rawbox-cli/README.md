# rawbox-cli

`rawbox-cli` is the command-line utility for the Rawbox Framework. It provides scaffolding
templates (projects, plugins, operations, workspaces) and workflow runtime commands
(verification, locking, environment setup, execution, registry hashing).

Scaffolded configuration is emitted as annotated **YAML**. The format is defined over the
parsed data model, so equivalent JSON is accepted everywhere a document is read.

---

## 1. Commands Reference

Every command runs non-interactively when its options are supplied as CLI arguments;
omitting them drops into interactive prompts. `rawbox-cli <resource> --help` lists the
actions for a resource.

| Command | Purpose |
| --- | --- |
| `project create` | Scaffold a standalone Rawbox monorepo. |
| `plugin create` | Scaffold a plugin package. |
| `plugin info <file>` | Report what a workflow's plugins resolved to. |
| `operation create` | Add an operation to an existing plugin. |
| `workspace create` | Scaffold a workspace with a runnable example workflow. |
| `workspace verify <file>` | Validate a workspace document. |
| `workspace setup <workspace-path> [target-folder]` | Install the declared plugins. |
| `workflow verify <file>` | Deep-verify a workflow against its plugin registries. |
| `workflow lock <file>` | Write/refresh the workspace `rawbox.lock`. |
| `run <workflow>` | Execute a workflow, auto-installing missing plugins first (alias for `workflow run`). |
| `workflow run <workflow>` | Execute a workflow, auto-installing missing plugins first. |
| `registry hash <registry-path>` | Print a contract registry's SHA-256 signature. |
| `runs list [workspace]` | List recorded runs — status, age, duration, step counts, with crash detection. |
| `runs show <run-id>` | Show one run's registry entry plus a summary of its NDJSON log. |
| `runs tail <run-id>` | Print (and, with `-f`, follow) a run's log without knowing its path. |
| `runs prune [workspace]` | Delete registry entries and their log files down to a bound. |
| `store list <workspace-or-path>` | List every storage key a workspace has written, declared-vs-actual. |
| `store get <workspace-or-path> <workflow> <key>` | Print one storage key's value, non-destructively. |
| `store watch <workspace-or-path> [key…]` | Poll a workspace's storage and print keys that changed. |
| `workspace status [path]` | One snapshot of a workspace's workflows (liveness, last event, steps) plus a storage panel. |
| `workspace logs [path]` | Merge a workspace's run logs by timestamp — live by default, `--run`/`--since` for finished runs. |

---

### 1.1. Scaffolding Commands

#### A. Initialize a Project (`project create`)
Generates a recommended npm-workspaces monorepo. `npm` is enforced as the sole package
manager. Dependencies are installed by default; pass `--no-install` to skip.
```bash
rawbox-cli project create --name rawbox-project-example --package-manager npm
```

Pass `--registry <url>` to also write an `.npmrc` at the project root routing the
`@rawbox` scope to that registry — a local Verdaccio, a corporate proxy — while every
third-party package keeps resolving from npmjs
([CONTRIBUTING.md §4](../../CONTRIBUTING.md#4-testing-what-a-consumer-gets)). The URL
must be `http://` or `https://`; without the flag, no `.npmrc` is written.
```bash
rawbox-cli project create --name rawbox-project-example --registry http://localhost:4873
```

#### B. Create a Plugin (`plugin create`)
Scaffolds a new plugin directory with base dependencies, TypeScript config, and contract
registry boilerplate.
```bash
rawbox-cli plugin create --name rawbox-plugin-example --no-install
```

#### C. Add an Operation (`operation create`)
Scaffolds a new type-safe operation handler inside an existing plugin and registers its
contract.
```bash
rawbox-cli operation create --name sum-numbers
```

#### D. Create a Workspace (`workspace create`)
Scaffolds a declarative workspace — `workspace.yaml`, a runnable example workflow, a
`logs/` directory, and a `.gitignore` covering `.rawbox/` (the gitignored, machine-owned
folder `workspace setup` installs plugins into and a run writes its LMDB data under —
§1.3.A). The workspace lands in `workspaces/<name>` when the current directory's
`package.json` declares npm `workspaces`, and in `<name>` otherwise; the example workflow
always gets a published registry range as its plugin specifier, never a `file:` one — even
when scaffolded inside this monorepo, where a run's auto-setup still resolves it with no
install by walking up to the hoisted sibling package (CONTRIBUTING.md).
```bash
rawbox-cli workspace create --name live-trading --workflows ./workflows/example.workflow.yaml
```

Pass `--registry <url>` to also write an `.npmrc` beside the generated `workspace.yaml`,
routing the `@rawbox` scope to that registry. `workspace setup` (and a run's auto-setup)
copies that file into the target folder before every install, so the scaffolded registry
governs every install rawbox performs for the workspace.
```bash
rawbox-cli workspace create --name live-trading --registry http://localhost:4873
```

---

### 1.2. Inspection and Verification

#### A. Workspace Verification (`workspace verify`)
Validates a workspace document and checks that every referenced workflow resolves. Two
optional blocks are checked here because this is the document that holds them:

- **`backends:`** — **every** declared entry, referenced by a workflow or not: a declared
  connection nobody can resolve is broken whether or not something reaches for it today. An
  unset or empty `${VARIABLE}` is an error naming the variable and the backend id, never an
  empty substitution — `redis://:@localhost:6379` is a valid URL that opens a connection to
  the wrong server in silence.
- **`seedOverrides:`** — every outer key must resolve to a path this workspace lists in
  `workflowPathList` (compared **resolved**, so `./workflows/a.yaml` and `workflows/./a.yaml`
  are one workflow), and no two keys may resolve to the same path. `workflow verify` and
  `workflow run` check this too — the answer is in the same document, so no command that loads
  a workspace is excused from asking — but this is the one that reports a typo in a block for
  a workflow nobody happens to be running today.

```bash
rawbox-cli workspace verify workspaces/live-trading/workspace.yaml
```

#### B. Workflow Verification (`workflow verify`)
Schema checks, strict storage-boundary checks, and cross-plugin registry verification:
every step's `plugin:`/`operation:` pair is resolved against the loaded contract
registries, and every `storage.keys` seed value is type-checked against the `inputSchema` of
the field that consumes it.

The `storage:` rules a schema cannot express are checked here too, reaching every key the
document names as a `keys:` entry or in a step binding: every key's length (≤ 79 bytes) and
character set (`[A-Za-z0-9_.-]+`), every queue seed being a list that fits the capacity
**its own strategy** declares, every `inputs:` binding reading a key nothing ever writes,
every key declaring `workflow:` being neither written nor seeded here, every key resolving
to **one store**, and any of the three **removed** forms — a `{ value: … }` inline literal,
a `storage.strategies` block, a `storage.seed` block — each diagnosed by name with the
replacement printed. See the
[runner README §2.3](../rawbox-runner/README.md#23-storage-rules-a-schema-cannot-express) for
each rule and its diagnostic.

A workflow naming a `backend:` is checked against the workspace's `backends:` map — but only
the ids **this workflow** references, so a workflow touching none of them does not fail
because a colleague's `prod` password is not set on this machine.

It also **reports the storage budget** — `dataBytesMax` and `recommendedVolumeBytes`, per
key and per workflow, with each key labelled `declared` or `bound by a step`. Both figures
are reported, neither is enforced: they exist to size a volume or container before the run
([rawbox-store README §1.D](../rawbox-store/README.md#d-the-storage-budget)).
`workspace verify` prints the same figures plus a workspace total. A key whose strategy
declares no byte model — `redis-kv` and `redis-fifo` — is printed as **not applicable**
rather than charged `0`, followed by one line saying how many keys the figures below exclude
and naming them: a summed zero would read as "this key costs nothing" in a number an operator
sizes a volume with.

**`--seed key=<json>`** applies the same seed overrides a run would, before checking anything
that depends on a seed value — so `verify` and `run` see the same document. Repeatable;
precedence is `CLI > workspace > workflow`. Every override that ends up applied is echoed by
**key and source layer, never by value**, which — together with the run's own
`seed.override.applied` event — is the whole of a `--seed` override's reviewability, since it
has no file, no diff and no lock entry.

The workspace is found by walking up for a `kind: Workspace` document, so `--workspace` is
only needed to override that.
```bash
rawbox-cli workflow verify workspaces/live-trading/workflows/example.workflow.yaml
rawbox-cli workflow verify workspaces/live-trading/workflows/example.workflow.yaml --workspace workspaces/live-trading/workspace.yaml

# Verify with the values this deployment would actually start from
rawbox-cli workflow verify workspaces/live-trading/workflows/example.workflow.yaml --seed sleep_ms=250
```

#### C. Plugin Report (`plugin info`)
Reports each package a workflow declares: its specifier, resolved version, install status,
contract-registry hash with `rawbox.lock` agreement, and the operations the workflow
references from it. This is the first command to reach for when a plugin will not resolve.
```bash
rawbox-cli plugin info workspaces/live-trading/workflows/example.workflow.yaml
```

#### D. Compute Registry Signature Hash (`registry hash`)
Prints the deterministic SHA-256 content-hash of a plugin's serialized `contractRecord`.
```bash
rawbox-cli registry hash ./packages/rawbox-plugin-example/dist/contract-registry.js
rawbox-cli registry hash ./packages/rawbox-plugin-example/dist/contract-registry.js --json
```

---

### 1.3. Runtime Commands

#### A. Workspace Initialization (`workspace setup`)
Splices every workflow's `plugins:` map into a generated `package.json` and runs one
`npm install`.

`run` / `workflow run` already do this automatically when a declared plugin does not
resolve (§1.3.C, "Auto-setup"), so this command is no longer a required step before a
first run. Reach for it directly when you want explicit control over *when* the install
happens (e.g. as a separate CI step, ahead of `workflow lock`) or *how* (`--install-links`,
a non-default `target-folder`) — `run --setup` covers the common "reinstall now" case
without a second command.

**Where** it installs — the *target folder* — is resolved in this order:

| Precedence | Source |
| --- | --- |
| 1 | the `target-folder` argument, when one is passed |
| 2 | `targetFolder:` in `workspace.yaml`, resolved relative to that file |
| 3 | `<workspace directory>/.rawbox` (default) |

Whatever it resolves to is the *first* place `workflow run` looks for a plugin, ahead of
the workspace directory and the process cwd. That is what makes setup and run agree: a
plugin installed only into a separate target folder used to be unresolvable from any cwd
but that folder.

`.rawbox/` is gitignored and machine-owned — `workspace create` writes the `.gitignore`
entry for it — so the default install never lands `package.json`/`node_modules` beside the
authored `workspace.yaml`. `rawbox.lock` is the one exception: it stays next to
`workspace.yaml` because it is committed.

```bash
# Default: install into <workspace directory>/.rawbox, where a run already resolves plugins from
rawbox-cli workspace setup workspaces/live-trading/workspace.yaml

# Or name a separate folder
rawbox-cli workspace setup workspaces/live-trading/workspace.yaml ./target-run-dir

# Portable, not live — see below
rawbox-cli workspace setup workspaces/live-trading/workspace.yaml ./target-run-dir --install-links
```

npm treats a `file:` dependency as a **link**: it symlinks the package and does not install
that package's own dependencies into the target. That is the default here on purpose —
rebuild a locally developed plugin and the next run picks it up, with no second setup. Pass
`--install-links` to make npm copy the package and install its dependencies instead,
producing a target folder you can move to a machine that never installed the plugin. The
trade is that the copy is a snapshot: re-run setup after every plugin change.

> [!WARNING]
> `--install-links` only works when everything the plugin needs is **published** — its
> dependencies *and its peers*. Copying forces npm to build a real dependency tree for the
> plugin, so a plugin needing an unpublished package fails with a 404 naming it. Every
> plugin in this monorepo is in that position: they declare `@rawbox/plugin` as a peer
> dependency, and it is not published. So `--install-links` is for self-contained
> third-party plugins, not for local ones. Without the flag the question never arises,
> because a linked package's dependencies resolve from where it already lives.
>
> `--legacy-peer-deps` appears to fix this and does not. It makes the install succeed with
> the peer simply absent, so the copied plugin then fails at import time with
> `Cannot find package '@rawbox/plugin'` — the same problem, moved later and made harder to
> read. Publishing `@rawbox/plugin` is what would actually change this.

#### B. Lock Plugin Resolution (`workflow lock`)
Resolves every plugin the workflow declares and writes `rawbox.lock` next to
`workspace.yaml`. The workflow file is never modified. Re-run it after any contract change,
which alters a plugin's registry hash.
```bash
rawbox-cli workflow lock workspaces/live-trading/workflows/example.workflow.yaml
```

#### C. Execute Workflow (`run` / `workflow run`)
Runs the XState orchestration engine, writing the run's **NDJSON event log** — one typed
event per line (`run.start`, `step.start`, `step.end`, `run.end`, …; see
[rawbox-runner README §4](../rawbox-runner/README.md)) — and mirroring every failure event
into a separate error log with the same schema. Takes a single workflow path — the
workspace is auto-discovered the same way `workflow verify` discovers it (walking up for
a `kind: Workspace` document), and log destinations default under the resolved workspace
target folder: `<target folder>/logs/<workflow name>/<run-id>.ndjson`, with the error
log at `<run-id>.error.ndjson` next to it — `<run-id>` is the same `run_id` every event
in the file carries. The top-level `run` command is an alias for `workflow run`.

**A run's log is a sequence of segments.** Both files **rotate**, on by default at 128 MiB
per segment and 8 segments kept — 1 GiB per run, per file. The path above is **segment 0**,
and it is also the **oldest**: successors are `<run-id>.1.ndjson`, `<run-id>.2.ndjson`, …
(and `<run-id>.error.1.ndjson`, …). Nothing is ever renamed or truncated, so the path the
registry recorded stays valid forever; when a roll would exceed the file count, the *oldest*
segment is unlinked, which is why a run's surviving segments may start above 0. Every reader
in this CLI — `runs tail`, `runs show`, `workspace logs`, `workspace status`, `runs prune`'s
sizing — enumerates the whole sequence, so none of them ever shows a rotated run's first
segment alone. Each roll writes a `log.rotate` event as the first line of the new segment,
carrying the segment numbers and the bounds in force; the ones that *deleted* history carry
`severity: "warn"` and print one line in the terminal. Both bounds come from the workspace
document's `logs.rotate:` block (FORMAT.md, "`logs.rotate`").

**Auto-setup.** Before attempting the run, every plugin the workflow declares under
`plugins:` is checked against the same resolution bases the run itself will use (the
resolved target folder, the workspace directory, the process cwd). If any do not resolve,
`run` installs them first — the equivalent of `workspace setup` into the resolved target
folder — reports where it installed, and then proceeds. A workspace that has never had
`workspace setup` run against it still executes successfully on the first try. Two flags
control this:

| Flag | Effect |
| --- | --- |
| *(default)* | Auto-installs only when one or more declared plugins do not already resolve. |
| `--no-setup` | Never auto-installs; a missing plugin fails the run exactly as it always has. |
| `--setup` | Forces a reinstall unconditionally, even when everything already resolves. |

**Concurrent runs of one workspace never race the install.** Starting several
workflows of the same workspace at once — the normal way to run a
multi-workflow system — used to mean every process independently found the
same plugin missing and called `npm install` into the same target folder at
the same time, which npm does not tolerate. Auto-setup now takes an exclusive
lock, `<target folder>/.rawbox-setup.lock`, before checking or installing
anything: exactly one process ever runs the install, and every other one
waits for it to finish, re-checks resolution, and proceeds without installing
a second time unless it still needs a plugin the winner did not install (e.g.
two workflows declaring different plugin sets). A lock left behind by a
process that died mid-install is detected as stale (its pid, or that pid's
start time, no longer matches a live process — the same check `runs list`
uses for crash detection) and taken over automatically. `--no-setup` never
touches the lock at all; `--setup` still honors it.

```bash
# Workspace auto-discovered, logs land under workspaces/live-trading/.rawbox/logs/example/
# — no `workspace setup` needed first; missing plugins are installed automatically.
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml

# Or use the longer form
rawbox-cli workflow run workspaces/live-trading/workflows/example.workflow.yaml

# Override the workspace explicitly
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --workspace workspaces/live-trading/workspace.yaml

# Or specify explicit log paths (--error-log alias -e)
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --log-file ./run-logs.txt --error-log ./run-errors.txt

# Skip auto-setup — a missing plugin fails instead of being installed
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --no-setup

# Force a reinstall before running, even though everything already resolves
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --setup
```

**Workspace-less ("scratch") runs (`--workspace-name`, `--fresh`).** For a one-off run with
no `workspace.yaml` anywhere — the `ansible-playbook -i localhost,` equivalent — pass
`--workspace-name <name>` instead of `--workspace` or relying on discovery. Nothing is read
from or written to disk as a workspace document: an in-memory workspace is synthesized,
scoped to just this one workflow, and its `.rawbox/` lands next to the workflow file itself
rather than anywhere discovery would have found one. `workflow verify` accepts the same flag,
for a verify → run loop with no workspace document at all. `--workspace` and
`--workspace-name` are mutually exclusive; `--workspace-name` requires a value — there is no
default, pass the workflow's own name if that's what you want.

Every scratch run prints one line naming the state-sharing rule before it runs: the LMDB store
is still keyed by workspace name, so **two runs sharing the same `--workspace-name` share
state, and two different names are isolated.** There is no guardrail beyond the notice — the
storage budget is informational everywhere in Rawbox, and a scratch run does not get a special
exception that gates writes on it
([rawbox-store README §1.D](../rawbox-store/README.md#d-the-storage-budget)).
`--fresh` is the ergonomic opt-out: it deletes that one name's LMDB environment before the
run starts, so this run gets a clean slate instead of whatever a same-named run left behind.

```bash
# No workspace.yaml anywhere in this directory or its ancestors.
rawbox-cli run one-off.workflow.yaml --workspace-name scratch
#   -> "state persisted under workspace "scratch" — reruns with the same name share it."
#   -> .rawbox/ appears next to one-off.workflow.yaml, not anywhere else.

# A second run with the same name sees whatever the first left behind.
rawbox-cli run one-off.workflow.yaml --workspace-name scratch

# Start that name over with empty state instead.
rawbox-cli run one-off.workflow.yaml --workspace-name scratch --fresh

# Verify against the same synthesized context, with no workspace document.
rawbox-cli workflow verify one-off.workflow.yaml --workspace-name scratch
```

**Starting from different values (`--seed`).** A workflow declares what its keys start with;
a workspace `seedOverrides:` block says those values are different *in this deployment*
([runner README §1.4](../rawbox-runner/README.md#14-seedoverrides--what-a-workflows-keys-start-with-here)).
`--seed` is the same override one layer up, for this one invocation. It obeys the same three
rules — only a key the workflow **already seeds**, replaced **whole** (never deep-merged),
re-validated against the strategy the workflow declares — and it changes no strategy, size,
backend or owner.

| Flag | Effect |
| --- | --- |
| *(default)* | The workflow's own seeds, with any workspace `seedOverrides:` block for this workflow applied on top. |
| `--seed key=<json>` | Replaces one seed for this run. **Repeatable**; precedence is `CLI > workspace > workflow`, applied key by key, so a key only the workspace names keeps the workspace's value. |

**The value is JSON, and that is not pedantry.** `500` is the number and `"500"` the string,
so a bare word is refused rather than stored as text: an unparsed `"500"` passes every shape,
size and ownership check there is and fails much later, the first time a step does arithmetic
on it — far from the flag that caused it. A malformed entry is rejected naming the flag, the
entry and what was wrong.

Applied overrides are echoed at run start — **key and source layer, never the value** — and
written once into the NDJSON stream as `seed.override.applied`. That pair is the whole of a
`--seed` override's reviewability: unlike a workspace block it has no file, no diff and no
lock entry. It is also why the value is deliberately absent from both: a log file is routinely
attached to a bug report, and a value typed on a command line is already in the shell's
history without also being persisted there. **`--seed` is not a channel for secrets** — a
connection credential belongs in a `backends:` entry's `${VARIABLE}` reference instead.

```bash
# One override, for this run only
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --seed sleep_ms=500

# Repeatable; a string needs its JSON quotes, a queue seed is a JSON array
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml \
  --seed name='"Ada"' --seed queue_items='["a","b"]'
```

> [!NOTE]
> **A workflow can verify and still refuse to run.** `redis-kv` and `redis-fifo` are valid
> strategies — the schema accepts them and `workflow verify` passes — but this version wires
> no Redis store into the run path, so a run declaring one stops at bootstrap with a message
> naming the strategy, where it was declared, and the strategies that do run. Nothing is
> written and nothing falls back to LMDB
> ([runner README §2.3](../rawbox-runner/README.md#23-storage-rules-a-schema-cannot-express)).

**Terminal output (`--output`, `-v`).** The run-event stream — the same typed events the
NDJSON log receives — has a second consumer: a terminal renderer
(`src/render/terminal-sink.ts`) that narrates the run as it happens and folds the log paths
into one final recap, so nothing after this is printed twice.

| `--output` | Shape |
| --- | --- |
| *(default)* | `pretty` on a TTY, `json` when the output is piped — the same heuristic `npm`/`ansible` use. |
| `pretty` | A `WORKFLOW` header, one line per step execution (✔/✘, label, operation, duration), `log` events indented under the step in flight, and a `RECAP` line. |
| `ndjson` | Every event, one `JSON.stringify`d line per stdout line — byte-identical to the log file, for piping into `jq` or straight into a systemd/Docker log stack. The log files are still written; this is a fan-out, not a replacement. |
| `json` | The older spelling of `ndjson`, and **identical to it** — not a second shape. Still accepted, and still what the piped-stdout default resolves to. |
| `quiet` | Only the `RECAP` line and **severity-bearing** events (a failed step, a `bootstrap.error`, a `warn`/`error`-level `log`) — the alarm classification described in the [runner README §4](../rawbox-runner/README.md#4-the-run-event-stream). |

```text
$ rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml

WORKFLOW example (workspace live-trading) ·····································
  ✔ sleep-step         time/sleep                                        502ms
  ✔ done                control-flow/halt                                  1ms

RECAP ·························································· ok=2 failed=0 skipped=0  812ms
  logs: workspaces/live-trading/.rawbox/logs/example/run-2026-08-09T10-11-12-ab3f.ndjson
```

The path on `RECAP` is the run's **segment 0** — for the overwhelming majority of runs, which
never reach `logs.rotate.maxBytes`, it is the whole log. A run long enough to have rotated
has `run-….1.ndjson` and up beside it, and `pretty`/`quiet` print one yellow
`⚠ log rotated: …` line for each roll that *deleted* a segment — a routine roll prints
nothing at all.

`-v` (repeatable, `pretty` only) adds per-step storage-key detail read straight off
`step.start.input`/`step.end.output` — never a separate query, only what the events already
carry:

| Flag | Adds |
| --- | --- |
| `-v` | Each step's input/output keys, with short values inline and oversized ones dropped to a byte count. |
| `-vv` | The same, with every value shown in full (one oversized value truncated at ~500 chars). |
| `-vvv` | `run.start`'s `run_id`/`format`, `storage.seed`'s key list, and each step's `registry_hash`. |

```bash
# Pipe the event stream into jq — the default the moment stdout isn't a TTY
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --output ndjson | jq 'select(.event == "step.end")'

# Only the recap and any errors — CI-friendly
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --output quiet

# Narrate every step's storage traffic
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml -vv
```

**Log durability (`--log-async`).** The NDJSON log is written **synchronously by default**:
each event is on disk before the run continues, so a run killed mid-workflow — precisely the
run whose log someone needs — keeps the lines explaining why. Event volume is one line per
step, not per byte of data, so that is not the bottleneck it would be in a request logger.

| Flag | Effect |
| --- | --- |
| *(default)* | Each line is written before the run continues, unless the workspace document's `logs.async:` says otherwise. |
| `--log-async` | Buffers writes instead — throughput for durability. Turn it on having measured that the syscalls cost you something. |
| `--no-log-async` | Forces synchronous writes back on, overriding a workspace's `logs.async: true`. |

Precedence is the usual **CLI > workspace.yaml > built-in default**. `run.end` is flushed
synchronously in both modes, so a stream that ends without one always means the process
died rather than the run failing quietly.

**Log detail (`--log-steps`).** `step.start`/`step.end` carry `input`/`output` — the records a
workflow read and produced — and those grow with whatever state the workflow accumulates: in
one measured workspace they were 91% of all log bytes. `--log-steps` decides how much of the
two the run's **main** log keeps.

| Flag | Effect |
| --- | --- |
| *(default)* | `full` — every field, unless the workspace document's `logs.steps:` says otherwise. |
| `--log-steps summary` | `step.start`/`step.end` reach the main log with `input`/`output` omitted; `step`, `outcome`, `duration_ms` and `error` are kept. |
| `--log-steps off` | `step.start`/`step.end` do not reach the main log at all. |

A value outside those three (`--log-steps sumary`) is refused by yargs, which names the three
legal values rather than silently falling back to `full`. Precedence is the usual
**CLI > workspace.yaml > built-in default**.

The error log is **never** affected: a failed step keeps its full `input`/`output` in
`<run-id>.error.ndjson` under every value, so `off` never costs you the diagnostics for the
step that actually failed — only the record of the ones that succeeded. `run.end`'s
`steps_total`/`steps_failed` are unaffected too, so `workspace status` still reports correct
step counts under `off`. `--output ndjson` is written through the same route as the log file,
so it honours this policy as well — the raw stdout stream and the file agree under all three
values. `-v`/`-vv` are a different axis: they change what `pretty` output *renders* for a
human, not what the stream *contains*, so `-vv` still prints `in:`/`out:` under
`--log-steps off`. This is a detail dial, not a log level — `step.start`/`step.end` carry no
`level` field to threshold on in the first place.

**Stopping a run (SIGTERM/SIGINT).** A long-looping workflow — the supported
run-forever pattern — is stopped by signalling the `run` process, and that stop leaves an
honest record rather than a truncated one. On the first SIGTERM or Ctrl-C, `run` prints one
dim line to stderr, starts no new step, abandons any step handler still blocked mid-flight,
writes a final `run.end` with `outcome: "interrupted"` (no severity — an operator stop is
not an alarm), flushes every sink, marks the registry entry with the terminal
`interrupted` status (§1.4), and exits with the shell convention 128+signum: **143** for
SIGTERM, **130** for SIGINT. A second signal force-quits immediately. Only SIGKILL — which
gives the process no chance to write anything — still shows up as `crashed` in `runs list`;
the two are deliberately distinguishable.

**Failing a run on purpose (exit 1).** A workflow that refuses to proceed — a precondition
that is not met, a state a bot must not trade from — ends with `control-flow/halt` carrying
`fail: true`, which writes a `run.end` of `outcome: "error"` with the author's `reason` as
its message and exits **1**, exactly as any other failed run does
(see `/runner`'s FORMAT.md, "`steps`"). This is the signal a
supervisor reads: without it a refusal exits 0, and a `Restart=always` policy hot-loops on
it. A plain `halt` (no `fail`) still exits **0** — finishing early is not failing. Note the
recap of a deliberate failure reads `failed=0`: no *step* failed, the **run** did.

**Blocked vs. dead (`--heartbeat`).** A step blocked for minutes — a websocket feed
waiting for a tick — looks identical to a hung process from outside. While a step is in
flight, the producer emits `run.heartbeat` (`step`, `in_flight_ms`) on an interval; `pretty`
mode renders it as an ephemeral, dimmed "still running" line, and it rides the same NDJSON
file and OTel bridge as everything else (see the [runner README §4.3](../rawbox-runner/README.md#43-runheartbeat--blocked-vs-dead)).

| Flag | Effect |
| --- | --- |
| *(default)* | Heartbeats roughly every 10 seconds while a step runs. |
| `--heartbeat <ms>` | Sets the interval explicitly. |
| `--heartbeat 0` | Disables heartbeats entirely. |

```bash
# Heartbeat every 5s instead of the ~10s default
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --heartbeat 5000

# No heartbeats at all
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --heartbeat 0
```

**Hung before the first step (`--preflight-timeout`).** A heartbeat only fires while a
step is in flight, and there is one thing a run does before it has any step: it imports
every step's definition module. A plugin that blocks at import — a top-level `await` that
never settles, a socket opened at evaluation — hangs there, and the stream stops after
`run.start` with no heartbeat, no `step.start` and no `run.end`, which `workspace status`
cannot tell from a slow startup. A step's own `timeoutMs` cannot cover it: that bound is
declared inside the contract, and the contract is unreadable until the module has loaded.
So the bound is the operator's, not the author's.

| Flag | Effect |
| --- | --- |
| *(default)* | The whole preflight load must finish within 30 seconds. |
| `--preflight-timeout <ms>` | Sets the bound explicitly. |
| `--preflight-timeout 0` | Disables the bound — the run waits forever, as it did before this flag existed. |

Unlike `--heartbeat`, this default can *end* a run, and that asymmetry with a step's
`timeoutMs` (which defaults to no bound at all) is deliberate: a step may block for hours
by design, but evaluating a module has no legitimate reason to block, so 30 seconds is a
backstop against a hang rather than a budget a healthy plugin has to fit inside. When it
expires, the run fails with an ordinary error `run.end` whose message names **which step
and which definition path** were being loaded, and whose `timed_out`/`timeout_ms` fields
are what distinguish "your plugin hung at import" from "your plugin failed to import" —
two failures with the same event shape and different remedies.

```bash
# Give a slow, cold-start plugin two minutes to load
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --preflight-timeout 120000

# Wait forever, as before this flag existed
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --preflight-timeout 0
```

**OpenTelemetry (`--otel`).** The same event stream has a third consumer: an OTLP exporter
that turns the run into one trace (a root `rawbox.workflow.run` span, one child span per
step execution), correlated log records, and two metrics. Attribute names, the sampling
recommendation for long-looping workflows, and the embedding API are documented in the
[runner README §6](../rawbox-runner/README.md#6-opentelemetry).

| Flag | Effect |
| --- | --- |
| *(default)* | Exports only when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set — otherwise no OpenTelemetry SDK is loaded at all. |
| `--otel` | Always exports, defaulting to the OTLP spec's own `http://localhost:4318`. |
| `--no-otel` | Never exports, even with those env vars set. |

Endpoints, headers, timeouts, service name and sampling all come from the standard
`OTEL_*` environment variables — no rawbox-specific knobs — so this points at a local
collector, Jaeger, Tempo or a vendor endpoint by following that project's own OTLP
quickstart. The exporter speaks OTLP over HTTP, and the run's exporters are flushed before
the command exits.

```bash
# Export to a locally running collector / Jaeger / Tempo on the OTLP default port
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml --otel

# Point somewhere else, with auth, and sample 5% of runs whole
export OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.example.com
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer $TOKEN"
export OTEL_TRACES_SAMPLER=parentbased_traceidratio OTEL_TRACES_SAMPLER_ARG=0.05
rawbox-cli run workspaces/live-trading/workflows/example.workflow.yaml
```

---

### 1.4. Observability: the Run Registry (`runs`)

Every `workflow run` writes a small JSON record — **the run registry** — at
`<resolved target folder>/runs/<run-id>.json`, alongside the NDJSON log it has always
written. It exists to answer three questions the log alone cannot: what runs exist at all,
which are still alive, and how much history has accumulated. Both the registry and the
logs live under the workspace's target folder (`.rawbox/` by default), so deleting that
folder to force a fresh plugin install also wipes the run history with it — `runs prune`
(below) is the intended way to trim history.

**Written before preflight, on purpose.** The entry is created the moment a run has an id
and its log paths — *before* `runWorkflowInstance` even runs its own preflight (workspace,
workflow, lock, plugin resolution) — with `status: "bootstrapping"`. A run that dies during
that preflight (an invalid document, a lock mismatch, an unresolvable plugin) is therefore
visible as a stalled `bootstrapping` entry rather than silently absent. From there `status`
advances to `running` at `run.start`, then to one of four terminal values at the end:
`ok`, `error`, `interrupted` (a graceful SIGTERM/SIGINT stop that still wrote its
`run.end` — see §1.3.C, "Stopping a run"), or `bootstrap-failed` (a preflight stage that
failed *after* `run.start` — `lock`/`resolve`/`seed-validation`/`store`/`seed` all can — takes
this status even though a `run.end` follows it).

**Crash detection.** A `bootstrapping`/`running` entry is only reported as such when its
`pid` **and** the process's start time both match a freshly-probed live process — a bare
`kill(pid, 0)` would report a crashed run as alive the day its pid number gets reused.
Anything else (dead pid, or a live pid whose start time has moved on) is reported
**`crashed`**. On Linux the start time comes from `/proc/<pid>/stat` (field 22, converted
via `/proc/uptime`); elsewhere it falls back to a wall-clock estimate, compared with a
tolerance rather than exact equality.

```bash
# Every run this project has recorded, scanned project-wide from the current directory
rawbox-cli runs list

# Scoped to one workspace
rawbox-cli runs list workspaces/live-trading/workspace.yaml

# Machine-readable, for a supervisor or a dashboard
rawbox-cli runs list --output json
```
```text
RUN ID                       WORKFLOW  STATUS   AGE  DURATION  STEPS
run-1786300000000-ab3fq      example   ok       2m   812ms     2/2
run-1786299000000-x7k2p      example   crashed  1h   -         1/2
```

**`runs show <run-id>`** prints the registry entry plus a summary derived from that run's
NDJSON log — event counts by kind, the last event, and the last error — without the caller
ever needing to locate the log file:
```bash
rawbox-cli runs show run-1786300000000-ab3fq
```

**`runs tail <run-id> [-f]`** prints (and, with `-f`, follows) that run's log, resolved
from the run id alone — the same "no path required" property as `show`:
```bash
rawbox-cli runs tail run-1786300000000-ab3fq -f
```

**`runs prune`** deletes registry entries *and* their log files — **every segment of them**,
not just the paths the registry names — down to a bound, so `.rawbox/runs/`+`.rawbox/logs/`
never grow forever. Three bounds compose (newest-first): `--older-than` drops anything past
an age cutoff, `--keep` then trims to the newest N of what remains, and `--max-bytes` — **the
primary bound when it is set** — trims further until the surviving set's total bytes fit,
even cutting an entry the other two would have kept (it always keeps at least the single
newest run, though, even if that one alone is over budget). The same pass also runs
opportunistically, bounded and silently, at the start of every `workflow run` — no separate
cron job is needed to keep the directory in check.

**A live run is never pruned.** Before any bound is applied, every entry is classified with
the same `pid` + `pid_started_at` probe `runs list` uses for crash detection, and an entry
whose process is alive is exempt from all three bounds — an inconclusive or failing probe
counts as alive, since deleting a file still being written is unrecoverable while keeping one
too long is not. That exemption is what makes the opportunistic pass safe in a workspace
shared with long-running daemon workflows: starting one run there does not delete its
siblings' history out from under them. A live run's bytes are still *charged* against
`--max-bytes` — exempt from deletion, not from accounting — so live runs alone can leave a
directory over budget, which is the honest outcome rather than one bought by unlinking a file
in use. A log file a surviving entry still points at is never removed either, which matters
when two runs were pointed at one path with `--log-file`.
```bash
# Explicit bounds
rawbox-cli runs prune workspaces/live-trading/workspace.yaml --keep 50 --max-bytes 52428800

# Every workspace found under the current directory, each using its own workspace.yaml
rawbox-cli runs prune
```

Defaults for `keep`/`older-than`/`max-bytes` come from the **workspace document's
`logs.prune:` block** (FORMAT.md, "`logs.prune`") — the untyped `rawbox.config.json` these
bounds used to live in is gone, along with its habit of silently discarding a mistyped value:
```yaml
# workspace.yaml
logs:
  prune:
    keep: 50
    olderThanDays: 14
    maxBytes: 52428800
```
Precedence is **CLI flag > `logs.prune:` > built-in default**, decided per bound, so a
`--max-bytes` on the command line composes with a `keep:` in the document rather than
replacing the whole block. Run with no workspace argument, each `.rawbox/runs` directory
found under the current directory answers for itself, using the workspace document beside it;
one whose document cannot be found or loaded falls back to the built-in default for that
target folder alone rather than failing the scan.

`keep` is the bound **always in effect**: with nothing configured anywhere it resolves to
**20**, so even an unconfigured workspace has a ceiling. There is deliberately **no built-in
`maxBytes` fallback** — the old unconditional 50 MB one is retired. Segment rotation now gives
every run a ceiling of its own (`logs.rotate.maxBytes * logs.rotate.maxFiles`, 1 GiB at the
defaults), which makes a *directory's* ceiling naturally a run count: the worst case is
`keep * rotate.maxBytes * rotate.maxFiles` = 20 GiB at the defaults, reached only by
daemon-shaped workflows that actually fill their rotation budget. Twenty short runs — a CI
job, a scaffolded example — cost well under a megabyte between them.

---

### 1.5. Observability: Storage Inspection (`store`)

`@rawbox/store` has no read path outside a running workflow — the LMDB environment behind
a workspace is otherwise a black box between runs and during them. `store list`/`get`/
`watch` are that read path, built entirely on the store package's read-only, out-of-process
observers (see
[rawbox-store/README.md §1.E](../rawbox-store/README.md#e-observation--peek-is-not-get)).

**Never a read-write store.** The in-process store's own inspection methods share its
read-write database lifecycle — peeking at a workflow with no database yet *creates* the
(empty) database. `BoxObserverLmdb` opens `readOnly: true` and cannot write at all, so
pointing it at a workspace that has never run is an error rather than a side effect. Every
`store` command uses an observer exclusively.

**A workspace declaring `backends:` is read from more than one place.** `BoxObserver` (LMDB,
synchronous) and `BoxObserverAsync` (Redis) are deliberately two different interfaces, so
these commands open one of each kind — the LMDB environment, plus one `BoxObserverRedis` per
entry of the workspace document's `backends:` map — and merge the results
(`src/store/observers.ts`). No new flag is involved: the backends come from the document.
A backend whose
connection cannot be resolved (an unset `${VARIABLE}`) or reached (server down) is reported as
a **warning and excluded from the merge** rather than failing the command — a workspace with a
live LMDB environment and one unreachable Redis server should still show what it can. A
workspace with no `backends:` block takes the pre-existing LMDB-only path untouched.

**No write or delete flag exists anywhere in this group, on purpose.** `store` inspects;
mutating state by hand is out of scope, and the fix for a value you want to change is the
workflow that owns it.

**The `<workspace-or-path>` argument is validated before it can reach the store.**
`BoxObserverLmdb.openSync(workspace, rootUrl)` resolves the environment directory with
`new URL('./' + workspace + '/', rootUrl)`, so a `workspace` string containing a path
separator or `..` could otherwise walk outside the intended data root — a hazard the store
package documents and defers to its callers to close. `rawbox-cli` is that boundary:

- A **bare name** (`live-trading`) is rejected outright if it contains `/`, `\` or `..`,
  then looked up under a `.rawbox/data` root discovered by scanning the current directory —
  exactly one match is required; more than one, or none found anywhere, is reported rather
  than guessed.
- A **path to a workspace document, or its directory**, is resolved the same way `runs
  list --workspace` resolves one (`resolveTargetFolder`/discovery), and its declared
  `name:` is validated too — a malicious or malformed document is exactly as much a hazard
  as a malicious CLI argument.

**Friendly empty states.** A workspace with no LMDB environment yet (nothing has run) is
not an error for `store list`: it prints an informational message and exits `0`. Nor is it on
its own a reason to call the workspace empty — a workspace whose keys are all Redis-backed
legitimately has no LMDB environment at all, so what counts is whether the merged observer set
found anything. `store get` always exits non-zero on the same condition — it was asked for a
specific value, and a script needs to be able to tell "key found" from "nothing here yet"
apart from a real crash.

#### A. List Storage Keys (`store list`)
Every key a workspace has actually written: key, workflow, strategy, byte size (the
**uncompressed** bytes `valueSizeMax` is checked against, never on-disk bytes — see
rawbox-store/README.md §1.C for why compression makes those differ), and, for a FIFO, its
depth and capacity.

When the workspace document is resolvable (a document/directory argument, or a bare name
whose sibling document was also found), each row is joined against the **declared**
`valueSizeMax`/`queueSizeMax` for that key — the runtime counterpart to `verify`'s static
budget report. A key bound only by a step and declared nowhere in `storage:` falls back to
`storage.defaultStrategy`, exactly as the runner resolves it, and is labelled `bound`
rather than `declared`; a key present in the store but named by no `storage.keys` entry and
no step binding is `undeclared` — the runtime drift `verify` cannot see because it never
opens the store.
```bash
rawbox-cli store list workspaces/live-trading/workspace.yaml
rawbox-cli store list live-trading --workflow grid
rawbox-cli store list live-trading --output json
```
```text
KEY            WORKFLOW  STRATEGY   SIZE (bytes)  DECLARED MAX  SOURCE      DEPTH/CAP
grid_state     grid      lmdb-kv    128           1900          declared    -
order_queue    grid      lmdb-fifo  512           1900 / q1024  declared    3/1023
scratch_notes  grid      lmdb-kv    64            -             undeclared  -
```

#### B. Read One Key (`store get`)
Prints a single key's value — pretty-printed, or `--output json`. Non-destructive under every
strategy: a queue key is **peeked**, never dequeued (a real `get` would consume it —
rawbox-store/README.md §1.E is the whole reason this command exists), so running it any
number of times leaves the queue's depth and contents unchanged. A queue key prints its
depth plus every queued element, oldest first (index `0` is what the next real dequeue
would return). A large text value is truncated by default; pass `--full` for the whole thing.
```bash
rawbox-cli store get live-trading grid grid_state
rawbox-cli store get live-trading grid order_queue --full
rawbox-cli store get live-trading grid order_queue --output json
```

#### C. Watch for Changes (`store watch`)
Polls a workspace's storage on an interval and prints keys whose value changed since the
previous poll, with timestamps; `--output json` streams one change record per line. A `key`
selector is `<workflow>:<key>` (`:` cannot appear in either half — the key character set
`[A-Za-z0-9_.-]+` excludes it); give none to watch every key currently in the workspace,
re-discovered on every poll so a key that appears later is picked up rather than missed.

**Snapshot hygiene, not staleness, is why this command is shaped the way it is.** An LMDB
read transaction pins an MVCC snapshot, and a snapshot left pinned stops the *writers'*
environment from reclaiming pages — so a naive watcher would not just see old data, it
would make someone else's store grow without bound. `store watch` follows
`BoxObserverLmdb`'s documented contract exactly: one observer opened for the whole watch,
its synchronous methods called again on every poll, nothing held open in between. Each
call resets its own read transaction before returning, so a `store watch` left running for
hours costs one reader slot and pins nothing. A Redis backend has no snapshot for a round
trip to pin, and is polled through the same one-observer, one-call-per-poll shape.
```bash
rawbox-cli store watch live-trading grid:grid_state reconciler:last_run --interval 2000
rawbox-cli store watch live-trading --output json | jq .
```

---

### 1.6. Observability: the Workspace View (`workspace status` / `workspace logs`)

`runs` and `store` each answer a question about one run, or one workspace's storage — but
a system built from more than one cooperating workflow needs a view that joins them:
"what is my whole workspace doing right now", and "what happened, across every workflow,
around the time things went wrong". `workspace status` and `workspace logs` are that view,
assembled entirely out of `runs`/`store`'s own surfaces — the run registry, its liveness
classification, the NDJSON log reader, and `BoxObserverLmdb` — never a second source of
truth.

**The `[path]` argument** is resolved the same way for both commands: a path to the
workspace document, a directory holding exactly one, or (`workspace logs` only) a bare
name under a discovered data root — the same resolution `store` commands use
(§1.5's "The `<workspace-or-path>` argument is validated before it can reach the store").
Omit it to look for a document directly inside the current directory. `workspace status`
does **not** accept a bare name: it needs the resolved document itself to read
`workflowPathList` from, which a bare name (an LMDB environment identifier, not a file)
cannot supply.

#### A. One Snapshot of the Whole System (`workspace status`)

Every workflow the workspace document lists, in one table: its latest recorded run
(registry) with **liveness** — `running`/`bootstrapping` only with a verified live pid,
otherwise `crashed`/`ok`/`error`/`bootstrap-failed`, exactly `runs list`'s own rule — its
age, the last event kind and timestamp off that run's NDJSON tail, step ok/failed counts,
and its last error message if any. A workflow the workspace lists but that has never
produced a single run is shown as `never run` rather than omitted. Below the table, a
compact storage panel: every key currently in the workspace's storage, by workflow, with its
byte size and — for a queue — its depth, through the same observer set `store list` uses, so
a workspace declaring `backends:` shows its Redis-held keys here too (§1.5).

When the tail's last event is a `run.heartbeat` — a step blocked for a while rather than
finished — the `LAST EVENT` column renders **"in `<step>` for `<duration>`"** instead of
the bare `run.heartbeat @<ts>` a generic render would show, e.g. `in websocket-wait for
4m`: the one piece of "is this alive or dead" information `workspace status` exists to
surface (see the [runner README §4.3](../rawbox-runner/README.md#43-runheartbeat--blocked-vs-dead)).

```bash
rawbox-cli workspace status workspaces/live-trading/workspace.yaml
rawbox-cli workspace status workspaces/live-trading --output json
```
```text
Workspace "live-trading" — /abs/path/workspaces/live-trading/.rawbox
generated 2026-08-09T10:15:00.000Z

WORKFLOW     STATUS     AGE  LAST EVENT               STEPS  LAST ERROR
grid         running    4s   step.end @10:14:56.120Z  2/3    -
reconciler   crashed    1h   run.end @09:03:33.000Z    5/5    -
risk-monitor never run  -    -                         -      -

STORAGE
  grid:
    KEY          STRATEGY   SIZE (bytes)  DEPTH
    grid_state   lmdb-kv    128           -
    order_queue  lmdb-fifo  512           3
  reconciler:
    KEY       STRATEGY  SIZE (bytes)  DEPTH
    last_run  lmdb-kv   64            -
```

`--watch [ms]` re-renders this panel on an interval instead of printing once — clears and
redraws the terminal (no TUI library), so a separate terminal can be left open as a live
dashboard for a multi-workflow system, watched without reading a line of raw NDJSON:
```bash
rawbox-cli workspace status workspaces/live-trading --watch        # every 2000ms
rawbox-cli workspace status workspaces/live-trading --watch 5000   # every 5s
```

#### B. Merged Logs Across Workflows (`workspace logs`)

Every selected run's NDJSON log, merged into one timestamp-ordered stream — the
`docker compose logs` shape — one line per event: `HH:MM:SS.mmm [workflow] event summary`,
coloured per workflow (`picocolors`; respects `NO_COLOR`). Ordering is a **stable sort on
`ts`, tiebroken by `run_id`** — two events sharing an instant are ordered deterministically
rather than by scan order. **Cross-process clock skew between the runs being merged is not
corrected**: `ts` is trusted as each process recorded it.

**Run selection**, tried in this order:
1. **`--run <id>…`** — exactly those runs, by registry id, **including already-finished
   ones**. This is the point of the whole command: reconstructing "the grid decided X, then
   the reconciler did Y" after both have exited is a first-class, fully-supported case, not
   a degraded one — it merges through the exact same reader a live run uses.
2. **`--since <t>`** — every run whose lifetime overlaps `[t, now]`, finished or not: `t` is
   an ISO-8601 instant or a relative shorthand (`15m`, `2h`, `90s`, `1d`). A run is selected
   by its *lifetime* overlapping the window, then shown in full — an old `run.start` from a
   long-lived still-live run is not trimmed off, since that context is exactly what a
   post-mortem read needs.
3. **Neither given** (the default) — every run the registry currently reports
   `running`/`bootstrapping` **with a verified live pid** — "what is happening right now".

`--workflow <name>…` narrows whichever of the above was selected, by the registry's own
`workflow` field. Repeatable, as is `--run`.

```bash
# Live, right now
rawbox-cli workspace logs workspaces/live-trading

# Only two workflows' live runs
rawbox-cli workspace logs workspaces/live-trading --workflow grid --workflow reconciler

# Post-mortem: two specific runs, one or both already finished
rawbox-cli workspace logs workspaces/live-trading --run run-1786299000000-x7k2p --run run-1786299001000-q2m9z

# Post-mortem: everything that was active in the last 15 minutes
rawbox-cli workspace logs workspaces/live-trading --since 15m

# Follow: live runs, plus any new run that starts while this is running
rawbox-cli workspace logs workspaces/live-trading -f

# Machine-readable — the merged raw event objects, one per line, for jq
rawbox-cli workspace logs workspaces/live-trading --since 1h --output json | jq 'select(.event == "log")'
```
```text
10:14:55.000Z [grid] run.start
10:14:55.010Z [reconciler] run.start
10:14:56.120Z [grid] step.end sleep-step outcome=ok 1ms
10:14:56.900Z [reconciler] step.end reconcile outcome=error error="stale price"
10:14:57.000Z [reconciler] run.end outcome=error steps=4/5 812ms error="stale price"
```

`-f`/`--follow` polls every selected run's log for appended lines (never holding a
transaction or a file handle open across polls) and keeps merging them in order; in the
default and `--since` modes a run that newly starts (or newly enters the `--since` window)
while following joins the merge automatically — `--run`'s explicit list never grows.

---

## 2. Typical Sequence

```bash
rawbox-cli workspace create --name live-trading
rawbox-cli workspace verify workspaces/live-trading/workspace.yaml
rawbox-cli workflow verify workspaces/live-trading/workflows/example.workflow.yaml
rawbox-cli workflow lock workspaces/live-trading/workflows/example.workflow.yaml
rawbox-cli workflow run workspaces/live-trading/workflows/example.workflow.yaml
```

`workspace setup` is not in this list: `workflow run` installs any plugin that does not
already resolve before running (§1.3.A/C). Add it back explicitly when you want the
install to happen as its own step — e.g. before `workflow lock`, or in CI ahead of time.

---

## 3. Bundled Assistant Skills

`project create` also writes `.agents/skills/`, teaching AI code assistants this project's
conventions: plugin creation, operation creation, workflow creation, and how the overall
layout fits together. The skill sources live in
[`src/templates/skills/`](src/templates/skills/).

---

## 4. Development

### Build
Compiles TypeScript, copies `.ejs` / `.md` templates into `dist/`, and marks the entry point
executable:
```bash
npm run build
```

> [!IMPORTANT]
> The repo-root `npm run build:all` is `tsc --build`, which compiles the TypeScript and
> **nothing else**. The scaffolding templates `project create`, `plugin create` and
> `operation create` read from `dist/templates/` are copied only by this package's own
> `build` script, so run it (`npm run build --workspace @rawbox/cli`) after a fresh clone.

### Test
```bash
npm test          # vitest run tests
npm run test-bin  # build, then invoke the compiled binary
```
