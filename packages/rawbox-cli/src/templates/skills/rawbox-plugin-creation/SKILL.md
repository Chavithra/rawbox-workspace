---
name: rawbox-plugin-creation
description: >-
  Provides the step-by-step procedure to scaffold, build, test, and publish/link a new Rawbox plugin from scratch.
  Activate this skill when the user asks to create, modify, or test a Rawbox plugin.
---

# Building a Rawbox Plugin from Scratch using `rawbox-cli`

This document details the step-by-step procedure to build, test, and publish a new Rawbox plugin from scratch using [rawbox-cli](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli).

---

## 1. Overview of Rawbox Plugins

A Rawbox plugin is a modular, content-addressable package that exposes **Operation** or **Control-Flow** definitions. In compliance with the [Plugin Discovery Architecture](https://github.com/chavithra/rawbox-workspace/blob/main/developer-guide.md#6-plugin-discovery-architecture), each plugin must satisfy:
1. **Naming**: Named with the prefix `rawbox-plugin-*` (e.g., `rawbox-plugin-custom`).
2. **Keywords**: Must contain the keyword `"rawbox-plugin"` in `package.json`.
3. **Registry Export**: Must expose its contract registry via the standard subpath export `./contract-registry`.

---

## 2. Setup and Prerequisites

Before executing the CLI commands within the workspace monorepo, compile the CLI package and link the workspace packages so that `npx` resolves it properly:

1. **Build the CLI Package**:
   ```bash
   npm run build -w packages/rawbox-cli
   ```
2. **Install/Link Workspaces**:
   ```bash
   npm install
   ```
   This ensures that the symlink for `rawbox-cli` is successfully generated inside your root `node_modules/.bin/` directory.

---

## 3. Step-by-Step Scaffolding Procedure

### Step 1: Run the Scaffold Command
To scaffold the plugin non-interactively, execute the `create` command from the root of your project or monorepo, specifying the `--name` (or `-n`) and `--install` (or `--no-install`) options:

```bash
npx rawbox-cli plugin create --name rawbox-plugin-custom --install
```

Alternatively, run the command without any parameters to trigger the interactive prompts:

```bash
npx rawbox-cli plugin create
```

### Step 2: Parameters and Configurations
The `plugin create` command supports the following parameters:
- **`--name` / `-n`** (string): The name of your plugin. It must follow the naming convention `rawbox-plugin-*` (e.g., `rawbox-plugin-custom`).
- **`--install` / `--no-install`** (boolean): Automatically run dependency installation (`npm install`) after scaffolding the files.

> [!NOTE]
> As implemented in [plugin/create.ts](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/commands/plugin/create.ts), the plugin directory is created directly in the path of command execution (pwd) under the name provided (e.g., `./rawbox-plugin-custom`).

---

## 4. Scaffolding Structure and Created Files

The tool scaffolds the following directory structure:

```
rawbox-plugin-custom/
├── package.json
├── tsconfig.json
├── src/
│   ├── contract-registry.ts
│   └── operations/
│       └── hello-world.definition.ts
└── tests/
    └── hello-world.test.ts
```

### Key Files Breakdown

#### A. [package.json](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/templates/plugin/package.json.ejs)
Defines metadata, exports, and dependencies:
- **`exports`**: Exposes the typescript compiled file via `"./contract-registry": "./dist/contract-registry.js"`.
- **`dependencies`**: Depends on `typebox`, `neverthrow`, and `rawbox-plugin`.

#### B. [tsconfig.json](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/templates/plugin/tsconfig.json.ejs)
Configures typescript settings for the ESM compiler output target `dist/`.

#### C. [contract-registry.ts](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/templates/plugin/src/contract-registry.ts.ejs)
Centralizes and exports all contracts and their builders. Here, we register our operation files:
```typescript
import { Type } from 'typebox';
import { setupContractRegistry } from 'rawbox-plugin/core';
import { getOperationDefinitionBuilder } from 'rawbox-plugin/operation';

const operationsRecord = {
  './operations/hello-world.definition.js': {
    type: 'operation',
    description: 'A hello world operation example',
    inputSchema: Type.Object({ name: Type.String() }),
    outputSchema: Type.Object({ greeting: Type.String() }),
    errorSchema: Type.Object({ message: Type.String() }),
    version: '1.0.0',
  },
} as const;

export const contractRegistry = setupContractRegistry({
  contractRecord: { ...operationsRecord },
});

export const createOperationDefinition = getOperationDefinitionBuilder({
  ...contractRegistry,
  contractRecord: operationsRecord,
});
```

#### D. [hello-world.definition.ts](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/templates/plugin/src/operations/hello-world.definition.ts.ejs)
Links the contract to the handler business logic using `neverthrow` for type-safe error handling:
```typescript
import { ok } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const helloWorldDefinition = createOperationDefinition(
  './operations/hello-world.definition.js',
  async (input) => {
    const { name } = input;
    return ok({ greeting: `Hello, ${name}!` });
  }
);

export default helloWorldDefinition;
```

---

## 5. Build, Test, and Link

### Run Tests
The scaffold comes pre-configured with [Vitest](https://vitest.dev/). Run:
```bash
npm run test
```
This executes all tests under the `tests/` directory (e.g. [hello-world.test.ts](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/templates/plugin/tests/hello-world.test.ts.ejs)).

### Build the Output
Compile your TypeScript code to ESM distribution files:
```bash
npm run build
```
This runs `tsc` and outputs build files to the `dist/` directory.

### Local Linking
To test your plugin locally in a Rawbox project workspace before publishing:
1. Inside the plugin directory, link it globally:
   ```bash
   npm link
   ```
2. Inside your Rawbox project workspace, link the plugin package:
   ```bash
   npm link rawbox-plugin-custom
   ```
3. Add the plugin dependency to your workspace's `package.json` manually or run `npm install --save-dev ./path-to-plugin`.
4. Ensure the keyword `"rawbox-plugin"` is set in the plugin's package config so the Runner discovers it correctly.
