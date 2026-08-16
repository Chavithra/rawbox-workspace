/**
 * Validates a workspace identifier — the string handed to
 * `BoxObserverLmdb.openSync` and, inside it, to `resolveEnvFolderUrl` — before
 * it ever reaches either.
 *
 * `resolveEnvFolderUrl(rootDirectoryUrl, envIdentifier)` builds
 * `new URL('./' + envIdentifier + '/', rootDirectoryUrl)`
 * (`@rawbox/store/box-store-lmdb`). A `URL` resolves `..` segments and `/`
 * exactly like a filesystem path, so an identifier such as `../../etc` or
 * `a/b` would walk the resolved directory outside the workspace's own data
 * root — a traversal hazard the store package documents as pre-existing and
 * defers to its callers to close (OBSERVABILITY.md, "CLI surfaces";
 * rawbox-store/README.md, "Observation — `peek` is not `get`"). The CLI is that boundary: every path into
 * `BoxObserverLmdb.openSync` — the raw-name form typed by a user and the
 * `workspace.name` read out of a loaded document — is validated here first.
 *
 * Deliberately stricter than "no traversal actually occurs": a name
 * containing a path separator or the substring `..` is rejected outright,
 * matching OBSERVABILITY.md, "CLI surfaces"'s own wording, rather than trying to
 * reason about which such strings would resolve outside the root and which
 * merely look suspicious.
 */

const PATH_SEPARATOR_PATTERN = /[/\\]/;

/**
 * Returns an explanatory error message when `name` is unsafe to hand to
 * `BoxObserverLmdb.openSync`, or `undefined` when it is fine.
 */
export function validateWorkspaceIdentifier(name: string): string | undefined {
  if (name.trim().length === 0) {
    return 'Workspace name must not be empty.';
  }

  if (PATH_SEPARATOR_PATTERN.test(name)) {
    return (
      `Workspace name "${name}" must not contain a path separator ('/' or '\\'). ` +
      `Pass a workspace document or directory path instead if that is what you meant — ` +
      `\`store list <path-to-workspace.yaml>\` resolves the data root from the document.`
    );
  }

  if (name.includes('..')) {
    return `Workspace name "${name}" must not contain '..'.`;
  }

  return undefined;
}
