import { Type, type Static } from 'typebox';
import { err, ok, type Result } from 'neverthrow';

import { StrictObject } from '@rawbox/store';

// ---------------------------------------------------------------------------
// `backends:` — how a workspace reaches a store that is not its own LMDB file
//
// ## Why this is on the workspace and not on the strategy
//
// A strategy block is declared **per key** (FORMAT.md, "`storage`"): a
// `redis-kv` key that carried its own connection string would repeat one
// server's address once per key, with nothing keeping the copies in agreement,
// and a document with twenty keys would have twenty places to edit when the
// server moves. Worse, a workflow document is **committed**, and a Redis URL
// routinely carries a password — so the repeated thing would be a secret.
//
// A workspace is defined as ONE storage environment (root README, "How It
// Works"). The
// environment's connection details are therefore the workspace's to state, once,
// and a strategy names an **id** into that map. `backend: main` is a reference,
// exactly as `plugin: "@rawbox/rawbox-plugin-default"` is a reference into
// `plugins:` rather than a path.
//
// ## The consequence, stated rather than discovered
//
// A workflow declaring `redis-kv` can still be **shape**-verified standing
// alone: the strategy schema, the strategy-field diagnostics
// (`workflow/validation.ts`) and the seed rules all read the workflow document
// and nothing else. It cannot be **connection**-verified without its workspace,
// because the id it names is resolved there — {@link
// collectUnknownBackendProblems} needs both documents in hand.
//
// That split is not new and is not an exception. `plugin:` resolution has
// always worked the same way: `workflow verify` reports what it can from the
// document, then locates a workspace because the workspace is what says where
// packages were installed, and says plainly what was NOT checked when it cannot
// find one (`rawbox-cli`, `commands/workflow/verify.ts`, step 2). One rule,
// two things it governs.
//
// ## Credentials come from the environment
//
// The document holds a *shape* — `redis://cache.internal:6379/${REDIS_PASSWORD}`
// — and the process environment holds the secret. {@link
// interpolateEnvReferences} substitutes, and refuses to substitute an unset or
// empty variable. That refusal is the whole point of the module: the failure
// being designed out is a run that silently connects to `localhost` (or to a
// URL with an empty password field, which some clients accept) because
// `$REDIS_URL` expanded to nothing. A wrong store that answers is far worse
// than a store that will not open, so an unset variable is a **verify-time
// error naming the variable and the backend id**, never a default.
// ---------------------------------------------------------------------------

/**
 * How to reach one backend, as written in the workspace document.
 *
 * Closed (`StrictObject`) for the same reason every other authoring schema is:
 * this is a document a person or an assistant writes, and an unrecognised field
 * here would be a misread of something they meant. A misspelt `connexion:` that
 * validated would leave `connection` absent, which is a required field — so the
 * closed schema is what turns a typo into "unknown property `connexion`" rather
 * than into a lookup that finds nothing at run time.
 *
 * One field today, and deliberately an object rather than a bare string: a
 * backend entry is the place a TLS setting, a database index or a connection
 * pool bound would land, and widening `string` into an object later would be a
 * breaking change to every workspace document in existence.
 */
export const BackendConnection = StrictObject({
  /**
   * The connection string, with `${VARIABLE}` references to the process
   * environment (see {@link interpolateEnvReferences}).
   *
   * `minLength: 1` because an empty connection names no server and would
   * otherwise reach a client library as the string it treats as "use the
   * default" — which is precisely the silent-localhost failure this module
   * exists to prevent.
   */
  connection: Type.Readonly(Type.String({ minLength: 1 })),
});
export type BackendConnection = Static<typeof BackendConnection>;

/**
 * `backends:` — backend id → connection descriptor.
 *
 * A `Type.Record`, not a `StrictObject`: the *keys* are the author's own ids,
 * exactly as `plugins:` and `storage.keys` are (see `StrictObject`'s note
 * on why it deliberately does not reach records). The **values** are closed.
 */
