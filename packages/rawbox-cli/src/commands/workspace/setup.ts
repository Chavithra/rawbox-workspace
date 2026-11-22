import path from 'node:path';

import * as p from '@clack/prompts';
import pc from 'picocolors';
import type { Argv } from 'yargs';
import { setupWorkspace, type SetupOptions } from '@rawbox/runner';

import { withSetupLock } from '../workflow/setup-lock.js';

/**
 * `targetFolder` is optional: omitted, it falls back to `targetFolder:` in the
 * workspace document and then to `<workspace directory>/.rawbox`. The resolved
 * folder is reported rather than the argument, because the interesting case is
 * exactly the one where nothing was passed.
 *
 * Each env is installed under its own `.rawbox-setup.lock`, the one a `run`'s
 * auto-setup takes, so this command and concurrent runs never install into
 * one env at the same time.
 */
export async function setupWorkspaceCommand(
  workspacePath: string,
  targetFolder?: string | undefined,
  options: Omit<SetupOptions, 'withEnvLock'> = {},
): Promise<void> {
  const s = p.spinner();
  s.start(`Setting up workspace environment...`);

  const result = await setupWorkspace(workspacePath, targetFolder, {
    ...options,
    withEnvLock: (envDir, fn) => withSetupLock(envDir, fn),
  });

  if (result.isErr()) {
    s.error('Setup failed.');
    p.log.error(pc.red(`Error setting up workspace: ${result.error}`));
    process.exit(1);
  } else {
    s.stop('Setup completed.');
    const { targetFolder: resolvedTargetFolder, envs, prunedEnvs } = result.value;
    for (const env of envs) {
      p.log.step(
        `${pc.cyan(path.relative(resolvedTargetFolder, env.envDir))}  ${env.workflowPathList.join(', ')}`,
      );
    }
    for (const pruned of prunedEnvs) {
      p.log.step(pc.dim(`pruned ${path.relative(resolvedTargetFolder, pruned)}`));
    }
    if (options.installLinks) {
      p.log.info(
        `Installed with --install-links: \`file:\` plugins were copied and their own ` +
          `dependencies installed, so each env is portable. It is a snapshot — ` +
          `re-run setup after changing a local plugin.`,
      );
    }
    p.outro(
      pc.green(`✅ Workspace successfully setup at target directory: ${pc.cyan(resolvedTargetFolder)}`),
    );
  }
}

/** Shared yargs builder and handler for `workspace setup`. */
export const setupCommandDefinition = {
  builder: (yargs: Argv): Argv => {
    return yargs
      .positional('workspace-path', {
        description: 'Path to the workspace configuration JSON file',
        type: 'string',
      })
      .positional('target-folder', {
        description:
          'Folder whose envs/ directory receives one npm project per distinct dependency set. ' +
          'Defaults to `targetFolder:` in the workspace file, and failing that to <workspace directory>/.rawbox.',
        type: 'string',
      })
      .option('install-links', {
        description:
          'Copy `file:` plugins and install their own dependencies instead of symlinking them, making each env portable. ' +
          'The default symlink keeps a locally developed plugin live: rebuild it and the next run picks it up with no second setup.',
        type: 'boolean',
        default: false,
      })
      .option('concurrency', {
        description: 'How many env installs may run at once. A positive integer.',
        type: 'number',
        default: 2,
        requiresArg: true,
      })
      .option('prune', {
        description:
          'Once every install succeeded, delete the envs under <target folder>/envs/ that no workflow ' +
          'of the workspace references. --no-prune keeps them.',
        type: 'boolean',
        default: true,
      })
      .check((argv) => {
        const concurrency = argv.concurrency as number;
        if (!Number.isInteger(concurrency) || concurrency < 1) {
          throw new Error(`--concurrency expects a positive integer, got "${String(concurrency)}".`);
        }
        return true;
      });
  },
  handler: async (argv: Record<string, unknown>): Promise<void> => {
    await setupWorkspaceCommand(
      argv['workspace-path'] as string,
      argv['target-folder'] as string | undefined,
      {
        installLinks: argv['install-links'] as boolean,
        concurrency: argv.concurrency as number,
        pruneStaleEnvs: argv.prune as boolean,
      },
    );
  },
};
