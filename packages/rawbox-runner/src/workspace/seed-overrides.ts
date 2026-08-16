import path from 'node:path';

import { Type, type Static } from 'typebox';
import { err, ok, type Result } from 'neverthrow';

import { descriptorFor, type BoxStrategy } from '@rawbox/store';

import {
  checkFifoSeedIsList,
  checkFifoSeedLength,
  checkValueSize,
} from '../workflow/validation.js';
import { keyPath, resolveKeyTable } from '../workflow/key-table.js';
import type { ResolvedStorageKey } from '../workflow/key-table.js';
import type {
  Storage,
  StorageKeyRecord,
  Workflow,
} from '../workflow/workflow-types.js';
import { resolveWorkspaceWorkflowPath } from './workflow-path.js';

// ---------------------------------------------------------------------------
// `seedOverrides:` — how a workspace replaces a workflow's starting values
//
// ## The invariant, because it is what makes the whole design safe
//
// **An override can never change where a key lives or what an operation on it
// means — only what it starts with.**
//
// Everything below follows from that one sentence, and the field surface is
// drawn to make violating it unspeakable rather than merely discouraged. Only
// `seed:` is overridable. The four facts a `storage:` block states that are
// NOT, each refused for its own reason:
//
//   - **`name:` (the strategy)** decides what every operation on the key
//     MEANS. On `lmdb-kv` a read leaves the value; on `lmdb-fifo` it dequeues
//     and destroys it (`@rawbox/store`, `strategy/descriptor.ts`). A workspace
//     flipping it would silently convert "read this config each loop" into
//     "consume a queue", changing every step's behaviour without the workflow
//     document changing a character. That is not configuration, it is
//     rewriting the program from another file.
//   - **`valueSizeMax` / `queueSizeMax`** are sizing, and sizing is part of
//     what a workflow declares about its own storage — the figures its budget
//     is computed from (`key-table.ts`'s `boxStorageFor`).
//   - **`workflow:`** is topology: which box a key IS. See
//     `resolveKeyOwnerMap`.
//   - **`backend:`** is excluded deliberately, and it is the non-obvious one.
//     A `backend:` names a *role* that the workspace's `backends:` map already
//     binds to a connection (`workspace/backends.ts`), so dev-vs-prod is
//     already fully expressible without any override at all: you change what
//     `main` points to, not what the key calls it. It is also the ONLY
//     remaining candidate that could change WHICH STORE a key resolves to,
//     which would let a workspace split one store in two and break the
//     co-transactional rule (`validateCoTransactionalStore`,
//     `workflow/validation.ts`) from outside the workflow that has to satisfy
//     it.
//
// The name of the field states the scope for the same reason: `seedOverrides`,
// not `overrides`, so that the day somebody wants to override a strategy the
// field itself is the argument against it.
//
// ## Why the block is nested, and keyed by workflow PATH
//
// A workspace holds many workflows, and the same key name in two of them is
// two different boxes — `run-workflow.ts` writes every seed at
// `{ key, workflow, workspace }`, so `sleep_ms` in `flow-a` and `sleep_ms` in
// `flow-b` are unrelated. A flat key → value map would therefore hit both, and
// an author overriding one would silently move the other. So the block nests:
//
//     workflowPathList:
//       - ./workflows/my-flow.yaml
//     seedOverrides:
//       ./workflows/my-flow.yaml:
//         sleep_ms: 500
//
// keyed by the **path**, the identifier `workflowPathList` already uses, and
// resolved the same way it is ({@link resolveWorkspaceWorkflowPath}).
//
// ### Why not the workflow's `name:` — the failure that keying bought
//
// It was keyed by `name:` and that was wrong, for a reason worth stating
// rather than rediscovering. A workspace lists workflows by *path*; a
// workflow's *name* lives inside a **different file**. Keying by name put a
// second identifier into the workspace document pointing at a value the
// workspace cannot see, so "does this block name a workflow that exists" was
// answerable only by a command holding every workflow document — which meant
// `workspace verify` alone. Every other entry point,
// {@link seedOverrideLayerFor} included, returned "no layer" for a name it did
// not recognise, so `rawbox-cli run <flow>` with a misspelt block **silently
// used the workflow's own seed**: a wrong value, on every run, with no
// diagnostic anywhere.
//
// Keyed by path, the same question is answerable from `workflowPathList` in
// the same document. So {@link collectSeedOverridePathProblems} runs wherever
// the workspace document is loaded — `run`, `workflow verify` and
// `workspace verify` alike — and a block naming nothing is a **document
// error** at every one of them rather than a no-op at all but one.
//
// ### Why the match is on the RESOLVED path
//
// A path has many spellings for one file (`./workflows/a.yaml`,
// `workflows/a.yaml`, `workflows/./a.yaml`), so matching on the authored
// string would merely trade a name mismatch for a spelling mismatch — the same
// silent wrong seed, differently spelt. Both sides go through
// {@link resolveWorkspaceWorkflowPath}, against the workspace directory, and
// the comparison is on what comes out.
//
// ## The asymmetry with `storage.keys.<key>.workflow`, which is principled
//
// Inside a **workspace** document a workflow is named by PATH; inside a
// **workflow** document a sibling workflow is named by NAME
// (`storage.keys.<key>.workflow`, `resolveKeyOwnerMap`). That is deliberate
// and must not be "unified":
//
//   - The workspace lists paths, so a path keeps the reference checkable
//     within the one file that holds it.
//   - A workflow document must not depend on the workspace's directory layout.
//     The same workflow may be listed by different relative paths from
//     different workspaces (and by none at all under `--workspace-name`), so a
//     path there would be a reference that changes meaning per workspace.
//
// Each document refers to a workflow by the identifier it can actually check.
//
// Unifying them would break whichever half was moved, and the path half is
// what a live bug proved. Keyed by `name:`, the reference was verifiable only
// where every workflow document was in hand — `workspace verify` alone:
// `seedOverrideLayerFor` returned `undefined` for an unrecognised name, so
// `rawbox-cli run <flow>` with a misspelt block **silently used the workflow's
// own seed**, a wrong value on every run with no diagnostic anywhere. Keyed by
// path, `workflowPathList` in the same file answers it, which is what lets
// `run`, `workflow verify` and `workspace verify` all refuse a block that
// matches nothing.
// ---------------------------------------------------------------------------

