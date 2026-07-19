import * as p from '@clack/prompts';
import pc from 'picocolors';
import { setupWorkspace } from 'rawbox-runner';

/**
 * CLI command controller to initialize target npm package and install workflow plugins.
 */
export async function setupWorkspaceCommand(
  workspacePath: string,
  targetFolder: string,
): Promise<void> {
  const s = p.spinner();
  s.start(`Setting up workspace environment...`);

  const result = await setupWorkspace(workspacePath, targetFolder);

  if (result.isErr()) {
    s.stop('Setup failed.');
    p.log.error(pc.red(`Error setting up workspace: ${result.error}`));
    process.exit(1);
  } else {
    s.stop('Setup completed.');
    p.outro(pc.green(`✅ Workspace successfully setup at target directory: ${pc.cyan(targetFolder)}`));
  }
}
