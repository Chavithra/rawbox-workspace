---
name: rawbox-workflow-creation
description: >-
  Provides the step-by-step procedure to define a workflow and workspace configuration, get registry hashes, verify structures, and execute runner instances.
  Activate this skill when the user asks to create, modify, test, or run a Rawbox workflow/workspace.
---

# Creating and Executing Workflows and Workspaces

This guide details the procedure to define, configure, verify, and run **Workspaces** and **Workflows** in the Rawbox Framework.

---

## 1. Concepts Overview

- **Workspace:** A runtime environment that connects multiple workflows and registers their plugin packages. It is defined as a JSON configuration referencing workflow files.
- **Workflow:** A declarative state-machine definition made of sequential execution **Steps** referencing compiled operation/control-flow definitions.
- **Step:** An action mapping a compiled plugin operation definition path to input, output, and error storage locations (boxes).
- **Storage Location (Box):** A persistent storage item in the LMDB database (KV or FIFO strategy) indexed by a unique string key.
- **Control-Flow Steps:** Steps whose definition returns a jump label instead of an output record. The runner jumps to the step with that `label`, or honors the reserved labels `__START__` (first step), `__END__` (last step), `__EXIT__` (terminate).

> [!TIP]
> `rawbox-plugin-default` ships ready-made building blocks — control-flows (`branch`,
> `switch`, `loop-gate`, `halt`), timing (`sleep`, `workflow-throttle`), data plumbing
> (`echo`, `compare`, `logic`, `increment`, `assert`), and `log` — plus the canonical
> two-step loop pattern (`increment` + `loop-gate`). See its
> [README](https://github.com/chavithra/rawbox-workspace/blob/main/packages/rawbox-plugin-default/README.md)
> before writing custom operations.

---

## 2. Step-by-Step Creation Procedure

### Step 1: Compute Plugin Registry Hashes
Each step in a workflow binds to a plugin registry hash. To compute the unique hash of your plugin's registry, run:

```bash
npx rawbox-cli registry hash <path-to-contract-registry>
```

#### Example:
```bash
npx rawbox-cli registry hash packages/rawbox-plugin-default/src/contract-registry.ts
```
**Output:**
```
Hash: 92837f61c312...
```

---

### Step 2: Create the Workspace Configuration File
Create a YAML file at the root of your workspace (e.g. `workspace.yaml`) that lists your workflows.

#### `workspace.yaml`:
```yaml
name: data-processing-workspace
workflowPathList:
  - ./workflows/throttle-ops.yaml
```

---

### Step 3: Create the Workflow File
Create a YAML file under your workspace workflows folder matching the path in `workflowPathList` (e.g., `workflows/throttle-ops.yaml`).

#### `workflows/throttle-ops.yaml`:
```yaml
name: throttle-ops
pluginPathList:
  - ../packages/rawbox-plugin-default
stepList:
  - label: throttle-step
    definitionLocation:
      contractRegistryHash: "92837f61c312..."
      definitionPath: ./time/workflow-throttle.definition.js
    storageLocation:
      input:
        ms:
          key: throttle_ms
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
      output:
        throttledMs:
          key: throttle_result_throttled_ms
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
        timestamp:
          key: throttle_result_timestamp
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
      error:
        message:
          key: throttle_error_message
          strategy:
            name: lmdb-kv
            valueSizeMax: 2022
```

---

## 3. Verification

Before running, use the CLI tools to verify the integrity and schemas of both configurations.

### Verify Workspace
Checks if the workspace structure is valid and that all declared workflows and plugins exist:
```bash
npx rawbox-cli workspace verify workspace.yaml
```

### Verify Workflow
Checks if the workflow schema matches, and that all step reference paths (`definitionPath`) are correctly registered under the corresponding plugin `contractRegistryHash` inside the workspace context:
```bash
npx rawbox-cli workflow verify workflows/throttle-ops.yaml --workspace workspace.yaml
```

---

## 4. Setup and Execution

### Step 1: Initialize Workspace Environment
Scaffold the target folder, link the dependencies, and configure storage parameters:
```bash
npx rawbox-cli workspace setup workspace.yaml ./target-run-dir
```

### Step 2: Run the Workflow
Execute the workflow instance using XState transition management, generating state logs:
```bash
npx rawbox-cli workflow run workspace.yaml workflows/throttle-ops.yaml ./run-logs.txt
```
