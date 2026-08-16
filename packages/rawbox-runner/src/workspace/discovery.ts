import fs from 'node:fs/promises';
import path from 'node:path';

import { parseConfig } from '../utils/config.js';
import { DOCUMENT_KIND } from '../workflow/workflow-types.js';
import { resolveWorkspaceWorkflowPath } from './workflow-path.js';

// ---------------------------------------------------------------------------
// Workspace discovery
//
// Shared by every CLI command that needs a workspace context from nothing
// more than a workflow path (`workflow verify`, `workflow run`, `plugin
// info`, …): walk up from the workflow's directory looking for a
// `kind: Workspace` document, so the common case
// (`workspaces/<ws>/workflows/<workflow>.yaml`) needs no `--workspace` flag.
// Originally lived as a private copy inside `rawbox-cli`'s `workflow verify`
// command; moved here so every caller shares one implementation instead of
// three drifting copies.
// ---------------------------------------------------------------------------

/** Extensions `parseConfig` can read — JSON and YAML are equally valid. */
const CONFIG_EXTENSION_LIST = ['.json', '.yaml', '.yml'];

/**
 * Files that are never Rawbox documents but do share those extensions. Skipping
 * them by name keeps the upward walk from parsing a multi-megabyte
 * `package-lock.json` once per ancestor directory.
 */
const NON_DOCUMENT_FILENAME_PATTERN =
  /^(package\.json|package-lock\.json|tsconfig.*\.json|\.eslintrc\.json)$/i;

/** Upper bound on a candidate's size; real documents are orders below this. */
const MAX_CANDIDATE_BYTES = 256 * 1024;

/** How far up the tree discovery walks before giving up. */
const MAX_DISCOVERY_DEPTH = 8;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One `kind: Workspace` document found in a candidate directory. */
interface WorkspaceDocumentMatch {
  /** Absolute path to the workspace document. */
  file: string;
  /**
   * `workflowPathList` entries, resolved to absolute paths against `file`'s
   * directory — resolved here, once, so the ambiguity tie-break can compare
   * paths directly instead of every caller re-resolving relative entries.
   * Through {@link resolveWorkspaceWorkflowPath}, the one resolution every
   * reference in a workspace document goes through, so this tie-break and
   * `seedOverrides:`'s key matching cannot disagree about which entry names
   * which file.
   */
  workflowPathList: string[];
}

/** Every `kind: Workspace` document directly inside `directory`. */
async function findWorkspaceDocuments(
  directory: string,
): Promise<WorkspaceDocumentMatch[]> {
  let entryList: string[];
  try {
    entryList = await fs.readdir(directory);
  } catch {
    return [];
  }

  const matchList: WorkspaceDocumentMatch[] = [];

  for (const entry of entryList) {
    const lowered = entry.toLowerCase();
    if (!CONFIG_EXTENSION_LIST.some((extension) => lowered.endsWith(extension))) {
      continue;
    }
    if (NON_DOCUMENT_FILENAME_PATTERN.test(entry)) {
      continue;
    }

    const fullPath = path.join(directory, entry);
    try {
      const stats = await fs.stat(fullPath);
      if (!stats.isFile() || stats.size > MAX_CANDIDATE_BYTES) {
        continue;
      }
      const data = parseConfig(await fs.readFile(fullPath, 'utf-8'), fullPath);
      if (isPlainObject(data) && data.kind === DOCUMENT_KIND.WORKSPACE) {
        const rawWorkflowPathList = Array.isArray(data.workflowPathList)
          ? data.workflowPathList
          : [];
        matchList.push({
          file: fullPath,
          workflowPathList: rawWorkflowPathList
            .filter((value): value is string => typeof value === 'string')
            .map((entryPath) => resolveWorkspaceWorkflowPath(directory, entryPath)),
        });
      }
    } catch {
      // Unreadable or unparseable — by definition not a workspace document.
    }
  }

  return matchList.sort((a, b) => a.file.localeCompare(b.file));
}

export interface WorkspaceDiscovery {
  /** The single workspace document found, if discovery succeeded. */
  file?: string;
  /** Set when one directory held several — the author must disambiguate. */
  ambiguousList?: string[];
  /** Directories inspected, reported when nothing was found. */
  searchedList: string[];
}

