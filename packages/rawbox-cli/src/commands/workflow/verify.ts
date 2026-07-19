import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { validateStorageBoundaries, validateWorkflowType, parseConfig } from 'rawbox-runner';
import { ContractRegistryCache } from 'rawbox-plugin/core';

export async function verifyWorkflow(workflowPath: string, options: { workspace?: string } = {}) {
  const absoluteWorkflowPath = path.resolve(process.cwd(), workflowPath);
  const s = p.spinner();
  s.start(`Loading workflow from ${pc.green(workflowPath)}...`);

  try {
    const content = await fs.readFile(absoluteWorkflowPath, 'utf-8');
    const workflowJson = parseConfig(content, absoluteWorkflowPath);

    // 1. Schema check
    const typeResult = validateWorkflowType(workflowJson);
    if (typeResult.isErr()) {
      s.stop('Validation failed.');
      p.log.error(pc.red(`Workflow schema is invalid:\n${typeResult.error.message}`));
      process.exit(1);
    }
    s.stop(`Workflow "${pc.cyan(workflowJson.name)}" loaded and schema validated.`);

    // 2. Resolve workspace context
    let workspaceFile = options.workspace;
    if (!workspaceFile) {
      // Look for any JSON or YAML file containing "pluginPathList" in current folder
      const files = await fs.readdir(process.cwd());
      for (const file of files) {
        if (file.endsWith('.json') || file.endsWith('.yaml') || file.endsWith('.yml')) {
          try {
            const content = await fs.readFile(path.join(process.cwd(), file), 'utf-8');
            const data = parseConfig(content, file);
            if (data.pluginPathList && data.workflowPathList) {
              workspaceFile = file;
              break;
            }
          } catch {}
        }
      }
    }

    if (workspaceFile) {
      p.log.info(`Verifying step references against workspace: ${pc.green(workspaceFile)}`);
      const workspaceAbs = path.resolve(process.cwd(), workspaceFile);
      const workspaceJson = parseConfig(await fs.readFile(workspaceAbs, 'utf-8'), workspaceAbs);

      // Validate storage boundaries
      const boundaryResult = validateStorageBoundaries(workflowJson, workspaceJson.name);
      if (boundaryResult.isErr()) {
        p.log.error(pc.red(`Storage boundary validation failed:\n  ${boundaryResult.error.message}`));
        p.outro(pc.red('❌ Workflow verification failed with errors.'));
        process.exit(1);
      }
      
      const registryMap = new Map<string, any>(); // Hash -> Registry structure

      // Load all registries in the workflow plugins
      for (const pluginRelPath of workflowJson.pluginPathList) {
        const pluginAbsPath = path.resolve(path.dirname(workspaceAbs), pluginRelPath);
        
        // Find registry file under src/
        let regFile = '';
        const registryCandidates = [
          path.join(pluginAbsPath, 'src', 'contract-registry.ts'),
          path.join(pluginAbsPath, 'src', 'contracts-registry.ts'),
        ];
        for (const candidate of registryCandidates) {
          try {
            if ((await fs.stat(candidate)).isFile()) {
              regFile = candidate;
              break;
            }
          } catch {}
        }

        if (regFile) {
          try {
            // Load and get registry record via subprocess
            const normalizedPath = regFile.replace(/\\/g, '/');
            const evalCode = `
              import('${normalizedPath}')
                .then(m => {
                  const reg = m.default || m.contractRegistry;
                  console.log(JSON.stringify(reg.contractRecord));
                })
                .catch(() => process.exit(1));
            `;
            const stdout = execSync(`node --import tsx --eval "${evalCode.replace(/"/g, '\\"')}"`, {
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'ignore'],
            });
            const contractRecord = JSON.parse(stdout.trim());
            const hash = ContractRegistryCache.computeHash({ contractRecord } as any);
            registryMap.set(hash, contractRecord);
          } catch {
            p.log.warn(`Could not load or compile contract registry in plugin: ${pluginRelPath}`);
          }
        }
      }

      // Check step definitions
      let stepIndex = 0;
      let hasError = false;
      for (const step of workflowJson.stepList) {
        const { contractRegistryHash, definitionPath } = step.definitionLocation;
        const stepLabel = step.label || `#${stepIndex}`;
        
        const registryRecord = registryMap.get(contractRegistryHash);
        if (!registryRecord) {
          p.log.error(pc.red(`Step "${stepLabel}": registry hash "${contractRegistryHash}" was not found in the loaded workspace plugins.`));
          hasError = true;
        } else {
          // Hash matches, check if definitionPath exists in the registry
          const contractExists = Object.keys(registryRecord).includes(definitionPath);
          if (!contractExists) {
            p.log.error(pc.red(`Step "${stepLabel}": definition path "${definitionPath}" is not registered in the contract registry.`));
            hasError = true;
          } else {
            p.log.step(`Step "${stepLabel}" is fully verified.`);
          }
        }
        stepIndex++;
      }

      if (hasError) {
        p.outro(pc.red('❌ Workflow verification failed with errors.'));
        process.exit(1);
      }
    } else {
      p.log.warn('Could not locate a workspace context. Skipping cross-plugin reference verification.');
    }

    p.outro(pc.green('✅ Workflow verification complete and successful!'));
  } catch (error: any) {
    s.stop('Failed.');
    p.log.error(pc.red(`Error: ${error.message}`));
    process.exit(1);
  }
}
