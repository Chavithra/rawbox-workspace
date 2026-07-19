# rawbox-plugin-default

`rawbox-plugin-default` contains the core set of default operations and control flow definitions bundled out-of-the-box with the Rawbox Framework.

---

## 1. Exposed Operations

Operations take an input record and produce an output record or a schema-conforming
error (`{ message: string }` for every entry below).

### Timing (`./time/`)

| Definition Path | Input | Output | Purpose |
| --- | --- | --- | --- |
| `./time/sleep.definition.js` | `ms` (Number ≥ 0) | `timestamp` (Number) | Pause execution for a fixed delay. |
| `./time/workflow-throttle.definition.js` | `ms` (Number ≥ 0), `lastTimestamp?` (Number) | `throttledMs`, `timestamp` (Number) | Wait only the remaining time since `lastTimestamp` — rate-limits a loop. |

### Data Plumbing (`./data/`)

| Definition Path | Input | Output | Purpose |
| --- | --- | --- | --- |
| `./data/echo.definition.js` | `value` (Any) | `value` (Any) | Identity — copy/rename a storage key or seed a constant. |
| `./data/compare.definition.js` | `a`, `b` (Any), `operator` (`eq`\|`ne`\|`gt`\|`gte`\|`lt`\|`lte`) | `result` (Boolean) | Produce the boolean that `branch` consumes. `eq`/`ne` are strict; ordering requires two numbers or two strings (else error). |
| `./data/logic.definition.js` | `operator` (`and`\|`or`\|`not`), `values` (Boolean[]) | `result` (Boolean) | Combine conditions. Empty `and`/`or` and multi-value `not` fail explicitly. |
| `./data/increment.definition.js` | `value` (Number), `step?` (Number, default 1) | `value` (Number) | Loop-counter companion to `loop-gate` (see the loop pattern below). |
| `./data/assert.definition.js` | `condition` (Boolean), `message?` (String) | `passed` (Boolean) | Succeeds when true; otherwise fails the step with `message` (default `"Assertion failed"`). |

### Observability (`./observability/`)

| Definition Path | Input | Output | Purpose |
| --- | --- | --- | --- |
| `./observability/log.definition.js` | `level` (`debug`\|`info`\|`warn`\|`error`), `message` (String), `data?` (Any) | `timestamp` (Number) | Write one structured JSON line to the local log via `console.<level>`. Circular `data` degrades to `"[unserializable]"` without failing the step. |

> Built-in observability writes to the **local log only**. Anything that ships
> telemetry to external systems (StatsD, OTLP, webhooks) belongs in community
> plugins — this package stays zero-dependency.

---

## 2. Exposed Control-Flows

Control-flows take an input record and return a jump target. Their output is fixed
by the framework to `{ label: string }` — they have no output schema of their own and
can never mutate storage. Returned labels may be step labels or the reserved labels
`__START__`, `__END__`, `__EXIT__`.

| Definition Path | Input | Jump Behavior |
| --- | --- | --- |
| `./control-flow/definitions/jump.definition.js` | `condition` (Boolean), `label` (String) | Always jumps to `label` (the `condition` field is currently ignored — prefer `branch`). |
| `./control-flow/definitions/branch.definition.js` | `condition` (Boolean), `thenLabel`, `elseLabel` (String) | Real if/else: `thenLabel` when true, `elseLabel` when false. |
| `./control-flow/definitions/switch.definition.js` | `value` (String), `caseMap` (Record<String, String>), `defaultLabel` (String) | Multi-way dispatch: the label mapped to `value` (own properties only), else `defaultLabel`. |
| `./control-flow/definitions/loop-gate.definition.js` | `counter`, `max` (Number), `loopLabel`, `exitLabel` (String) | `loopLabel` while `counter < max` (strict), else `exitLabel`. |
| `./control-flow/definitions/halt.definition.js` | `reason?` (String) | Terminates the workflow (`__EXIT__`), logging `reason` first when provided. |

---

## 3. Canonical Loop Pattern

Control-flow definitions have no `outputSchema` — the framework fixes their output to
`{ label: string }` — so a control-flow gate can never increment its own counter.
State changes belong to **operations**; jump decisions belong to **control-flows**.
Loops in Rawbox are therefore always a **two-step idiom**:

1. **`./data/increment.definition.js`** (operation) reads the counter and writes
   `value + step` back. The wiring trick: point the step's
   `storageLocation.input.value` and `storageLocation.output.value` at the **same
   storage key**, so the counter accumulates across iterations.
2. **`./control-flow/definitions/loop-gate.definition.js`** reads that same key as
   `counter` and jumps back to `loopLabel` while `counter < max`, otherwise to
   `exitLabel`.

### Worked Example

The fragment below runs `loop-body` exactly `max` times (strict `<`, so seeding the
counter at `0` yields `max` iterations), then exits:

```yaml
stepList:
  - label: loop-body
    definitionLocation:
      contractRegistryHash: "<hash-of-default-plugin-registry>"
      definitionPath: ./time/sleep.definition.js
    storageLocation:
      input:
        ms: { key: loop_sleep_ms }
      output:
        timestamp: { key: loop_sleep_timestamp }
  - label: increment-counter
    definitionLocation:
      contractRegistryHash: "<hash-of-default-plugin-registry>"
      definitionPath: ./data/increment.definition.js
    storageLocation:
      input:
        value: { key: loop_counter }
      output:
        value: { key: loop_counter }
  - label: loop-check
    definitionLocation:
      contractRegistryHash: "<hash-of-default-plugin-registry>"
      definitionPath: ./control-flow/definitions/loop-gate.definition.js
    storageLocation:
      input:
        counter: { key: loop_counter }
        max: { key: loop_max }
        loopLabel: { key: loop_label }
        exitLabel: { key: loop_exit_label }
```

Seed `loop_counter` with `0`, `loop_max` with the desired iteration count,
`loop_label` with the string `"loop-body"`, and `loop_exit_label` with the reserved
label `"__EXIT__"` (or the label of whatever step should run after the loop) before
starting the workflow.

### Related Pieces

* **`branch`** (`./control-flow/definitions/branch.definition.js`) — jump on a
  single boolean condition.
* **`switch`** (`./control-flow/definitions/switch.definition.js`) — multi-way
  dispatch on a string value.
* **`halt`** (`./control-flow/definitions/halt.definition.js`) — early
  termination; returns the reserved `__EXIT__` label directly.
* **Reserved labels**: `__START__` (jump to the first step), `__END__` (jump to the
  last step), `__EXIT__` (terminate the workflow) — recognized by the runner for
  any control-flow's returned `label`.

> **Registry hash note:** adding new definitions changes the plugin's contract
> registry hash. Recompute it with
> `npx rawbox-cli registry hash packages/rawbox-plugin-default/src/contract-registry.ts`
> and update any workflow YAML that references the old hash.

---

## 4. Usage

To use these default operations in your workflow configurations, reference this package inside your workflow's `pluginPathList` and set the steps' `definitionLocation`:

```yaml
name: throttle-workflow
pluginPathList:
  - rawbox-plugin-default
stepList:
  - label: throttle-step
    definitionLocation:
      contractRegistryHash: "<hash-of-default-plugin-registry>"
      definitionPath: ./time/workflow-throttle.definition.js
    storageLocation:
      input:
        ms: { key: 100 }
      output:
        throttledMs: { key: 101 }
        timestamp: { key: 102 }
```