/**
 * Walks up from the workflow's own directory looking for a `kind: Workspace`
 * document, then falls back to the process's working directory.
 *
 * Upward first, because the conventional layout is
 * `workspaces/<name>/workflows/<workflow>.yaml` with the workspace document one
 * level above `workflows/` — a workflow's own directory almost never holds it.
 *
 * The walk is bounded ({@link MAX_DISCOVERY_DEPTH} ancestor directories) so a
 * workflow file placed near the filesystem root cannot turn discovery into an
 * unbounded scan.
 *
 * Several workspace documents sharing one directory is resolved, not
 * necessarily an error: a document whose `workflowPathList` names this exact
 * workflow (compared as resolved absolute paths) wins outright, on the
 * reasoning that declaring a workflow is a stronger, author-written signal
 * than mere directory proximity. That preference is applied only to break a
 * tie among several candidates at the *same* level — it never pulls in a
 * workspace document from a different directory, and it never overrides a
 * single unambiguous candidate (which needs no tie-break). If it still
 * doesn't narrow to one document, that is an ambiguity the caller must
 * resolve explicitly (`--workspace <file>`), never a guess this function
 * makes on the author's behalf.
 *
 * @param workflowPath - Path to the workflow document to discover a workspace
 *   for. Both the starting directory (its parent) and the tie-break
 *   (`workflowPathList` membership) are derived from this one path.
 * @returns The discovery outcome: a single `file`, an `ambiguousList`, or
 *   neither (with `searchedList` naming every directory inspected).
 */
export async function discoverWorkspace(
  workflowPath: string,
): Promise<WorkspaceDiscovery> {
  const resolvedWorkflowPath = path.resolve(workflowPath);
  const searchedList: string[] = [];
  const visited = new Set<string>();

  const inspect = async (
    directory: string,
  ): Promise<WorkspaceDiscovery | undefined> => {
    if (visited.has(directory)) {
      return undefined;
    }
    visited.add(directory);
    searchedList.push(directory);

    const matchList = await findWorkspaceDocuments(directory);
    if (matchList.length === 0) {
      return undefined;
    }
    if (matchList.length === 1) {
      return { file: matchList[0]!.file, searchedList };
    }

    // Several candidates at this level — the one(s) that actually declare
    // this workflow take precedence over the rest.
    const listedList = matchList.filter((match) =>
      match.workflowPathList.includes(resolvedWorkflowPath),
    );
    if (listedList.length === 1) {
      return { file: listedList[0]!.file, searchedList };
    }

    // Still ambiguous: report whichever set is actually tied — the listing
    // candidates if more than one declares the workflow, otherwise every
    // candidate (none of them named it, so none is preferred).
    const ambiguousList = (listedList.length > 1 ? listedList : matchList).map(
      (match) => match.file,
    );
    return { ambiguousList, searchedList };
  };

  let directory = path.dirname(resolvedWorkflowPath);
  for (let depth = 0; depth < MAX_DISCOVERY_DEPTH; depth += 1) {
    const found = await inspect(directory);
    if (found) {
      return found;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  const found = await inspect(process.cwd());
  if (found) {
    return found;
  }

  return { searchedList };
}

/**
 * The workspace document directly inside `directory`, when exactly one
 * `kind: Workspace` file lives there.
 *
 * Unlike {@link discoverWorkspace}, this does not walk up and has no workflow
 * path to break a tie among several candidates — it answers one narrower
 * question: "does this exact directory hold one unambiguous workspace
 * document". That is what `runs prune`'s no-argument scan needs
 * (`rawbox-cli`, `commands/runs/prune.ts`): it finds `.rawbox` target folders
 * under a root with no workflow in hand at all, and a target folder's default
 * location — `<workspaceDir>/.rawbox` (`resolveTargetFolder`) — puts the
 * document directly in its parent.
 *
 * `undefined` when the directory holds none or several. Neither case is
 * guessed at here — a caller resolving `logs:` from this falls back to
 * `resolveLogsConfig`'s built-in defaults, the same answer a workspace that
 * declares no `logs:` block gives, rather than this function picking one
 * candidate among several or inventing a document that is not there. A
 * workspace using a customised `targetFolder:` that does not resolve back to
 * its own directory this way gets the same fallback — no worse than the
 * `rawbox.config.json` lookup this replaces, which made the identical
 * assumption.
 *
 * @param directory - Scanned non-recursively; typically a `.rawbox` target
 *   folder's parent.
 */
export async function findWorkspaceDocumentIn(
  directory: string,
): Promise<string | undefined> {
  const matchList = await findWorkspaceDocuments(directory);
  return matchList.length === 1 ? matchList[0]!.file : undefined;
}
