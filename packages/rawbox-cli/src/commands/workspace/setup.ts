import * as p from '@clack/prompts';
import pc from 'picocolors';
import { setupWorkspace, type SetupOptions } from '@rawbox/runner';

/**
 * `targetFolder` is optional: omitted, it falls back to `targetFolder:` in the
 * workspace document and then to the workspace directory itself. The resolved
 * folder is reported rather than the argument, because the interesting case is
 * exactly the one where nothing was passed.
 */
export async function setupWorkspaceCommand(
  workspacePath: string,
  targetFolder?: string | undefined,
  options: SetupOptions = {},
): Promise<void> {
  const s = p.spinner();
  s.start(`Setting up workspace environment...`);

  const result = await setupWorkspace(workspacePath, targetFolder, options);

  if (result.isErr()) {
    s.error('Setup failed.');
    p.log.error(pc.red(`Error setting up workspace: ${result.error}`));
    process.exit(1);
  } else {
    s.stop('Setup completed.');
    if (options.installLinks) {
      p.log.info(
        `Installed with --install-links: \`file:\` plugins were copied and their own ` +
          `dependencies installed, so this target folder is portable. It is a snapshot — ` +
          `re-run setup after changing a local plugin.`,
      );
    }
    p.outro(pc.green(`✅ Workspace successfully setup at target directory: ${pc.cyan(result.value)}`));
  }
}
