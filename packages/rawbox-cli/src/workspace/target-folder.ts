import * as p from '@clack/prompts';
import { resolveWorkspaceTargetFolder } from '@rawbox/runner';

/**
 * `resolveWorkspaceTargetFolder`, with its fallback made audible.
 *
 * The runner answers with the workspace directory when the document cannot be
 * loaded, and says why in `fallbackReason`. Every command that resolves
 * plugins or state through this used to drop that reason on the floor, so a
 * workspace declaring `targetFolder: ../shared` with one schema error would
 * quietly resolve from the wrong place. One warning, worded once, here.
 */
export async function resolveWorkspaceTargetFolderOrWarn(
  workspaceFile: string,
): Promise<string> {
  const resolved = await resolveWorkspaceTargetFolder(workspaceFile);

  if (resolved.fallbackReason !== undefined) {
    p.log.warn(
      `Resolving from "${resolved.targetFolder}": the workspace document could not be ` +
        `loaded, so a targetFolder: it may declare was not applied.\n  ${resolved.fallbackReason}`,
    );
  }

  return resolved.targetFolder;
}
