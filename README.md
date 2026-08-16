# Rawbox Framework

Rawbox is a self-contained automation framework. You describe
automations as **declarative YAML workflows**; Rawbox runs them as state machines with
persistent, transactional storage — and both humans and code assistants can write,
verify and operate them.

---

## 1. Quick Start

```bash
npm install -g @rawbox/cli
rawbox-cli workspace create --name my-workspace
rawbox-cli run my-workspace/workflows/launch.workflow.yaml
```

Nothing to set up in between: the scaffolded workspace is runnable, and its missing plugins
are installed on the first run.

```text
WORKFLOW launch (workspace my-workspace) ·······································
    [info] T-minus 5
  ✔ tick                 observability/log                            0ms
  ✔ step-1               time/sleep                                 503ms
  ✔ step-2               value-ops/increment                          1ms
  ✔ step-3               value-ops/compare                            1ms
  ✔ step-4               control-flow/branch                          1ms
    [info] T-minus 4
     ⋮        (three more ticks)
    [info] T-minus 1
    [info] Workflow halted: 🚀 Liftoff!
  ✔ liftoff              control-flow/halt                            1ms

RECAP ········································· ok=26 failed=0 skipped=0  2586ms
```

---

## 2. How It Works

Two ideas carry the whole framework:

- **Workflows** are YAML documents: a list of typed **steps**, each calling one
  **operation** from a **plugin** (an npm package). Steps read inputs from and write
  outputs to named **storage keys**.
- **Workspaces** group workflows that cooperate: they share one storage environment, so
  one workflow can read what another wrote — that is how multi-process systems are built.

The generated example, abridged — plugins are declared like npm dependencies, every key is
declared once in `storage.keys` with everything it needs, and every step maps its fields to
those keys:

```yaml
kind: Workflow
formatVersion: "1.0"
name: launch

plugins:
  "@rawbox/rawbox-plugin-default": "^0.1.0"

storage:
  defaultStrategy: { name: lmdb-kv, valueSizeMax: 1900 }
  keys:
    t_minus: { seed: 5 }
    minus_one: { seed: -1 }
    zero: { seed: 0 }
    op_gt: { seed: gt }
    level: { seed: info }
    tick_msg: { seed: T-minus }
    tick_ms: { seed: 500 }
    label_tick: { seed: tick }
    label_liftoff: { seed: liftoff }
    liftoff_reason: { seed: 🚀 Liftoff! }

steps:
  - label: tick
    plugin: "@rawbox/rawbox-plugin-default"
    operation: observability/log
    inputs:
      level: level
      message: tick_msg
      data: t_minus
    outputs:
      timestamp: tick_at

  # time/sleep on tick_ms, value-ops/increment t_minus by minus_one, then
  # value-ops/compare writing its result to still_counting

  - plugin: "@rawbox/rawbox-plugin-default"
    operation: control-flow/branch
    inputs:
      condition: still_counting
      thenLabel: label_tick        # jump back to the labelled step — that is the loop
      elseLabel: label_liftoff
    errors:
      message: branch_error

  - label: liftoff
    plugin: "@rawbox/rawbox-plugin-default"
    operation: control-flow/halt
    inputs:
      reason: liftoff_reason
```

---

## 3. The Packages

| Package | What it does | Read its README for |
| --- | --- | --- |
| [@rawbox/cli](packages/rawbox-cli/README.md) | The command line: scaffold, verify, lock, run, observe | Every command, flag and output format |
| [@rawbox/rawbox-plugin-default](packages/rawbox-plugin-default/README.md) | Built-in operations and control flow | Operations, branching, the loop pattern, monitor workflows |
| [@rawbox/runner](packages/rawbox-runner/README.md) | The execution engine | Workflow/workspace documents, the run-event stream, OpenTelemetry |
| [@rawbox/store](packages/rawbox-store/README.md) | Transactional storage: cells and queues, one strategy per key | Storage strategies, sizing, the read-only observers |
| [@rawbox/plugin](packages/rawbox-plugin/README.md) | The plugin SDK | Writing your own plugins and operations |

---

## 4. The Documents

| Document | What it covers |
| --- | --- |
| [FORMAT.md](FORMAT.md) | The YAML grammar: every field and rule of a workflow and a workspace document |
| [OBSERVABILITY.md](OBSERVABILITY.md) | Every event kind in the NDJSON stream, every bootstrap stage, every run status |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Working *on* Rawbox: building the clone, the verification gates, testing what a consumer gets |

---

## 5. Watching It Run

A run narrates itself in the terminal and writes a structured NDJSON event log. Beyond
one run, the CLI answers the three operational questions directly:

| Command | Answers |
| --- | --- |
| `rawbox-cli runs list <workspace>` | What ran, what is alive, what crashed |
| `rawbox-cli store list <workspace>` | What state the system holds right now |
| `rawbox-cli workspace status <workspace>` | One live snapshot of every workflow and its storage |

Full tour — including merged multi-workflow logs, `store get`/`watch`, retention, and
OpenTelemetry export: [cli README §1.4–1.6](packages/rawbox-cli/README.md#14-observability-the-run-registry-runs).

---

## 6. Your Own Project

For real automations, scaffold a project monorepo — it separates your **code**
(`packages/`, your plugins) from your **config** (`workspaces/`, the YAML), and ships
skill files that teach AI code assistants how to extend it:

```bash
rawbox-cli project create --name my-rawbox-project
cd my-rawbox-project
npm run build:all
```

Ask your assistant for a plugin, an operation, or a workflow — the bundled skills in
`.agents/skills/` guide it through creating, testing and verifying each one. The
development loop is always the same:

```bash
npm run build:all && npm run test:all
rawbox-cli workflow verify <workflow.yaml>
rawbox-cli run <workflow.yaml>
```

---

## 7. License

BSD 3-Clause — see [LICENSE](LICENSE).

Every package in this monorepo ships under the same license.
