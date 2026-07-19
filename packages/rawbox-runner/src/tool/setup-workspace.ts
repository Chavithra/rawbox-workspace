import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { Compile } from 'typebox/compile';
import { ok, err, type Result } from 'neverthrow';

import { Workspace } from '../workspace/workspace-types.js';
import { Workflow } from '../workflow/workflow-types.js';
import { parseConfig } from '../utils/config.js';


const workspaceValidator = Compile(Workspace);
const workflowValidator = Compile(Workflow);

/**
 * Loads and validates a workspace JSON file against the Workspace TypeBox schema.
 */
export async function loadAndValidateWorkspace(workspacePath: string): Promise<Result<Workspace, string>> {
  const absoluteWorkspacePath = path.resolve(workspacePath);
  
  try {
    const content = await fs.readFile(absoluteWorkspacePath, 'utf-8');
    const workspaceData = parseConfig(content, absoluteWorkspacePath);
    
    if (!workspaceValidator.Check(workspaceData)) {
      const errorDetails = Array.from(workspaceValidator.Errors(workspaceData))
        .map((error: any) => `  - Path: "${error.path}" : ${error.message}`)
        .join('\n');
      return err(`Workspace JSON validation failed for "${absoluteWorkspacePath}":\n${errorDetails}`);
    }
    
    return ok(workspaceData);
  } catch (e: any) {
    return err(`Failed to read or parse workspace JSON at "${absoluteWorkspacePath}": ${e.message}`);
  }
}

/**
 * Loads and validates all workflows listed in the workspace from their relative paths.
 */
export async function loadAndValidateWorkflows(workspacePath: string, workspace: Workspace): Promise<Result<Workflow[], string>> {
  const workspaceDir = path.dirname(path.resolve(workspacePath));
  const workflows: Workflow[] = [];

  for (const relWorkflowPath of workspace.workflowPathList) {
    const absoluteWorkflowPath = path.resolve(workspaceDir, relWorkflowPath);
    try {
      const content = await fs.readFile(absoluteWorkflowPath, 'utf-8');
      const workflowData = parseConfig(content, absoluteWorkflowPath);
      
      if (!workflowValidator.Check(workflowData)) {
        const errorDetails = Array.from(workflowValidator.Errors(workflowData))
          .map((error: any) => `  - Path: "${error.path}" : ${error.message}`)
          .join('\n');
        return err(`Workflow validation failed for "${relWorkflowPath}":\n${errorDetails}`);
      }
      
      workflows.push(workflowData);
    } catch (e: any) {
      return err(`Failed to read or parse workflow JSON at "${relWorkflowPath}": ${e.message}`);
    }
  }

  return ok(workflows);
}

/**
 * Initializes a new npm package in the target directory and installs the specified plugins.
 */
export async function setupNpmPackage(
  targetFolder: string,
  pluginPathList: string[],
  workspaceDir: string,
): Promise<Result<void, string>> {
  const absoluteTargetFolder = path.resolve(targetFolder);
  
  try {
    await fs.mkdir(absoluteTargetFolder, { recursive: true });

    // Write a local package.json to prevent npm from climbing up the monorepo directory tree
    const packageJsonPath = path.join(absoluteTargetFolder, 'package.json');
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify(
        {
          name: path.basename(absoluteTargetFolder).toLowerCase().replace(/[^a-z0-9-_]/g, ''),
          version: '1.0.0',
          type: 'module',
          dependencies: {},
        },
        null,
        2,
      ),
    );

    if (pluginPathList.length === 0) {
      return ok(undefined);
    }

    for (const plugin of pluginPathList) {
      let installSpec = plugin;
      const localPluginPath = path.resolve(workspaceDir, plugin);
      try {
        const stat = await fs.stat(localPluginPath);
        if (stat.isDirectory()) {
          installSpec = localPluginPath;
        }
      } catch {}

      execSync(`npm install ${installSpec}`, { cwd: absoluteTargetFolder, stdio: 'ignore' });
    }
    
    return ok(undefined);
  } catch (e: any) {
    return err(`Failed to setup target npm package directory: ${e.message}`);
  }
}

/**
 * Orchestrator function to load, validate, initialize, and install the workspace dependencies.
 */
export async function setupWorkspace(workspacePath: string, targetFolder: string): Promise<Result<void, string>> {
  const workspaceResult = await loadAndValidateWorkspace(workspacePath);
  if (workspaceResult.isErr()) {
    return err(workspaceResult.error);
  }
  const workspace = workspaceResult.value;

  const workflowsResult = await loadAndValidateWorkflows(workspacePath, workspace);
  if (workflowsResult.isErr()) {
    return err(workflowsResult.error);
  }
  const workflows = workflowsResult.value;
  const pluginPathList = Array.from(new Set(workflows.flatMap((w) => w.pluginPathList)));

  const workspaceDir = path.dirname(path.resolve(workspacePath));
  return setupNpmPackage(targetFolder, pluginPathList, workspaceDir);
}