export const BackendMap = Type.Record(Type.String(), BackendConnection);
export type BackendMap = Static<typeof BackendMap>;

/**
 * `${NAME}` — the one interpolation form, anchored on braces.
 *
 * Braces are required rather than optional (`$NAME` is **not** a reference).
 * A connection string is a URL, and a URL's password field may legitimately
 * contain a `$`; a bare-word form would make `redis://u:pa$$w0rd@h:6379`
 * ambiguous between a literal password and two undefined variables, and the
 * ambiguity would resolve in the dangerous direction — silently, into an empty
 * password. The braces make a reference something the author typed on purpose.
 *
 * The name is a POSIX-shell-style identifier so that the same string can be
 * exported from a shell verbatim.
 */
const ENV_REFERENCE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Every environment variable a connection string references, in first-seen
 * order and deduplicated.
 *
 * Exported because both the diagnostic path and the resolution path need the
 * same answer, and a second regex somewhere else is a second definition of what
 * a reference is.
 *
 * @param connection - The connection string as written in the document.
 * @returns The referenced variable names; empty for a string with no references.
 */
export function collectEnvReferenceList(connection: string): string[] {
  const nameList: string[] = [];

  for (const match of connection.matchAll(ENV_REFERENCE_PATTERN)) {
    const name = match[1];
    if (name !== undefined && !nameList.includes(name)) {
      nameList.push(name);
    }
  }

  return nameList;
}

/** One `${VARIABLE}` reference that the environment did not supply. */
export interface UnsetEnvReference {
  /** The variable name, without the `${…}`. */
  readonly variable: string;
  /**
   * Whether the variable was absent entirely or present-but-empty.
   *
   * Both are failures and both are refused, but they are different mistakes:
   * absent is usually "you forgot to export it", empty is usually "the thing
   * that was meant to set it produced nothing". Naming which one happened is
   * what stops an author from staring at an `export` line that is right there.
   */
  readonly reason: 'unset' | 'empty';
}

/**
 * Substitute every `${VARIABLE}` in `connection` from `env`.
 *
 * **An unset or empty variable is an error, never a substitution.** A variable
 * that expanded to the empty string would produce a connection string that is
 * still syntactically a URL — `redis://:@localhost:6379` — which a client will
 * happily open against the wrong server. The whole failure this module exists
 * to prevent is a run that connects somewhere plausible instead of failing, so
 * there is no default, no fallback and no warning-and-continue.
 *
 * Every unresolved reference is collected rather than the first, so an author
 * with three missing variables sets three of them in one pass — the same rule
 * every diagnostic follows for a `storage:` block: all the problems in one are
 * reported together rather than one per run, so a single pass gives the author
 * the whole fix list.
 *
 * @param connection - The connection string as written.
 * @param env - The environment to read, normally `process.env`.
 * @returns The substituted string, or every reference that could not be
 *          resolved.
 */
export function interpolateEnvReferences(
  connection: string,
  env: Record<string, string | undefined>,
): Result<string, UnsetEnvReference[]> {
  const unresolvedList: UnsetEnvReference[] = [];

  for (const variable of collectEnvReferenceList(connection)) {
    const value = env[variable];

    if (value === undefined) {
      unresolvedList.push({ variable, reason: 'unset' });
    } else if (value === '') {
      unresolvedList.push({ variable, reason: 'empty' });
    }
  }

  if (unresolvedList.length > 0) {
    return err(unresolvedList);
  }

  return ok(
    connection.replace(
      ENV_REFERENCE_PATTERN,
      // Every name reaching here resolved above, so the `?? ''` is unreachable
      // — it exists because `replace` has no way to fail and TypeScript has no
      // way to know the loop above already checked.
      (_match, name: string) => env[name] ?? '',
    ),
  );
}