/**
 * The same continuation indent every storage diagnostic in
 * `workflow/validation.ts` uses for the extra lines of one problem, so an
 * override's diagnostic sits in a `verify` report indistinguishably from the
 * workflow's own.
 */
const DETAIL = '\n    ';

/**
 * One workflow's overrides — storage key → the value that key starts with.
 *
 * `Type.Unknown()` for exactly the reason a `storage.keys` entry's `seed` is
 * (`StorageKeyEntry`, `workflow-types.ts`): a seed is arbitrary data whose *shape* is
 * strategy-dependent, and the strategy lives in the workflow document, not
 * here. {@link applySeedOverrides} is what evaluates the shape, against the
 * strategy the workflow declared.
 */
export const SeedOverrideRecord = Type.Record(Type.String(), Type.Unknown());
export type SeedOverrideRecord = Static<typeof SeedOverrideRecord>;

/**
 * `seedOverrides:` — workflow **path** → (storage key → replacement seed
 * value).
 *
 * A `Type.Record` of records, not a `StrictObject`: both levels of key are the
 * author's own strings — a `workflowPathList` entry and their own storage keys
 * — exactly as `plugins:`, `backends:` and `storage.keys` are (see
 * `StrictObject`'s note on why it deliberately does not reach records). The
 * outer key is checked by {@link collectSeedOverridePathProblems} rather than
 * by the schema, because "is this one of the paths this document lists" is a
 * cross-field question no `Type.Record` can express.
 *
 * There is no closed *value* schema to reach for here, unlike
 * `BackendConnection`: the leaf is a seed, which is arbitrary data, so nothing
 * about its shape can be reserved to mean something else — the reasoning
 * that refuses `seed:` a long form: a binding value is always a storage-key
 * string, so an object there signals a long form unambiguously, but a seed
 * value is arbitrary data and `{ value: 1 }` cannot be told apart from an
 * intended literal object.
 * That is also why an override **replaces whole and never deep-merges**: a
 * merge would have to tell structure from content, and a seed value has no
 * distinction between the two. `{a: 1}` overriding `{a: 0, b: 2}` yields
 * `{a: 1}`, not `{a: 1, b: 2}`.
 */
export const SeedOverrideMap = Type.Record(Type.String(), SeedOverrideRecord);
export type SeedOverrideMap = Static<typeof SeedOverrideMap>;

/**
 * One layer of seed overrides for **one** workflow, with everything a
 * diagnostic needs to say where it came from.
 *
 * This is the seam the precedence order is expressed on. {@link
 * applySeedOverrides} takes a *list* of layers, lowest precedence first, and a
 * later layer replaces an earlier one key by key — so the CLI layer that comes
 * next (`CLI > workspace > workflow`) appends one more layer built from its
 * flag and changes nothing else: not the rules, not the diagnostics, not the
 * call sites. The workflow document is not a layer; it is the base the layers
 * replace values in, which is what makes "may only replace a seed the workflow
 * already declares" a property of the merge rather than a check bolted beside
 * it.
 */
