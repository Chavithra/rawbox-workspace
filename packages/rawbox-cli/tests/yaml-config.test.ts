import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from '../src/commands/workspace/verify.js';
import { verifyWorkflow } from '../src/commands/workflow/verify.js';
import { setupWorkspace } from '@rawbox/runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, 'temp-yaml-test');

describe('YAML workspace and workflow support', () => {
  const workspacePath = path.join(tempDir, 'workspace.yaml');
  const workflowPath = path.join(tempDir, 'workflows', 'test-workflow.yml');

  beforeAll(async () => {
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });

    const workspaceYaml = `
kind: Workspace
name: yaml-workspace
workflowPathList:
  - ./workflows/test-workflow.yml
`;
    await fs.writeFile(workspacePath, workspaceYaml.trim(), 'utf-8');

    // A full workflow document, not a resolved shape: both commands reject a
    // document with no `kind:`, and `workspace verify` validates every workflow
    // the workspace lists.
    const workflowYaml = `
kind: Workflow
formatVersion: "1.0"
name: test-workflow
plugins: {}
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
steps: []
`;
    await fs.writeFile(workflowPath, workflowYaml.trim(), 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should successfully verify YAML workspace', async () => {
    // verifyWorkspace doesn't throw or exit process on success.
    // Let's spy on process.exit to make sure it's not called with failure code.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await verifyWorkspace(workspacePath);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  // `workflow verify` parses the YAML as a workflow document, resolves it, and
  // validates storage boundaries and seeds on the resolver's output. Plugin and
  // operation resolution, and the boundary check itself, are covered in
  // `verify.test.ts`; this case only asserts that a YAML-encoded workflow
  // travels the whole path.
  it('should successfully verify YAML workflow', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await verifyWorkflow(workflowPath, { workspace: workspacePath });
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  // The same document, verified with **no** `--workspace` flag: discovery must
  // find `workspace.yaml` by reading `kind: Workspace`.
  it('should auto-discover the YAML workspace when no --workspace is given', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await verifyWorkflow(workflowPath);
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      exitSpy.mockRestore();
    }
  });

  // Self-contained fixtures: this test needs a workspace whose plugin is a
  // real installable package, which the shared `beforeAll` fixture is not, so
  // it builds its own workspace + workflow rather than reusing it.
  // The install pipeline reads the `plugins:` map and splices it into the
  // generated package.json's `dependencies` for a plain `npm install`.
  it('should successfully setup workspace with YAML configurations', async () => {
    const localWorkspaceDir = path.join(tempDir, 'local-workspace');
    const localWorkflowsDir = path.join(localWorkspaceDir, 'workflows');
    const localPluginDir = path.join(tempDir, 'local-plugin');
    const localSetupTargetDir = path.join(tempDir, 'local-setup-target');

    await fs.mkdir(localWorkflowsDir, { recursive: true });
    await fs.mkdir(localPluginDir, { recursive: true });

    // A local plugin the workflow declares via a *relative* `file:`
    // specifier. It must resolve against the workspace directory, not the
    // generated target package.json — the install pipeline's one trap.
    await fs.writeFile(
      path.join(localPluginDir, 'package.json'),
      JSON.stringify({ name: 'local-test-plugin', version: '1.0.0' }, null, 2),
    );

    const relativePluginSpecPath = path.relative(localWorkspaceDir, localPluginDir);

    const localWorkspaceYaml = `
kind: Workspace
name: yaml-workspace-local
workflowPathList:
  - ./workflows/test-workflow.yml
`;
    await fs.writeFile(path.join(localWorkspaceDir, 'workspace.yaml'), localWorkspaceYaml.trim(), 'utf-8');

    const localWorkflowYaml = `
kind: Workflow
formatVersion: "1.0"
name: test-workflow
plugins:
  local-test-plugin: "file:${relativePluginSpecPath}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
steps: []
`;
    await fs.writeFile(path.join(localWorkflowsDir, 'test-workflow.yml'), localWorkflowYaml.trim(), 'utf-8');

    const localWorkspacePath = path.join(localWorkspaceDir, 'workspace.yaml');
    const setupResult = await setupWorkspace(localWorkspacePath, localSetupTargetDir);
    expect(setupResult.isOk()).toBe(true);

    const pkgJsonPath = path.join(localSetupTargetDir, 'package.json');
    const pkgJsonExists = await fs.access(pkgJsonPath)
      .then(() => true)
      .catch(() => false);
    expect(pkgJsonExists).toBe(true);

    const pkg = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'));
    // The relative `file:` specifier must have been rewritten to an absolute
    // one, resolved against the workspace directory.
    expect(pkg.dependencies['local-test-plugin']).toBe(`file:${localPluginDir}`);

    const installedRealPath = await fs.realpath(path.join(localSetupTargetDir, 'node_modules', 'local-test-plugin'));
    expect(installedRealPath).toBe(await fs.realpath(localPluginDir));
  });
});
