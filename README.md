# Rawbox Framework

Rawbox is a self-contained automation framework built for the AI era. It empowers developers and code assistants to design, connect, and manage automations — with a focus on high observability and simple maintenance.

---

## 1. Core Concepts

* **Operation**: A type-safe unit of work (`input → output | error`) validated at runtime by TypeBox schemas.
* **Control-Flow**: A decision mapping inputs to step labels (like `__START__` or `__END__`) to steer execution.
* **Rawbox-Plugin**: A modular package exposing operations and control-flows through a content-addressed registry.
* **Workflow**: A declarative state-machine whose steps map inputs, outputs, and errors to storage keys.
* **Workspace**: A YAML configuration registering workflows and their required plugin packages.
* **Rawbox-Project**: A standalone project directory housing both custom plugins (`packages/`) and configurations (`workspaces/`).

---

## 2. Core Packages

This repository (`rawbox-workspace`) is an **npm workspaces monorepo** housing the core packages:

| Package | Description |
| --- | --- |
| [rawbox-cli](packages/rawbox-cli/README.md) | Command-line interface for scaffolding projects, plugins, and operations, and for verifying/running workflows. |
| [rawbox-plugin](packages/rawbox-plugin/README.md) | Base plugin system defining, validating, and dynamically loading contract registries. |
| [rawbox-store](packages/rawbox-store/README.md) | Type-safe LMDB storage abstraction for KV/FIFO workflow state. |
| [rawbox-runner](packages/rawbox-runner/README.md) | Orchestration runner executing state-machine workflows with XState. |
| [rawbox-plugin-default](packages/rawbox-plugin-default/README.md) | Built-in operations (timing, data plumbing, observability) and control-flows (branch, switch, loop-gate, halt) available out of the box. |

---

## 3. Quick Start

Run the script below to install the framework and run an example sleep workflow with pre-configured schemas and inputs:

```bash
# --- Install and build -------------------------------------------------------
# Clone, install, and compile all core packages
git clone https://github.com/chavithra/rawbox-workspace.git
cd rawbox-workspace
npm install
npm run build:all

# Link the core packages globally so projects can resolve them locally
npm link ./packages/rawbox-plugin ./packages/rawbox-runner ./packages/rawbox-cli ./packages/rawbox-store ./packages/rawbox-plugin-default

# --- Scaffold a workspace with a runnable example workflow -------------------
npx rawbox-cli workspace create --name my-workspace

# --- Verify and run the generated example ------------------------------------
npx rawbox-cli workspace verify workspaces/my-workspace/workspace.yaml
npx rawbox-cli workflow verify workspaces/my-workspace/workflows/example.workflow.yaml --workspace workspaces/my-workspace/workspace.yaml

# Execute — waits 500 ms, persists the timestamp, and logs every state transition
npx rawbox-cli workflow run workspaces/my-workspace/workspace.yaml workspaces/my-workspace/workflows/example.workflow.yaml ./run-logs.txt

# Display state transitions
cat ./run-logs.txt
```

### 3.1. Example YAML Configurations

Once generated, your workspace and workflow configuration files will look like this:

#### `workspace.yaml`
```yaml
name: my-workspace
workflowPathList:
  - ./workflows/example.workflow.yaml
```

#### `workflows/example.workflow.yaml`
```yaml
name: example
pluginPathList:
  - ../../packages/rawbox-plugin-default
seedData:
  - key: sleep_ms
    strategy:
      name: lmdb-kv
      valueSizeMax: 2022
    value: 500
stepList:
  - label: sleep-step
    definitionLocation:
      contractRegistryHash: "92837f61c312..."
      definitionPath: ./time/sleep.definition.js
    storageLocation:
      input:
        ms:
          key: sleep_ms
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
      output:
        timestamp:
          key: sleep_done_at
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
      error:
        message:
          key: sleep_error
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
```

---

## 4. Your Own Automation Monorepo (Build with Code Assist)

Real automations live in a standalone project monorepo where built-in skill files allow AI code assistants to build plugins and workflows for you.

