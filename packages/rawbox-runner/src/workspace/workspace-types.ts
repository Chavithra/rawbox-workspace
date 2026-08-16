import path from 'node:path';

import { Type, type Static } from 'typebox';

import { StrictObject } from '@rawbox/store';

import { BackendMap } from './backends.js';
import { WorkspaceLogs } from './logs.js';
import { SeedOverrideMap } from './seed-overrides.js';

/**
 * `kind: Workspace` identifies a workspace file directly. Consumers must
 * discover a workspace by testing `kind === 'Workspace'`, not by shape.
 */
export const WORKSPACE_KIND = 'Workspace';
export const WorkspaceKind = Type.Literal(WORKSPACE_KIND);
export type WorkspaceKind = Static<typeof WorkspaceKind>;

/**
 * `kind` is **required**, matching `Workflow`. Workspace auto-discovery matches
 * on `kind === 'Workspace'` and nothing else, so a document without it would
 * validate yet never be found. The fix is to add the one line, and
 * {@link workspaceKindError} says so.
 *
 * **Authoring model, and closed like one.** This is a document a person or an
 * assistant writes, so an unrecognised field here is a silent misread rather
 * than a tidiness question — in particular `metadata:`, which is reserved and
 * which the Workflow document has always rejected.
 *
 * **Identity stays flat, and `metadata:` is reserved for a reason.** Both
 * comparable formats put `name` at the top level and use the surrounding words
 * for something else: Make's top-level `metadata` holds execution settings
 * (`roundtrips`, `maxErrors`, `autoCommit`, `zone`), and n8n's equivalent is
 * `settings`. Nesting identity under `metadata:` would collide with the
 * established meaning in this product category *and* consume the obvious name
 * for a future execution-settings block. So `metadata:` and `settings:` are
 * reserved and unused, on the Workspace document as much as on the Workflow.
 */
export const Workspace = StrictObject({
  kind: WorkspaceKind,
  name: Type.String(),
  workflowPathList: Type.Array(Type.String()),
  targetFolder: Type.Optional(Type.String({ minLength: 1 })),
  /**
   * `backends:` — backend id → connection descriptor, for strategies whose
   * store is not this workspace's own LMDB file.
   *
   * **Optional, and absent for every LMDB-only workspace.** The LMDB
   * environment is not a backend entry and never will be: its location is
   * derived from `targetFolder`, there is nothing to connect to and no
   * credential to hold. This map exists for the stores that *are* somebody
   * else's server, and a workspace that uses none declares none.
   *
   * **The map stays here, on the workspace, rather than on the strategy** —
   * `workspace/backends.ts`'s module header has the argument in full, in short:
   * a strategy block is per-key, so a connection string there would be repeated
   * once per key, and a workflow document is committed, so the repeated thing
   * would be a secret. A workspace is one storage environment (root README,
   * "How It Works"),
   * which makes this document the one place its address belongs.
   *
   * `Workspace` stays closed around it. A record's *keys* are the author's own
   * ids and so are open, exactly as `plugins:` and `storage.keys` are;
   * its *values* are closed (`BackendConnection`), so a misspelt field inside
   * one is still an error rather than a dropped setting.
   */
  backends: Type.Optional(BackendMap),
  /**
   * `seedOverrides:` — workflow **path** → (storage key → the value that key
   * starts with), replacing the seed the workflow document declares.
   *
   * **Overridable: `seed:` only, and the field is named to say so.** The
   * invariant `workspace/seed-overrides.ts` states in full, and the one that
   * makes this safe to have at all: *an override can never change where a key
   * lives or what an operation on it means — only what it starts with.* A
   * workspace that could also replace `strategy.name` would silently turn "read
   * this config each loop" into "consume a queue"; one that could replace
   * `backend:` could split a workflow's keys across two stores and break the
   * co-transactional rule from outside the document that has to satisfy it. So
   * the field is `seedOverrides`, not `overrides` — it resists being widened
   * later by being unable to name anything else.
   *
   * **Nested by workflow path, not flat.** A workspace holds many workflows,
   * and `sleep_ms` in two of them is two different boxes (seeds are written at
   * `{ key, workflow, workspace }`), so a flat map would hit both. The key is
   * the same entry {@link Workspace.workflowPathList} holds, matched on the
   * **resolved** path (`resolveWorkspaceWorkflowPath`) so that
   * `./workflows/a.yaml` and `workflows/a.yaml` are one workflow. Because the
   * reference is checkable against `workflowPathList` in this same document, a
   * key matching nothing is an error at *every* entry point that loads the
   * workspace — `run`, `workflow verify` and `workspace verify` alike
   * (`collectSeedOverridePathProblems`), not at one command holding every
   * workflow document.
   *
   * **Path here, name inside a workflow — the asymmetry is deliberate.**
   * `storage.keys.<key>.workflow` names a sibling workflow by `name:`, because
   * a workflow document must not depend on the workspace's directory layout and
   * the same workflow may be listed by different relative paths from different
   * workspaces. Each document refers to a workflow by the identifier it can
   * actually check. Unifying them would break whichever half was moved: keyed
   * by `name:`, an override block was verifiable only by a command holding
   * every workflow document, so `run` with a misspelt block silently used the
   * workflow's own seed — a wrong value on every run, with no diagnostic
   * anywhere. See `workspace/seed-overrides.ts`'s module note.
   *
   * **Optional, and absent for every workspace that overrides nothing.** An
   * override may only *replace* a seed the workflow already declares; it can
   * never introduce one, because seeding is unconditional on every run and an
   * override on an unseeded key would reset that key each run rather than
   * initialise it.
   *
   * `Workspace` stays closed around it, exactly as it does around `backends:`:
   * both levels of a record's keys are the author's own names and so are open;
   * there is no closed value schema at the leaf because a seed is arbitrary
   * data — which is the same fact that denies `seed:` a long form, since a
   * wrapper could never be told apart from an intended literal object — and its
   * shape is checked against the strategy the *workflow* declares.
   */
  seedOverrides: Type.Optional(SeedOverrideMap),
  /**
   * `logs:` — how this workspace's run-event files are written, rotated and
   * pruned. See `workspace/logs.ts` for each field.
   *
   * **Here for the same reason `backends:` is here.** A log bound is a
   * deployment fact: the same workflow runs on a laptop that can spare 50 MB
   * and on a box that keeps a fortnight of history, and nothing about its steps
   * differs between them. A workflow document that carried these numbers would
   * have to be edited per environment — which is the thing this document exists
   * to stop.
   *
   * **Optional, and every sub-block optional inside it.** `logs: {}` is legal
   * and means what omitting the key means: all defaults. Rotation in particular
   * is off unless both of its fields are declared, so an existing workspace
   * that adds this block keeps exactly the log files it has today.
   *
   * **Closed, and that is the point.** These bounds used to live in an untyped
   * `rawbox.config.json` whose reader silently discarded anything of the wrong
   * type — `"maxBytes": "50mb"` was not an error there, it was the default and
   * no diagnostic. Moving them into this validated document is what turns a
   * mistyped retention bound into a verify-time error naming the field, instead
   * of into a full disk three weeks later.
   */
  logs: Type.Optional(WorkspaceLogs),
});

