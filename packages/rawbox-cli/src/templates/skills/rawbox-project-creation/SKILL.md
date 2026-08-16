---
name: rawbox-project-creation
description: >-
  Provides the step-by-step procedure to define, structure, initialize, and manage a new Rawbox project containing multiple runtime workspaces, workflows, and custom plugins.
  Activate this skill when the user asks to create, modify, structure, or run a new Rawbox project.
---

# Structuring a Rawbox Project with Multiple Workspaces and Workflows

This document explains the recommended procedure for structuring, initializing, and managing a Rawbox project containing multiple runtime workspaces, workflows, and custom plugins.

---

## 1. Project Directory Layout

For developers managing multiple workflows alongside custom plugins and shared libraries, we recommend a single **npm/yarn/pnpm workspace monorepo** layout. 

The configuration folder containing your workflow state-machines is named **`workspaces/`** to align with the Rawbox domain model:

```text
my-rawbox-project/
├── package.json               # Master workspaces declaration
├── tsconfig.base.json         # Shared typescript base rules
│
├── packages/                  # Code Folder: TS packages and custom plugins
│   ├── rawbox-plugin-custom/  # Custom exchange or processing plugin
│   └── rawbox-shared-utils/   # Shared code dependencies (math, formatting)
│
└── workspaces/                # Config Folder: Declarative workspaces and workflows
    ├── workspace-example/         # Workspace 1: Production runtime
    │   ├── workspace.yaml     # Workspace environments configuration
    │   ├── .gitignore         # Covers .rawbox/ — see below
    │   ├── .rawbox/           # Installed plugins + LMDB data + NDJSON run logs
    │   │   │                  # (created at setup/run; gitignored, machine-owned, safe to delete)
    │   │   └── logs/          # <workflow name>/<run-id>.ndjson, <run-id>.error.ndjson — a run's default
│   │                      # (segment 0 of each; long runs rotate into <run-id>.1.ndjson, .2, …)
    │   └── workflows/         # Workflows specific to Live Trading
    │       ├── market-maker.workflow.yaml
    │       └── monitor.workflow.yaml
    │
    └── backtesting/           # Workspace 2: Testing runtime
        ├── workspace.yaml
        ├── .gitignore
        ├── .rawbox/           # Isolated installed plugins + LMDB data + run logs for backtesting
        └── workflows/
            └── run-strategy.yaml
```

---

## 2. Initializing a Standalone Project

For standalone automation environments that do not require multiple workspace subdirectories or local plugins, you can initialize a pre-configured Rawbox project in a single command:

```bash
npx rawbox-cli project create --name my-rawbox-project --package-manager npm
```

### Supported Parameters
- **`--name` / `-n`** (string): The directory name and package name for the new project.
- **`--package-manager` / `-p`** (choice): The package manager to use (`npm`, `yarn`, or `pnpm`).

This scaffolding command generates:
- A `package.json` pre-configured with `neverthrow`, `@rawbox/plugin`, and `typebox`.
- A `tsconfig.json` for ESM compilation module-resolution rules.
- A `workspace.yaml` per scaffolded workspace — the one place runtime configuration lives, including the optional `logs:` block that bounds log rotation and run retention. (There is no `rawbox.config.json`: that file was removed, and its `runs.prune` settings are now `logs.prune:` in the workspace document.)
- Sample operation definitions under `src/` (e.g., `sum.definition.ts` and `mul.definition.ts`).

---

## 3. Monorepo Project Setup Procedure (Multiple Workspaces)

### Step 1: Initialize the Monorepo Root
Create the project folder and generate the master `package.json` to define the workspaces:

```json
{
  "name": "my-rawbox-project",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build:all": "npm run build --workspaces",
    "test:all": "npm run test --workspaces"
  },
  "devDependencies": {
    "typescript": "^6.0.3"
  }
}
```

---

### Step 2: Configure TypeScript Bases
Add a `tsconfig.base.json` at the root of the project to enforce consistent TypeScript and module compilation configurations:

```json
{
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "strict": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

---

### Step 3: Scaffold Custom Plugins
Change directory into `packages/` and scaffold your custom plugin packages using the CLI generator tool:

```bash
cd packages
npx rawbox-cli plugin create --name rawbox-plugin-custom
```
Because this is inside an npm workspace context, running `npm install` at the root will automatically symlink your custom plugins so that other packages and workflow execution engines can resolve them instantly.

---

### Step 4: Configure Workspace Environments
Create your workflow environments folder (`workspaces/`) and write your environment configurations inside `workspace.yaml` (e.g., under `workspaces/workspace-example/workspace.yaml`):

```yaml
kind: Workspace
name: workspace-example
workflowPathList:
  - ./workflows/market-maker.workflow.yaml
```

`kind: Workspace` is what the tooling walks up the tree to find, so a workspace emitted
without it cannot be auto-discovered from its own workflows.

---

### Step 5: Declare Steps in Workflows
Write the steps of your workflow under the environment workflows subdirectory (e.g., `workspaces/workspace-example/workflows/market-maker.workflow.yaml`):

```yaml
kind: Workflow
formatVersion: "1.0"
name: market-maker
description: Fetches a price using the project's custom plugin.

# Package name -> npm dependency specifier. A relative `file:` specifier is
# resolved against the workspace directory — the one holding workspace.yaml —
# so this points two levels up, not three.
plugins:
  rawbox-plugin-custom: "file:../../packages/rawbox-plugin-custom"

storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    target_symbol_key:
      seed: BTC-USD

steps:
  - label: fetch-price
    plugin: rawbox-plugin-custom
    operation: operations/fetch-price
    inputs:
      symbol: target_symbol_key
    outputs:
      price: last_price_key
    errors:
      message: price_error_key
```

`operation: operations/fetch-price` addresses `./operations/fetch-price.definition.js` in
that plugin's contract registry — it must be a key the plugin's `contract-registry.ts`
actually declares, which `npx rawbox-cli workflow verify` checks for you. No registry hash
appears anywhere: hashes belong to the generated `rawbox.lock` beside `workspace.yaml`.

For the full authoring reference — binding forms, the `storage.keys` entry, control-flow steps
and how a constant is seeded and bound by key — see the **rawbox-workflow-creation** skill.

---

## 4. Advantages of this Layout

* **Environment Isolation:** Database storage (`.rawbox/data/`) and runtime log files (`.rawbox/logs/`) are created relative to the specific workspace folders, keeping state, databases, and logs for staging, testing, and production completely separated. `.rawbox/` is gitignored and machine-owned — safe to delete, regenerated by `workspace setup` or a run.
* **Logs Organization:** `run`/`workflow run` needs no log path at all — it defaults to `.rawbox/logs/<workflow name>/<run-id>.ndjson`, one subdirectory per workflow, so every workspace gets organized, non-colliding logs with zero configuration. Pass `--log-file`/`--error-log` only when a run needs to land somewhere specific — a fixed path a long-running service tails, say. That path is **segment 0**: logs rotate by default at 128 MiB per segment, keeping 8 (1 GiB per run), with successors named `<run-id>.1.ndjson`, `.2`, … and the *oldest* dropped once the count is exceeded. Tune both numbers together under `logs.rotate:` in `workspace.yaml` — declaring one without the other is a verify-time error — and bound how many runs are kept at all under `logs.prune:` (`keep` defaults to 20).
* **Granular Dependency Management:** Common utility logic can be placed in `packages/rawbox-shared-utils` and imported cleanly into custom plugins without code duplication.
* **Portable Relative Linking:** A workflow reaches a custom plugin with a `file:` specifier under `plugins:`, which `workspace setup` splices straight into a generated `package.json` and installs with a single `npm install`. Relative `file:` specifiers resolve against the **workspace directory** (where `workspace.yaml` lives), e.g. `file:../../packages/rawbox-plugin-custom` from `workspaces/workspace-example/`, so they resolve correctly on any developer environment or build agent. `workspace setup` installs into `<workspace directory>/.rawbox` by default — the first place a run resolves plugins from — so no target folder argument is needed; set `targetFolder:` in `workspace.yaml` to install somewhere else and keep setup and run in agreement. npm *links* a `file:` plugin rather than copying it, which is what keeps the edit-rebuild-rerun loop live; pass `--install-links` only when the target folder must be portable.