### 4.1. Scaffold the Monorepo

```bash
npx rawbox-cli project create --name my-rawbox-project
cd my-rawbox-project
npm run build:all
```

This generates an npm-workspaces monorepo with a working example plugin and a
clear code/config split:

```text
my-rawbox-project/
├── package.json                     # npm workspaces root (build:all / test:all)
├── tsconfig.base.json               # Shared TypeScript configuration
├── .agents/skills/                  # 🤖 Skill files that teach code assistants this project
│   ├── rawbox-plugin-creation/      #    …how to scaffold a new plugin package
│   ├── rawbox-operation-creation/   #    …how to add + test an operation
│   ├── rawbox-workflow-creation/    #    …how to wire and run workflows
│   └── rawbox-project-creation/     #    …how this whole layout fits together
├── packages/                        # 📦 CODE: TypeScript packages
│   ├── rawbox-plugin-example/       #    Example plugin: registry + hello-world op + test
│   └── rawbox-shared-utils/         #    Shared helpers importable by plugins
└── workspaces/                      # ⚙️ CONFIG: declarative YAML only
    └── workspace-example/            #    Example workspace: workspace.yaml + workflows/ + logs/ + db/
```

### 4.2. Build with a Code Assistant

Ask your AI assistant to build what you need; the bundled skills guide it on how to create, test, and verify operations and workflows:

| You ask for… | The assistant follows | What it produces |
| :--- | :--- | :--- |
| "Create a plugin for the Kraken API" | [rawbox-plugin-creation](.agents/skills/rawbox-plugin-creation/SKILL.md) | A `packages/rawbox-plugin-*` package with registry, exports, and test setup |
| "Add a fetch-ticker operation to it" | [rawbox-operation-creation](.agents/skills/rawbox-operation-creation/SKILL.md) | Contract in `contract-registry.ts` + typed handler + Vitest tests |
| "Wire a workflow that polls it every 5 s" | [rawbox-workflow-creation](.agents/skills/rawbox-workflow-creation/SKILL.md) | Workspace/workflow YAML with storage keys mapped and registry hashes computed |

Two features keep the assistant's output safe and minimal:

* **Schema-enforced contracts** — TypeBox schemas validate inputs, outputs, and errors at runtime so failures occur in testing (`npm run test:all`) rather than production.
* **Built-ins first** — The assistant is guided to reuse existing control-flow and utilities in [rawbox-plugin-default](packages/rawbox-plugin-default/README.md) to minimize custom code.

### 4.3. The Development Loop

Whether changes come from the assistant or your own editor, the loop is:

```bash
npm run build:all                       # compile plugins (registry hash = compiled contracts)
npm run test:all                        # Vitest validates handlers against their schemas
npx rawbox-cli registry hash packages/<plugin>/src/contract-registry.ts   # rebind workflows after contract changes
npx rawbox-cli workflow verify <workflow.yaml> --workspace <workspace.yaml>
npx rawbox-cli workflow run <workspace.yaml> <workflow.yaml> ./run-logs.txt
```

Plugins are discovered automatically if they use the `rawbox-plugin-*` prefix, include the `"rawbox-plugin"` keyword in `package.json`, and export a `./contract-registry` subpath (see [Plugin Discovery](packages/rawbox-plugin/README.md)).

---

## 5. Built-in Definitions

`rawbox-plugin-default` provides standard definitions to build workflows without writing custom code:

* **Control-flow**: `jump`, `branch` (if/else), `switch` (multi-way dispatch), `loop-gate`, and `halt` (early exit).
* **Timing**: `sleep` and `workflow-throttle`.
* **Data plumbing**: `echo`, `compare`, `logic`, `increment`, and `assert`.
* **Observability**: `log` writes structured JSON lines to local logs.

Implement loops using the built-in `increment` and `loop-gate` steps (see the [Canonical Loop Pattern](packages/rawbox-plugin-default/README.md#3-canonical-loop-pattern)).
