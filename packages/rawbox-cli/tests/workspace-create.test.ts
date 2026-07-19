import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspace } from '../src/commands/workspace/create.js';
import { createProject } from '../src/commands/project/create.js';
import YAML from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, 'temp-create-test');
const originalCwd = process.cwd();

describe('Workspace and Project creation', () => {
  beforeAll(async () => {
    await fs.mkdir(tempDir, { recursive: true });
    process.chdir(tempDir);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should create workspace with name argument and no prompt', async () => {
    // Calling createWorkspace with option.name should not prompt.
    // If it did prompt, it would hang or fail since we are in non-interactive shell.
    await createWorkspace({ name: 'my-workspace' });

    // Verify it created target parent and child directories
    const workspaceYamlPath = path.join(tempDir, 'my-workspace', 'workspace.yaml');
    const workflowPath = path.join(tempDir, 'my-workspace', 'workflows', 'example.workflow.yaml');

    expect(await fs.stat(workspaceYamlPath)).toBeDefined();
    expect(await fs.stat(workflowPath)).toBeDefined();

    // Verify workspace.yaml content
    const workspaceYamlContent = await fs.readFile(workspaceYamlPath, 'utf-8');
    const parsedWorkspace = YAML.parse(workspaceYamlContent);
    expect(parsedWorkspace.name).toBe('my-workspace');
    expect(parsedWorkspace.workflowPathList).toContain('./workflows/example.workflow.yaml');

    // Verify example.workflow.yaml content
    const workflowYamlContent = await fs.readFile(workflowPath, 'utf-8');
    const parsedWorkflow = YAML.parse(workflowYamlContent);
    expect(parsedWorkflow.name).toBe('example');
    expect(parsedWorkflow.stepList).toBeDefined();
  });

  it('should create project with workspaces/workspace-example and .workflow.yaml extensions', async () => {
    // Call createProject with option.name and install = false (to avoid npm install)
    await createProject({ name: 'my-project', install: false });

    const projectDir = path.join(tempDir, 'my-project');
    const workspaceYamlPath = path.join(projectDir, 'workspaces', 'workspace-example', 'workspace.yaml');
    const workflowExamplePath = path.join(projectDir, 'workspaces', 'workspace-example', 'workflows', 'example.workflow.yaml');
    const workflowMonitorPath = path.join(projectDir, 'workspaces', 'workspace-example', 'workflows', 'monitor.workflow.yaml');

    expect(await fs.stat(workspaceYamlPath)).toBeDefined();
    expect(await fs.stat(workflowExamplePath)).toBeDefined();
    expect(await fs.stat(workflowMonitorPath)).toBeDefined();

    // Verify workspace.yaml content
    const workspaceYamlContent = await fs.readFile(workspaceYamlPath, 'utf-8');
    const parsedWorkspace = YAML.parse(workspaceYamlContent);
    expect(parsedWorkspace.name).toBe('workspace-example');
    expect(parsedWorkspace.workflowPathList).toContain('./workflows/example.workflow.yaml');
    expect(parsedWorkspace.workflowPathList).toContain('./workflows/monitor.workflow.yaml');

    // Verify example workflow contents
    const workflowYamlContent = await fs.readFile(workflowExamplePath, 'utf-8');
    const parsedWorkflow = YAML.parse(workflowYamlContent);
    expect(parsedWorkflow.name).toBe('example');
  });
});