/**
 * The `${VARIABLE}` diagnostic, in the house style FORMAT.md, "Validation",
 * requires: name the thing, name where it was declared, say what to do.
 *
 * It names the **variable** (what to set), the **backend id** (which entry is
 * broken, since a workspace may declare several) and the **document path**
 * (`backends.<id>.connection`, so the author can go straight to the line), and
 * it says explicitly that there is no default — because the reasonable guess on
 * seeing "REDIS_URL is not set" is that something sensible happens anyway, and
 * that guess is what this whole check exists to contradict.
 */
function describeUnsetEnvReference(parameters: {
  backendId: string;
  source: string;
  unresolvedList: readonly UnsetEnvReference[];
}): string {
  const { backendId, source, unresolvedList } = parameters;

  const detail = unresolvedList
    .map(
      (unresolved) =>
        `    ${unresolved.variable} — ` +
        (unresolved.reason === 'unset'
          ? 'not set in this process'
          : 'set, but empty'),
    )
    .join('\n');

  return (
    `Backend "${backendId}" cannot be resolved: its connection string references ` +
    `${unresolvedList.length} environment ${unresolvedList.length === 1 ? 'variable' : 'variables'} ` +
    `this process does not supply.\n` +
    `  Declared at backends.${backendId}.connection in "${source}".\n` +
    `${detail}\n` +
    `  Set ${unresolvedList.length === 1 ? 'it' : 'them'} in the environment before ` +
    `running or verifying — for example: export ${unresolvedList[0]?.variable}=…\n` +
    `  There is NO default and no fallback. An unset variable is refused here rather ` +
    `than substituted with nothing, because a connection string with an empty ` +
    `substitution is still a valid URL and a client would open it against the wrong ` +
    `server — silently.`
  );
}

/**
 * Every declared backend whose connection references an environment variable
 * the process does not supply, as author-facing diagnostics.
 *
 * **`backendIdList` decides the scope, and each command passes its own**, which
 * is the one design decision in this function:
 *
 * - `workspace verify` passes nothing, so **every** declared backend is
 *   checked. The workspace document *is* what that command verifies, and a
 *   declared-but-unresolvable backend is broken whether or not a workflow
 *   happens to reference it today.
 * - `workflow verify` passes the ids **this workflow references**. A workflow
 *   that touches no Redis at all must not fail because the workspace also
 *   declares a `prod` backend whose password this developer does not hold.
 *
 * Each command checks the document it is verifying. Checking every backend from
 * `workflow verify` would make one workflow's verification depend on another
 * workflow's secrets; checking only the referenced ones from `workspace verify`
 * would let a broken entry sit undetected until the day something referenced it.
 *
 * @param parameters.backends - The workspace's `backends:` map, if it has one.
 * @param parameters.source - Path of the workspace document, named in messages.
 * @param parameters.env - The environment to read, normally `process.env`.
 * @param parameters.backendIdList - Restrict the check to these ids; omit to
 *                                   check every declared backend.
 * @returns One diagnostic per unresolvable backend, in declaration order.
 */
export function collectBackendEnvProblems(parameters: {
  backends: BackendMap | undefined;
  source: string;
  env: Record<string, string | undefined>;
  backendIdList?: readonly string[] | undefined;
}): string[] {
  const { backends, source, env, backendIdList } = parameters;

  if (backends === undefined) {
    return [];
  }

  const problemList: string[] = [];

  for (const [backendId, backend] of Object.entries(backends)) {
    if (backendIdList !== undefined && !backendIdList.includes(backendId)) {
      continue;
    }

    const result = interpolateEnvReferences(backend.connection, env);

    if (result.isErr()) {
      problemList.push(
        describeUnsetEnvReference({
          backendId,
          source,
          unresolvedList: result.error,
        }),
      );
    }
  }

  return problemList;
}

/** One `backend:` id a strategy block names, and where it named it. */
export interface BackendReference {
  /** The id, exactly as written. */
  readonly backendId: string;
  /**
   * Document path of the strategy block that named it —
   * `storage.defaultStrategy` or `storage.keys.<key>.strategy`. Printed so the
   * author goes to the line rather than searching for the id.
   */
  readonly path: string;
}

