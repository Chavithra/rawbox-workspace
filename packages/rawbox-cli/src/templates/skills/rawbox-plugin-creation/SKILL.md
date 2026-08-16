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
1. **Naming**: Named with the prefix `rawbox-plugin-*` (e.g., `rawbox-plugin-custom`), optionally inside any scope (e.g., `@acme/rawbox-plugin-custom`). The scope may be your own — the prefix is what discovery matches.
2. **Keywords**: Must contain the keyword `"rawbox-plugin"` in the `package.json` `keywords` array. This is the explicit opt-in signal, and it also makes the plugin findable via `npm search keywords:rawbox-plugin`.
3. **Registry Export**: Must expose its contract registry via the standard subpath export `./contract-registry`, with the registry as the module's `default` export.

All three are enforced at discovery time. A dependency matching the name convention but failing (2) or (3) is skipped, and the reason is reported rather than silently swallowed.

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
- **`keywords`**: Contains `"rawbox-plugin"`, required for the Runner to discover the package.
- **`exports`**: Exposes the typescript compiled file via `"./contract-registry": "./dist/contract-registry.js"`.
- **`dependencies`**: **none.** A scaffolded plugin declares no runtime dependency at all.
  Add one only if your operations wrap a third-party library of their own.
- **`peerDependencies`**: `@rawbox/plugin`, *not* a regular dependency. A plugin and the
  runner that loads it must share one copy — it defines the vocabulary they use to talk to
  each other — so the host supplies it. Declaring it under `dependencies` would let a
  published plugin quietly bring its own second copy. It is also listed under
  `devDependencies` so the package still builds and tests on its own. The caret range is
  floored at the `@rawbox/plugin` version the scaffolding CLI itself resolves, interpolated
  rather than hardcoded, so a new plugin always starts out matching its framework.

> [!IMPORTANT]
> **Import `typebox` and `neverthrow` from `@rawbox/plugin`, never directly.**
>
> ```typescript
> import { Type } from '@rawbox/plugin/typebox';
> import { ok, err } from '@rawbox/plugin/neverthrow';
> ```
>
> `@rawbox/plugin` re-exports both libraries unchanged at those subpaths. Everything the
> upstream package exports at its root is available, and upstream documentation applies
> verbatim — these add nothing and wrap nothing.
>
> This is why a scaffolded plugin has no `dependencies` block. **Do not "fix" that by adding
> `typebox` or `neverthrow`** — that installs a second copy of a library the plugin already
> has, and reintroduces a version you would then have to keep in range forever.
>
> Only the libraries' root exports are passed through. If you genuinely need
> `typebox/compile` or `typebox/error`, say so upstream rather than adding a `typebox`
> dependency: the answer is another subpath on `@rawbox/plugin`.

> [!NOTE]
> **If you do bring your own `typebox` anyway, its version does not have to match the
> framework's** — and if you are working from memory, or an older copy of this skill, note
> that this rule was once the opposite.
>
> Contract types were once generic over TypeBox's `TObject`, which carries a *computed*
> field, `required: TRequiredArray<Properties>`. When a plugin's `typebox` and
> `@rawbox/plugin`'s resolved to two different installed copies, TypeScript compared that
> computed tuple structurally and refused to unify them, with an error mentioning neither
> typebox nor versions:
> ```
> Type 'undefined' is not assignable to type '[string]'.
> ```
> for a schema with zero required properties, or `'["a","b"]' is not assignable to '[string]'`
> for one with two. Both read like a nonexistent rule capping a contract at one required
> property.
>
> `@rawbox/plugin` now constrains on its own structural `ObjectSchemaLike`, which omits
> `required`, so extra copies are harmless and inference is unaffected. **If you hit the error
> above, you are on an older `@rawbox/plugin` — upgrade; nothing about your schema is wrong.**
>
> `typebox` is also optional outright: contracts may be plain hand-written JSON Schema
> objects. Inference still works for well-formed ones, and a malformed property degrades to
> `unknown`, which fails where the handler uses it. `Type.Object(...)` is just the ergonomic
> default.
>
> `npx rawbox-cli plugin info <workflow file>` reports each plugin's resolved `typebox`
> alongside the framework's. A plugin using the passthrough has none of its own, so there is
> nothing to report — that silence is the expected result, not a failed check.

#### B. [tsconfig.json](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/templates/plugin/tsconfig.json.ejs)
Configures typescript settings for the ESM compiler output target `dist/`.

#### C. [contract-registry.ts](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/templates/plugin/src/contract-registry.ts.ejs)
Centralizes and exports all contracts and their builders. Here, we register our operation files:
```typescript
import { Type } from '@rawbox/plugin/typebox';
import { setupPluginRegistry } from '@rawbox/plugin';

const operationsRecord = {
  './operations/hello-world.definition.js': {
    type: 'operation',
    description: 'A hello world operation example',
    inputSchema: Type.Object({
      name: Type.String(),
    }),
    outputSchema: Type.Object({
      greeting: Type.String(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
} as const;

const controlFlowRecord = {} as const;

export const {
  contractRegistry,
  createOperationDefinition,
  createControlFlowDefinition,
} = setupPluginRegistry({
  operationsRecord,
  controlFlowRecord,
});

export default contractRegistry;
```

`setupPluginRegistry` is the single entry point: it merges the two records into one contract
registry and hands back the matching definition builders, so nothing has to be wired by
hand. The **default export is the registry itself** — that is the shape discovery requires
of `./contract-registry` (see "Step 2: Parameters and Configurations"), and a module that only names it does not get loaded.

#### D. [hello-world.definition.ts](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-cli/src/templates/plugin/src/operations/hello-world.definition.ts.ejs)
Links the contract to the handler business logic using `neverthrow` for type-safe error handling:
```typescript
import { ok } from '@rawbox/plugin/neverthrow';
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
4. Ensure the plugin's `package.json` declares the `"rawbox-plugin"` keyword and exposes the `./contract-registry` subpath under `exports`, so the Runner discovers it correctly.
