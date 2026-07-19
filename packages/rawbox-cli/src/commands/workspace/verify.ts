import fs from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import TypeCompiler from 'typebox/compile';
import { Workspace, parseConfig } from 'rawbox-runner';

export async function verifyWorkspace(workspacePath: string) {
  const absolutePath = path.resolve(process.cwd(), workspacePath);
  const s = p.spinner();
  s.start(`Loading workspace config from ${pc.green(workspacePath)}...`);

  try {
    const content = await fs.readFile(absolutePath, 'utf-8');
    const json = parseConfig(content, absolutePath);

    // Validate workspace schema
    const C = TypeCompiler(Workspace);
    if (!C.Check(json)) {
      const errors = Array.from(C.Errors(json)).map(
        (err: any) => `  - Path: "${err.path}" : ${err.message}`
      ).join('\n');
      s.stop('Validation failed.');
      p.log.error(pc.red(`Workspace config schema is invalid:\n${errors}`));
      process.exit(1);
    }

    s.stop(`Workspace config for "${pc.cyan(json.name)}" loaded successfully.`);

    // 1. Verify workflow paths and load plugin path lists
    p.log.info(pc.cyan('Verifying workflows...'));
    const pluginPaths = new Set<string>();
    for (const workflowPath of json.workflowPathList) {
      const workflowFullPath = path.resolve(path.dirname(absolutePath), workflowPath);
      try {
        const workflowStat = await fs.stat(workflowFullPath);
        if (workflowStat.isFile()) {
          p.log.step(`Workflow file ${pc.green(workflowPath)} exists.`);
          const content = await fs.readFile(workflowFullPath, 'utf-8');
          const workflowJson = parseConfig(content, workflowFullPath);
          if (Array.isArray(workflowJson.pluginPathList)) {
            for (const pPath of workflowJson.pluginPathList) {
              pluginPaths.add(pPath);
            }
          }
        }
      } catch {
        p.log.error(pc.red(`Workflow file not found: ${workflowPath}`));
        process.exit(1);
      }
    }

    // 2. Verify plugin paths
    p.log.info(pc.cyan('Verifying plugins...'));
    for (const pluginPath of pluginPaths) {
      const pluginFullPath = path.resolve(path.dirname(absolutePath), pluginPath);
      try {
        const pkgJsonStat = await fs.stat(path.join(pluginFullPath, 'package.json'));
        if (pkgJsonStat.isFile()) {
          p.log.step(`Plugin ${pc.green(pluginPath)} exists and contains package.json.`);
        }
      } catch {
        p.log.error(pc.red(`Plugin path not found or missing package.json: ${pluginPath}`));
        process.exit(1);
      }
    }

    p.outro(pc.green('✅ Workspace structure is valid and verified!'));
  } catch (error: any) {
    s.stop('Failed.');
    p.log.error(pc.red(`Error verifying workspace: ${error.message}`));
    process.exit(1);
  }
}
