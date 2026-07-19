import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ContractRegistryCache } from 'rawbox-plugin/core';
import YAML from 'yaml';

/**
 * Resolves the rawbox-plugin-default contract registry (monorepo dist build or
 * globally linked package) and returns its content hash, or null when the
 * plugin cannot be found — callers then fall back to an empty workflow stub.
 */
async function computeDefaultPluginHash(rootDir: string, inMonorepo: boolean): Promise<string | null> {
  const candidates: string[] = [];
  if (inMonorepo) {
    candidates.push(
      pathToFileURL(path.resolve(rootDir, 'packages', 'rawbox-plugin-default', 'dist', 'contract-registry.js')).href,
    );
  }
  candidates.push('rawbox-plugin-default/contract-registry');

  for (const candidate of candidates) {
    try {
      const module = await import(candidate);
      const registry = module.default || module.contractRegistry;
      if (registry && registry.contractRecord) {
        return ContractRegistryCache.computeHash(registry);
      }
    } catch {}
  }
  return null;
}

export async function createWorkspace(options: { name?: string | undefined; workflows?: string[] | undefined } = {}) {
  let workspaceName = options.name?.trim();

  if (!workspaceName) {
    p.intro(pc.cyan('Create a new Rawbox Workspace'));

    const answers = await p.group(
      {
        workspaceName: async () =>
          p.text({
            message: 'What is the name of your workspace?',
            placeholder: 'workspace-example',
            validate: (val) => {
              if (!val.trim()) return 'Workspace name is required';
            },
          }),
      },
      {
        onCancel: () => {
          p.cancel('Operation cancelled.');
          process.exit(0);
        },
      }
    );

    workspaceName = answers.workspaceName.trim();
  }

  // Detect monorepo structure
  const rootDir = process.cwd();
  let inMonorepo = false;
  try {
    const pkg = JSON.parse(await fs.readFile(path.resolve(rootDir, 'package.json'), 'utf-8'));
    if (pkg.workspaces && Array.isArray(pkg.workspaces)) {
      inMonorepo = true;
    }
  } catch {}

  const targetParentDir = inMonorepo ? path.resolve(rootDir, 'workspaces') : rootDir;
  const targetDir = path.resolve(targetParentDir, workspaceName);

  const s = p.spinner();
  s.start(`Generating workspace files in ${pc.green(targetDir)}...`);

  try {
    // Ensure target directories exist
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(targetDir, 'workflows'), { recursive: true });
    await fs.mkdir(path.join(targetDir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(targetDir, 'db'), { recursive: true });

    // Determine workflowPathList
    const workflowPathList = options.workflows !== undefined
      ? options.workflows
      : ['./workflows/example.workflow.yaml'];

    // Create workspace.yaml
    const workspaceJson = {
      name: workspaceName,
      workflowPathList,
    };

    await fs.writeFile(
      path.join(targetDir, 'workspace.yaml'),
      YAML.stringify(workspaceJson),
      'utf-8'
    );

    // Plugin paths resolve relative to the workspace directory (where
    // workspace.json lives), not the workflow file: workspaces/<name>/ -> repo root is ../../
    const defaultPluginPath = inMonorepo ? '../../packages/rawbox-plugin-default' : 'rawbox-plugin-default';
    const defaultPluginHash = await computeDefaultPluginHash(rootDir, inMonorepo);
    const strategy = { name: 'lmdb-kv', valueSizeMax: 2022 };

    // Create a default workflow file for each mapped workflow. When the
    // rawbox-plugin-default registry is resolvable, generate a runnable
    // one-step sleep example; otherwise fall back to an empty stub.
    for (const wPath of workflowPathList) {
      if (wPath.startsWith('./workflows/')) {
        let ext = '.json';
        if (wPath.endsWith('.workflow.yaml')) {
          ext = '.workflow.yaml';
        } else if (wPath.endsWith('.workflow.yml')) {
          ext = '.workflow.yml';
        } else {
          ext = path.extname(wPath) || '.json';
        }
        const workflowName = path.basename(wPath, ext);
        const defaultWorkflowJson = defaultPluginHash
          ? {
              name: workflowName,
              pluginPathList: [defaultPluginPath],
              seedData: [
                { key: 'sleep_ms', strategy, value: 500 },
              ],
              stepList: [
                {
                  label: 'sleep-step',
                  definitionLocation: {
                    contractRegistryHash: defaultPluginHash,
                    definitionPath: './time/sleep.definition.js',
                  },
                  storageLocation: {
                    input: {
                      ms: { key: 'sleep_ms', strategy },
                    },
                    output: {
                      timestamp: { key: 'sleep_done_at', strategy },
                    },
                    error: {
                      message: { key: 'sleep_error', strategy },
                    },
                  },
                },
              ],
            }
          : {
              name: workflowName,
              pluginPathList: inMonorepo ? [defaultPluginPath] : [],
              stepList: [],
            };

        const isYaml = ext.endsWith('yaml') || ext.endsWith('yml');
        const fileContent = isYaml
          ? YAML.stringify(defaultWorkflowJson)
          : JSON.stringify(defaultWorkflowJson, null, 2);

        await fs.writeFile(
          path.join(targetDir, 'workflows', `${workflowName}${ext}`),
          fileContent,
          'utf-8'
        );
      }
    }

    s.stop('Workspace structure and files generated successfully.');
    if (!defaultPluginHash) {
      p.log.warn('rawbox-plugin-default registry not found (is it built?); generated an empty workflow stub instead of a runnable example.');
    }
    p.outro(pc.green('✅ Workspace generation complete!'));
  } catch (error: any) {
    s.stop('Generation failed.');
    p.log.error(pc.red(`Error generating workspace: ${error.message}`));
    process.exit(1);
  }
}