export interface SeedOverrideLayer {
  /** Storage key → replacement value, exactly as authored. */
  readonly valueRecord: Readonly<Record<string, unknown>>;
  /**
   * Document path of the block itself — `seedOverrides["./workflows/my-flow.yaml"]`,
   * from {@link keyPath}, built from the **authored** spelling rather than the
   * resolved path so the field named is one the document literally contains.
   * Per-key paths are built from it, so a diagnostic names a field the author
   * can copy out of the message and go and find.
   */
  readonly blockPath: string;
  /** The document that holds the block, named in every diagnostic. */
  readonly source: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The one sentence that states the keying rule, appended to every diagnostic
 * about an outer key. One constant rather than a phrase per message so the
 * three entry points that now report these ({@link seedOverrideLayerFor}'s
 * callers: `run-workflow.ts`, `workflow verify`, `workspace verify`) cannot
 * drift into three dialects of one rule — the same reasoning
 * {@link collectOverrideShapeProblems} gives for reusing the shared size
 * checks.
 */
const KEYING_RULE =
  `A seedOverrides: block is keyed by workflow PATH — the same entry ` +
  `workflowPathList holds, resolved against the workspace directory — so ` +
  `"./workflows/a.yaml", "workflows/a.yaml" and "workflows/./a.yaml" all name ` +
  `one workflow. (Inside a WORKFLOW document, storage.keys.<key>.workflow ` +
  `names a sibling by NAME instead: a path there would couple that workflow to ` +
  `this workspace's directory layout.)`;

/**
 * Every `seedOverrides:` key paired with the absolute path it resolves to.
 *
 * The one place the outer keys are read and resolved, shared by
 * {@link seedOverrideLayerFor} (which needs the block whose path matches the
 * running workflow) and {@link collectSeedOverridePathProblems} (which needs
 * every path that matches nothing). Two resolutions here would be exactly the
 * bug the keying change removes: a selector and a checker disagreeing by one
 * `./` makes a listed block look unlisted, or an unlisted one apply silently.
 *
 * Reads defensively rather than through the `Workspace` schema for the reason
 * `collectBackendReferenceList` (`workspace/backends.ts`) does: `workflow
 * verify` holds a workspace document it has deliberately *not* validated —
 * `workspace verify` is what validates that document, and one command must not
 * start reporting a second document's schema errors. So a `seedOverrides:`
 * that is not a map yields nothing here, and the schema reports it by path
 * where it belongs.
 */
function resolveOverrideBlockList(
  seedOverrides: unknown,
  workspaceDir: string,
): { authored: string; resolved: string; value: unknown }[] {
  if (!isPlainObject(seedOverrides)) {
    return [];
  }

  return Object.entries(seedOverrides).map(([authored, value]) => ({
    authored,
    resolved: resolveWorkspaceWorkflowPath(workspaceDir, authored),
    value,
  }));
}

/**
 * The layer a workspace's `seedOverrides:` block supplies for the workflow
 * being run or verified, selected by that workflow's **own source path**.
 *
 * The authored spelling is kept for `blockPath` — a diagnostic must quote the
 * field as the author wrote it, so the path in the message can be copied back
 * into the document — while the *match* is on the resolved path, so a block
 * written `workflows/a.yaml` against a `workflowPathList` entry
 * `./workflows/a.yaml` is the same workflow rather than a near miss.
 *
 * ## `undefined` here is no longer "no diagnostic"
 *
 * It still returns `undefined` when no block matches, but that is now only ever
 * one of two things: the workspace declares no block for this workflow (which
 * is the ordinary case), or it declares one matching nothing — and *that* case
 * is a document error {@link collectSeedOverridePathProblems} reports at the
 * same entry point, before this layer is ever applied. There is no longer a
 * state in which a misspelt block silently leaves the workflow's own seed in
 * place, which is the whole point of keying by path (see the module note).
 *
 * @param parameters.seedOverrides - The workspace's block, if it has one.
 * @param parameters.workflowPath - The running/verifying workflow's own source
 *   path. Resolved here, so a caller may pass a relative one.
 * @param parameters.workspaceDir - Directory holding the workspace document —
 *   the base every path in that document resolves against. `undefined` for a
 *   workspace with no document at all (an in-memory `WorkspaceSource` built by
 *   `--workspace-name`): there is no path base, so there is no block to select
 *   and no layer, exactly as before.
 * @param parameters.source - How the workspace document is named in a
 *   diagnostic (its path, or `run-workflow.ts`'s `workspaceLabel` for one that
 *   has none).
 */
export function seedOverrideLayerFor(parameters: {
  seedOverrides: unknown;
  workflowPath: string;
  workspaceDir: string | undefined;
  source: string;
}): SeedOverrideLayer | undefined {
  const { seedOverrides, workflowPath, workspaceDir, source } = parameters;

  if (workspaceDir === undefined) {
    return undefined;
  }

  const target = path.resolve(workflowPath);

  for (const block of resolveOverrideBlockList(seedOverrides, workspaceDir)) {
    if (block.resolved !== target) continue;
    // Not a map: the schema reports that by path, and this command must not
    // report a second document's schema errors.
    if (!isPlainObject(block.value)) continue;

    return {
      valueRecord: block.value,
      blockPath: keyPath('seedOverrides', block.authored),
      source,
    };
  }

  return undefined;
}

/**
 * Every `seedOverrides:` key that names no workflow this workspace lists, plus
 * every pair of keys that name the *same* workflow twice.
 *
 * **The check the keying change exists to make possible.** Both questions are
 * answerable from `workflowPathList` in the same document, so this runs
 * wherever the workspace document is loaded — `runWorkflowInstance`,
 * `workflow verify` and `workspace verify` — rather than at the single command
 * that used to hold every workflow *document*. A block matching nothing is the
 * failure being designed out: an author writes
 * `seedOverrides: { ./workflows/my-flwo.yaml: { sleep_ms: 500 } }`, every
 * command passes, the run seeds 2000 anyway, and nothing anywhere says why.
 *
 * A **duplicate** is refused for the same reason and is new with path keying:
 * two spellings of one path are one workflow, so one of the two blocks would be
 * silently dropped by {@link seedOverrideLayerFor}'s first match. Normalisation
 * is what makes them equal; refusing the pair is what keeps the equality from
 * costing an author a block they wrote.
 *
 * Diagnostics name the authored spelling, what it resolved to, and the resolved
 * paths that *do* exist — so an author who wrote `workflows/a.yaml` against a
 * list holding `./workflows/a.yaml` is never told they do not match. They do,
 * and this function never reports them.
 *
 * @param parameters.seedOverrides - The workspace's block, if it has one.
 * @param parameters.workflowPathList - `workflowPathList` as authored. Typed
 *   `unknown` and filtered to strings for the reason
 *   {@link resolveOverrideBlockList} reads defensively: `workflow verify` holds
 *   a workspace document it has deliberately not validated.
 * @param parameters.workspaceDir - Directory holding the workspace document.
 *   `undefined` for a workspace with no document — no path base, nothing to
 *   check, no problems.
 * @param parameters.source - How the workspace document is named in a
 *   diagnostic.
 * @returns One diagnostic per offending key, in document order.
 */
export function collectSeedOverridePathProblems(parameters: {
  seedOverrides: unknown;
  workflowPathList: unknown;
  workspaceDir: string | undefined;
  source: string;
}): string[] {
  const { seedOverrides, workflowPathList, workspaceDir, source } = parameters;

  if (workspaceDir === undefined) {
    return [];
  }

  const listedList = (Array.isArray(workflowPathList) ? workflowPathList : [])
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => ({
      authored: entry,
      resolved: resolveWorkspaceWorkflowPath(workspaceDir, entry),
    }));