/** True for a value that is a plain object, mirroring `workflow/validation.ts`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every `backend:` id a workflow document names, in document order.
 *
 * Takes `unknown` and reads defensively because both call sites want the answer
 * from a *document*, before or independently of the schema: the strategy-field
 * diagnostics run pre-schema for the reason `workflow/validation.ts` explains
 * (a union reports a stray field as a branch dump), and this check reads better
 * next to them than three passes later.
 *
 * Reads the field by name rather than by strategy name. `backend:` means one
 * thing wherever it appears — an id into `backends:` — which is the rule
 * FORMAT.md, "Strategies", states for every strategy field, so a second
 * strategy that also references a backend is swept here the day it is added,
 * with nothing to change.
 *
 * **Completeness is over declaration SITES as well as over strategies**, and
 * that half was missed once. This function read the then-existing
 * `storage.strategies` alone, which was complete while it was the only per-key
 * home for a strategy; `keys:` added a second, and a `redis-*` declared there
 * had its `backend:` id checked by nothing — neither the unknown-id rule nor
 * the unset-variable rule — so a typo'd id or an unset `${VAR}` verified clean
 * and failed at connect time, or worse, connected somewhere unintended. The
 * shorthand has since been removed and the sites are back down to two, but the
 * lesson is not: a third site would have to be added here the day it is
 * invented, and nothing else in the codebase would notice its absence.
 *
 * @param document - The parsed workflow document; any shape.
 * @returns The references, including duplicates — two keys naming the same
 *          missing backend are two lines an author has to fix.
 */
export function collectBackendReferenceList(
  document: unknown,
): BackendReference[] {
  const storage = isPlainObject(document) ? document.storage : undefined;

  if (!isPlainObject(storage)) {
    return [];
  }

  const referenceList: BackendReference[] = [];

  const record = (path: string, block: unknown): void => {
    if (!isPlainObject(block)) return;
    const backendId = block.backend;
    if (typeof backendId === 'string' && backendId.length > 0) {
      referenceList.push({ backendId, path });
    }
  };

  record('storage.defaultStrategy', storage.defaultStrategy);

  if (isPlainObject(storage.keys)) {
    for (const [key, entry] of Object.entries(storage.keys)) {
      if (isPlainObject(entry)) {
        record(`storage.keys.${key}.strategy`, entry.strategy);
      }
    }
  }

  return referenceList;
}

/**
 * The unknown-id diagnostic, again in that house style: name the thing, name
 * where it was declared, say what to do.
 *
 * The two cases are genuinely different mistakes and get different sentences.
 * A workspace with *no* `backends:` block at all is one an author has not
 * written yet, so the message is the block to add; a workspace with a map that
 * simply lacks this id is almost always a typo or a rename, so the message is
 * the list of ids that do exist — which is the fix in the overwhelming majority
 * of cases — a diagnostic names the field that is wrong and lists the values
 * that would be right.
 *
 * It never dumps a schema branch: the document is schema-valid, and what is
 * wrong is a reference, not a shape.
 */
function describeUnknownBackend(parameters: {
  reference: BackendReference;
  knownIdList: readonly string[];
  workflowLabel: string;
  workspaceSource: string;
}): string {
  const { reference, knownIdList, workflowLabel, workspaceSource } = parameters;

  const where =
    `  Named at ${reference.path} in ${workflowLabel}; backends are declared in ` +
    `the workspace document "${workspaceSource}".`;

  if (knownIdList.length === 0) {
    return (
      `Backend "${reference.backendId}" is not declared: the workspace document ` +
      `has no "backends:" block at all.\n` +
      `${where}\n` +
      `  Add one, with this id, and put the credentials in the environment rather ` +
      `than in the document:\n` +
      `    backends:\n` +
      `      ${reference.backendId}:\n` +
      `        connection: \${REDIS_URL}\n` +
      `  A strategy's "backend:" is an id into that map, never a connection string ` +
      `— one workspace is one storage environment, so the address is stated once ` +
      `there rather than once per key.`
    );
  }

  return (
    `Backend "${reference.backendId}" is not declared by this workspace.\n` +
    `${where}\n` +
    `  Declared backend ids: ${knownIdList.map((id) => `"${id}"`).join(', ')}.\n` +
    `  Either correct "${reference.backendId}" to one of those, or add an entry ` +
    `under "backends:" for it in "${workspaceSource}".`
  );
}

