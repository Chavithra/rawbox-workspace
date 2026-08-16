/**
 * Resolving a `store` command's `<workspace-or-path>` argument to the two
 * things `BoxObserverLmdb.openSync` needs: a workspace identifier and a data
 * root URL (OBSERVABILITY.md, "CLI surfaces").
 *
 * The argument is one of three things, tried in this order:
 *
 * 1. **An existing file** — a workspace document. Loaded and validated like
 *    `runs list --workspace` does, then resolved to its target folder with
 *    `resolveTargetFolder` and its declared `name:` as the LMDB environment
 *    identifier.
 * 2. **An existing directory** — scanned (non-recursively) for exactly one
 *    `kind: Workspace` document directly inside it. Ambiguous or absent is an
 *    error naming the candidates, never a guess.
 * 3. **Anything else** — a bare workspace name. Validated
 *    ({@link validateWorkspaceIdentifier}) and then looked up under a data
 *    root discovered by scanning `cwd` for `.rawbox/data` directories
 *    (`./scan.js`) that actually contain this name — never guessed from a
 *    root that doesn't have it.
 *
 * **Every path into `BoxObserverLmdb.openSync` is validated before this
 * function returns an `Ok`** — both the raw-name form (case 3) and the
 * `workspace.name` read out of a loaded document (cases 1 and 2). A malicious
 * or malformed `name:` field is exactly as much a traversal hazard as a
 * malicious CLI argument, and `resolveEnvFolderUrl` cannot tell the two
 * apart.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ok, err, type Result } from 'neverthrow';
import {
  loadAndValidateWorkspace,
  resolveTargetFolder,
  type Workspace,
} from '@rawbox/runner';

import { getErrorMessage } from '../utils/error.js';
import { validateWorkspaceIdentifier } from './name-validate.js';
import { findDataDirectories, type DataDirHit } from './scan.js';

export interface StoreTarget {
  /** The LMDB environment identifier: `workspace.name` when resolved from a document, the raw argument otherwise. Always validated. */
  readonly workspaceName: string;
  /** `<targetFolder>/data/` — what `BoxObserverLmdb.openSync` resolves `workspaceName` under. */
  readonly dataRootUrl: URL;
  /** Absolute path to the resolved target folder, for messages. */
  readonly targetFolder: string;
  /** The workspace document, when the argument resolved to one — enables the declared-vs-actual join in `store list`. */
  readonly workspaceDoc?: Workspace;
  /** Absolute path to the workspace document, when the argument resolved to one. */
  readonly workspaceDocPath?: string;
}

/** Extensions a workspace document may be written in — matches `@rawbox/runner`'s own discovery. */
const CONFIG_EXTENSION_LIST = ['.json', '.yaml', '.yml'];

function dataRootUrlFor(targetFolder: string): URL {
  const dataDir = path.join(targetFolder, 'data');
  return pathToFileURL(dataDir.endsWith(path.sep) ? dataDir : `${dataDir}${path.sep}`);
}

function fromDocument(
  workspaceDocPath: string,
  workspaceDoc: Workspace,
): Result<StoreTarget, string> {
  const nameError = validateWorkspaceIdentifier(workspaceDoc.name);
  if (nameError !== undefined) {
    return err(
      `Workspace document "${workspaceDocPath}" declares an unsafe name: ${nameError}`,
    );
  }

  const targetFolder = resolveTargetFolder(path.dirname(workspaceDocPath), workspaceDoc);

  return ok({
    workspaceName: workspaceDoc.name,
    dataRootUrl: dataRootUrlFor(targetFolder),
    targetFolder,
    workspaceDoc,
    workspaceDocPath,
  });
}