  const problemList: string[] = [];
  /** Resolved path → the first authored key that claimed it. */
  const claimedBy = new Map<string, string>();

  for (const block of resolveOverrideBlockList(seedOverrides, workspaceDir)) {
    const blockPath = keyPath('seedOverrides', block.authored);

    const firstClaim = claimedBy.get(block.resolved);
    if (firstClaim !== undefined) {
      problemList.push(
        `Seed overrides are declared twice for one workflow: ` +
          `${JSON.stringify(firstClaim)} and ${JSON.stringify(block.authored)} ` +
          `are two spellings of one path.${DETAIL}` +
          `Both ${keyPath('seedOverrides', firstClaim)} and ${blockPath} in ` +
          `"${source}" resolve to "${block.resolved}".${DETAIL}` +
          `${KEYING_RULE}${DETAIL}` +
          `Merge the two blocks into one. They are refused rather than merged ` +
          `here because an override replaces a value whole and never deep-merges ` +
          `— two blocks for one workflow would mean one of them was silently ` +
          `dropped.`,
      );
      continue;
    }
    claimedBy.set(block.resolved, block.authored);

    if (listedList.some((listed) => listed.resolved === block.resolved)) {
      continue;
    }

    problemList.push(
      `Seed overrides are declared for workflow path ` +
        `${JSON.stringify(block.authored)}, which this workspace does not ` +
        `list.${DETAIL}` +
        `Declared at ${blockPath} in "${source}", resolving to ` +
        `"${block.resolved}".${DETAIL}` +
        (listedList.length === 0
          ? `This workspace's workflowPathList is empty, so there is nothing the ` +
            `block can apply to.${DETAIL}`
          : `workflowPathList holds: ` +
            `${listedList
              .map((listed) => `${JSON.stringify(listed.authored)} → "${listed.resolved}"`)
              .join(', ')}.${DETAIL}`) +
        `${KEYING_RULE}${DETAIL}` +
        `Correct the path, or add the workflow to workflowPathList. A block that ` +
        `matches no workflow is refused rather than ignored: it would otherwise ` +
        `sit in the document looking applied while every run used the workflow's ` +
        `own value.`,
    );
  }

  return problemList;
}

/**
 * The multi-line form of {@link collectSeedOverridePathProblems}'s output, or
 * `undefined` when there is nothing wrong.
 *
 * Shaped exactly like {@link applySeedOverrides}'s `err` — a heading naming the
 * document at fault, then one `- ` bullet per problem — so the three entry
 * points that report it (`runWorkflowInstance`'s `bootstrap.error`,
 * `workflow verify`, `workspace verify`) print one recognisable thing, and so
 * a reader cannot tell "this key names no workflow" from "this key's value
 * breaks a rule" by formatting alone when only one of them is their bug.
 *
 * `workspace verify` deliberately does **not** use this: it reports one
 * `p.log.error` per problem, alongside the other per-field errors it collects
 * for the same document.
 */
export function formatSeedOverridePathProblems(parameters: {
  seedOverrides: unknown;
  workflowPathList: unknown;
  workspaceDir: string | undefined;
  source: string;
}): string | undefined {
  const problemList = collectSeedOverridePathProblems(parameters);

  if (problemList.length === 0) {
    return undefined;
  }

  return (
    `Seed override validation failed for workspace "${parameters.source}":\n` +
    problemList.map((problem) => `  - ${problem}`).join('\n')
  );
}

/**
 * One override that passed every rule — the key and the value it now starts
 * with. Where that value is written back is decided from the document by
 * {@link withReplacedSeeds}, not carried here, so the merge cannot write a seed
 * into an idiom the author did not use.
 */
interface SeedReplacement {
  readonly key: string;
  readonly value: unknown;
}