/**
 * Every `backend:` id a workflow names that the workspace does not declare.
 *
 * The diagnostic this produces is why the reference is an id rather than a
 * connection string: a typo in an id is caught here, at verify time, naming the
 * ids that exist. A typo in a hostname is caught by a connection timeout, at
 * run time, if at all.
 *
 * @param parameters.document - The parsed workflow document.
 * @param parameters.backends - The workspace's `backends:` map, if it has one.
 * @param parameters.workflowLabel - How to name the workflow in the message —
 *                                   its path for `workspace verify`, `"this
 *                                   workflow"` for a single-document check.
 * @param parameters.workspaceSource - Path of the workspace document.
 * @returns One diagnostic per offending reference, in document order.
 */
export function collectUnknownBackendProblems(parameters: {
  document: unknown;
  backends: BackendMap | undefined;
  workflowLabel: string;
  workspaceSource: string;
}): string[] {
  const { document, backends, workflowLabel, workspaceSource } = parameters;

  const knownIdList = backends === undefined ? [] : Object.keys(backends);
  const problemList: string[] = [];

  for (const reference of collectBackendReferenceList(document)) {
    if (knownIdList.includes(reference.backendId)) {
      continue;
    }

    problemList.push(
      describeUnknownBackend({
        reference,
        knownIdList,
        workflowLabel,
        workspaceSource,
      }),
    );
  }

  return problemList;
}

/**
 * The connection string for one backend id, fully substituted — what a store
 * implementation asks for when it is about to open a connection.
 *
 * A `Result` rather than a throw, per this codebase's convention and because
 * both failures are ordinary author mistakes rather than exceptional
 * conditions: the id names nothing, or the environment did not supply a
 * variable. The error is the same sentence the verify-time diagnostics print,
 * so a reader who sees it at run time sees a message they can act on rather
 * than a second, terser wording of the same problem.
 *
 * Nothing calls this yet — the Redis store is not implemented in this version
 * (see `workflow/store-support.ts`, which is what refuses such a run). It is
 * defined here, next to the diagnostics it shares its wording with, so that the
 * store which does connect reads the map through one function rather than
 * reaching into `Workspace.backends` itself.
 *
 * @param parameters.backends - The workspace's `backends:` map, if it has one.
 * @param parameters.backendId - The id a strategy named.
 * @param parameters.source - Path of the workspace document, named in errors.
 * @param parameters.env - The environment to read, normally `process.env`.
 * @returns The substituted connection string, or the reason it could not be
 *          produced.
 */
export function resolveBackendConnection(parameters: {
  backends: BackendMap | undefined;
  backendId: string;
  source: string;
  env: Record<string, string | undefined>;
}): Result<string, string> {
  const { backends, backendId, source, env } = parameters;

  const backend = backends?.[backendId];

  if (backend === undefined) {
    const knownIdList = backends === undefined ? [] : Object.keys(backends);

    return err(
      `Backend "${backendId}" is not declared in "${source}".` +
        (knownIdList.length === 0
          ? ' That document has no "backends:" block at all.'
          : ` Declared backend ids: ${knownIdList.map((id) => `"${id}"`).join(', ')}.`),
    );
  }

  const result = interpolateEnvReferences(backend.connection, env);

  if (result.isErr()) {
    return err(
      describeUnsetEnvReference({
        backendId,
        source,
        unresolvedList: result.error,
      }),
    );
  }

  return ok(result.value);
}
