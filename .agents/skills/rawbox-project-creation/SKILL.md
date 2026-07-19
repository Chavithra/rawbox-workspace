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
    │   ├── logs/              # Directory for long-running logs
    │   │   ├── market-maker.log
    │   │   └── monitor.log
    │   ├── db/                # LMDB runtime databases (created at run)
    │   └── workflows/         # Workflows specific to Live Trading
    │       ├── market-maker.workflow.yaml
    │       └── monitor.workflow.yaml
    │
    └── backtesting/           # Workspace 2: Testing runtime
        ├── workspace.yaml
        ├── run-logs.txt       # Minimalist log file for simulation runs
        ├── db/                # Isolated LMDB databases for backtesting
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
- A `package.json` pre-configured with `neverthrow`, `rawbox-plugin`, and `typebox`.
- A `tsconfig.json` for ESM compilation module-resolution rules.
- A `rawbox.config.json` containing runtime configs.
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
    "typescript": "^5.0.0"
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
name: workspace-example
workflowPathList:
  - ./workflows/market-maker.workflow.yaml
```

---

### Step 5: Declare Steps in Workflows
Write the steps of your workflow under the environment workflows subdirectory (e.g., `workspaces/workspace-example/workflows/market-maker.workflow.yaml`):

```yaml
name: market-maker
pluginPathList:
  - ../../packages/rawbox-plugin-custom
stepList:
  - label: fetch-price
    definitionLocation:
      contractRegistryHash: abc123hash...
      definitionPath: ./operations/fetch-price.definition.js
    storageLocation:
      input:
        symbol:
          key: target_symbol_key
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
      output:
        price:
          key: last_price_key
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
      error:
        message:
          key: price_error_key
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
```

---

## 4. Advantages of this Layout

* **Environment Isolation:** Database storage directories (`db/`) and runtime log files are created relative to the specific workspace folders, keeping state, databases, and logs for staging, testing, and production completely separated.
* **Logs Organization:** A dedicated `logs/` directory in production workspaces (e.g. `workspaces/workspace-example/logs/`) keeps multiple workflow run-logs organized and prevents them from cluttering the root workspace directory, while temporary backtesting workspaces can use a minimalist root-level `run-logs.txt`.
* **Granular Dependency Management:** Common utility logic can be placed in `packages/rawbox-shared-utils` and imported cleanly into custom plugins without code duplication.
* **Portable Relative Linking:** Link targets between workflows and custom plugins use standard relative directory mappings which resolve correctly on any developer environment or build agent. Plugin paths resolve relative to the **workspace directory** (where `workspace.yaml` lives), e.g. `../../packages/rawbox-plugin-custom` from `workspaces/workspace-example/`.