/**
 * The diagnostic for an override on a key the workflow declares but does not
 * seed, and for one on a key it does not declare at all.
 *
 * The two are one function because they are one mistake with one remedy —
 * "there is no seed here to replace" — and one paragraph of reasoning, which is
 * the load-bearing half of this whole module:
 *
 * **Seeding is unconditional on every run.** `run-workflow.ts`'s seeding pass
 * has no "only if absent" guard; it writes every `Seed` it is handed, every
 * time. So an override on a key the workflow deliberately left unseeded does
 * not supply an initial value — it **RESETS that key on every run**, silently
 * destroying whatever a step accumulated across runs, with nothing in the
 * workflow document hinting that it happens. A workflow that wants an
 * externally-supplied value declares `seed:` with a default and lets the
 * workspace replace it, which keeps "this key is reset each run" visible where
 * the key is defined.
 *
 * Both documents are named, because the author is looking at two files and the
 * cause is in the one that did not declare the key.
 */
function describeUnseedableOverride(parameters: {
  key: string;
  entry: ResolvedStorageKey | undefined;
  overridePath: string;
  layer: SeedOverrideLayer;
  workflowName: string;
  workflowSource: string;
  seededKeyList: readonly string[];
}): string {
  const {
    key,
    entry,
    overridePath,
    layer,
    workflowName,
    workflowSource,
    seededKeyList,
  } = parameters;

  const rendered = JSON.stringify(key);

  const cause =
    entry === undefined
      ? `workflow ${JSON.stringify(workflowName)} does not declare that key at all`
      : `workflow ${JSON.stringify(workflowName)} declares that key but does not ` +
        `seed it`;

  const where =
    entry === undefined
      ? `Written at ${overridePath} in "${layer.source}"; the key appears nowhere ` +
        `in storage: in "${workflowSource}".`
      : `Written at ${overridePath} in "${layer.source}"; the key is declared at ` +
        `${entry.declaredAt.key} in "${workflowSource}", with no seed:.`;

  // A `seed:` field inside the key's own `storage.keys` entry, which is the
  // only place a seed is written. `declaredAt.key` and `keyPath` build the same
  // string for the same key, so the branch is about whether the entry exists
  // yet, not about where the field would go.
  const seedSite = `${entry?.declaredAt.key ?? keyPath('storage.keys', key)}.seed`;

  const remedy =
    entry === undefined
      ? `Declare the key in the workflow first and give it the value it should ` +
        `have when nothing overrides it — ${seedSite} — then this override ` +
        `replaces it.`
      : `Set ${seedSite} to the value the key should have when nothing ` +
        `overrides it, and this override replaces it.`;

  return (
    `Seed override for storage key ${rendered} has nothing to replace: ` +
    `${cause}.${DETAIL}` +
    `${where}${DETAIL}` +
    `An override REPLACES a seed the workflow already declares; it cannot ` +
    `introduce one. Seeding is unconditional on every run — the seeding pass ` +
    `writes every seed it is handed, every time — so an override on an unseeded ` +
    `key would not supply a starting value, it would RESET that key on every ` +
    `run, destroying whatever a step accumulated in it, with nothing in the ` +
    `workflow document saying so.${DETAIL}` +
    (seededKeyList.length === 0
      ? `Workflow ${JSON.stringify(workflowName)} seeds no key at all, so nothing ` +
        `in it can be overridden yet.${DETAIL}`
      : `Keys that workflow seeds: ` +
        `${seededKeyList.map((seeded) => JSON.stringify(seeded)).join(', ')}.${DETAIL}`) +
    remedy
  );
}

/**
 * The diagnostic for an override on a key another workflow owns.
 *
 * Doubly wrong, and it says so: a foreign key is not seedable *at all* —
 * `validateStorageKeyTable` refuses `workflow:` beside `seed:` by name
 * (`workflow/validation.ts`, `describeSeededForeignKey`) — so there is no seed
 * here for an override to replace and never can be. Reported separately from
 * {@link describeUnseedableOverride} rather than folded into its
 * "declared but unseeded" branch, because the remedy is completely different:
 * not "add a seed here", which is itself an error, but "override it in the
 * owning workflow's block".
 *
 * ## Why the remedy names the owner but cannot render its block path
 *
 * This is the asymmetry the module note states, met in the one place it costs
 * something. The owning workflow is named here by **name**, because that is
 * what `storage.keys.<key>.workflow` holds and a workflow document must not
 * depend on the workspace's directory layout; the block that would override it
 * is keyed by **path**, because that is what `workflowPathList` holds. This
 * function has the workflow document and not the workspace's, so it can name
 * the owner and describe the block precisely without inventing a path it has
 * no way to know. Saying "under the block for workflow X, keyed by X's path in
 * workflowPathList" is exact; guessing `./workflows/X.yaml` would be a field
 * the document may well not contain.
 */
function describeForeignKeyOverride(parameters: {
  key: string;
  entry: ResolvedStorageKey;
  overridePath: string;
  layer: SeedOverrideLayer;
  workflowName: string;
  workflowSource: string;
}): string {
  const { key, entry, overridePath, layer, workflowName, workflowSource } =
    parameters;

  // Both present by the caller's guard on `entry.workflow`
  // (`StorageKeyDeclaration`, `key-table.ts`).
  const owner = entry.workflow!;
  const ownerPath = entry.declaredAt.workflow!;

  return (
    `Seed override for storage key ${JSON.stringify(key)} cannot be applied: ` +
    `workflow ${JSON.stringify(workflowName)} declares that key to belong to ` +
    `workflow ${JSON.stringify(owner)}.${DETAIL}` +
    `Written at ${overridePath} in "${layer.source}"; ownership is declared at ` +
    `${ownerPath} in "${workflowSource}".${DETAIL}` +
    `This is refused twice over. A key another workflow owns is not seedable at ` +
    `all — a seed is a write to the running workflow's own store, so seeding a ` +
    `foreign key is already an error in the workflow document itself — and an ` +
    `override may only replace a seed that document declares. There is no value ` +
    `here to replace, and there is no way to write one.${DETAIL}` +
    `Override it where the box lives: under the workspace's seedOverrides: ` +
    `block for workflow ${JSON.stringify(owner)} — the block keyed by that ` +
    `workflow's path in workflowPathList — with ${JSON.stringify(key)} inside ` +
    `it, if that workflow declares a seed for that key.${DETAIL}` +
    `This document names the owner by NAME (a workflow must not depend on a ` +
    `workspace's directory layout) while the workspace keys its blocks by PATH ` +
    `(the identifier workflowPathList holds), so the owning block cannot be ` +
    `spelled out from this document alone.`
  );
}

