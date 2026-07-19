import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from '../src/commands/workspace/verify.js';
import { verifyWorkflow } from '../src/commands/workflow/verify.js';
import { setupWorkspace } from 'rawbox-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, 'temp-yaml-test');

describe('YAML workspace and workflow support', () => {
  const workspacePath = path.join(tempDir, 'workspace.yaml');
  const workflowPath = path.join(tempDir, 'workflows', 'test-workflow.yml');
  const setupTargetDir = path.join(tempDir, 'setup-target');

  beforeAll(async () => {
    await fs.mkdir(path.dirname(workflowPath), { recursive: true });

    // 1. Create a workspace.yaml referencing a workflow yaml
    const workspaceYaml = `
name: yaml-workspace
workflowPathList:
  - ./workflows/test-workflow.yml
`;
    await fs.writeFile(workspacePath, workspaceYaml.trim(), 'utf-8');

    // 2. Create a workflows/test-workflow.yml
    const workflowYaml = `
name: test-workflow
pluginPathList: []
stepList: []
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

  it('should successfully setup workspace with YAML configurations', async () => {
    const setupResult = await setupWorkspace(workspacePath, setupTargetDir);
    expect(setupResult.isOk()).toBe(true);

    const pkgJsonExists = await fs.access(path.join(setupTargetDir, 'package.json'))
      .then(() => true)
      .catch(() => false);
    expect(pkgJsonExists).toBe(true);
  });
});
