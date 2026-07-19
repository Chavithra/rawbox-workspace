# rawbox-cli

`rawbox-cli` is the command-line utility for the Rawbox Framework. It provides scaffolding templates (projects, plugins, operations, workspaces) and workflow runtime commands (verification, environment setup, execution, registry hashing).

---

## 1. Commands Reference

All commands support non-interactive execution by providing their options directly as CLI arguments (bypassing interactive terminal prompts).

### Scaffolding Commands

#### A. Initialize a Project (`project create`)
Generates a recommended workspaces monorepo structure. Note that `npm` is enforced as the sole package manager.
```bash
rawbox-cli project create --name rawbox-project-example --package-manager npm
```

#### B. Create a Plugin (`plugin create`)
Scaffolds a new plugin directory with base dependencies, typescript, and contract configurations.
```bash
rawbox-cli plugin create --name rawbox-plugin-example --no-install
```

#### C. Add an Operation (`operation create`)
Scaffolds a new type-safe operation handler and registers its contracts.
```bash
rawbox-cli operation create --name sum-numbers
```

#### D. Create a Workspace (`workspace create`)
Scaffolds a declarative workspace environment with staging databases, workflow configs, and logs directory structure.
```bash
rawbox-cli workspace create --name live-trading --workflows ./workflows/example.yaml
```

---

### Workflow Runtime Commands

#### A. Compute Registry Signature Hash (`registry hash`)
Generates the deterministic SHA-256 content-hash of a plugin's serialized `contractRecord` for step validation.
```bash
rawbox-cli registry hash ./packages/rawbox-plugin-example/dist/contract-registry.js
```

#### B. Workspace Verification (`workspace verify`)
Validates a workspace structure and checks if all referenced workflow configurations and plugins are correctly defined.
```bash
rawbox-cli workspace verify workspaces/live-trading/workspace.yaml
```

#### C. Workflow Verification (`workflow verify`)
Performs a deep verification of step inputs, outputs, and definition paths against their plugin schema registries.
```bash
rawbox-cli workflow verify workspaces/live-trading/workflows/example.yaml --workspace workspaces/live-trading/workspace.yaml
```

#### D. Workspace Initialization (`workspace setup`)
Prepares the target execution runtime directory, compiling storage settings and linking dependencies.
```bash
rawbox-cli workspace setup workspaces/live-trading/workspace.yaml ./target-run-dir
```

#### E. Execute Workflow (`workflow run`)
Runs the state machine workflow engine and writes state transition logs.
```bash
rawbox-cli workflow run workspaces/live-trading/workspace.yaml workspaces/live-trading/workflows/example.yaml ./run-logs.txt
```

---

## 2. Development

### Build
Compiles TypeScript files and copies markdown / `.ejs` templates to the compiled `dist/` directory:
```bash
npm run build
```

### Test
Runs the Vitest test suite:
```bash
npm test
```