/**
 * Re-validate one override value against the strategy the **workflow**
 * declares for the key, reusing the very checks the workflow's own seed goes
 * through.
 *
 * ## Why these checks are well defined here at all
 *
 * Because the strategy is **not overridable**. Every rule about a seed's shape
 * is a rule about its strategy — a list is mandatory exactly when
 * `descriptorFor(strategy).seedExpandsList` says one seed becomes N writes, the
 * element count is bounded by `seedCapacityOf(strategy)`, each value by
 * `strategy.valueSizeMax` — so a workspace that could also replace the strategy
 * would leave "is this value acceptable" with no fixed answer to give, and the
 * check would have to run against whatever the *merged* strategy turned out to
 * be. That is the payoff of the restriction stated at the top of this module,
 * and it is why this function can hand the workflow's own `strategy` and
 * `declaredAt.strategy` straight to the shared checks.
 *
 * ## Why the checks are the shared ones and not new ones
 *
 * {@link checkFifoSeedIsList}, {@link checkFifoSeedLength} and
 * {@link checkValueSize} are the same functions `validateStorageSizes` runs on
 * an authored seed, called with the same arguments except one: `subject`, which
 * names the override's field instead of the workflow's. So an override that
 * breaks a rule produces the *identical* sentence the workflow's own seed would
 * have produced, pointed at the document that actually holds the offending
 * value. A parallel implementation here would drift the first time either
 * message was reworded, and an author fixing two documents would be reading two
 * dialects of one rule.
 *
 * @returns One diagnostic per problem, empty when the value is acceptable.
 */
function collectOverrideShapeProblems(parameters: {
  value: unknown;
  strategy: BoxStrategy;
  overridePath: string;
  strategyLabel: string;
}): string[] {
  const { value, strategy, overridePath, strategyLabel } = parameters;

  const problemList: string[] = [];

  if (!descriptorFor(strategy).seedExpandsList) {
    // A cell: one seed, one stored value, measured whole — exactly
    // `validateStorageSizes`'s non-expanding branch.
    const problem = checkValueSize({
      value,
      strategy,
      subject: overridePath,
      strategyLabel,
    });
    if (problem) problemList.push(problem);
    return problemList;
  }

  const shapeProblem = checkFifoSeedIsList({
    value,
    strategy,
    subject: overridePath,
    strategyLabel,
  });
  if (shapeProblem) {
    // Nothing further is decidable: without the mandatory list there is no
    // element to measure and no count to check. Same short-circuit as
    // `validateStorageSizes`.
    problemList.push(shapeProblem);
    return problemList;
  }

  const entryList = value as readonly unknown[];

  // The `in` test is on the **shape**, not on `strategy.name`, for the reason
  // `validateStorageSizes` gives at its own call site: every queue strategy
  // passes it, and a future list-expanding strategy declaring no ceiling is
  // simply skipped with no name to add here.
  if ('queueSizeMax' in strategy) {
    const lengthProblem = checkFifoSeedLength({
      entryList,
      strategy,
      subject: overridePath,
      strategyLabel,
    });
    if (lengthProblem) problemList.push(lengthProblem);
  }

  entryList.forEach((element, elementIndex) => {
    const problem = checkValueSize({
      value: element,
      strategy,
      subject: `${overridePath}[${elementIndex}]`,
      strategyLabel,
      note:
        `Each element of an ${strategy.name} seed becomes one queue entry, ` +
        `so valueSizeMax bounds the element rather than the whole list.`,
    });
    if (problem) problemList.push(problem);
  });

  return problemList;
}

/**
 * Attach the provenance both documents need to a re-validation problem.
 *
 * The problem itself is left byte-for-byte as the shared check produced it —
 * its `subject` already names the override's own field — and the provenance is
 * appended. So the *rule* reads identically whether the value came from the
 * workflow or from the workspace, and the *cause* is unambiguous: the value is
 * the override's, the bound it broke is the workflow's. A message that named
 * only the workflow would blame a document for a value it did not write.
 */
function attributeToOverride(parameters: {
  problem: string;
  layer: SeedOverrideLayer;
  workflowName: string;
  workflowSource: string;
}): string {
  const { problem, layer, workflowName, workflowSource } = parameters;

  return (
    `${problem}${DETAIL}` +
    `That value is a seed override written in "${layer.source}", not the seed ` +
    `workflow ${JSON.stringify(workflowName)} declares in "${workflowSource}". ` +
    `An override replaces the value and nothing else: the strategy, and every ` +
    `bound quoted above, stay the workflow's.`
  );
}