/** Every `kind: Workspace` document directly inside `directory`, loaded and validated. */
async function findWorkspaceDocumentsInDirectory(
  directory: string,
): Promise<{ path: string; doc: Workspace }[]> {
  let entryList: string[];
  try {
    entryList = await fs.readdir(directory);
  } catch {
    return [];
  }

  const found: { path: string; doc: Workspace }[] = [];
  for (const entry of entryList) {
    const lowered = entry.toLowerCase();
    if (!CONFIG_EXTENSION_LIST.some((extension) => lowered.endsWith(extension))) {
      continue;
    }
    const fullPath = path.join(directory, entry);
    const loaded = await loadAndValidateWorkspace(fullPath);
    if (loaded.isOk()) {
      found.push({ path: fullPath, doc: loaded.value });
    }
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveDirectoryArg(directory: string): Promise<Result<StoreTarget, string>> {
  const found = await findWorkspaceDocumentsInDirectory(directory);

  if (found.length === 1) {
    return fromDocument(found[0]!.path, found[0]!.doc);
  }

  if (found.length === 0) {
    return err(
      `No workspace document ("kind: Workspace") found directly inside "${directory}". ` +
        `Pass the document's path directly, or a bare workspace name to look one up under a discovered data root.`,
    );
  }

  return err(
    `Several workspace documents found directly inside "${directory}": ` +
      `${found.map((match) => match.path).join(', ')}. Pass the specific file instead.`,
  );
}

/** Picks the one `.rawbox/data` root under `cwd` that actually holds `name`, or a synthesized default when none has been discovered yet. */
async function resolveRawName(name: string, cwd: string): Promise<Result<StoreTarget, string>> {
  const hitList = await findDataDirectories(cwd);

  async function hasWorkspace(hit: DataDirHit): Promise<boolean> {
    try {
      return (await fs.stat(path.join(hit.dataDir, name))).isDirectory();
    } catch {
      return false;
    }
  }

  const matchList: DataDirHit[] = [];
  for (const hit of hitList) {
    if (await hasWorkspace(hit)) {
      matchList.push(hit);
    }
  }

  let chosen: DataDirHit;

  if (matchList.length === 1) {
    chosen = matchList[0]!;
  } else if (matchList.length > 1) {
    return err(
      `Workspace "${name}" was found under ${matchList.length} different data roots beneath "${cwd}": ` +
        `${matchList.map((hit) => hit.targetFolder).join(', ')}. Pass the workspace's document path instead to disambiguate.`,
    );
  } else if (hitList.length === 0) {
    // Nothing discovered anywhere under cwd: fall back to the conventional
    // default (`<cwd>/.rawbox/data`, unwritten). `BoxObserverLmdb.openSync`
    // reports this cleanly as "nothing has been written yet" — the friendly
    // empty state — rather than this function inventing its own version of
    // the same message.
    chosen = { targetFolder: path.join(cwd, '.rawbox'), dataDir: path.join(cwd, '.rawbox', 'data') };
  } else if (hitList.length === 1) {
    chosen = hitList[0]!;
  } else {
    return err(
      `Workspace "${name}" was not found under any of ${hitList.length} data roots discovered beneath "${cwd}" ` +
        `(${hitList.map((hit) => hit.targetFolder).join(', ')}). Pass the workspace's document path instead to disambiguate.`,
    );
  }

  return ok({
    workspaceName: name,
    dataRootUrl: dataRootUrlFor(chosen.targetFolder),
    targetFolder: chosen.targetFolder,
  });
}

export async function resolveStoreTarget(
  rawArg: string,
  cwd: string,
): Promise<Result<StoreTarget, string>> {
  const resolvedPath = path.resolve(cwd, rawArg);

  let stat: import('node:fs').Stats | undefined;
  try {
    stat = await fs.stat(resolvedPath);
  } catch {
    stat = undefined;
  }

  if (stat?.isFile() === true) {
    const loaded = await loadAndValidateWorkspace(resolvedPath);
    if (loaded.isErr()) {
      return err(`"${rawArg}" is not a valid workspace document: ${loaded.error}`);
    }
    return fromDocument(resolvedPath, loaded.value);
  }

  if (stat?.isDirectory() === true) {
    return resolveDirectoryArg(resolvedPath);
  }

  const nameError = validateWorkspaceIdentifier(rawArg);
  if (nameError !== undefined) {
    return err(nameError);
  }

  try {
    return await resolveRawName(rawArg, cwd);
  } catch (error) {
    return err(`Failed to resolve workspace "${rawArg}": ${getErrorMessage(error)}`);
  }
}
