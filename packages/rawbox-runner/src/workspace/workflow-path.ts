import path from 'node:path';

// ---------------------------------------------------------------------------
// How a workspace names a workflow: by PATH, resolved against the workspace
// directory
//
// A workspace document refers to its workflows in exactly one way — a path,
// resolved relative to the directory holding the document. `workflowPathList`
// is the list of them, and `seedOverrides:` is keyed by the same identifier
// (FORMAT.md, "`seedOverrides`"), so a reference inside a workspace document
// can be checked **against that same document** rather than against a fact
// living in some other file.
//
// The base is the **workspace directory**, never the process's cwd: it is the
// base `workflowPathList` has always used (`tool/setup-workspace.ts`,
// `workspace/discovery.ts`), the base `targetFolder:` uses
// (`resolveTargetFolder`), and the base a relative `file:` plugin specifier
// uses (FORMAT.md, "`plugins`"). One rule for every path an author
// writes in that document, so a workspace behaves identically from any cwd.
//
// This exists as a named function rather than as a `path.resolve` call at each
// site because the *comparison* now matters. Before `seedOverrides:` was keyed
// by path, every caller merely needed a path it could open; a second, slightly
// different resolution would have failed loudly at `readFile`. Now two callers
// disagreeing by a single `./` would make a block that IS listed look unlisted
// (or the reverse) — a silent wrong seed, which is the failure this whole
// keying change exists to remove. One function, one answer.
// ---------------------------------------------------------------------------

/**
 * The absolute path a `workflowPathList`-style entry names.
 *
 * **Purely lexical** — `path.resolve`, which collapses `.` and `..` segments
 * and normalises separators, and touches the filesystem not at all. So
 * `./workflows/a.yaml`, `workflows/a.yaml` and `workflows/./a.yaml` are one
 * path, while a file that does not exist yet still resolves (which is what lets
 * `workspace verify` report a missing workflow as a missing *file* rather than
 * as an unresolvable reference).
 *
 * Symlinks are deliberately **not** followed: `fs.realpath` would need the file
 * to exist, would turn an unreadable path into a thrown error at every call
 * site, and would make a reference's meaning depend on the state of the disk
 * rather than on the two documents in hand.
 *
 * @param workspaceDir - Directory containing the workspace document. Resolved
 *   itself, so a relative one behaves like every other path the runner accepts.
 * @param entry - The entry as authored, e.g. `./workflows/a.workflow.yaml`.
 * @returns The absolute path, for opening or for comparing with another
 *   entry resolved by this same function.
 */
export function resolveWorkspaceWorkflowPath(
  workspaceDir: string,
  entry: string,
): string {
  return path.resolve(path.resolve(workspaceDir), entry);
}