/**
 * Rule 2's "last layer to name a key wins" reduction — the one place
 * precedence is decided, shared by {@link applySeedOverrides} (which also
 * needs the *value*, to validate and apply it) and
 * {@link summarizeAppliedSeedOverrides} (which needs only the *source*, to
 * report it). One implementation, so the two can never disagree about which
 * layer wins a given key — a second reduction beside this one is exactly the
 * drift risk `collectOverrideShapeProblems`'s own doc warns about for the
 * size checks, applied to the precedence rule instead.
 *
 * First-seen key order is preserved (`Map` insertion order), which is what
 * makes a workspace with several offending keys report them in the order they
 * were written.
 */
function reduceOverrideLayers(
  layerList: readonly SeedOverrideLayer[],
): Map<string, { value: unknown; layer: SeedOverrideLayer }> {
  const overrideByKey = new Map<string, { value: unknown; layer: SeedOverrideLayer }>();
  for (const layer of layerList) {
    for (const [key, value] of Object.entries(layer.valueRecord)) {
      overrideByKey.set(key, { value, layer });
    }
  }
  return overrideByKey;
}

/**
 * One override that ended up applied: the key, and the source layer that
 * supplied its winning value. No value — see {@link summarizeAppliedSeedOverrides}
 * for why reporting is deliberately shape-only.
 */
export interface SeedOverrideApplication {
  readonly key: string;
  readonly source: string;
}

/**
 * Every key any layer in `layerList` names, paired with the source that won
 * it — precedence resolved exactly as {@link applySeedOverrides} resolves it,
 * but with no re-validation run.
 *
 * ## Why this is safe to call without re-running the rules
 *
 * Meant to be called **after** {@link applySeedOverrides} has returned `ok`
 * for this exact `layerList`. An `ok` result means every key any layer names
 * passed every rule — foreign-key, unseeded-key and shape checks all fail the
 * *whole* call (`applySeedOverrides`'s `problemList` short-circuits to `err`
 * before producing a partial merge) — so there is no state in which some keys
 * in `layerList` were applied and others were not. That is what makes reading
 * the *input* layers back a correct description of what was *applied*,
 * without this function re-deriving `byKey`, `hasSeed` or any strategy check
 * of its own.
 *
 * ## Why this exists at all — the CLI's `--seed` is otherwise unreviewable
 *
 * A workspace's `seedOverrides:` block is at least a diff in a file under
 * version control; `--seed` on the command line is not — no file, no diff, no
 * `rawbox.lock` entry, and nothing in the run log unless something puts it
 * there. This is that something: `run-workflow.ts` calls it once every run to
 * build the `seed.override.applied` event (`events/event-types.ts`), and
 * `workflow verify` calls it to print the same information before a run ever
 * starts. Both read off the *same* `layerList` {@link applySeedOverrides} just
 * validated, so the report and the values a run actually writes cannot
 * diverge.
 *
 * ## Why no value
 *
 * A seed is arbitrary data — the same reason `seed:` has no long form, since
 * no wrapper could be told apart from an intended literal object — and the
 * NDJSON log this feeds is
 * a file on disk, read by `rawbox-cli runs` and routinely attached to bug
 * reports. The key name and its source layer are already enough to
 * reconstruct *which* run used *what override* and go look up the value at
 * its source (the workspace document, or the process's own argv/shell
 * history for `--seed` — which is also why the flag's `--help` text says not
 * to put a secret there in the first place: shell history is not a vault, and
 * `backends:` already interpolates `${ENV_VAR}` references for connection
 * credentials, so a workflow that genuinely needs a secret has a channel that
 * is not this one). Printing the value as well would make the log the
 * *second* place a value typed on a command line ends up persisted to disk,
 * which is a worse hazard than the one this function exists to close.
 */
export function summarizeAppliedSeedOverrides(
  layerList: readonly SeedOverrideLayer[],
): SeedOverrideApplication[] {
  const overrideByKey = reduceOverrideLayers(layerList);
  return Array.from(overrideByKey, ([key, { layer }]) => ({ key, source: layer.source }));
}

