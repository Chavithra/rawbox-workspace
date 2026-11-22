import fs from 'node:fs/promises';
import path from 'node:path';

import * as p from '@clack/prompts';
import pc from 'picocolors';

import {
  discoverWorkspace,
  lockWorkspacePlugins,
  parseConfig,
  resolveDependencyEnvDir,
  validateWorkflowType,
  RAWBOX_LOCK_FILENAME,
  type Workflow,
} from '@rawbox/runner';
import { resolveWorkspaceTargetFolderOrWarn } from '../../workspace/target-folder.js';

import { getErrorMessage } from '../../utils/error.js';

export interface WorkflowLockOptions {
  /** Path to the workspace config whose `rawbox.lock` is written. */
  workspace?: string;
}

/**
 * Resolves every package declared in the workflow's `dependencies:` map, computes
 * each contract-registry hash, and writes `workspaces/<workspace>/rawbox.lock`.
 *
 * **The workflow file is never modified.** That is the entire reason the lock
 * is a separate file: the agent-authored document stays pure `name: range`, so
 * re-reading it after locking never surfaces a shape its author did not write.
 * This command reads the workflow and writes only the lock.
 *
 * Because the lock is keyed at the workspace level, locking one workflow merges
 * into — rather than replaces — the entries its siblings contributed.
 */
export async function lockWorkflow(
  workflowPath: string,
  options: WorkflowLockOptions = {},
): Promise<void> {
  const absoluteWorkflowPath = path.resolve(process.cwd(), workflowPath);

  try {
    // 1. Load and schema-check the workflow. Locking a document that does not
    //    validate would record hashes for a file that can never run.
    const content = await fs.readFile(absoluteWorkflowPath, 'utf-8');
    const parsed = parseConfig(content, absoluteWorkflowPath);
    if (parsed.isErr()) {
      p.log.error(pc.red(parsed.error));
      process.exit(1);
      return;
    }
    const document = parsed.value;

    const typeResult = validateWorkflowType(document, workflowPath);
    if (typeResult.isErr()) {
      p.log.error(pc.red(typeResult.error.message));
      process.exit(1);
    }
    const workflow = document as Workflow;

    // 2. Locate the workspace whose lock this is.
    let workspaceFile =
      options.workspace !== undefined
        ? path.resolve(process.cwd(), options.workspace)
        : undefined;

    if (!workspaceFile) {
      const discovery = await discoverWorkspace(absoluteWorkflowPath);

      if (discovery.ambiguousList) {
        p.log.error(
          pc.red(
            `Several workspace documents were found in one directory:\n` +
              discovery.ambiguousList.map((file) => `  - ${file}`).join('\n') +
              `\nPass the one to lock against explicitly: --workspace <file>`,
          ),
        );
        process.exit(1);
        return;
      }

      workspaceFile = discovery.file;

      if (!workspaceFile) {
        p.log.error(
          pc.red(
            `Could not locate a workspace document for "${workflowPath}".\n` +
              `${RAWBOX_LOCK_FILENAME} is written per workspace, so one is required. ` +
              `Searched:\n${discovery.searchedList.map((directory) => `  - ${directory}`).join('\n')}\n` +
              (discovery.unreadableList
                ? `Could not read:\n${discovery.unreadableList.map((entry) => `  - ${entry}`).join('\n')}\n`
                : '') +
              `Pass it explicitly: npx rawbox-cli workflow lock ${workflowPath} --workspace <workspace file>`,
          ),
        );
        process.exit(1);
        return;
      }
    }

    const workspaceDir = path.dirname(workspaceFile);
    const packageNames = Object.keys(workflow.dependencies);

    if (packageNames.length === 0) {
      p.log.warn(
        `Workflow "${workflow.name}" declares no plugins — nothing to lock.`,
      );
      return;
    }

    // Resolution happens in this workflow's env under the workspace's target
    // folder, where `workspace setup` installed it. The lock is still written
    // beside `workspace.yaml`: the two are different questions.
    const targetFolder = await resolveWorkspaceTargetFolderOrWarn(workspaceFile);
    const envDir = resolveDependencyEnvDir(targetFolder, workflow.dependencies, workspaceDir);

    const s = p.spinner();
    s.start(
      `Resolving ${packageNames.length} plugin(s) from ${pc.green(envDir ?? targetFolder)}...`,
    );

    const result = await lockWorkspacePlugins({
      workspaceDir,
      dependencies: workflow.dependencies,
      targetFolder,
    });

    if (result.isErr()) {
      s.error('Locking failed.');
      p.log.error(pc.red(result.error));
      process.exit(1);
    }

    const { entries, lockPath, changed } = result.value;
    s.stop(`Resolved ${entries.length} plugin(s) from ${pc.green(result.value.envDir ?? targetFolder)}.`);

    for (const entry of entries) {
      const mark = changed.includes(entry.name) ? pc.yellow('updated') : pc.dim('unchanged');
      p.log.step(
        `${pc.cyan(entry.name)} @ ${entry.resolved} → ${entry.registryHash} (${mark})`,
      );
    }

    p.outro(
      pc.green(
        `✅ Wrote ${path.relative(process.cwd(), lockPath) || lockPath}. ` +
          `The workflow file was not modified.`,
      ),
    );
  } catch (error) {
    p.log.error(
      pc.red(`Failed to lock workflow "${workflowPath}": ${getErrorMessage(error)}`),
    );
    process.exit(1);
  }
}
