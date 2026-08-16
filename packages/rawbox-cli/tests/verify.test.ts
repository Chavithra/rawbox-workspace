import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

import { verifyWorkflow } from '../src/commands/workflow/verify.js';
import { verifyWorkspace } from '../src/commands/workspace/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-verify-test');

// ---------------------------------------------------------------------------
// Harness
//
// Both commands report through `@clack/prompts` and end by calling
// `process.exit(1)`. The exit spy here does **not** throw: every failure path
// in both commands is written as `process.exit(1); return;`, so a non-throwing
// stub lets the function unwind normally and keeps the assertion about *what
// was reported* separate from the assertion about *whether it failed*.
// ---------------------------------------------------------------------------

let exitSpy: ReturnType<typeof vi.spyOn>;
let messageList: string[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureLog(): any {
  return vi.fn((...args: unknown[]) => {
    messageList.push(args.map(String).join(' '));
  });
}

beforeEach(() => {
  messageList = [];
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation(captureLog());
  vi.spyOn(p.log, 'warn').mockImplementation(captureLog());
  vi.spyOn(p.log, 'info').mockImplementation(captureLog());
  vi.spyOn(p.log, 'step').mockImplementation(captureLog());
  // `p.outro` is a module-level export, not a property of an object, so ESM
  // namespaces make it unspyable. Nothing here asserts on it — the outro only
  // restates the outcome `process.exit` already carries.
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** All reported text, with ANSI colouring stripped. */
function reported(): string {
  // eslint-disable-next-line no-control-regex
  return messageList.join('\n').replace(/\[[0-9;]*m/g, '');
}

function expectFailed(): void {
  expect(exitSpy).toHaveBeenCalledWith(1);
}

function expectPassed(): void {
  expect(exitSpy, reported()).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KV_STORAGE = `
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
`.trim();

const FAKE_PLUGIN = 'rawbox-plugin-fake';

/**
 * Installs a minimal plugin package into `<directory>/node_modules`.
 *
 * `verify` resolves `<package>/contract-registry` with `createRequire` rooted at
 * the workspace directory, so a hand-built `node_modules` entry exercises the
 * real resolution path without depending on any package having been built.
 *
 * The contracts are written as plain JSON Schema objects: the schemas are
 * defined over the parsed data model, and a registry's `contractRecord` is
 * hashed as data, so nothing here needs TypeBox at authoring time.
 */
async function installFakePlugin(directory: string): Promise<void> {
  const packageDir = path.join(directory, 'node_modules', FAKE_PLUGIN);
  await fs.mkdir(packageDir, { recursive: true });

  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: FAKE_PLUGIN,
        version: '1.0.0',
        type: 'module',
        keywords: ['rawbox-plugin'],
        exports: { './contract-registry': './contract-registry.js' },
      },
      null,
      2,
    ),
    'utf-8',
  );

  const registrySource = `
const contractRecord = {
  './time/sleep.definition.js': {
    type: 'operation',
    description: 'Pauses execution',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'number', minimum: 0 } },
      required: ['ms'],
    },
    outputSchema: {
      type: 'object',
      properties: { timestamp: { type: 'number' } },
    },
    errorSchema: { type: 'object', properties: { message: { type: 'string' } } },
    version: '1.0.0',
  },
  './control-flow/branch.definition.js': {
    type: 'control-flow',
    description: 'Branches on a condition',
    inputSchema: {
      type: 'object',
      properties: {
        condition: { type: 'boolean' },
        thenLabel: { type: 'string' },
        elseLabel: { type: 'string' },
      },
      required: ['condition', 'thenLabel', 'elseLabel'],
    },
    errorSchema: { type: 'object', properties: { message: { type: 'string' } } },
    version: '1.0.0',
  },
};

export default {
  contractRecord,
  contractRegistryPath: import.meta.url,
};
`.trimStart();

  await fs.writeFile(
    path.join(packageDir, 'contract-registry.js'),
    registrySource,
    'utf-8',
  );
}

interface Scenario {
  directory: string;
  workspacePath: string;
  workflowPath: string;
}

/**
 * Builds `<root>/<name>/{workspace.yaml,workflows/main.yaml}`.
 *
 * Every scenario gets its own subtree so that the upward walk of one scenario's
 * workspace discovery can never reach another's workspace document.
 */
async function makeScenario(
  name: string,
  options: { workspaceYaml: string; workflowYaml: string; workflowName?: string },
): Promise<Scenario> {
  const directory = path.join(rootDir, name);
  const workflowDir = path.join(directory, 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });

  const workspacePath = path.join(directory, 'workspace.yaml');
  const workflowPath = path.join(workflowDir, options.workflowName ?? 'main.yaml');

  await fs.writeFile(workspacePath, options.workspaceYaml.trim(), 'utf-8');
  await fs.writeFile(workflowPath, options.workflowYaml.trim(), 'utf-8');

  return { directory, workspacePath, workflowPath };
}

function workspaceYaml(workflowRelativePathList: string[] = ['./workflows/main.yaml']): string {
  return `
kind: Workspace
name: verify-test-workspace
workflowPathList:
${workflowRelativePathList.map((entry) => `  - ${entry}`).join('\n')}
`;
}

/**
 * The same workspace, plus a `backends:` map — what a document declaring a
 * `redis-kv` key needs in order to verify, since `backend:` is an id into this
 * map rather than a connection string.
 *
 * The connection is a literal by default so a budget test exercises the budget
 * and nothing else. `connection` takes the `${VAR}` form when a test is about
 * env-var interpolation.
 */
function workspaceWithBackendsYaml(options: {
  workflowRelativePathList?: string[];
  backendById?: Record<string, string>;
}): string {
  const workflowRelativePathList = options.workflowRelativePathList ?? [
    './workflows/main.yaml',
  ];
  const backendById = options.backendById ?? {
    main: 'redis://cache.internal:6379/0',
  };

  return `
kind: Workspace
name: verify-test-workspace
workflowPathList:
${workflowRelativePathList.map((entry) => `  - ${entry}`).join('\n')}
backends:
${Object.entries(backendById)
  .map(([id, connection]) => `  ${id}:\n    connection: "${connection}"`)
  .join('\n')}
`;
}

/** A workflow using the fake plugin's sleep operation. */
function sleepWorkflowYaml(): string {
  return `
kind: Workflow
formatVersion: "1.0"
name: sleep-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    sleep_ms:
      seed: 500
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: slept_at
`;
}

beforeAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('workflow verify — workspace auto-discovery', () => {
  it('finds the workspace by `kind: Workspace` with no --workspace flag', async () => {
    const scenario = await makeScenario('auto-discovery', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    // No `options` argument at all — this is the path that has never worked:
    // the old heuristic looked for a document carrying both `pluginPathList`
    // and `workflowPathList`, which no schema can produce.
    await verifyWorkflow(scenario.workflowPath);

    expectPassed();
    expect(reported()).toContain('Auto-discovered workspace');
    expect(reported()).toContain(scenario.workspacePath);
    expect(reported()).toContain('kind: Workspace');
  });

  it('does not mistake the workflow itself for a workspace document', async () => {
    const scenario = await makeScenario('auto-discovery-sibling', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    // A second `kind: Workflow` document sits beside the one being verified;
    // discovery keys on `kind`, so neither is a candidate.
    await fs.writeFile(
      path.join(path.dirname(scenario.workflowPath), 'other.yaml'),
      sleepWorkflowYaml().trim(),
      'utf-8',
    );

    await verifyWorkflow(scenario.workflowPath);

    expectPassed();
    expect(reported()).toContain(scenario.workspacePath);
  });

  it('reports ambiguity rather than guessing when a directory holds two workspaces', async () => {
    const scenario = await makeScenario('auto-discovery-ambiguous', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await fs.writeFile(
      path.join(scenario.directory, 'workspace-staging.yaml'),
      workspaceYaml().trim(),
      'utf-8',
    );

    await verifyWorkflow(scenario.workflowPath);

    expectFailed();
    expect(reported()).toContain('Several workspace documents were found');
    expect(reported()).toContain('--workspace');
  });

  it('fails rather than passing when no workspace document exists', async () => {
    // Placed directly under the OS temp-free root with no workspace anywhere in
    // its ancestry inside the fixture tree.
    const directory = path.join(rootDir, 'no-workspace', 'workflows');
    await fs.mkdir(directory, { recursive: true });
    const workflowPath = path.join(directory, 'main.yaml');
    await fs.writeFile(
      workflowPath,
      `
kind: Workflow
formatVersion: "1.0"
name: plugin-free-workflow
plugins: {}
${KV_STORAGE}
steps: []
`.trim(),
      'utf-8',
    );

    await verifyWorkflow(workflowPath);

    // A clean exit here would be misleading: without a workspace context,
    // the majority of what this command checks never ran. It must fail
    // rather than silently pass with reduced coverage.
    expectFailed();
    const output = reported();
    expect(output).toContain('Verification could not be completed');
    // It must not imply the document itself is invalid — the schema check
    // already passed by this point.
    expect(output).not.toContain('is invalid');
    // Names what was skipped as a result.
    expect(output).toContain('plugin resolution');
    expect(output).toContain('operation existence');
    expect(output).toContain('seed validation');
    expect(output).toContain('rawbox.lock integrity');
    // Lists the directories searched, and tells the user how to fix it.
    expect(output).toContain(directory);
    expect(output).toContain('--workspace <file>');
    // And now also suggests the workspace-less alternative
    // (rawbox-runner README, "Implicit (workspace-less) workspaces").
    expect(output).toContain('--workspace-name <name>');
  });
});

// ---------------------------------------------------------------------------
// `--workspace-name` — verify against a synthesized, workspace-less context
// (rawbox-runner README, "Implicit (workspace-less) workspaces"), the same seam `workflow run` uses.
// ---------------------------------------------------------------------------

describe('workflow verify — workspace-less scratch context (--workspace-name)', () => {
  it('verifies a lone workflow file with zero workspace.yaml on disk', async () => {
    const directory = path.join(rootDir, 'scratch-verify');
    await fs.mkdir(directory, { recursive: true });
    const workflowPath = path.join(directory, 'main.yaml');
    await fs.writeFile(workflowPath, sleepWorkflowYaml().trim(), 'utf-8');
    // Resolved from the workflow's own directory, since a scratch context's
    // "workspace directory" is exactly that.
    await installFakePlugin(directory);

    await verifyWorkflow(workflowPath, { workspaceName: 'scratch-verify' });

    expectPassed();
    const output = reported();
    expect(output).toContain('state persisted under workspace');
    expect(output).toContain('"scratch-verify"');
    expect(output).toContain('Verifying against synthesized (workspace-less) workspace');
    expect(output).toContain(`Plugin ${FAKE_PLUGIN}`);

    // No workspace document was read or written.
    await expect(fs.stat(path.join(directory, 'workspace.yaml'))).rejects.toThrow();
  });
});

describe('workflow verify — document validation', () => {
  it('rejects a document with no `kind:`, naming the line to add', async () => {
    const scenario = await makeScenario('no-kind-workflow', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
name: legacy
pluginPathList: []
stepList: []
`,
    });

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    expect(reported()).toContain('is not a Rawbox workflow document');
    expect(reported()).toContain('no "kind:" field');
    expect(reported()).toContain('kind: Workflow');
  });

  it('rejects a `workflow:` property on an output as a storage-boundary violation', async () => {
    const scenario = await makeScenario('boundary-structural', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: boundary-breaker
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp:
        key: slept_at
        workflow: some-other-workflow
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('Storage boundary violation');
    expect(output).toContain('outputs "timestamp"');
    expect(output).toContain('may only write into its own workflow');
  });

  it('rejects a `workspace:` property on an input as a storage-boundary violation', async () => {
    const scenario = await makeScenario('boundary-workspace', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: boundary-breaker
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms:
        key: sleep_ms
        workspace: another-workspace
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('Storage boundary violation');
    expect(output).toContain('inputs "ms"');
    expect(output).toContain('no binding may name another workspace');
  });
});

describe('workflow verify — resolution', () => {
  it('verifies a workflow whose plugin and operation both resolve', async () => {
    const scenario = await makeScenario('resolution-happy', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    const output = reported();
    expect(output).toContain(`Plugin ${FAKE_PLUGIN}`);
    expect(output).toContain('Step "sleep" verified');
    expect(output).toContain('time/sleep');
  });

  it('type-checks a seeded jump target against the contract inputSchema', async () => {
    // A jump target is a seeded key, checked by `validateSeedData` against the
    // same field schema as the input that reads it — there is no inline
    // literal to check at resolve time any more.
    const scenario = await makeScenario('resolution-seeded-labels', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: seeded-label-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    flag:
      seed: true
    then_label:
      seed: sleep-step
    else_label:
      seed: done
steps:
  - label: branch
    plugin: ${FAKE_PLUGIN}
    operation: control-flow/branch
    inputs:
      condition: flag
      thenLabel: then_label
      elseLabel: else_label
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    // Three seeds, each paired to the input field that reads its key.
    expect(reported()).toContain('3 seed value(s) validated');
  });

  it('rejects a seeded jump target that does not match the inputSchema', async () => {
    const scenario = await makeScenario('resolution-seeded-labels-bad', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: seeded-label-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    flag:
      seed: true
    then_label:
      seed: 42
    else_label:
      seed: done
steps:
  - label: branch
    plugin: ${FAKE_PLUGIN}
    operation: control-flow/branch
    inputs:
      condition: flag
      thenLabel: then_label
      elseLabel: else_label
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    expect(reported()).toContain('Seed validation failed for key "then_label"');
    expect(reported()).toContain('thenLabel');
  });

  it('rejects a `{ value: … }` literal and prints the seed that replaces it', async () => {
    // The form was removed from the format — pins FORMAT.md, "Bindings":
    // a binding names a storage key, and no binding form carries a value. An author or an assistant working from an older example
    // arrives here, so the diagnostic has to be the migration path — verify is
    // where they will see it.
    const scenario = await makeScenario('resolution-literal-removed', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: literal-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    flag:
      seed: true
steps:
  - label: branch
    plugin: ${FAKE_PLUGIN}
    operation: control-flow/branch
    inputs:
      condition: flag
      thenLabel: { value: sleep-step }
      elseLabel: { value: done }
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('steps[0].inputs.thenLabel');
    expect(output).toContain('has been removed from the workflow format');
    expect(output).toContain('then_label:');
    expect(output).toContain('seed: "sleep-step"');
    expect(output).toContain('thenLabel: then_label');
    // Both are reported, not just the first: verify is run in a loop, so one
    // pass should surface the whole fix list.
    expect(output).toContain('steps[0].inputs.elseLabel');
  });

  it('lists the declared packages and suggests the nearest for an unmatched `plugin:`', async () => {
    const scenario = await makeScenario('resolution-bad-plugin', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: bad-plugin-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    sleep_ms:
      seed: 500
steps:
  - label: sleep
    plugin: rawbox-plugin-fak
    operation: time/sleep
    inputs:
      ms: sleep_ms
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('is not declared in `plugins:`');
    expect(output).toContain('Declared packages:');
    expect(output).toContain(`- ${FAKE_PLUGIN}`);
    expect(output).toContain(`Did you mean "${FAKE_PLUGIN}"?`);
  });

  it("lists the registry's operations for an unmatched `operation:`", async () => {
    const scenario = await makeScenario('resolution-bad-operation', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: bad-operation-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    sleep_ms:
      seed: 500
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/slep
    inputs:
      ms: sleep_ms
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('was not found in plugin');
    expect(output).toContain('Operations provided by this plugin:');
    expect(output).toContain('- time/sleep');
    expect(output).toContain('- control-flow/branch');
    expect(output).toContain('Did you mean "time/sleep"?');
  });

  it('reports a plugin that is declared but not installed', async () => {
    const scenario = await makeScenario('resolution-not-installed', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    // Deliberately no `installFakePlugin`.

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    // The loader warns with the resolution attempt, and the resolver then
    // hard-fails with the list of registries that *were* loaded.
    expect(output).toContain('could not be loaded');
    expect(output).toContain('not installed');
    expect(output).toContain('no contract registry was loaded for it');
    expect(output).toContain('Registries were loaded for (0)');
  });
});

describe('workflow verify — rawbox.lock', () => {
  it('fails with a re-lock hint when the locked registry hash disagrees', async () => {
    const scenario = await makeScenario('lock-mismatch', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await fs.writeFile(
      path.join(scenario.directory, 'rawbox.lock'),
      `
version: "1"
plugins:
  ${FAKE_PLUGIN}:
    resolved: "1.0.0"
    registryHash: "${'0'.repeat(64)}"
`.trim(),
      'utf-8',
    );

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('rawbox.lock mismatch');
    expect(output).toContain(FAKE_PLUGIN);
    expect(output).toContain('workflow lock');
  });

  it('rejects a malformed lock rather than silently ignoring it', async () => {
    const scenario = await makeScenario('lock-malformed', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await fs.writeFile(
      path.join(scenario.directory, 'rawbox.lock'),
      'version: "9"\nplugins: {}\n',
      'utf-8',
    );

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    expect(reported()).toContain('does not match the rawbox.lock schema');
  });
});

// ---------------------------------------------------------------------------
// workflow verify — the boundary check runs on resolver output
//
// A schema-valid authoring document can no longer *produce* a boundary-violating
// resolved model: `additionalProperties: false` on the binding schemas rejects
// the authored mistake first (covered above), and the resolver builds every
// location itself. So the property under test here is not "a violation is
// found" but the defect this pins: the check used to be passed the **raw
// parsed document**, where an authoring document has `steps` and not
// `stepList`, so the check matched nothing and returned `ok()` vacuously.
//
// Substituting the validator is the only way to observe which model it receives
// and to prove its rejection is honoured rather than skipped.
// ---------------------------------------------------------------------------

describe('workflow verify — storage boundaries run on resolver output', () => {
  afterEach(() => {
    vi.doUnmock('@rawbox/runner');
    vi.resetModules();
  });

  it('passes the resolved workflow, not the raw document, and honours a rejection', async () => {
    const scenario = await makeScenario('boundary-resolved', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    const received: unknown[] = [];
    vi.resetModules();
    vi.doMock('@rawbox/runner', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@rawbox/runner')>();
      const { err } = await import('neverthrow');
      return {
        ...actual,
        validateStorageBoundaries: vi.fn((workflow: unknown, workspace: string) => {
          received.push({ workflow, workspace });
          return err(new Error('Preflight Check: Storage boundary validation failed:\n  - injected'));
        }),
      };
    });

    const { verifyWorkflow: freshVerifyWorkflow } = await import(
      '../src/commands/workflow/verify.js'
    );
    await freshVerifyWorkflow(scenario.workflowPath, {
      workspace: scenario.workspacePath,
    });

    // 1. It ran at all. The enclosing block used to be unreachable whenever
    //    `--workspace` was omitted, and vacuous when it was not.
    expect(received).toHaveLength(1);

    const { workflow, workspace } = received[0] as {
      workflow: Record<string, unknown>;
      workspace: string;
    };

    // 2. It received resolver output — the runtime model, which carries
    //    `stepList`/`pluginPathList` — and not the authored document's `steps`.
    expect(workflow).toHaveProperty('stepList');
    expect(workflow).not.toHaveProperty('steps');
    expect(Array.isArray(workflow.stepList)).toBe(true);
    expect((workflow.stepList as unknown[]).length).toBe(1);

    // Fully resolved: `plugin:`/`operation:` have become a DefinitionLocation.
    const [step] = workflow.stepList as Array<Record<string, unknown>>;
    expect(step).toHaveProperty('definitionLocation');
    expect(step).toHaveProperty('storageLocation');

    // 3. The workspace name comes from the workspace document.
    expect(workspace).toBe('verify-test-workspace');

    // 4. Its rejection actually fails verification.
    expectFailed();
    expect(reported()).toContain('Storage boundary validation failed');
  });
});

describe('workspace verify', () => {
  async function makeWorkspaceScenario(
    name: string,
    workflowByFile: Record<string, string>,
  ): Promise<{ directory: string; workspacePath: string }> {
    const directory = path.join(rootDir, name);
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });

    for (const [file, yaml] of Object.entries(workflowByFile)) {
      await fs.writeFile(path.join(workflowDir, file), yaml.trim(), 'utf-8');
    }

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      workspaceYaml(Object.keys(workflowByFile).map((file) => `./workflows/${file}`)).trim(),
      'utf-8',
    );

    return { directory, workspacePath };
  }

  function pluginWorkflowYaml(name: string, specifier: string): string {
    return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  ${FAKE_PLUGIN}: "${specifier}"
${KV_STORAGE}
steps: []
`;
  }

  it('accepts a workspace whose workflows agree on every plugin specifier', async () => {
    const { workspacePath } = await makeWorkspaceScenario('ws-agreeing', {
      'a.yaml': pluginWorkflowYaml('workflow-a', '^1.0.0'),
      'b.yaml': pluginWorkflowYaml('workflow-b', '^1.0.0'),
    });

    await verifyWorkspace(workspacePath);

    expectPassed();
    expect(reported()).toContain(`Plugin ${FAKE_PLUGIN} → ^1.0.0`);
  });

  it('fails when two workflows declare different specifiers for one package', async () => {
    const { workspacePath } = await makeWorkspaceScenario('ws-conflicting', {
      'a.yaml': pluginWorkflowYaml('workflow-a', '^1.0.0'),
      'b.yaml': pluginWorkflowYaml('workflow-b', '^2.0.0'),
    });

    await verifyWorkspace(workspacePath);

    expectFailed();
    const output = reported();
    expect(output).toContain(`Plugin "${FAKE_PLUGIN}" is declared with 2 different specifiers`);
    // Both specifiers, and the file that declared each — the fix is always
    // "make these agree", so the author needs to know which files to edit.
    expect(output).toContain('"^1.0.0"');
    expect(output).toContain('"^2.0.0"');
    expect(output).toContain('./workflows/a.yaml');
    expect(output).toContain('./workflows/b.yaml');
    expect(output).toContain('rawbox.lock');
  });

  it('rejects a listed workflow with no `kind:`', async () => {
    const { workspacePath } = await makeWorkspaceScenario('ws-no-kind-workflow', {
      'a.yaml': `
name: legacy
pluginPathList: []
stepList: []
`,
    });

    await verifyWorkspace(workspacePath);

    expectFailed();
    expect(reported()).toContain('is not a Rawbox workflow document');
    expect(reported()).toContain('kind: Workflow');
  });

  it('fails when a listed workflow file is missing', async () => {
    const directory = path.join(rootDir, 'ws-missing-workflow');
    await fs.mkdir(directory, { recursive: true });
    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(workspacePath, workspaceYaml(['./workflows/gone.yaml']).trim(), 'utf-8');

    await verifyWorkspace(workspacePath);

    expectFailed();
    expect(reported()).toContain('Workflow file not found');
  });

  it('fails when a `file:` specifier points nowhere', async () => {
    const { workspacePath } = await makeWorkspaceScenario('ws-bad-file-spec', {
      'a.yaml': pluginWorkflowYaml('workflow-a', 'file:../plugins/absent'),
    });

    await verifyWorkspace(workspacePath);

    expectFailed();
    expect(reported()).toContain('is not a directory containing a package.json');
  });

  it('rejects a document whose kind is not Workspace', async () => {
    const directory = path.join(rootDir, 'ws-wrong-kind');
    await fs.mkdir(directory, { recursive: true });
    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      'kind: Workflow\nname: not-a-workspace\nworkflowPathList: []\n',
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectFailed();
    // Names what the document actually declares and what it must declare —
    // asserted on the substance rather than the sentence, so rewording the
    // diagnostic does not fail this test but dropping either fact does.
    expect(reported()).toContain('"Workflow"');
    expect(reported()).toContain('kind: Workspace');
  });

  it('rejects a workspace with no kind at all, naming the line to add', async () => {
    // A document with no `kind:` at all: it is one line short, and the error
    // has to say which line.
    const directory = path.join(rootDir, 'ws-no-kind');
    await fs.mkdir(directory, { recursive: true });
    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      'name: legacy-workspace\nworkflowPathList: []\n',
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectFailed();
    expect(reported()).toContain('kind: Workspace');
    // The reason it matters, not just the fact: an author who is told to add a
    // field without being told what it does will reasonably wonder if they can
    // skip it. They cannot — discovery matches on this and nothing else.
    expect(reported()).toContain('discovery');
  });
});

describe('workflow verify — storage budget', () => {
  /**
   * A mixed kv/fifo storage block, identical in shape to
   * `packages/rawbox-runner/tests/fixtures/example.workflow.yaml`: one
   * `lmdb-fifo` key declared under `strategies`, two `lmdb-kv` keys that fall
   * back to `defaultStrategy` through `seed` alone.
   *
   * Hand-checked against `budgetForStorage` (verified independently in a
   * scratch script — both agree):
   *
   *   queue_items (lmdb-fifo, queueSizeMax 1000, valueSizeMax 1900):
   *     slotCount = 999
   *     dataKeySize  = len("fifo:queue_items:data:") + digits(999) = 22 + 3 = 25
   *     headKeySize  = len("fifo:queue_items:head") = 21
   *     tailKeySize  = len("fifo:queue_items:tail") = 21
   *     in-page? 25 + 1900 = 1925 ≤ 2013, yes — so no page rounding.
   *     entryDataBytes(25, 1900) = (2 + 8 + 25) + 1900 = 1935
   *     dataBytesMax = 999 * 1935 + (2+8+21) + 9 + (2+8+21) + 9
   *                  = 1,933,065 + 31 + 9 + 31 + 9 = 1,933,145
   *     entryCount   = 999 + 2 = 1001
   *
   *   sleep_ms / is_ready (lmdb-kv, defaultStrategy, valueSizeMax 1900):
   *     keySize = 8 (both keys are 8 bytes)
   *     in-page? 8 + 1900 = 1908 ≤ 2013, yes.
   *     dataBytesMax = (2 + 8 + 8) + 1900 = 1918, each
   *     entryCount   = 1, each
   *
   *   Declared subtotal: 1,933,145 + 1,918 + 1,918 = 1,936,981 over 1003 entries
   *
   *   slept_at    bound by `steps[0].outputs.timestamp` and declared nowhere,
   *               so it resolves to defaultStrategy like any undeclared key
   *               and is written at run time — hence counted.
   *               keySize = 8; 8 + 1900 = 1908 ≤ 2013, in-page.
   *               dataBytesMax = (2 + 8 + 8) + 1900 = 1918, entryCount = 1
   *
   *               `sleep_ms` is bound too (`steps[0].inputs.ms`) but already
   *               declared through `seed`, so it is not counted twice.
   *
   *   Workflow total: dataBytesMax = 1,936,981 + 1,918 = 1,938,899
   *                    entryCount   = 1003 + 1 = 1004
   *
   *   recommendedVolumeBytes is a SECOND accounting of the same entries, in
   *   pages — not `dataBytesMax` scaled. A leaf node costs
   *   2 + 8 + even(k) + even(v + 18), a page holds floor(4080 / node) of them,
   *   and a settled page is 0.55 full. Nothing here overflows, so there are no
   *   dedicated overflow pages:
   *
   *     queue_items  999 slots at k = 25, v = 1900
   *                  node       = 2 + 8 + 26 + even(1918) = 1954
   *                  nodes/page = floor(4080 / 1954) = 2
   *                  leaf share = 999 / (2 * 0.55) = 999 / 1.1 = 908.181818...
   *                  head+tail: 2 entries at k = 21, v = 9
   *                  node       = 2 + 8 + 22 + even(27) = 60
   *                  nodes/page = floor(4080 / 60) = 68
   *                  leaf share = 2 / (68 * 0.55) = 2 / 37.4   =   0.053475...
   *
   *     sleep_ms / is_ready / slept_at, each k = 8, v = 1900
   *                  node       = 2 + 8 + 8 + even(1918) = 1936
   *                  nodes/page = floor(4080 / 1936) = 2
   *                  leaf share = 1 / 1.1 = 0.909090..., three of them
   *                                                       =   2.727272...
   *                                                          -------------
   *                  total leaf share                          910.962566...
   *
   *     Shares are fractional and round ONCE, at the total: a leaf page belongs
   *     to the dbi, not to a key.
   *
   *     pageCountMax = ceil(910.962566...)                  =         911
   *
   *     recommendedVolumeBytes
   *       = ceil(max((8192 + 6144 * 1 + 4096 * 911) * 1.15, 262144) / 4096) * 4096
   *       = ceil(3,745,792 * 1.15 / 4096) * 4096
   *       = ceil(4,307,660.8 / 4096) * 4096
   *       = ceil(1051.67...) * 4096 = 1052 * 4096           =   4,308,992
   *
   *   The in-page test is key-aware, and that is what keeps these entries on
   *   the cheap branch: at `valueSizeMax` 2022 the sums (25 + 2022 = 2047,
   *   8 + 2022 = 2030) would both exceed 2013 and every entry would be charged
   *   a whole 4096-byte page instead.
   */
  function budgetWorkflowYaml(name = 'budget-workflow'): string {
    return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    queue_items:
      strategy:
        name: lmdb-fifo
        queueSizeMax: 1000
        valueSizeMax: 1900
      seed: [a, b, c]
    sleep_ms:
      seed: 500
    is_ready:
      seed: true
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: slept_at
`;
  }

  it('prints a per-key budget and a workflow total that matches a hand check', async () => {
    const scenario = await makeScenario('budget-workflow', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: budgetWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    const output = reported();

    // Per-key figures, hand-checked above.
    expect(output).toContain('Key "queue_items" (lmdb-fifo, declared)');
    expect(output).toContain('1001 entries');
    expect(output).toContain('1933145');
    expect(output).toContain('Key "sleep_ms" (lmdb-kv, declared)');
    expect(output).toContain('1 entry,');
    expect(output).toContain('1918');
    expect(output).toContain('Key "is_ready" (lmdb-kv, declared)');

    // The key no declaration mentions, which the budget nonetheless covers —
    // and the line saying where it came from. A reader shown four keys against
    // three declarations, with nothing explaining the fourth, would reasonably
    // conclude the figure is wrong.
    expect(output).toContain('Key "slept_at" (lmdb-kv, bound by a step)');
    expect(output).toContain(
      '1 of these 4 keys is bound by a step and declared nowhere in storage:',
    );
    expect(output).toContain('Cross-workflow reads');

    // Workflow total: two DISTINCT, distinctly labelled figures — never one
    // number presented as both.
    expect(output).toContain('dataBytesMax');
    expect(output).toContain('1938899');
    expect(output).toContain('1004 entries');
    expect(output).toContain('recommendedVolumeBytes');
    expect(output).toContain('4308992');
    // The two figures must not collapse into the same reported number.
    expect(output).toContain('DIFFERENT number from dataBytesMax');
  });

  it('reports a non-zero budget for a workflow declaring no strategies and no seed', async () => {
    // The sharp case for the step-binding sweep. This document declares only a
    // `defaultStrategy` — no `strategies`, no `seed` — and used to report
    // `dataBytesMax: 0` while writing one key per binding at run time. Not an
    // approximation that was a bit low: structurally blind, and the figure a
    // container is sized from.
    //
    // Hand-derived: overhead(k) = 2 + 8 + k, defaultStrategy valueSizeMax
    // 1900, both keys comfortably in-page:
    //
    //   sleep_ms       8 bytes  (10 + 8) + 1900  = 1918
    //   sleep_done_at 13 bytes  (10 + 13) + 1900 = 1923
    //                                             ------
    //   dataBytesMax                                3841   over 2 entries
    //
    //   Pages, both in-page and both at 2 nodes to a page:
    //     sleep_ms      node = 2 + 8 + 8 + even(1918) = 1936, floor(4080/1936) = 2
    //     sleep_done_at node = 2 + 8 + 14 + even(1918) = 1942, floor(4080/1942) = 2
    //     leaf share    = 1 / (2 * 0.55) each = 0.909090... × 2 = 1.818181...
    //     pageCountMax  = ceil(1.818181...) = 2
    //
    //   The model prices that at (8192 + 6144 + 2 * 4096) * 1.15 = 25,907 —
    //   below what an environment really occupies once MVCC has settled — so
    //   LMDB_ENV_OVERHEAD_BYTES floors it:
    //
    //   recommendedVolumeBytes = max(25 907, 262 144), page-rounded = 262 144
    //
    //   The floor is a measured 256 KiB; here it is the whole figure, because
    //   two pages of declared data are nothing beside it.
    const scenario = await makeScenario('budget-undeclared-only', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: undeclared-only-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
steps:
  # \`sleep_ms\` is written here rather than seeded, so the document still
  # declares no \`strategies\` and no \`seed\` — the point of this test — while
  # satisfying the rule that a key which is read must be written by something
  # (FORMAT.md, "Storage keys").
  # A write by any step counts, whatever the order.
  - label: prime
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: sleep_ms
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: sleep_done_at
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    const output = reported();

    expect(output).toContain('Key "sleep_ms" (lmdb-kv, bound by a step)');
    expect(output).toContain('Key "sleep_done_at" (lmdb-kv, bound by a step)');
    expect(output).toContain('3841');
    expect(output).toContain('2 entries');
    expect(output).toContain('262144');
    expect(output).toContain('2 of these 2 keys are bound by a step');
  });

  it('flags a key whose valueSizeMax forces it onto overflow pages', async () => {
    const scenario = await makeScenario('budget-overflow-clean', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: overflow-workflow-clean
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 3000
  keys:
    sleep_ms:
      seed: 500
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    const output = reported();
    expect(output).toContain('Key "sleep_ms" (lmdb-kv, declared)');
    expect(output).toContain('uses overflow pages');
    // The note names the sum, not the value alone: 'sleep_ms' is 8 bytes and
    // 8 + 3000 = 3008 is past 2013. A reader told only "valueSizeMax > 2013"
    // would go looking for a value-only ceiling that does not exist.
    expect(output).toContain('keySizeMax 8 + valueSizeMax > 2013');
  });
});

describe('workflow verify — cross-workflow reads', () => {
  /**
   * One local key (seeded, written into `slept_at`) plus one step that reads
   * `shared_ms` from another workflow's box (`{ key, workflow }`). The second
   * step has no `outputs:` at all, so the only effect a cross-workflow read
   * has on the storage budget is that it does not appear in it.
   */
  function crossWorkflowReaderYaml(name = 'cross-workflow-reader'): string {
    return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    sleep_ms:
      seed: 500
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: slept_at
  - label: sleep-remote
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms:
        key: shared_ms
        workflow: upstream-workflow
`;
  }

  /** The same document, with the cross-workflow step removed entirely. */
  function baselineYaml(name = 'cross-workflow-baseline'): string {
    return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    sleep_ms:
      seed: 500
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: slept_at
`;
  }

  it('names the key and the owning workflow for a `{ key, workflow }` input', async () => {
    const scenario = await makeScenario('cross-workflow-reader', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: crossWorkflowReaderYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    const output = reported();

    expect(output).toContain('Cross-workflow read');
    expect(output).toContain('shared_ms');
    expect(output).toContain('upstream-workflow');
    // Its bytes are counted elsewhere, not omitted for no reason — the key
    // itself never appears as a budgeted entry.
    expect(output).not.toContain('Key "shared_ms"');
  });

  it('names them for a key-table declaration read by a SHORTHAND binding', async () => {
    // The binding here is a bare key name — `ms: shared_ms` — so nothing about
    // it is cross-workflow. The report used to find the owner by re-reading
    // `steps[n].inputs` for a `workflow:` field, which this document does not
    // have; it now reads `StorageBinding.owningWorkflow`, which the key table
    // supplies for every binding of the key at once.
    const scenario = await makeScenario('cross-workflow-key-table', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: cross-workflow-key-table
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    shared_ms:
      workflow: upstream-workflow
    sleep_ms:
      seed: 500
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: slept_at
  - label: sleep-remote
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: shared_ms
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    const output = reported();

    expect(output).toContain('Cross-workflow read');
    expect(output).toContain('shared_ms');
    expect(output).toContain('upstream-workflow');
    // And its bytes are still charged to the workflow that owns it.
    expect(output).not.toContain('Key "shared_ms"');
  });

  it('gains no new output for a workflow with no cross-workflow reads', async () => {
    const scenario = await makeScenario('cross-workflow-none', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: baselineYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    expect(reported()).not.toContain('Cross-workflow read (');
  });

  it('leaves the budget figures unchanged by the presence of a cross-workflow read', async () => {
    // Same declared `name:` in both documents (they live in separate
    // scenario directories, so there is no collision) — otherwise the
    // per-workflow summary lines would differ by name text alone and the
    // exact-equality check below would be comparing the wrong thing.
    const sharedName = 'budget-parity-workflow';
    const withRead = await makeScenario('cross-workflow-with', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: crossWorkflowReaderYaml(sharedName),
    });
    await installFakePlugin(withRead.directory);
    const withoutRead = await makeScenario('cross-workflow-without', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: baselineYaml(sharedName),
    });
    await installFakePlugin(withoutRead.directory);

    await verifyWorkflow(withRead.workflowPath, { workspace: withRead.workspacePath });
    expectPassed();
    const outputWithRead = reported();

    messageList = [];
    await verifyWorkflow(withoutRead.workflowPath, { workspace: withoutRead.workspacePath });
    expectPassed();
    const outputWithoutRead = reported();

    // Same two local keys either way (`sleep_ms` seeded, `slept_at` bound):
    // 8 + 1900 = 1918 bytes each, 3836 total over 2 entries. The cross-workflow
    // read must not move this figure by a single byte.
    for (const figure of ['3836', '1918', '2 entries']) {
      expect(outputWithRead).toContain(figure);
      expect(outputWithoutRead).toContain(figure);
    }

    const extractSummary = (output: string): string[] =>
      output
        .split('\n')
        .filter((line) => line.includes('dataBytesMax') || line.includes('recommendedVolumeBytes'));

    expect(extractSummary(outputWithRead)).toEqual(extractSummary(outputWithoutRead));
  });
});

describe('workspace verify — storage budget total', () => {
  function kvWorkflowYamlWithSeed(name: string, keySeed: string, value: string): string {
    return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    ${keySeed}:
      seed: ${value}
steps: []
`;
  }

  async function makeWorkspaceScenarioTopLevel(
    name: string,
    workflowByFile: Record<string, string>,
  ): Promise<{ directory: string; workspacePath: string }> {
    const directory = path.join(rootDir, name);
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });

    for (const [file, yaml] of Object.entries(workflowByFile)) {
      await fs.writeFile(path.join(workflowDir, file), yaml.trim(), 'utf-8');
    }

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      workspaceYaml(Object.keys(workflowByFile).map((file) => `./workflows/${file}`)).trim(),
      'utf-8',
    );

    return { directory, workspacePath };
  }

  it('reports a per-key, per-workflow, and workspace-total budget, distinctly labelled', async () => {
    const directory = path.join(rootDir, 'ws-budget');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });

    await fs.writeFile(
      path.join(workflowDir, 'a.yaml'),
      kvWorkflowYamlWithSeed('workflow-a', 'sleep_ms', '500').trim(),
      'utf-8',
    );
    // Same key name and length as workflow-a's ("sleep_ms", 8 bytes) —
    // budgets are computed per workflow, not shared across them, so this
    // still produces two independent 1918-byte entries, not one shared one.
    await fs.writeFile(
      path.join(workflowDir, 'b.yaml'),
      kvWorkflowYamlWithSeed('workflow-b', 'sleep_ms', '"x"').trim(),
      'utf-8',
    );

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      workspaceYaml(['./workflows/a.yaml', './workflows/b.yaml']).trim(),
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectPassed();
    const output = reported();

    // Per key, per workflow. Both workflows have `steps: []`, so there is
    // nothing bound and every key is `declared`.
    expect(output).toContain('Key "sleep_ms" (lmdb-kv, declared)');
    expect(output).toContain('Workflow "workflow-a": dataBytesMax');
    expect(output).toContain('Workflow "workflow-b": dataBytesMax');

    // Each single-kv-key workflow: 8 + 1900 = 1908 ≤ 2013, so in-page, and
    // (2 + 8 + 8) + 1900 = 1918 bytes, 1 entry.
    expect(output).toContain('1918');

    // Workspace total: two workflows of 1918 bytes each = 3836, and the
    // recommendedVolumeBytes must be a DIFFERENT, larger number, never the same
    // figure relabelled.
    expect(output).toContain('Workspace storage budget total');
    expect(output).toContain('Workspace "verify-test-workspace": dataBytesMax');
    expect(output).toContain('3836');
    expect(output).toContain('recommendedVolumeBytes');
    expect(output).toContain('DIFFERENT number from dataBytesMax');
  });

  it('excludes a workflow that failed to validate from the total, and says so', async () => {
    const { workspacePath } = await makeWorkspaceScenarioTopLevel('ws-budget-partial', {
      'a.yaml': kvWorkflowYamlWithSeed('workflow-a', 'sleep_ms', '500'),
      'b.yaml': 'name: legacy\npluginPathList: []\nstepList: []\n',
    });

    await verifyWorkspace(workspacePath);

    expectFailed(); // the malformed workflow still fails the run overall
    const output = reported();
    expect(output).toContain('Workflow "workflow-a": dataBytesMax');
    expect(output).toContain('Workspace storage budget total');
    expect(output).toContain('Only 1 of 2 declared');
  });

  function crossWorkflowReaderYaml(name: string, owningWorkflow: string): string {
    return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
steps:
  - label: read-remote
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms:
        key: shared_ms
        workflow: ${owningWorkflow}
`;
  }

  it("marks a cross-workflow read's owner as verified when it is one of this workspace's workflows", async () => {
    const { workspacePath } = await makeWorkspaceScenarioTopLevel('ws-cross-owner-present', {
      'owner.yaml': kvWorkflowYamlWithSeed('owner-workflow', 'shared_ms', '500'),
      'reader.yaml': crossWorkflowReaderYaml('reader-workflow', 'owner-workflow'),
    });

    await verifyWorkspace(workspacePath);

    expectPassed();
    const output = reported();

    expect(output).toContain('Cross-workflow read');
    expect(output).toContain('shared_ms');
    expect(output).toContain('owner-workflow');
    expect(output).toContain('verified in this run');
    // The bytes belong to the owner's budget, not the reader's — the reader's
    // own budget covers zero entries, since a cross-workflow input is its only
    // storage reference and it carries no bytes here.
    expect(output).toContain('Workflow "reader-workflow": dataBytesMax ≤ 0 bytes across 0 entries');
  });

  it("marks a cross-workflow read's owner as NOT part of the workspace when no workflow declares that name", async () => {
    const { workspacePath } = await makeWorkspaceScenarioTopLevel('ws-cross-owner-absent', {
      'reader.yaml': crossWorkflowReaderYaml('reader-workflow-orphan', 'ghost-workflow'),
    });

    await verifyWorkspace(workspacePath);

    expectPassed();
    const output = reported();

    expect(output).toContain('Cross-workflow read');
    expect(output).toContain('ghost-workflow');
    expect(output).toContain('NOT part of this workspace');
  });

  it('gains no new cross-workflow output for a workspace with no cross-workflow reads', async () => {
    const directory = path.join(rootDir, 'ws-cross-none');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowDir, 'a.yaml'),
      kvWorkflowYamlWithSeed('workflow-only-a', 'sleep_ms', '500').trim(),
      'utf-8',
    );
    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      workspaceYaml(['./workflows/a.yaml']).trim(),
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectPassed();
    expect(reported()).not.toContain('Cross-workflow read (');
  });
});

// ---------------------------------------------------------------------------
// A strategy with no byte budget, end to end
//
// `StrategyDescriptor.budget` has always been optional, and `budgetForKey`,
// `partitionKeyBudgetOutcomeList` and every reporting function in
// `utils/budget-report.ts` have always had a `budgetable: false` half. Until
// `redis-kv` joined the union that half was **unreachable through a real
// document** — it could only be exercised against a hand-built mixture
// (`budget-report.test.ts`). These tests reach it the way a reader does: by
// running `verify` on a document that declares the strategy.
//
// **No Redis server is involved, and none is needed.** Everything below is
// static analysis of two YAML files.
//
// The invariant every one of them protects is that the excluded key is
// *visible*: named, marked "not applicable", and subtracted from a total that
// says how many keys it now covers. A `0` in a column of byte counts would be
// the one statement about the key that is certainly false: a zero is summed
// like any other figure, and a summed zero states that the key costs nothing.
// ---------------------------------------------------------------------------

describe('verify — a strategy that declares no byte budget (redis-kv)', () => {
  /**
   * One `redis-kv` key beside two `lmdb-kv` ones.
   *
   * The LMDB figures are the *same* hand-computed ones as the cross-workflow
   * parity test above, and deliberately so: `sleep_ms` is seeded and `slept_at`
   * is bound by the step, both 8-byte keys under a `valueSizeMax` of 1900, so
   * each costs `(2 + 8 + 8) + 1900 = 1918` bytes over one entry — 3836 across
   * two entries. Adding a `redis-kv` key must not move either number by a byte,
   * which is the arithmetic half of "excluded, not charged zero": a zero would
   * be summed and would leave the total unchanged too, so the totals alone
   * cannot distinguish the two. The *reporting* assertions below are what
   * separate them.
   */
  /**
   * A workflow whose every key is `redis-kv`, so **nothing** in it can be
   * charged bytes.
   *
   * It used to mix an `lmdb-kv` default with one `redis-kv` key, which was the
   * tidiest way to get a budgeted and an unbudgeted key into one report. The
   * co-transactional rule (FORMAT.md, "Strategies") made that document
   * illegal: one step's write and the next step's read are a single
   * transaction, and a transaction cannot span two stores. The mixed case now
   * lives at the *workspace* level — several workflows, each internally
   * consistent — which is what a workspace total is, and what the workspace tests below
   * exercise.
   *
   * What survives here is the sharper half: a report whose totals cover **none**
   * of the keys swept. A `0` in a byte column is most dangerous precisely when
   * it is the whole total, because "this workflow needs no storage" is a
   * reading an operator can act on.
   */
  function redisOnlyWorkflowYaml(name = 'redis-only-workflow'): string {
    return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
storage:
  defaultStrategy:
    name: redis-kv
    valueSizeMax: 1900
    backend: main
  keys:
    sleep_ms:
      seed: 500
    cache_entry:
      seed: "cached"
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: slept_at
`;
  }

  it('reports a redis-kv key as not applicable, never as 0 bytes', async () => {
    const scenario = await makeScenario('budget-redis-kv', {
      workspaceYaml: workspaceWithBackendsYaml({}),
      workflowYaml: redisOnlyWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    const output = reported();

    // The key is NAMED, with its strategy and where it came from — the same
    // three facts a budgeted key's line carries, so a reader scanning the
    // column does not have to notice an absence.
    expect(output).toContain('Key "cache_entry" (redis-kv, declared)');
    expect(output).toContain('not applicable');
    expect(output).toContain('this strategy declares no byte budget');

    // And it is NOT charged. The forbidden rendering is a byte figure on this
    // key's line; asserted on the line itself rather than on the whole output,
    // because "0" appears legitimately elsewhere (page counts, timestamps).
    const cacheLine = output
      .split('\n')
      .find((line) => line.includes('Key "cache_entry"'));
    expect(cacheLine).toBeDefined();
    expect(cacheLine).not.toContain('dataBytesMax');
    expect(cacheLine).not.toContain('0 bytes');
    expect(cacheLine).toContain('NOT zero bytes');
  });

  it('says the totals cover fewer keys than the document declares, and names which', async () => {
    const scenario = await makeScenario('budget-redis-note', {
      workspaceYaml: workspaceWithBackendsYaml({}),
      workflowYaml: redisOnlyWorkflowYaml('redis-note-workflow'),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    const output = reported();

    // The risk this closes is not "the key was not shown" but "the total was
    // read as covering it". Three keys are swept and NONE is charged, which is
    // the sharper form of the same hazard: the totals below are `0`, and a
    // reader must not take that for "this workflow needs no storage".
    expect(output).toContain('3 keys are NOT included in the figures below');
    expect(output).toContain('"cache_entry" (redis-kv)');
    expect(output).toContain('The totals below therefore cover 0 of 3 keys');
    expect(output).toContain("they size THIS store's volume, not the other backend's");
    // And the `0` is present as a total, so the sentence above is load-bearing
    // rather than decorative.
    expect(output).toContain('dataBytesMax ≤ 0 bytes across 0 entries');
  });

  /**
   * A workspace holding one all-Redis workflow and one all-LMDB workflow.
   *
   * This is what "mixed" means now. A single workflow may not span two stores
   * (FORMAT.md, "Strategies" — one step's write and the next step's read are
   * one transaction), so the only legal way to have a budgeted and an
   * unbudgeted key in one report is across workflows, which is exactly what a
   * workspace total is.
   *
   * Returns the workspace path.
   */
  async function makeMixedWorkspace(dirName: string): Promise<string> {
    const directory = path.join(rootDir, dirName);
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });

    await fs.writeFile(
      path.join(workflowDir, 'redis.yaml'),
      redisOnlyWorkflowYaml('ws-redis-workflow').trim(),
      'utf-8',
    );
    await fs.writeFile(
      path.join(workflowDir, 'lmdb.yaml'),
      `
kind: Workflow
formatVersion: "1.0"
name: ws-lmdb-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    sleep_ms:
      seed: 500
steps: []
`.trim(),
      'utf-8',
    );

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      workspaceWithBackendsYaml({
        workflowRelativePathList: ['./workflows/redis.yaml', './workflows/lmdb.yaml'],
      }).trim(),
      'utf-8',
    );

    return workspacePath;
  }

  it('reports the LMDB workflow as the whole of the workspace provisioning figure', async () => {
    // Moved to the workspace level deliberately. This assertion used to live on
    // a single workflow that mixed an `lmdb-kv` default with one `redis-kv`
    // key; the co-transactional rule made that document illegal, and a workspace
    // total is now where the mixed case lives — internally-consistent workflows.
    const workspacePath = await makeMixedWorkspace('ws-budget-redis-total');

    await verifyWorkspace(workspacePath);

    expectPassed();
    const output = reported();

    // The LMDB workflow's one key is charged, and is the only thing charged.
    expect(output).toContain('Key "sleep_ms" (lmdb-kv, declared): 1 entry, dataBytesMax ≤ 1918 bytes');
    expect(output).toContain('Workflow "ws-lmdb-workflow": dataBytesMax ≤ 1918 bytes across 1 entries');

    // The Redis workflow contributes no bytes at all, and says so rather than
    // contributing a zero.
    expect(output).toContain('Workflow "ws-redis-workflow": dataBytesMax ≤ 0 bytes across 0 entries');
    expect(output).toContain('not applicable');

    // And the workspace total is the LMDB figure — the Redis workflow neither
    // adds to it nor is silently folded into it.
    expect(output).toContain('Workspace storage budget total');
    expect(output).toContain('dataBytesMax ≤ 1918 bytes across 1 entries');
    // Still two distinctly labelled figures. A partial total is still a total
    // that must not be confused with a volume size.
    expect(output).toContain('recommendedVolumeBytes');
    expect(output).toContain('DIFFERENT number from dataBytesMax');
  });

  it('leaves the workspace figures identical to a workspace with no redis workflow', async () => {
    // The parity check that makes "excluded" mean excluded, also lifted to the
    // workspace level. A Redis workflow must change WHAT IS REPORTED without
    // changing ANY FIGURE a container is sized from.
    const withRedisPath = await makeMixedWorkspace('ws-budget-parity-with');

    await verifyWorkspace(withRedisPath);
    expectPassed();
    const outputWithRedis = reported();

    // The same workspace minus the Redis workflow entirely.
    const withoutDir = path.join(rootDir, 'ws-budget-parity-without');
    const withoutWorkflowDir = path.join(withoutDir, 'workflows');
    await fs.mkdir(withoutWorkflowDir, { recursive: true });
    await fs.writeFile(
      path.join(withoutWorkflowDir, 'lmdb.yaml'),
      `
kind: Workflow
formatVersion: "1.0"
name: ws-lmdb-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    sleep_ms:
      seed: 500
steps: []
`.trim(),
      'utf-8',
    );
    const withoutPath = path.join(withoutDir, 'workspace.yaml');
    await fs.writeFile(
      withoutPath,
      workspaceWithBackendsYaml({
        workflowRelativePathList: ['./workflows/lmdb.yaml'],
      }).trim(),
      'utf-8',
    );

    // `messageList` accumulates across runs within one test and is reset only
    // in `beforeEach`, so the second run has to start from a clean slate or it
    // would be compared against both runs concatenated.
    messageList = [];

    await verifyWorkspace(withoutPath);
    expectPassed();
    const outputWithoutRedis = reported();

    // The workspace-level FIGURES, not the prose around them — the two numbers
    // an operator provisions from, plus the entry count behind them.
    //
    // Deliberately numbers rather than whole lines. The two reports do differ
    // in one word: `recommendedVolumeBytes` explains itself as covering "2
    // workflows' dbis" with the Redis workflow present and "1 workflow' dbis"
    // without, because the LMDB environment charges one database per workflow
    // regardless of where that workflow's keys actually live. The resulting
    // BYTES are identical, and an over-estimate would be the safe direction
    // anyway, so the invariant worth pinning is the figure — asserting the
    // sentence would fail on a true statement.
    const extractDataBytes = (output: string): string[] =>
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('Workspace "'))
        .map(
          (line) =>
            line.match(
              /dataBytesMax ≤ \d+ bytes across \d+ entries|recommendedVolumeBytes = \d+ bytes/,
            )?.[0] ?? line,
        );

    // Identical workspace totals: the figure a container is sized from, and the
    // entry count behind it. An unbudgetable key charged `0` would also satisfy
    // this — which is why the tests above assert the reporting as well.
    expect(extractDataBytes(outputWithRedis)).toEqual(extractDataBytes(outputWithoutRedis));

    // And the difference that SHOULD exist does: only one of them names keys it
    // could not charge.
    expect(outputWithRedis).toContain('not applicable');
    expect(outputWithoutRedis).not.toContain('not applicable');
    expect(outputWithoutRedis).not.toContain('NOT part of the workspace total above');
  });

  it('lists the excluded key by workflow and key name in a workspace total', async () => {
    const directory = path.join(rootDir, 'ws-budget-redis');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });

    await fs.writeFile(
      path.join(workflowDir, 'mixed.yaml'),
      redisOnlyWorkflowYaml('ws-mixed-workflow').trim(),
      'utf-8',
    );
    // A second, purely LMDB workflow, so the workspace total is a real total
    // over a mixed workspace rather than a total over one workflow.
    await fs.writeFile(
      path.join(workflowDir, 'lmdb.yaml'),
      `
kind: Workflow
formatVersion: "1.0"
name: ws-lmdb-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
  keys:
    sleep_ms:
      seed: 500
steps: []
`.trim(),
      'utf-8',
    );

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      workspaceWithBackendsYaml({
        workflowRelativePathList: ['./workflows/mixed.yaml', './workflows/lmdb.yaml'],
      }).trim(),
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectPassed();
    const output = reported();

    // Per workflow, first — the key named where it was declared.
    expect(output).toContain('Key "cache_entry" (redis-kv, declared)');

    // Then beneath the workspace total, tagged with the workflow it belongs to.
    // The workflow NAME, not the file path: it is the identifier a reader can
    // go and look up.
    expect(output).toContain('Workspace storage budget total');
    expect(output).toContain('3 keys are NOT part of the workspace total above');
    expect(output).toContain(
      'Workflow "ws-mixed-workflow", key "cache_entry" (redis-kv, declared)',
    );
    expect(output).toContain(
      'not applicable — bounded by the backend that holds it, not by this workspace',
    );

    // The total itself is the LMDB workflow's figure and nothing else. Every
    // key of the Redis workflow is excluded, so the workspace total is exactly
    // the 1918 bytes of `ws-lmdb-workflow`'s single `sleep_ms` — not a sum that
    // quietly counted the excluded keys as zero.
    expect(output).toContain('Workspace "verify-test-workspace": dataBytesMax ≤ 1918 bytes');
  });

  it('quotes redis-kv\'s own empty-read sentence for a key nothing writes', async () => {
    // The diagnostic for a key that is read but never written must quote the
    // sentence the key's OWN strategy
    // declares. `redis-kv` declares the same sentence as `lmdb-kv` on purpose —
    // a cell that is missing is a cell that is missing, whatever holds it — so
    // this asserts the rule reaches a strategy that reuses another's wording,
    // which is the case the rule explicitly allows.
    const scenario = await makeScenario('budget-redis-unwritten', {
      workspaceYaml: workspaceWithBackendsYaml({}),
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: redis-unwritten-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
storage:
  defaultStrategy:
    name: redis-kv
    valueSizeMax: 1900
    backend: main
steps:
  - label: sleep
    plugin: ${FAKE_PLUGIN}
    operation: time/sleep
    inputs:
      ms: never_written
`,
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('never_written');
    expect(output).toContain('Value not found');
  });
});

// ---------------------------------------------------------------------------
// `backends:` — the workspace's map of backend id → connection descriptor
//
// Two diagnostics, both verify-time, both about connecting to the RIGHT place:
// an id that names no entry, and an entry whose connection string references an
// environment variable nobody set. The second is the one with teeth — a run
// that silently connects to `localhost` because `${REDIS_URL}` expanded to
// nothing is the failure the whole design is arranged around.
//
// No server is contacted by any of these. Nothing here opens a socket.
// ---------------------------------------------------------------------------

describe('verify — backends', () => {
  function redisWorkflowYaml(options: {
    name?: string;
    backendId?: string;
  } = {}): string {
    const name = options.name ?? 'redis-backend-workflow';
    const backendId = options.backendId ?? 'main';

    return `
kind: Workflow
formatVersion: "1.0"
name: ${name}
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
storage:
  defaultStrategy:
    name: redis-kv
    valueSizeMax: 1900
    backend: ${backendId}
  keys:
    cache_entry:
      seed: "cached"
steps: []
`;
  }

  it('resolves a backend id and reports every variable as set', async () => {
    process.env.RAWBOX_TEST_REDIS_URL = 'redis://cache.internal:6379/0';
    try {
      const scenario = await makeScenario('backends-ok', {
        workspaceYaml: workspaceWithBackendsYaml({
          backendById: { main: '${RAWBOX_TEST_REDIS_URL}' },
        }),
        workflowYaml: redisWorkflowYaml(),
      });
      await installFakePlugin(scenario.directory);

      await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

      expectPassed();
      expect(reported()).toContain(
        'storage backend reference resolved',
      );
    } finally {
      delete process.env.RAWBOX_TEST_REDIS_URL;
    }
  });

  it('fails when a backend id names no entry, listing the ids that do exist', async () => {
    const scenario = await makeScenario('backends-unknown-id', {
      workspaceYaml: workspaceWithBackendsYaml({
        backendById: { cache: 'redis://cache.internal:6379/0' },
      }),
      workflowYaml: redisWorkflowYaml({ backendId: 'main' }),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();

    // Name the thing, name where it was declared, say what to do.
    expect(output).toContain('Backend "main" is not declared by this workspace');
    // The declaration path the diagnostic names, which is where the fixture
    // puts the strategy: on the default rather than on a per-key override.
    // The point of the assertion is that the message names WHERE the offending
    // backend id was written, not merely that an id was unknown.
    expect(output).toContain('storage.defaultStrategy');
    expect(output).toContain('Declared backend ids: "cache".');
    // Never a schema branch dump: the document is schema-valid and what is
    // wrong is a reference.
    expect(output).not.toContain('anyOf');
  });

  it('shows the block to add when the workspace declares no backends at all', async () => {
    const scenario = await makeScenario('backends-absent', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: redisWorkflowYaml({ backendId: 'main' }),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();

    expect(output).toContain('has no "backends:" block at all');
    // A missing block is a different mistake from a missing entry, and gets the
    // block to write rather than a list of ids that would be empty.
    expect(output).toContain('backends:');
    expect(output).toContain('connection: ${REDIS_URL}');
    expect(output).toContain('never a connection string');
  });

  it('fails loudly when a referenced environment variable is unset', async () => {
    delete process.env.RAWBOX_TEST_ABSENT_URL;

    const scenario = await makeScenario('backends-unset-env', {
      workspaceYaml: workspaceWithBackendsYaml({
        backendById: { main: '${RAWBOX_TEST_ABSENT_URL}' },
      }),
      workflowYaml: redisWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();

    // The variable AND the backend id — a workspace may declare several, and
    // the author needs to know which entry to look at.
    expect(output).toContain('RAWBOX_TEST_ABSENT_URL');
    expect(output).toContain('Backend "main" cannot be resolved');
    expect(output).toContain('backends.main.connection');
    expect(output).toContain('not set in this process');
    // The reading that must be contradicted: that something sensible happens
    // anyway. It does not — that is the whole point of the check.
    expect(output).toContain('NO default and no fallback');
  });

  it('treats an empty variable as unset, and says which it was', async () => {
    process.env.RAWBOX_TEST_EMPTY_URL = '';
    try {
      const scenario = await makeScenario('backends-empty-env', {
        workspaceYaml: workspaceWithBackendsYaml({
          backendById: { main: 'redis://user:${RAWBOX_TEST_EMPTY_URL}@host:6379' },
        }),
        workflowYaml: redisWorkflowYaml(),
      });
      await installFakePlugin(scenario.directory);

      await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

      expectFailed();
      const output = reported();

      // The exact failure being designed out: an empty expansion leaves a URL
      // that is still syntactically valid, and a client would open it.
      expect(output).toContain('RAWBOX_TEST_EMPTY_URL');
      expect(output).toContain('set, but empty');
    } finally {
      delete process.env.RAWBOX_TEST_EMPTY_URL;
    }
  });

  it('does not fail an LMDB-only workflow over a backend it never references', async () => {
    // The scoping rule: `workflow verify` checks the ids THIS workflow names.
    // A developer without the production password must still be able to verify
    // a workflow that touches no Redis.
    delete process.env.RAWBOX_TEST_PROD_URL;

    const scenario = await makeScenario('backends-unreferenced', {
      workspaceYaml: workspaceWithBackendsYaml({
        backendById: { prod: '${RAWBOX_TEST_PROD_URL}' },
      }),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    expect(reported()).not.toContain('RAWBOX_TEST_PROD_URL');
  });

  it('checks EVERY declared backend from workspace verify, referenced or not', async () => {
    // The other half of the scoping rule. The workspace document is what this
    // command verifies, so a declared-but-unresolvable entry is broken whether
    // or not a workflow reaches for it today.
    delete process.env.RAWBOX_TEST_UNUSED_URL;

    const directory = path.join(rootDir, 'ws-backends-unused');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowDir, 'a.yaml'),
      sleepWorkflowYaml().trim(),
      'utf-8',
    );

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      workspaceWithBackendsYaml({
        workflowRelativePathList: ['./workflows/a.yaml'],
        backendById: { unused: '${RAWBOX_TEST_UNUSED_URL}' },
      }).trim(),
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectFailed();
    const output = reported();
    expect(output).toContain('Backend "unused" cannot be resolved');
    expect(output).toContain('RAWBOX_TEST_UNUSED_URL');
  });

  it('names the workflow file when a backend id is unknown under workspace verify', async () => {
    const directory = path.join(rootDir, 'ws-backends-unknown');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowDir, 'redis.yaml'),
      redisWorkflowYaml({ name: 'ws-redis-workflow', backendId: 'typo' }).trim(),
      'utf-8',
    );

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      workspaceWithBackendsYaml({
        workflowRelativePathList: ['./workflows/redis.yaml'],
        backendById: { main: 'redis://cache.internal:6379/0' },
      }).trim(),
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectFailed();
    const output = reported();
    expect(output).toContain('Backend "typo" is not declared by this workspace');
    expect(output).toContain('./workflows/redis.yaml');
    expect(output).toContain('Declared backend ids: "main".');
  });

  it('rejects a workspace whose backend entry carries an unrecognised field', async () => {
    // `Workspace` stays closed and so do the map's VALUES: a misspelt setting
    // inside a backend entry is an error rather than a dropped setting.
    const directory = path.join(rootDir, 'ws-backends-stray-field');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowDir, 'a.yaml'),
      sleepWorkflowYaml().trim(),
      'utf-8',
    );

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      `
kind: Workspace
name: verify-test-workspace
workflowPathList:
  - ./workflows/a.yaml
backends:
  main:
    connection: "redis://cache.internal:6379/0"
    connexion: "typo"
`.trim(),
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectFailed();
    expect(reported()).toContain('Workspace config schema is invalid');
  });

  it('cannot connection-verify against a synthesized workspace, and says so', async () => {
    // The consequence stated in `workspace/backends.ts`: shape verification
    // needs the workflow alone, connection verification needs the workspace.
    // `--workspace-name` has no workspace document at all, so there is nowhere
    // for `backends:` to live — the same shape of answer `plugin:` resolution
    // gives when no workspace can be found.
    const directory = path.join(rootDir, 'backends-scratch');
    await fs.mkdir(directory, { recursive: true });
    const workflowPath = path.join(directory, 'main.yaml');
    await fs.writeFile(workflowPath, redisWorkflowYaml().trim(), 'utf-8');
    await installFakePlugin(directory);

    await verifyWorkflow(workflowPath, { workspaceName: 'scratch-ws' });

    expectFailed();
    const output = reported();
    expect(output).toContain('synthesized workspace');
    expect(output).toContain('--workspace <file>');
    // The budget still printed: the document IS shape-verifiable on its own,
    // and the report above this failure proves it.
    expect(output).toContain('Key "cache_entry" (redis-kv, declared)');
  });
});

// ---------------------------------------------------------------------------
// `seedOverrides:` — the one thing a workspace may replace in a workflow
//
// `workflow verify` merges the block for the workflow it is verifying and
// re-checks the value against the strategy that workflow declares — the half
// that needs both documents.
//
// The block's OUTER keys are workflow paths, the same identifier
// `workflowPathList` holds, so "does this block name a workflow this workspace
// lists" is answerable from the workspace document alone — and BOTH commands
// check it, as does `run` (`packages/rawbox-runner/tests/run-workflow.test.ts`).
// That is the whole point of the keying: it used to be a name, checkable only by
// `workspace verify`, and a misspelt block silently seeded the workflow's own
// value everywhere else.
// ---------------------------------------------------------------------------

describe('seed overrides', () => {
  function overrideWorkspaceYaml(block: string): string {
    return `
kind: Workspace
name: verify-test-workspace
workflowPathList:
  - ./workflows/main.yaml
seedOverrides:
${block}
`;
  }

  it('workflow verify merges a workspace override and reports it', async () => {
    const scenario = await makeScenario('seed-override-ok', {
      workspaceYaml: overrideWorkspaceYaml('  workflows/main.yaml:\n    sleep_ms: 2000'),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectPassed();
    expect(reported()).toContain('Seed overrides from');
    expect(reported()).toContain('applied to workflow "sleep-workflow"');
  });

  it('workflow verify refuses an override on a key the workflow does not seed', async () => {
    const scenario = await makeScenario('seed-override-unseeded', {
      workspaceYaml: overrideWorkspaceYaml('  ./workflows/main.yaml:\n    slept_at: 0'),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('Seed override for storage key "slept_at"');
    expect(output).toContain('RESET that key on every run');
    // The override is named as the cause, and both documents are named.
    expect(output).toContain('seedOverrides["./workflows/main.yaml"].slept_at');
    expect(output).toContain('workspace.yaml');
    expect(output).toContain('main.yaml');
  });

  it('workflow verify refuses an override the declared strategy cannot store', async () => {
    const scenario = await makeScenario('seed-override-too-big', {
      // `valueSizeMax` is the workflow's and stays the workflow's — an override
      // replaces the value and nothing else, which is what makes this check
      // well defined at all.
      workspaceYaml: overrideWorkspaceYaml(
        `  ./workflows/main.yaml:\n    sleep_ms: "${'x'.repeat(4000)}"`,
      ),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('seedOverrides["./workflows/main.yaml"].sleep_ms is 4003 bytes');
    expect(output).toContain('exceeds the valueSizeMax of 1900');
    expect(output).toContain('storage.defaultStrategy');
    expect(output).toContain('That value is a seed override written in');
  });

  it('workspace verify refuses a block naming a workflow it does not contain', async () => {
    const directory = path.join(rootDir, 'ws-seed-override-unknown');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(workflowDir, 'main.yaml'), sleepWorkflowYaml().trim(), 'utf-8');

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      overrideWorkspaceYaml('  ./workflows/mian.yaml:\n    sleep_ms: 2000').trim(),
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectFailed();
    const output = reported();
    expect(output).toContain(
      'Seed overrides are declared for workflow path "./workflows/mian.yaml", ' +
        'which this workspace does not list.',
    );
    expect(output).toContain('workflowPathList holds: "./workflows/main.yaml"');
    expect(output).toContain('keyed by workflow PATH');
  });

  // The same misspelling, at the two entry points that used to say nothing at
  // all about it. Keyed by name, only `workspace verify` could tell a typo from
  // a sibling's block; keyed by path, `workflowPathList` in the same document
  // answers it, so every command that loads the workspace refuses. See
  // `@rawbox/runner`'s `workspace/seed-overrides.ts` module note.
  it('workflow verify refuses a block naming a path the workspace does not list', async () => {
    const scenario = await makeScenario('seed-override-unlisted', {
      workspaceYaml: overrideWorkspaceYaml('  ./workflows/mian.yaml:\n    sleep_ms: 2000'),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain(
      'Seed overrides are declared for workflow path "./workflows/mian.yaml", ' +
        'which this workspace does not list.',
    );
    expect(output).toContain('workflowPathList holds: "./workflows/main.yaml"');
    expect(output).toContain('keyed by workflow PATH');
  });

  it('workspace verify accepts an equivalent spelling of a listed path', async () => {
    const directory = path.join(rootDir, 'ws-seed-override-known');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(workflowDir, 'main.yaml'), sleepWorkflowYaml().trim(), 'utf-8');

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      overrideWorkspaceYaml('  workflows/main.yaml:\n    sleep_ms: 2000').trim(),
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectPassed();
  });

  // -------------------------------------------------------------------------
  // `--seed key=<json>` — the CLI's own layer, appended after the workspace's
  // (`CLI > workspace > workflow`). `workflow verify` merges it in exactly
  // where it merges the workspace's `seedOverrides:` block (see `verify.ts`),
  // so an
  // author can check a `--seed` override before ever running it.
  // -------------------------------------------------------------------------

  it('workflow verify merges a --seed override and reports the key and its source', async () => {
    const scenario = await makeScenario('seed-flag-ok', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      seed: ['sleep_ms=2000'],
    });

    expectPassed();
    const output = reported();
    expect(output).toContain('Seed overrides from');
    expect(output).toContain('applied to workflow "sleep-workflow"');
    expect(output).toContain('sleep_ms');
    expect(output).toContain('the --seed flag');
  });

  it('a --seed override takes precedence over a workspace seedOverrides: block for the same key', async () => {
    const scenario = await makeScenario('seed-flag-beats-workspace', {
      workspaceYaml: overrideWorkspaceYaml('  ./workflows/main.yaml:\n    sleep_ms: 3000'),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      seed: ['sleep_ms=2000'],
    });

    expectPassed();
    // The report names the winning source — the flag, not the workspace
    // document — for the one key both layers named.
    expect(reported()).toContain('sleep_ms ← the --seed flag');
  });

  it('a malformed --seed JSON value is a named error, distinct from the workspace layer\'s own diagnostics', async () => {
    const scenario = await makeScenario('seed-flag-malformed', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      // Not valid JSON: an unquoted word. Would silently become the string
      // "five-hundred" rather than the number 500 if this were not checked.
      seed: ['sleep_ms=five-hundred'],
    });

    expectFailed();
    const output = reported();
    expect(output).toContain('--seed "sleep_ms"');
    expect(output).toContain('is not valid JSON');
  });

  it('a --seed override on a key the workflow does not seed is refused with the same diagnostic as a workspace override, naming the flag', async () => {
    const scenario = await makeScenario('seed-flag-unseeded', {
      workspaceYaml: workspaceYaml(),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, {
      workspace: scenario.workspacePath,
      seed: ['slept_at=0'],
    });

    expectFailed();
    const output = reported();
    // The identical rule and prose the workspace layer's own equivalent test
    // ("workflow verify refuses an override on a key the workflow does not
    // seed", above) produces — nothing reimplemented or relaxed.
    expect(output).toContain('Seed override for storage key "slept_at"');
    expect(output).toContain('RESET that key on every run');
    // But naming the flag as the source, not a workspace document.
    expect(output).toContain('the --seed flag');
    expect(output).toContain('--seed.slept_at');
  });
});

// ---------------------------------------------------------------------------
// `logs.rotate:` — the one cross-field rule a schema cannot express
// (`@rawbox/runner`'s `workspace/logs.ts`, `collectLogRotationProblems`):
// `maxBytes` and `maxFiles` are declared together or not at all. Both
// commands that validate a workspace document check it — the run path's own
// copy is covered in `packages/rawbox-runner/tests/run-workflow.test.ts`.
// ---------------------------------------------------------------------------

describe('logs.rotate half-configured', () => {
  function logsWorkspaceYaml(logsBlock: string): string {
    return `
kind: Workspace
name: verify-test-workspace
workflowPathList:
  - ./workflows/main.yaml
logs:
${logsBlock}
`;
  }

  it('workflow verify refuses a workspace declaring rotate.maxBytes without rotate.maxFiles', async () => {
    const scenario = await makeScenario('logs-rotate-half-workflow', {
      workspaceYaml: logsWorkspaceYaml('  rotate:\n    maxBytes: 134217728'),
      workflowYaml: sleepWorkflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });

    expectFailed();
    const output = reported();
    expect(output).toContain('Log rotation is half-configured');
    expect(output).toContain('logs.rotate.maxBytes');
    expect(output).toContain('logs.rotate.maxFiles');
    expect(output).toContain('is missing');
  });

  it('workspace verify refuses a workspace declaring rotate.maxFiles without rotate.maxBytes', async () => {
    const directory = path.join(rootDir, 'logs-rotate-half-workspace');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.writeFile(path.join(workflowDir, 'main.yaml'), sleepWorkflowYaml().trim(), 'utf-8');

    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      logsWorkspaceYaml('  rotate:\n    maxFiles: 8').trim(),
      'utf-8',
    );

    await verifyWorkspace(workspacePath);

    expectFailed();
    const output = reported();
    expect(output).toContain('Log rotation is half-configured');
    expect(output).toContain('logs.rotate.maxFiles');
    expect(output).toContain('logs.rotate.maxBytes');
    expect(output).toContain('Add logs.rotate.maxBytes');
  });

  it('both commands pass a fully-configured logs.rotate, and an absent one', async () => {
    for (const logsBlock of [
      '  rotate:\n    maxBytes: 134217728\n    maxFiles: 8',
      '  async: true',
    ]) {
      const scenario = await makeScenario(`logs-rotate-ok-${logsBlock.length}`, {
        workspaceYaml: logsWorkspaceYaml(logsBlock),
        workflowYaml: sleepWorkflowYaml(),
      });
      await installFakePlugin(scenario.directory);

      await verifyWorkflow(scenario.workflowPath, { workspace: scenario.workspacePath });
      expectPassed();

      await verifyWorkspace(scenario.workspacePath);
      expectPassed();
    }
  });
});