/**
 * Replace the seed values a workflow declares with the ones the layers supply,
 * producing the **merged** document every later stage reads.
 *
 * This is the one place seed overrides are applied. Seed validation
 * (`validateSeedData`, against the consuming step's `inputSchema`) and the
 * resolver's seed expansion (`resolveWorkflow`, which turns each `Seed` into
 * the writes `run-workflow.ts` performs) must both see the merged document
 * rather than the authored one — otherwise a run would type-check a value it
 * is not going to write, and write a value nothing checked.
 *
 * ## The three rules
 *
 * 1. **An override may only replace a seed the workflow already declares.**
 *    Overriding an undeclared key, a declared-but-unseeded key, or a key
 *    another workflow owns is an error naming the key, the workflow and both
 *    documents. See {@link describeUnseedableOverride} for why the unseeded
 *    case is a refusal rather than a convenience, and
 *    {@link describeForeignKeyOverride} for why the foreign case is refused
 *    twice over.
 * 2. **Replacement is whole, never a deep merge.** A seed is arbitrary data,
 *    so a merge cannot tell structure from content — the same reasoning that
 *    refuses `seed:` a long form, since no wrapper could be distinguished from
 *    an intended literal object. The last layer to name a key supplies that
 *    key's whole value.
 * 3. **Every replacement is re-validated against the strategy the workflow
 *    declares**, through the very checks the workflow's own seed goes through.
 *    See {@link collectOverrideShapeProblems}.
 *
 * ## Where the merged value is written back
 *
 * Into `storage.keys.<key>.seed`, the one place a seed is written. Rule 1
 * guarantees the field already exists, because an override can only replace a
 * seed that is already there — so this is a value substitution rather than a
 * declaration, and `declaredAt` (`key-table.ts`), which every downstream
 * diagnostic interpolates, keeps naming the field the author wrote.
 *
 * Nothing is mutated: the input `workflow` is returned **unchanged and
 * identical** when no layer supplies anything, so every path that has no
 * overrides behaves exactly as it did before this function existed.
 *
 * @param parameters.workflow - The parsed, schema-valid authoring document.
 * @param parameters.workflowSource - Path of the workflow document, named in
 *   diagnostics.
 * @param parameters.layerList - Override layers, **lowest precedence first**;
 *   a later layer replaces an earlier one key by key. Today the workspace
 *   supplies the only layer; the CLI's `--seed` flag becomes one appended after
 *   it, which is the whole of `CLI > workspace > workflow`.
 * @returns The merged document, or every problem the overrides caused as one
 *   multi-line diagnostic.
 */
export function applySeedOverrides(parameters: {
  workflow: Workflow;
  workflowSource: string;
  layerList: readonly SeedOverrideLayer[];
}): Result<Workflow, string> {
  const { workflow, workflowSource, layerList } = parameters;

  const overrideByKey = reduceOverrideLayers(layerList);

  if (overrideByKey.size === 0) {
    return ok(workflow);
  }

  // The one canonical view of what `storage:` says about a key
  // (`key-table.ts`). Every rule below is expressed against it rather than
  // walking `storage.keys` again, so "is this key seeded" has one answer here
  // and in every diagnostic that reports on the merged document.
  const { byKey } = resolveKeyTable(workflow.storage);

  const seededKeyList: string[] = [];
  for (const entry of byKey.values()) {
    if (entry.hasSeed) seededKeyList.push(entry.key);
  }

  const problemList: string[] = [];
  const replacementList: SeedReplacement[] = [];

  for (const [key, { value, layer }] of overrideByKey) {
    const overridePath = keyPath(layer.blockPath, key);
    const entry = byKey.get(key);

    // Foreign first, and it is not merely an ordering preference: a foreign key
    // can never carry a seed (`validateStorageKeyTable` refuses `workflow:`
    // beside `seed:`), so it always also fails the `hasSeed` test below — and
    // "this key is another workflow's" is the fact the author has to act on.
    if (entry !== undefined && entry.workflow !== undefined) {
      problemList.push(
        describeForeignKeyOverride({
          key,
          entry,
          overridePath,
          layer,
          workflowName: workflow.name,
          workflowSource,
        }),
      );
      continue;
    }

    if (entry === undefined || !entry.hasSeed) {
      problemList.push(
        describeUnseedableOverride({
          key,
          entry,
          overridePath,
          layer,
          workflowName: workflow.name,
          workflowSource,
          seededKeyList,
        }),
      );
      continue;
    }

    const shapeProblemList = collectOverrideShapeProblems({
      value,
      strategy: entry.strategy,
      overridePath,
      strategyLabel: entry.declaredAt.strategy,
    });

    if (shapeProblemList.length > 0) {
      for (const problem of shapeProblemList) {
        problemList.push(
          attributeToOverride({
            problem,
            layer,
            workflowName: workflow.name,
            workflowSource,
          }),
        );
      }
      continue;
    }

    replacementList.push({ key, value });
  }

  if (problemList.length > 0) {
    return err(
      `Seed override validation failed for workflow ` +
        `${JSON.stringify(workflow.name)} ("${workflowSource}"):\n` +
        problemList.map((problem) => `  - ${problem}`).join('\n'),
    );
  }

  return ok({
    ...workflow,
    storage: withReplacedSeeds(workflow.storage, replacementList),
  });
}

/**
 * A copy of `storage:` with each replacement written back into the `seed:`
 * field that already holds that key's value.
 *
 * Every replacement's entry exists and already owns a `seed` property, by rule
 * 1 — an override can only replace a seed the workflow declares, and
 * `applySeedOverrides` has rejected every key for which that is untrue before
 * reaching here. The entry is still spread rather than assumed to hold only a
 * seed, so a `strategy:` or `workflow:` beside it survives the substitution.
 *
 * `keys:` is re-attached only when the original block had it, because
 * `exactOptionalPropertyTypes` is on and an explicit `undefined` is a different
 * value from an absent field — and a block with no `keys:` reaches here only
 * with an empty `replacementList`, again by rule 1.
 */
function withReplacedSeeds(
  storage: Storage,
  replacementList: readonly SeedReplacement[],
): Storage {
  const keyEntryRecord: StorageKeyRecord = { ...(storage.keys ?? {}) };

  for (const { key, value } of replacementList) {
    keyEntryRecord[key] = { ...keyEntryRecord[key], seed: value };
  }

  return {
    ...storage,
    ...(storage.keys === undefined ? {} : { keys: keyEntryRecord }),
  };
}
