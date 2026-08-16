import {
  describe,
  it,
  expect,
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import YAML from 'yaml';

import { createWorkspace } from '../src/commands/workspace/create.js';
import { createProject } from '../src/commands/project/create.js';
import { verifyWorkflow } from '../src/commands/workflow/verify.js';
import { verifyWorkspace } from '../src/commands/workspace/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tempDir = path.join(__dirname, 'temp-create-test');
const originalCwd = process.cwd();

// ---------------------------------------------------------------------------
// What these tests are for
//
// The generators are the first Rawbox document most people will ever read, so
// the bar is not "it emits something parseable": a fresh scaffold **verifies
// with no edits**, and the comments that justify emitting YAML over JSON
// actually survive into the file.
//
// Both are asserted by driving the real `workflow verify` / `workspace verify`
// over the generated tree rather than by re-checking the shape the generator
// just wrote — a structural assertion cannot tell a valid document from one
// that merely looks like the fixtures.
// ---------------------------------------------------------------------------

/** Text reported by the verify commands, and whether they failed. */
let messageList: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureLog(): any {
  return vi.fn((...args: unknown[]) => {
    messageList.push(args.map(String).join(' '));
  });
}

beforeEach(() => {
  messageList = [];
  // Non-throwing, as in verify.test.ts: every failure path in the verify
  // commands is `process.exit(1); return;`, so letting the call unwind keeps
  // "what was reported" separate from "whether it failed".
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation(captureLog());
  vi.spyOn(p.log, 'warn').mockImplementation(captureLog());
  vi.spyOn(p.log, 'info').mockImplementation(captureLog());
  vi.spyOn(p.log, 'step').mockImplementation(captureLog());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** All reported text, with ANSI colouring stripped. */
function reported(): string {
  return messageList.join('\n').replace(/\[[0-9;]*m/g, '');
}

function expectVerified(): void {
  expect(exitSpy, reported()).not.toHaveBeenCalled();
}

/** Comment lines of a YAML file, `#` and leading space stripped. */
function commentText(content: string): string {
  return content
    .split('\n')
    .filter((line) => line.trimStart().startsWith('#'))
    .map((line) => line.trimStart().slice(1).trim())
    .join('\n');
}

describe('workspace create — emits annotated YAML', () => {
  const workspaceDir = path.join(tempDir, 'my-workspace');
  const workspaceYamlPath = path.join(workspaceDir, 'workspace.yaml');
  const workflowPath = path.join(
    workspaceDir,
    'workflows',
    'launch.workflow.yaml',
  );

  beforeAll(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    process.chdir(tempDir);
    // Passing `name` must not prompt: this is a non-interactive shell, and a
    // prompt would hang rather than fail.
    await createWorkspace({ name: 'my-workspace' });
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes a workspace document carrying kind: Workspace', async () => {
    const parsed = YAML.parse(await fs.readFile(workspaceYamlPath, 'utf-8'));

    // `kind:` is not decoration — it is what workspace auto-discovery reads
    // when it walks up from a workflow, so a workspace emitted without it is
    // undiscoverable.
    expect(parsed.kind).toBe('Workspace');
    expect(parsed.name).toBe('my-workspace');
    expect(parsed.workflowPathList).toContain(
      './workflows/launch.workflow.yaml',
    );
  });

  it('writes a workflow: kind, formatVersion, plugins, storage, steps', async () => {
    const parsed = YAML.parse(await fs.readFile(workflowPath, 'utf-8'));

    expect(parsed.kind).toBe('Workflow');
    expect(parsed.formatVersion).toBe('1.0');
    expect(parsed.name).toBe('launch');

    // The resolved-model keys this generator used to emit. Asserted absent
    // rather than merely "authoring keys present", because emitting both would
    // satisfy every positive assertion while still failing `additionalProperties: false`.
    expect(parsed.stepList).toBeUndefined();
    expect(parsed.pluginPathList).toBeUndefined();
    expect(parsed.seedData).toBeUndefined();

    expect(parsed.plugins).toBeDefined();
    expect(Object.keys(parsed.plugins)).toContain(
      '@rawbox/rawbox-plugin-default',
    );
    expect(parsed.storage.defaultStrategy).toEqual({
      name: 'lmdb-kv',
      valueSizeMax: 1900,
    });
    expect(Array.isArray(parsed.steps)).toBe(true);
  });

  it('declares every plugin: its steps name', async () => {
    const parsed = YAML.parse(await fs.readFile(workflowPath, 'utf-8'));
    const declaredList = Object.keys(parsed.plugins);

    // The schema cannot catch this — `plugin:` is just a string — so a
    // generator that drifts from its own `plugins:` map produces a document
    // that parses and never resolves.
    for (const step of parsed.steps) {
      expect(declaredList).toContain(step.plugin);
    }
  });

  it('shows the shape an author is least likely to guess', async () => {
    const parsed = YAML.parse(await fs.readFile(workflowPath, 'utf-8'));

    // A control-flow step: `inputs:`/`errors:` but never `outputs:` — pins
    // FORMAT.md, "`steps`".
    const controlFlowStep = parsed.steps.find((step: { operation: string }) =>
      step.operation.startsWith('control-flow/'),
    );
    expect(controlFlowStep, 'no control-flow step was scaffolded').toBeDefined();
    expect(controlFlowStep.outputs).toBeUndefined();

    // Its inputs are storage keys, like every other step's — there is no
    // inline-literal form, see FORMAT.md, "Bindings" — and each
    // one it names is either seeded or written by another step's `outputs:`,
    // so every read has a writer.
    const writtenKeyList = parsed.steps.flatMap(
      (step: { outputs?: Record<string, string> }) =>
        Object.values(step.outputs ?? {}),
    );
    const seededKeyList = Object.keys(parsed.storage.keys).filter(
      (key) => parsed.storage.keys[key].seed !== undefined,
    );

    for (const binding of Object.values(controlFlowStep.inputs)) {
      expect(typeof binding).toBe('string');
      expect([...seededKeyList, ...writtenKeyList]).toContain(binding);
    }

    // The jump targets in particular are seeded keys — a constant declared
    // and bound by key, never written in place.
    expect(seededKeyList).toContain(controlFlowStep.inputs.thenLabel);
    expect(seededKeyList).toContain(controlFlowStep.inputs.elseLabel);
  });

  it('keeps the comments that are the reason for emitting YAML', async () => {
    // JSON forfeits comments, which is the whole basis on which YAML was
    // chosen. A generator that emitted comment-free YAML would pass every other
    // test here and deliver none of the benefit the decision was made for.
    const workflowComments = commentText(
      await fs.readFile(workflowPath, 'utf-8'),
    );
    expect(workflowComments).toContain('format v1.0');
    expect(workflowComments).toContain('keys[key].strategy ?? defaultStrategy');
    expect(workflowComments).toContain('workflow verify');

    const workspaceComments = commentText(
      await fs.readFile(workspaceYamlPath, 'utf-8'),
    );
    expect(workspaceComments).toContain('kind: Workspace');
  });

  it('passes `workflow verify` with no edits', async () => {
    // The only assertion here that can fail for a reason the structural checks
    // above cannot see: the scaffolded `operation:` values must exist in the
    // registry the declared package actually loads.
    process.chdir(workspaceDir);
    await verifyWorkflow('./workflows/launch.workflow.yaml');
    process.chdir(tempDir);

    expectVerified();
    expect(reported()).toContain('Auto-discovered workspace');
  });

  it('passes `workspace verify` with no edits', async () => {
    process.chdir(workspaceDir);
    await verifyWorkspace('./workspace.yaml');
    process.chdir(tempDir);

    expectVerified();
  });

  it('emits a `.gitignore` covering `.rawbox/` — the default target folder', async () => {
    const gitignore = await fs.readFile(
      path.join(workspaceDir, '.gitignore'),
      'utf-8',
    );
    expect(gitignore).toContain('.rawbox/');
  });
});

describe('project create — emits annotated YAML', () => {
  const projectDir = path.join(tempDir, 'my-project');
  const workspaceDir = path.join(projectDir, 'workspaces', 'workspace-example');
  const exampleWorkflowPath = path.join(
    workspaceDir,
    'workflows',
    'example.workflow.yaml',
  );
  const monitorWorkflowPath = path.join(
    workspaceDir,
    'workflows',
    'monitor.workflow.yaml',
  );

  beforeAll(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    process.chdir(tempDir);
    // `install: false` — the generated project's dependencies are irrelevant
    // to what is asserted here, and installing them takes minutes.
    await createProject({ name: 'my-project', install: false });
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes both workflows as workflow documents', async () => {
    const workspace = YAML.parse(
      await fs.readFile(path.join(workspaceDir, 'workspace.yaml'), 'utf-8'),
    );
    expect(workspace.kind).toBe('Workspace');
    expect(workspace.name).toBe('workspace-example');
    expect(workspace.workflowPathList).toEqual([
      './workflows/example.workflow.yaml',
      './workflows/monitor.workflow.yaml',
    ]);

    for (const workflowPath of [exampleWorkflowPath, monitorWorkflowPath]) {
      const parsed = YAML.parse(await fs.readFile(workflowPath, 'utf-8'));
      expect(parsed.kind, workflowPath).toBe('Workflow');
      expect(parsed.formatVersion, workflowPath).toBe('1.0');
      expect(parsed.stepList, workflowPath).toBeUndefined();
      expect(parsed.pluginPathList, workflowPath).toBeUndefined();
      expect(parsed.storage.defaultStrategy, workflowPath).toBeDefined();
    }
  });

  it('references an operation the plugin it scaffolds actually declares', async () => {
    // An earlier generator emitted a `fetch-price` step under a placeholder
    // registry hash, and no generated file ever defined that operation — so
    // the first `workflow verify` on a fresh project failed. The step and the
    // generated registry are checked against each other here so the two cannot
    // drift apart again.
    const parsed = YAML.parse(await fs.readFile(exampleWorkflowPath, 'utf-8'));
    const [step] = parsed.steps;
    expect(step).toBeDefined();

    const registrySource = await fs.readFile(
      path.join(
        projectDir,
        'packages',
        'rawbox-plugin-example',
        'src',
        'contract-registry.ts',
      ),
      'utf-8',
    );
    expect(registrySource).toContain(`'./${step.operation}.definition.js'`);
    expect(Object.keys(parsed.plugins)).toContain(step.plugin);
  });

  it('resolves its `file:` specifier against the workspace directory', async () => {
    const parsed = YAML.parse(await fs.readFile(exampleWorkflowPath, 'utf-8'));
    const specifier = parsed.plugins['rawbox-plugin-example'];

    // Two levels up from `workspaces/workspace-example`, not three: a relative
    // `file:` specifier is resolved against the workspace directory, not
    // against the workflow file.
    expect(specifier).toBe('file:../../packages/rawbox-plugin-example');
    expect(
      await fs.stat(path.resolve(workspaceDir, specifier.slice('file:'.length))),
    ).toBeDefined();
  });

  it('emits `.gitignore` entries covering `.rawbox/`, at project root and per workspace', async () => {
    const rootGitignore = await fs.readFile(
      path.join(projectDir, '.gitignore'),
      'utf-8',
    );
    expect(rootGitignore).toContain('.rawbox/');

    const workspaceGitignore = await fs.readFile(
      path.join(workspaceDir, '.gitignore'),
      'utf-8',
    );
    expect(workspaceGitignore).toContain('.rawbox/');
  });

  it('writes no `.npmrc` without --registry', async () => {
    // The flag is strictly additive: a scaffold that never asked for a
    // registry must not carry npm configuration of any kind.
    await expect(fs.access(path.join(projectDir, '.npmrc'))).rejects.toThrow();
  });
});

describe('--registry — scaffolds a scoped .npmrc', () => {
  const registryTempDir = path.join(__dirname, 'temp-registry-test');

  // The exact file both scaffolds emit: a comment naming its origin, then the
  // scoped line — scoped so third-party packages keep resolving from npmjs.
  const EXPECTED_NPMRC =
    '# scaffolded by --registry; scoped, so third-party packages still come from npmjs\n' +
    '@rawbox:registry=http://localhost:4873\n';

  beforeAll(async () => {
    await fs.mkdir(registryTempDir, { recursive: true });
    process.chdir(registryTempDir);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(registryTempDir, { recursive: true, force: true });
  });

  it('workspace create --registry writes `.npmrc` beside workspace.yaml', async () => {
    await createWorkspace({
      name: 'registry-workspace',
      registry: 'http://localhost:4873',
    });

    const workspaceDir = path.join(registryTempDir, 'registry-workspace');
    // Beside workspace.yaml — the location `workspace setup` copies it from.
    await expect(
      fs.access(path.join(workspaceDir, 'workspace.yaml')),
    ).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(workspaceDir, '.npmrc'), 'utf-8')).toBe(
      EXPECTED_NPMRC,
    );
  });

  it('workspace create without --registry writes no `.npmrc`', async () => {
    await createWorkspace({ name: 'plain-workspace' });
    await expect(
      fs.access(path.join(registryTempDir, 'plain-workspace', '.npmrc')),
    ).rejects.toThrow();
  });

  it('project create --registry writes `.npmrc` at the project root', async () => {
    await createProject({
      name: 'registry-project',
      install: false,
      registry: 'http://localhost:4873',
    });

    expect(
      await fs.readFile(
        path.join(registryTempDir, 'registry-project', '.npmrc'),
        'utf-8',
      ),
    ).toBe(EXPECTED_NPMRC);
  });

  it('rejects a --registry value that is not a URL, before writing anything', async () => {
    // Note: a bare "localhost:4873" would *parse* — "localhost:" reads as a
    // URL scheme — and be rejected by the protocol check instead. This value
    // cannot parse at all.
    await createWorkspace({
      name: 'bad-registry-workspace',
      registry: 'not a registry url',
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(reported()).toContain('--registry expects a URL');
    // Validation happens before scaffolding: no directory was created.
    await expect(
      fs.access(path.join(registryTempDir, 'bad-registry-workspace')),
    ).rejects.toThrow();
  });

  it('rejects a non-http(s) --registry URL on project create too', async () => {
    await createProject({
      name: 'bad-registry-project',
      install: false,
      registry: 'ftp://localhost:4873',
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(reported()).toContain('--registry expects an http:// or https:// URL');
    await expect(
      fs.access(path.join(registryTempDir, 'bad-registry-project')),
    ).rejects.toThrow();
  });
});
