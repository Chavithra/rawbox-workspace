import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

import { resolvePluginLockEntries } from '@rawbox/runner';

import { pluginInfo } from '../src/commands/plugin/info.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-plugin-info-test');

// ---------------------------------------------------------------------------
// Harness
//
// `plugin info` reports through `@clack/prompts` and signals failure with
// `process.exit(1)`. The exit spy does **not** throw: every failure path is
// written as `process.exit(1); return;`, so a non-throwing stub lets the
// function unwind normally and keeps "what was reported" separable from
// "whether it failed".
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
  vi.spyOn(p.log, 'message').mockImplementation(captureLog());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** All reported text, with ANSI colouring stripped. */
function reported(): string {
  // `` written as an escape rather than as the literal control byte the
  // sibling test files embed — same pattern, but greppable.
  // eslint-disable-next-line no-control-regex
  return messageList.join('\n').replace(/\[[0-9;]*m/g, '');
}

function expectFailed(): void {
  expect(exitSpy, reported()).toHaveBeenCalledWith(1);
}

function expectPassed(): void {
  expect(exitSpy, reported()).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_PLUGIN = 'rawbox-plugin-fake';
const FAKE_PLUGIN_VERSION = '1.4.2';

/**
 * Installs a minimal plugin package into
 * `<directory>/.rawbox/node_modules`.
 *
 * `plugin info` resolves `<package>/contract-registry` with `createRequire`
 * rooted at the workspace's *target folder* — `<workspace directory>/.rawbox`
 * by default, since none of these fixture workspaces declare `targetFolder:`
 * (rawbox-cli README, "Workspace Initialization (`workspace setup`)") — so a hand-built `node_modules` entry has to
 * live there to exercise the real resolution path, without depending on any
 * package in this repo having been built first.
 *
 * The contracts are plain JSON Schema objects: the schemas are defined over the
 * parsed data model and a `contractRecord` is hashed as data, so nothing here
 * needs TypeBox at authoring time.
 */
async function installFakePlugin(directory: string): Promise<void> {
  const packageDir = path.join(directory, '.rawbox', 'node_modules', FAKE_PLUGIN);
  await fs.mkdir(packageDir, { recursive: true });

  await fs.writeFile(
    path.join(packageDir, 'package.json'),
    JSON.stringify(
      {
        name: FAKE_PLUGIN,
        version: FAKE_PLUGIN_VERSION,
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
  './control-flow/halt.definition.js': {
    type: 'control-flow',
    description: 'Stops the run',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      required: ['reason'],
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

/** Builds `<root>/<name>/{workspace.yaml,workflows/main.yaml}`. */
async function makeScenario(
  name: string,
  options: { workflowYaml: string; workspaceYaml?: string },
): Promise<Scenario> {
  const directory = path.join(rootDir, name);
  const workflowDir = path.join(directory, 'workflows');
  await fs.mkdir(workflowDir, { recursive: true });

  const workspacePath = path.join(directory, 'workspace.yaml');
  const workflowPath = path.join(workflowDir, 'main.yaml');

  await fs.writeFile(
    workspacePath,
    (
      options.workspaceYaml ??
      `
kind: Workspace
name: plugin-info-test-workspace
workflowPathList:
  - ./workflows/main.yaml
`
    ).trim(),
    'utf-8',
  );
  await fs.writeFile(workflowPath, options.workflowYaml.trim(), 'utf-8');

  return { directory, workspacePath, workflowPath };
}

const KV_STORAGE = `
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
  keys:
    sleep_ms:
      seed: 500
    halt_reason:
      seed: done
`.trim();

/**
 * Three steps over one plugin: `time/sleep` twice and `control-flow/halt` once.
 * The duplication is deliberate — it is what proves the report counts *steps*
 * but lists *distinct* operations.
 */
function workflowYaml(pluginName: string = FAKE_PLUGIN): string {
  return `
kind: Workflow
formatVersion: "1.0"
name: sleep-workflow
plugins:
  ${pluginName}: "^1.0.0"
${KV_STORAGE}
steps:
  - label: first-sleep
    plugin: ${pluginName}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: slept_at
  - label: second-sleep
    plugin: ${pluginName}
    operation: time/sleep
    inputs:
      ms: sleep_ms
    outputs:
      timestamp: slept_again_at
  - label: stop
    plugin: ${pluginName}
    operation: control-flow/halt
    inputs:
      reason: halt_reason
`;
}

/** Reads the registry hash the way the command does, for lock fixtures. */
async function actualRegistryHash(workspaceDirectory: string): Promise<string> {
  const result = await resolvePluginLockEntries(
    [FAKE_PLUGIN],
    path.join(workspaceDirectory, '.rawbox'),
  );
  if (result.isErr()) {
    throw new Error(`fixture could not resolve the fake plugin: ${result.error}`);
  }
  const entry = result.value[0];
  if (!entry) throw new Error('fixture resolved no entry');
  return entry.registryHash;
}

async function writeLock(
  workspaceDirectory: string,
  plugins: Record<string, { resolved: string; registryHash: string }>,
): Promise<void> {
  await fs.writeFile(
    path.join(workspaceDirectory, 'rawbox.lock'),
    JSON.stringify({ version: '1', plugins }, null, 2),
    'utf-8',
  );
}

beforeAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('plugin info — installed package with a matching lock', () => {
  it('reports specifier, resolved version, status, hash and lock agreement', async () => {
    const scenario = await makeScenario('installed-matching-lock', {
      workflowYaml: workflowYaml(),
    });
    await installFakePlugin(scenario.directory);
    const hash = await actualRegistryHash(scenario.directory);
    await writeLock(scenario.directory, {
      [FAKE_PLUGIN]: { resolved: FAKE_PLUGIN_VERSION, registryHash: hash },
    });

    await pluginInfo(scenario.workflowPath);

    expectPassed();
    const output = reported();

    expect(output).toContain(`Package:       ${FAKE_PLUGIN}`);
    // The specifier the workflow asked for, and what npm actually gave it.
    expect(output).toContain('^1.0.0');
    expect(output).toContain(`(resolved: ${FAKE_PLUGIN_VERSION})`);
    expect(output).toContain('✅ Installed & Compiled');
    expect(output).toContain(hash.slice(0, 12));
    expect(output).toContain('rawbox.lock: ✅ matches');
  });

  it('names the operations the workflow actually references', async () => {
    const scenario = await makeScenario('operation-names', {
      workflowYaml: workflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await pluginInfo(scenario.workflowPath, {
      workspace: scenario.workspacePath,
    });

    expectPassed();
    const output = reported();

    // Three steps, two distinct operations — the whole point of the column.
    expect(output).toContain('3 steps referenced');
    expect(output).toContain('time/sleep');
    expect(output).toContain('control-flow/halt');
    // Listed once each despite `time/sleep` being used twice.
    expect(output.match(/time\/sleep ✅/g)).toHaveLength(1);
  });

  it('marks a referenced operation the registry does not provide', async () => {
    const scenario = await makeScenario('operation-missing', {
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: typo-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
steps:
  - label: typo
    plugin: ${FAKE_PLUGIN}
    operation: time/slep
    inputs:
      ms: sleep_ms
`,
    });
    await installFakePlugin(scenario.directory);

    await pluginInfo(scenario.workflowPath);

    // The package resolves perfectly; the operation does not exist. Reporting
    // this as success is the exact failure mode the command exists to prevent.
    expectFailed();
    const output = reported();
    expect(output).toContain('time/slep ❌ not in registry');
    expect(output).toContain(`Plugin "${FAKE_PLUGIN}" has no operation "time/slep"`);
    // The actionable half: the contract keys that do exist.
    expect(output).toContain('./time/sleep.definition.js');
    expect(output).toContain('./control-flow/halt.definition.js');
  });

  it('flags a package declared in plugins: but referenced by no step', async () => {
    const scenario = await makeScenario('declared-unused', {
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: unused-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
steps: []
`,
    });
    await installFakePlugin(scenario.directory);

    await pluginInfo(scenario.workflowPath);

    expectPassed();
    expect(reported()).toContain('declared in plugins: but unused');
  });
});

describe('plugin info — declared but not installed', () => {
  it('reports the package as unavailable and says how to install it', async () => {
    const scenario = await makeScenario('not-installed', {
      workflowYaml: workflowYaml(),
    });
    // Deliberately no `installFakePlugin` — nothing is in `node_modules`.

    await pluginInfo(scenario.workflowPath);

    expectFailed();
    const output = reported();

    expect(output).toContain(`Package:       ${FAKE_PLUGIN}`);
    expect(output).toContain('(resolved: not installed)');
    expect(output).toContain('❌ Unavailable');
    expect(output).toContain(`Plugin "${FAKE_PLUGIN}" could not be resolved from`);
    expect(output).toContain('npx rawbox-cli workspace setup');
    expect(output).toContain('1 plugin(s) unavailable');
  });

  it('still names the operations the workflow references', async () => {
    const scenario = await makeScenario('not-installed-operations', {
      workflowYaml: workflowYaml(),
    });

    await pluginInfo(scenario.workflowPath);

    expectFailed();
    const output = reported();
    // An author diagnosing a failed install still needs to see what the
    // workflow wanted from the package.
    expect(output).toContain('3 steps referenced');
    expect(output).toContain('time/sleep');
    expect(output).toContain('control-flow/halt');
    // Without a loaded registry there is nothing to check them against, so
    // they must not be reported as missing.
    expect(output).not.toContain('not in registry');
  });

  it('surfaces what the lock recorded for a package that is now absent', async () => {
    const scenario = await makeScenario('not-installed-but-locked', {
      workflowYaml: workflowYaml(),
    });
    await writeLock(scenario.directory, {
      [FAKE_PLUGIN]: { resolved: '9.9.9', registryHash: 'a'.repeat(64) },
    });

    await pluginInfo(scenario.workflowPath);

    expectFailed();
    const output = reported();
    expect(output).toContain('rawbox.lock records 9.9.9');
    expect(output).toContain('nothing is installed to compare it with');
  });
});

describe('plugin info — rawbox.lock', () => {
  it('treats a mismatch as a hard error naming the package', async () => {
    const scenario = await makeScenario('lock-mismatch', {
      workflowYaml: workflowYaml(),
    });
    await installFakePlugin(scenario.directory);
    const hash = await actualRegistryHash(scenario.directory);
    await writeLock(scenario.directory, {
      [FAKE_PLUGIN]: { resolved: '1.0.0', registryHash: 'b'.repeat(64) },
    });

    await pluginInfo(scenario.workflowPath);

    expectFailed();
    const output = reported();

    expect(output).toContain('rawbox.lock: ❌ MISMATCH');
    expect(output).toContain(`rawbox.lock mismatch for plugin "${FAKE_PLUGIN}"`);
    // Both sides of the comparison, in full, so the author can act on them.
    expect(output).toContain('b'.repeat(64));
    expect(output).toContain(hash);
    expect(output).toContain('npx rawbox-cli workflow lock');
    // The package itself resolved fine; only the integrity check failed.
    expect(output).toContain('✅ Installed & Compiled');
    expect(output).toContain('1 rawbox.lock mismatch(es)');
  });

  it('treats an absent lock as unlocked, not as an error', async () => {
    const scenario = await makeScenario('lock-absent', {
      workflowYaml: workflowYaml(),
    });
    await installFakePlugin(scenario.directory);
    // No `rawbox.lock` is written: resolve whatever is installed.

    await pluginInfo(scenario.workflowPath);

    expectPassed();
    const output = reported();

    expect(output).toContain('rawbox.lock: absent — unlocked, no integrity guarantee');
    expect(output).toContain('✅ Installed & Compiled');
    // Reported as the development default it is, with the remedy offered.
    expect(output).toContain('no integrity guarantee');
    expect(output).toContain('npx rawbox-cli workflow lock');
  });

  it('treats a present lock with no entry for the package as unlocked', async () => {
    const scenario = await makeScenario('lock-partial', {
      workflowYaml: workflowYaml(),
    });
    await installFakePlugin(scenario.directory);
    // A lock covering only some other package: a partially locked workspace
    // stays usable, so this package is simply unlocked.
    await writeLock(scenario.directory, {
      'rawbox-plugin-other': { resolved: '2.0.0', registryHash: 'c'.repeat(64) },
    });

    await pluginInfo(scenario.workflowPath);

    expectPassed();
    expect(reported()).toContain('no entry — this package is unlocked');
  });

  it('treats a corrupt lock as an error rather than as unlocked', async () => {
    const scenario = await makeScenario('lock-corrupt', {
      workflowYaml: workflowYaml(),
    });
    await installFakePlugin(scenario.directory);
    await fs.writeFile(
      path.join(scenario.directory, 'rawbox.lock'),
      '{ "version": "1", "plugins": { "x": { "resolved": 12 } } }',
      'utf-8',
    );

    await pluginInfo(scenario.workflowPath);

    // Downgrading a corrupt lock to "unlocked" would turn an integrity failure
    // into a clean report.
    expectFailed();
    const output = reported();
    expect(output).toContain('rawbox.lock');
    expect(output).toContain('npx rawbox-cli workflow lock');
    expect(output).not.toContain('✅ Installed & Compiled');
  });
});

describe('plugin info — workspace location', () => {
  it('auto-discovers the workspace by `kind: Workspace` with no flag', async () => {
    const scenario = await makeScenario('auto-discovery', {
      workflowYaml: workflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await pluginInfo(scenario.workflowPath);

    expectPassed();
    const output = reported();
    expect(output).toContain('Auto-discovered workspace');
    expect(output).toContain(scenario.workspacePath);
  });

  it('refuses to guess when one directory holds several workspace documents', async () => {
    const scenario = await makeScenario('ambiguous', {
      workflowYaml: workflowYaml(),
    });
    // `discoverWorkspace` prefers a candidate whose `workflowPathList` names
    // this workflow, so a second candidate that stays silent on the workflow
    // (as `makeScenario`'s default `workspace.yaml` does not) would not
    // reproduce ambiguity — it would just lose the tie-break. Listing the
    // same workflow here keeps both candidates tied, which is the case this
    // test means to cover.
    await fs.writeFile(
      path.join(scenario.directory, 'other-workspace.yaml'),
      'kind: Workspace\nname: second\nworkflowPathList:\n  - ./workflows/main.yaml\n',
      'utf-8',
    );

    await pluginInfo(scenario.workflowPath);

    expectFailed();
    const output = reported();
    expect(output).toContain('Several workspace documents were found');
    expect(output).toContain('--workspace');
  });

  it('honours an explicit --workspace over discovery', async () => {
    const scenario = await makeScenario('explicit-workspace', {
      workflowYaml: workflowYaml(),
    });
    await installFakePlugin(scenario.directory);

    await pluginInfo(scenario.workflowPath, {
      workspace: scenario.workspacePath,
    });

    expectPassed();
    const output = reported();
    expect(output).toContain('✅ Installed & Compiled');
    // Discovery never ran.
    expect(output).not.toContain('Auto-discovered workspace');
  });
});

describe('plugin info — document faults', () => {
  it('rejects a document with no `kind:`, naming the line to add', async () => {
    const scenario = await makeScenario('no-kind-document', {
      workflowYaml: `
name: legacy
pluginPathList:
  - some-plugin
stepList: []
`,
    });

    await pluginInfo(scenario.workflowPath);

    expectFailed();
    expect(reported()).toContain('is not a Rawbox workflow document');
    expect(reported()).toContain('kind: Workflow');
  });

  it('reports a step naming a plugin the workflow never declares', async () => {
    const scenario = await makeScenario('undeclared-plugin', {
      workflowYaml: `
kind: Workflow
formatVersion: "1.0"
name: undeclared-workflow
plugins:
  ${FAKE_PLUGIN}: "^1.0.0"
${KV_STORAGE}
steps:
  - label: stray
    plugin: rawbox-plugin-typo
    operation: time/sleep
    inputs:
      ms: sleep_ms
`,
    });
    await installFakePlugin(scenario.directory);

    await pluginInfo(scenario.workflowPath);

    // The schema cannot catch this: `plugin:` is just a string.
    expectFailed();
    const output = reported();
    expect(output).toContain(
      'Step(s) reference plugin "rawbox-plugin-typo", which the workflow does not declare',
    );
    // The ground rule: an unmatched `plugin:` lists what *was* declared.
    expect(output).toContain(`"${FAKE_PLUGIN}"`);
    expect(output).toContain('undeclared plugin reference(s)');
  });
});