export type Workspace = Static<typeof Workspace>;

/**
 * The identity diagnostic for a document that should have been a workspace.
 *
 * Returns `undefined` when `kind` is right, so a caller can use it as a guard.
 * It exists so the reason reaches the author as one sentence naming the fix,
 * rather than as a schema error reading `Path "/kind" : Expected required
 * property` — which states what is missing without saying what to write.
 *
 * @param document - The parsed document, of any shape.
 * @param source - Path to name in the message.
 * @returns The diagnostic, or `undefined` if `kind` is `'Workspace'`.
 */
export function workspaceKindError(
  document: unknown,
  source: string,
): string | undefined {
  const kind =
    typeof document === 'object' && document !== null
      ? (document as { kind?: unknown }).kind
      : undefined;

  if (kind === WORKSPACE_KIND) {
    return undefined;
  }

  if (kind === undefined) {
    return (
      `"${source}" has no "kind:" field, so it is not a Rawbox workspace document.\n` +
      `  Add this as its first line:  kind: ${WORKSPACE_KIND}\n` +
      `  It is how a workflow finds the workspace it belongs to — discovery walks up ` +
      `looking for that exact field, and matches on nothing else.`
    );
  }

  return (
    `"${source}" declares kind ${JSON.stringify(kind)}, but a workspace document must ` +
    `declare kind: ${WORKSPACE_KIND}.`
  );
}

/**
 * The dot-folder that holds everything ephemeral a workspace produces —
 * installed plugins, the LMDB data directory, and (eventually) run logs. It is
 * gitignored and machine-owned: safe to delete, regenerated by `workspace
 * setup` / `workflow run` on demand. `rawbox.lock` deliberately stays *outside*
 * this folder, next to `workspace.yaml`, because it is committed rather than
 * ephemeral. See the rawbox-cli README, "Workspace Initialization
 * (`workspace setup`)".
 */
export const RAWBOX_DOT_FOLDER = '.rawbox';

/**
 * Resolves the folder `workspace setup` installs into and the runner resolves
 * plugins from, highest precedence first:
 *
 * 1. an explicit `target-folder` argument on the command line;
 * 2. `targetFolder:` in the workspace document, resolved **relative to the
 *    workspace directory** — the same base a relative `file:` plugin specifier
 *    uses, so an author only has to learn one rule;
 * 3. `<workspace directory>/.rawbox` ({@link RAWBOX_DOT_FOLDER}).
 *
 * (3) is the default so that ephemeral, machine-owned output — the installed
 * `node_modules`, the generated `package.json`, the LMDB data directory — never
 * lands directly beside the authored `workspace.yaml` and `rawbox.lock`; it is
 * one gitignorable folder a workspace can delete freely and regenerate.
 * `runWorkflowInstance` resolves plugins by walking up from the workspace
 * directory too, so installing under it (rather than somewhere unrelated) is
 * what keeps a run reproducible from any cwd.
 *
 * @param workspaceDir - Directory containing the workspace document.
 * @param workspace - The loaded workspace document.
 * @param explicitTargetFolder - The CLI positional, when one was given.
 * @returns An absolute path.
 */
export function resolveTargetFolder(
  workspaceDir: string,
  workspace: Pick<Workspace, 'targetFolder'>,
  explicitTargetFolder?: string | undefined,
): string {
  const absoluteWorkspaceDir = path.resolve(workspaceDir);

  if (explicitTargetFolder !== undefined && explicitTargetFolder.trim() !== '') {
    return path.resolve(explicitTargetFolder);
  }

  const declared = workspace.targetFolder?.trim();
  if (declared !== undefined && declared !== '') {
    return path.resolve(absoluteWorkspaceDir, declared);
  }

  return path.join(absoluteWorkspaceDir, RAWBOX_DOT_FOLDER);
}
