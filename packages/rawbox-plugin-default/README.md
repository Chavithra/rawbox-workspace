# rawbox-plugin-default

`@rawbox/rawbox-plugin-default` contains the core set of operations and control-flows
bundled out-of-the-box with the Rawbox Framework.

A workflow reaches them by declaring the package under `plugins:` and naming an
**operation path** on a step. The path is the definition path without its `./` prefix and
`.definition.js` suffix — `operation: time/sleep` addresses
`./time/sleep.definition.js`.

```yaml
plugins:
  "@rawbox/rawbox-plugin-default": "^0.1.0"
```

The document rules the examples below follow — bindings name storage keys and never carry a
value, a control-flow step declares no `outputs:` — are defined by `@rawbox/runner`'s
document schemas ([rawbox-runner README §2.1–2.2](../rawbox-runner/README.md#21-binding-forms)).

---

## 1. Exposed Operations

Operations take an input record and produce an output record or a schema-conforming
error (`{ message: string }` for every entry below).

### Timing (`time/`)

| `operation:` | Input | Output | Purpose |
| --- | --- | --- | --- |
| `time/sleep` | `ms` (Number ≥ 0) | `timestamp` (Number) | Pause execution for a fixed delay. |
| `time/workflow-throttle` | `ms` (Number ≥ 0), `lastTimestamp?` (Number) | `throttledMs`, `timestamp` (Number) | Wait only the remaining time since `lastTimestamp` — rate-limits a loop. |

### Value Operations (`value-ops/`)

| `operation:` | Input | Output | Purpose |
| --- | --- | --- | --- |
| `value-ops/echo` | `value` (Any) | `value` (Any) | Identity — copy or rename a storage key. |
| `value-ops/compare` | `a`, `b` (Any), `operator` (`eq`\|`ne`\|`gt`\|`gte`\|`lt`\|`lte`) | `result` (Boolean) | Produce the boolean that `branch` consumes. `eq`/`ne` are strict; ordering requires two numbers or two strings (else error). |
| `value-ops/logic` | `operator` (`and`\|`or`\|`not`), `values` (Boolean[]) | `result` (Boolean) | Combine conditions. Empty `and`/`or` and multi-value `not` fail explicitly. |
| `value-ops/increment` | `value` (Number), `step?` (Number, default 1) | `value` (Number) | Loop-counter companion to `loop-gate` (see the loop pattern below). |
| `value-ops/assert` | `condition` (Boolean), `message?` (String) | `passed` (Boolean) | Succeeds when true; otherwise fails the step with `message` (default `"Assertion failed"`). |

### Observability (`observability/`)

| `operation:` | Input | Output | Purpose |
| --- | --- | --- | --- |
| `observability/log` | `level` (`debug`\|`info`\|`warn`\|`error`), `message` (String), `data?` (Any) | `timestamp` (Number) | Emit one structured line into the host's run-event stream, falling back to `console.<level>` when there is no host. Circular `data` degrades to `"[unserializable]"` without failing the step. |
| `observability/snapshot` | `label?` (String), `value1`..`value8?` (Any) | `label?` (String), `snapshot` (Record<String, Any>), `count` (Number), `timestamp` (Number) | Emit whatever is bound to `value1`..`value8` as one `info`-level `log` event — the whole of a read-only monitor workflow. See §3.5 below. |

> **Where the line goes.** The operation calls `emitRunEvent({ event: 'log', … })`
> from `@rawbox/plugin` — the ambient host channel. Under `@rawbox/runner` a
> host is installed for the duration of a run, so the line joins the run's own
> NDJSON event stream with the same envelope as `step.start`/`step.end`, and any
> exporter the run has configured picks it up like any other event
> ([rawbox-runner README §4](../rawbox-runner/README.md)). Nothing about this
> plugin is special-cased: the host recognises the `log` **event kind** it owns,
> so any plugin may emit it. With no host — a unit test, a different embedder —
> the line still prints to `console.<level>` rather than vanishing.
>
> This package itself still ships **no telemetry**. Anything that talks to
> external systems (StatsD, OTLP, webhooks) belongs in the host or in community
> plugins — this one stays dependency-light.

---

## 2. Exposed Control-Flows

Control-flows take an input record and return a jump target. Their output is fixed
by the framework to `{ label: string, reason?: string }` — they have no output schema of
their own, so a control-flow step may not declare `outputs:` and can never mutate storage.
Returned labels may be step labels or the reserved labels `__START__`, `__END__`,
`__EXIT__`, `__FAIL__`.

| `operation:` | Input | Jump Behavior |
| --- | --- | --- |
| `control-flow/jump` | `condition` (Boolean), `label` (String) | Always jumps to `label` (the `condition` field is currently ignored — prefer `branch`). |
| `control-flow/branch` | `condition` (Boolean), `thenLabel`, `elseLabel` (String) | Real if/else: `thenLabel` when true, `elseLabel` when false. |
| `control-flow/switch` | `value` (String), `caseMap` (Record<String, String>), `defaultLabel` (String) | Multi-way dispatch: the label mapped to `value` (own properties only), else `defaultLabel`. |
| `control-flow/loop-gate` | `counter`, `max` (Number), `loopLabel`, `exitLabel` (String) | `loopLabel` while `counter < max` (strict), else `exitLabel`. |
| `control-flow/halt` | `reason?` (String), `fail?` (Boolean) | Terminates the workflow, logging `reason` first when provided. `__EXIT__` (clean) by default; `__FAIL__` when `fail` is true, which ends the **run** as a failure with `reason` as its message. |

#### Failing the run from a workflow

`fail: true` is the only way a document can end its run as a failure — a handler returning
`err(...)` is a *handled* step failure that writes the step's `errors:` bindings and lets
execution continue. A failing halt instead stops the run: the `run.end` reports
`outcome: "error"` and `npx rawbox-cli workflow run` exits non-zero, so a supervised loop
(`Restart=always`, CI, cron) sees a refusal for what it is instead of restarting on a clean
exit code.

```yaml
storage:
  keys:
    refusal_fail:
      seed: true
    refusal_reason:
      seed: there is no grid_state, but the symbol is ACTIVE

steps:
  - label: refuse
    plugin: "@rawbox/rawbox-plugin-default"
    operation: control-flow/halt
    inputs:
      reason: refusal_reason    # becomes run.end's error message
      fail: refusal_fail        # a plain Boolean input: seed it, or compute it
```

`fail` is a Boolean rather than a word so an earlier `value-ops/compare` or
`value-ops/logic` step can *decide* it — one halt step then ends the run either way,
with no `branch` in front of it. Omitting it halts cleanly, which is `halt`'s default
and a perfectly good ending: the step that halts is still reported `ok` either way, since
what failed is the run, not the step (FORMAT.md, "`steps`").

---

## 3. Canonical Loop Pattern

Control-flow definitions have no `outputSchema` — the framework fixes their output to
`{ label: string, reason?: string }` — so a control-flow gate can never increment its own
counter.
State changes belong to **operations**; jump decisions belong to **control-flows**.
Loops in Rawbox are therefore always a **two-step idiom**:

1. **`value-ops/increment`** reads the counter and writes `value + step` back. The wiring
   trick: point the step's `inputs.value` and `outputs.value` at the **same storage key**,
   so the counter accumulates across iterations.
2. **`control-flow/loop-gate`** reads that same key as `counter` and jumps back
   to `loopLabel` while `counter < max`, otherwise to `exitLabel`.

### Worked Example

The workflow below runs `loop-body` exactly `max` times (strict `<`, so seeding the counter
at `0` yields `max` iterations), then exits. Jump targets are seeded storage keys, read by
the step like every other input.

```yaml
kind: Workflow
formatVersion: "1.0"
name: counted-loop

plugins:
  "@rawbox/rawbox-plugin-default": "^0.1.0"

storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    loop_sleep_ms:
      seed: 100
    loop_counter:
      seed: 0
    loop_max:
      seed: 5
    loop_label:
      seed: loop-body     # the label to jump back to
    exit_label:
      seed: __EXIT__      # …or a reserved label to leave the loop

steps:
  - label: loop-body
    plugin: "@rawbox/rawbox-plugin-default"
    operation: time/sleep
    inputs:
      ms: loop_sleep_ms
    outputs:
      timestamp: loop_sleep_timestamp

  # Input and output point at the same key, so the counter accumulates.
  - label: increment-counter
    plugin: "@rawbox/rawbox-plugin-default"
    operation: value-ops/increment
    inputs:
      value: loop_counter
    outputs:
      value: loop_counter

  - label: loop-check
    plugin: "@rawbox/rawbox-plugin-default"
    operation: control-flow/loop-gate
    inputs:
      counter: loop_counter
      max: loop_max
      loopLabel: loop_label
      exitLabel: exit_label
```

Replace the `exit_label` seed with the label of whatever step should run after the loop
when the workflow is not meant to terminate there.

### Related Pieces

* **`branch`** — jump on a single boolean condition, usually fed by `value-ops/compare`.
* **`switch`** — multi-way dispatch on a string value.
* **`halt`** — early termination; returns the reserved `__EXIT__` label directly, or
  `__FAIL__` when its `fail` input is true.
* **Reserved labels**: `__START__` (jump to the first step), `__END__` (jump to the
  last step), `__EXIT__` (terminate the workflow), `__FAIL__` (terminate it as a
  failure) — recognized by the runner for any control-flow's returned `label`.

---

## 4. Monitor Workflow Pattern

`observability/snapshot` is a read-only monitor's whole job in one operation: bind other
workflows' storage keys to `value1`..`value8`, and it emits everything bound as **one**
structured `log` event —
`level: 'info'`, `data` keyed by field name — through the same run-event channel as
`observability/log`. Loop it on a throttle and a multi-workflow system becomes legible
from one terminal without a bespoke operation per project.

```yaml
kind: Workflow
formatVersion: "1.0"
name: system-monitor

plugins:
  "@rawbox/rawbox-plugin-default": "^0.1.0"

storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    monitor_interval_ms:
      seed: 2000
    monitor_label:
      seed: "grid + reconciler"
    monitor_loop_condition:
      seed: true
    monitor_loop_label:
      seed: snapshot

steps:
  - label: snapshot
    plugin: "@rawbox/rawbox-plugin-default"
    operation: observability/snapshot
    inputs:
      label: monitor_label
      value1: { key: position, workflow: grid }
      value2: { key: last_fill, workflow: grid }
      value3: { key: reconciled_at, workflow: reconciler }

  - label: throttle
    plugin: "@rawbox/rawbox-plugin-default"
    operation: time/workflow-throttle
    inputs:
      ms: monitor_interval_ms
    outputs:
      timestamp: monitor_last_run_at

  - label: loop
    plugin: "@rawbox/rawbox-plugin-default"
    operation: control-flow/jump
    inputs:
      condition: monitor_loop_condition   # jump ignores the value; a seed still must be Boolean
      label: monitor_loop_label
```

Each `value*` input is a `{ key, workflow }` **cross-workflow read** — the one binding
form that names another workflow's box
([rawbox-runner README §2.1](../rawbox-runner/README.md#21-binding-forms)) — so this
workflow never writes into `grid` or `reconciler`, only reads what they wrote. Only the
fields actually bound end up in the emitted `data`; leave `value4`..`value8` unbound and
they are simply absent, not `null`. The `throttle` + unconditional `jump` pair is the
same run-forever idiom as the loop pattern above, minus the counter: a monitor has no
exit condition of its own, so it throttles and jumps back to `snapshot` indefinitely
(replace `jump` with `branch` if the monitor should eventually stop).

To also let the monitor persist its own last snapshot — so, say, a dashboard can read
one key instead of tailing the log — add an `outputs:` binding on the same step:

```yaml
    outputs:
      snapshot: monitor_last_snapshot
      count: monitor_last_count
```

---

## 5. Contract Registry and Hashing

Every definition is registered in [`src/contract-registry.ts`](src/contract-registry.ts)
via `setupPluginRegistry({ operationsRecord, controlFlowRecord })`, which merges both
records into a single hashed registry and returns the two typed builders. The registry is
the package's `./contract-registry` export and its `default`.

Adding or changing a contract changes the registry's SHA-256 hash. **Workflows do not need
rebinding** — they name the package, not the hash — but a `rawbox.lock` pinned to the old
hash fails with a mismatch until it is regenerated:

```bash
# Inspect the current hash
npx rawbox-cli registry hash packages/rawbox-plugin-default/dist/contract-registry.js

# Re-pin the workspace lock after a contract change
npx rawbox-cli workflow lock workspaces/<workspace>/workflows/<workflow>.workflow.yaml
```

### Why nothing here declares a `timeoutMs`

A contract may declare a **bound** — how long the host lets its handler run before the
run is abandoned ([rawbox-plugin README §4D](../rawbox-plugin/README.md)). Not one
contract in this package does, and that is a decision rather than an omission: absent is
a first-class declaration meaning *deliberately unbounded*, and this package is the
clearest worked example of it. Every component here falls into one of two cases.

**Most of them are fully synchronous.** `value-ops/compare`, `value-ops/logic`,
`value-ops/increment`, `value-ops/assert`, `value-ops/echo`, `observability/log`,
`observability/snapshot` and every control-flow do their whole job without awaiting
anything outside the process. A bound cannot help there — the timer is a task on the same
event loop as the handler, so a handler that never yields never lets it fire. It would be
a field that reads like a safety guarantee and provides none.

**The two that do wait, wait for a duration that is their own input.** `time/sleep` waits
`ms`; `time/workflow-throttle` waits out the remainder of `ms` since `lastTimestamp`. The
bound and the work are the same number, supplied by the document, so a `timeoutMs` in the
contract could only ever agree with it (saying nothing) or disagree with it (breaking
every workflow whose `ms` is larger). Nothing here waits on a socket, a lock, or anything
a third party controls, which is the only situation a bound exists for.

A workflow may still bound any of these steps — `timeoutMs:` on a step needs no
cooperation from the contract — and that is the right layer for it, since the number
would come from other values seeded in the same document.

---

## 6. Development

```bash
npm run build       # rm -rf dist tsconfig.tsbuildinfo && tsc
npm test            # vitest run tests
npm run type-check  # tsc --noEmit
npm run lint        # eslint .
```
