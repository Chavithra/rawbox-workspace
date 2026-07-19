import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createActor } from 'xstate';
import { ok, err, type Result } from 'neverthrow';
import { Compile } from 'typebox/compile';
import { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import { ContractRegistryCache } from 'rawbox-plugin/core';

import { createWorkflowMachine } from '../machine/machine-instance.js';
import { loadAndValidateWorkspace } from './setup-workspace.js';
import { Workflow } from '../workflow/workflow-types.js';
import { validateSeedData } from '../workflow/validation.js';
import { parseConfig } from '../utils/config.js';


const workflowValidator = Compile(Workflow);


/**
 * Resolves and loads all contract registries from the plugin list inside a workspace.
 */
async function loadWorkspaceRegistries(
  workspaceDir: string,
  pluginPathList: string[],
  registryCache: ContractRegistryCache,
): Promise<Result<void, string>> {
  for (const pluginRelPath of pluginPathList) {
    const pluginAbsPath = path.resolve(workspaceDir, pluginRelPath);
    
    // Candidates for the compiled registry JS files
    const candidates = [
      path.join(pluginAbsPath, 'dist', 'contract-registry.js'),
      path.join(pluginAbsPath, 'dist', 'contracts-registry.js'),
      path.join(pluginAbsPath, 'dist', 'src', 'contract-registry.js'),
      path.join(pluginAbsPath, 'dist', 'src', 'contracts-registry.js'),
    ];

    let loaded = false;
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          const fileUrl = pathToFileURL(candidate).href;
          const module = await import(fileUrl);
          const registry = module.default || module.contractRegistry || module.registry;
          if (registry && (registry.contractRecord || (registry.default && registry.default.contractRecord))) {
            const actualRegistry = registry.contractRecord ? registry : registry.default;
            registryCache.addContractRegistry(actualRegistry);
            loaded = true;
            break;
          }
        }
      } catch {}
    }

    if (!loaded) {
      // If we couldn't load locally via directory candidates, try as standard Node/NPM package
      try {
        const module = await import(`${pluginRelPath}/contract-registry`);
        const registry = module.default || module.contractRegistry || module.registry;
        if (registry) {
          registryCache.addContractRegistry(registry);
          loaded = true;
        }
      } catch {}
    }

    if (!loaded) {
      return err(`Could not load contract registry for plugin: ${pluginRelPath}`);
    }
  }

  return ok(undefined);
}

/**
 * Loads a workspace and workflow config, initializes a MachineInstance,
 * subscribes to state transitions to write them to a log file, and executes the workflow.
 */
export async function runWorkflowInstance(
  workspacePath: string,
  workflowPath: string,
  logFilePath: string,
): Promise<Result<void, string>> {
  const absoluteWorkspacePath = path.resolve(workspacePath);
  const absoluteWorkflowPath = path.resolve(workflowPath);
  const absoluteLogFilePath = path.resolve(logFilePath);

  // 1. Load and validate workspace
  const workspaceResult = await loadAndValidateWorkspace(absoluteWorkspacePath);
  if (workspaceResult.isErr()) {
    return err(workspaceResult.error);
  }
  const workspace = workspaceResult.value;
  const workspaceDir = path.dirname(absoluteWorkspacePath);

  // 2. Load and validate workflow
  let workflow: Workflow;
  try {
    const content = await fs.readFile(absoluteWorkflowPath, 'utf-8');
    const workflowData = parseConfig(content, absoluteWorkflowPath);
    if (!workflowValidator.Check(workflowData)) {
      const errorDetails = Array.from(workflowValidator.Errors(workflowData))
        .map((error: any) => `  - Path: "${error.path}" : ${error.message}`)
        .join('\n');
      return err(`Workflow validation failed for "${absoluteWorkflowPath}":\n${errorDetails}`);
    }
    workflow = workflowData;
  } catch (e: any) {
    return err(`Failed to load or validate workflow at "${absoluteWorkflowPath}": ${e.message}`);
  }

  // 3. Setup log file directory
  try {
    await fs.mkdir(path.dirname(absoluteLogFilePath), { recursive: true });
    // Write an initial separator/header to log file
    fsSync.appendFileSync(
      absoluteLogFilePath,
      `=== Starting Workflow "${workflow.name}" in Workspace "${workspace.name}" ===\n`,
    );
  } catch (e: any) {
    return err(`Failed to initialize log file directory at "${absoluteLogFilePath}": ${e.message}`);
  }

  // 4. Setup registries and databases
  const contractRegistryCache = new ContractRegistryCache();
  const registryLoadResult = await loadWorkspaceRegistries(workspaceDir, workflow.pluginPathList, contractRegistryCache);
  if (registryLoadResult.isErr()) {
    return err(registryLoadResult.error);
  }

  // Validate seed data before database initialization/seeding
  const seedValidation = validateSeedData(workflow, contractRegistryCache);
  if (seedValidation.isErr()) {
    return err(`Seed Validation Failed: ${seedValidation.error.message}`);
  }

  const dbDirUrl = pathToFileURL(path.join(workspaceDir, 'data'));
  const boxStoreLmdb = BoxStoreLmdb.create(workspace.name, dbDirUrl);

  // Seed the database if seedData is present
  if (workflow.seedData && workflow.seedData.length > 0) {
    const seedResult = boxStoreLmdb.transaction((boxStore) => {
      for (const seed of workflow.seedData!) {
        const putRes = boxStore.putSync({
          content: seed.value,
          location: {
            key: seed.key,
            workflow: workflow.name,
            workspace: workspace.name,
            strategy: seed.strategy,
          },
        });
        if (putRes.isErr()) {
          return err(`Failed to write seed data for key "${seed.key}": ${putRes.error}`);
        }
      }
      return ok(undefined);
    });

    if (seedResult.isErr()) {
      return err(`Database Seeding Failed: ${seedResult.error}`);
    }
  }


  // 5. Setup XState machine input
  const machine = createWorkflowMachine(boxStoreLmdb, contractRegistryCache);
  const runId = `run-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const input = {
    params: {
      runId,
      workflow,
      workspace: workspace.name,
    },
    execution: {
      todoStep: { index: 0 },
      doneStep: null,
    },
    boxStoreLmdb,
  };

  const actor = createActor(machine, { input });

  // 6. Subscribe to transition updates and write logs
  actor.subscribe({
    next(state) {
      try {
        const logEntry = {
          timestamp: new Date().toISOString(),
          state: state.value,
          context: {
            params: {
              runId: state.context.params.runId,
              workspace: state.context.params.workspace,
              workflow: state.context.params.workflow.name,
            },
            execution: state.context.execution,
          },
        };
        fsSync.appendFileSync(absoluteLogFilePath, JSON.stringify(logEntry) + '\n');
      } catch (e: any) {
        console.error(`[runWorkflowInstance] Failed to write transition log entry: ${e.message}`);
      }
    },
  });

  // 7. Execute machine and return promise result
  try {
    await new Promise<void>((resolve, reject) => {
      actor.subscribe({
        next(state) {
          if (state.status === 'done') {
            resolve();
          }
        },
        error(e) {
          reject(e);
        },
      });
      actor.start();
    });

    fsSync.appendFileSync(absoluteLogFilePath, `=== Workflow "${workflow.name}" Completed Successfully ===\n`);
    return ok(undefined);
  } catch (e: any) {
    fsSync.appendFileSync(absoluteLogFilePath, `=== Workflow "${workflow.name}" Failed: ${e.message} ===\n`);
    return err(`Workflow execution failed: ${e.message}`);
  }
}
