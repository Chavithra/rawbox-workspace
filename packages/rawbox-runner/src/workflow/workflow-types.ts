import { Type, type Static } from 'typebox';

import { BoxStrategy, StrictObject } from '@rawbox/store';

import { ResolvedStep, Step } from '../workflow/step-types.js';

// ---------------------------------------------------------------------------
// Workflow format — authoring model
//
// Defined over the *parsed data model*, so a workflow document is equally valid
// as YAML or as JSON.
// ---------------------------------------------------------------------------

/** Value of `formatVersion:` for this specification revision. */
export const FORMAT_VERSION = '1.0';

/** Document kinds recognised by the runner. */
export const DOCUMENT_KIND = {
  WORKFLOW: 'Workflow',
  WORKSPACE: 'Workspace',
} as const;

export const WorkflowKind = Type.Literal(DOCUMENT_KIND.WORKFLOW);
export type WorkflowKind = Static<typeof WorkflowKind>;

export const FormatVersion = Type.Literal(FORMAT_VERSION);
export type FormatVersion = Static<typeof FormatVersion>;

/**
 * `plugins:` — package name → npm dependency specifier, exactly the shape of
 * `dependencies` in a `package.json`. The specifier carries the source, so
 * there is no `source:` or `path:` field. Integrity hashes live in
 * `rawbox.lock`, never here.
 */
export const PluginSpecifierRecord = Type.Record(
  Type.String(),
  Type.String({ minLength: 1 }),
);
export type PluginSpecifierRecord = Static<typeof PluginSpecifierRecord>;

/**
 * One entry of `storage.keys` — **everything one key's declaration says, in one
 * place.**
 *
 *     keys:
 *       queue_items:
 *         strategy: { name: lmdb-fifo, queueSizeMax: 1024, valueSizeMax: 1900 }
 *         seed: [a, b, c]
 *
 * **Every field is optional, and an entry with none is legal.** It declares
 * the key — which then resolves to `storage.defaultStrategy` like any other —
 * and that is how an author names a key that only steps write. There is nothing
 * to reject: the entry adds the key to the table, which is what the budget and
 * the key-size rules sweep.
 *
 * ## This is the only way to declare a key
 *
 * Two earlier top-level maps, `storage.strategies` and `storage.seed`, stated
 * the first two facts one map per fact rather than one entry per key. They are
 * **removed**: understanding `queue_items` meant consulting two blocks, adding
 * a key meant editing two, and every per-key rule had to merge them. `Storage`
 * is a `StrictObject`, so a document still writing either is rejected — by name
 * and with the replacing `keys:` entry printed, via
 * `collectRemovedStorageBlockProblems` (`validation.ts`), which runs ahead of
 * the schema so the author gets the migration rather than "unknown property".
 *
 * The one thing the removal costs is the bare constant, which was two lines and
 * is now three:
 *
 *     seed:                        keys:
 *       sleep_ms: 500                sleep_ms:
 *                                      seed: 500
 *
 * There is no scalar shorthand inside `keys:` that recovers it, and there
 * cannot be: `sleep_ms: 500` under `keys:` would have to mean "the seed", which
 * then makes `sleep_ms: { name: 'x' }` ambiguous between a strategy block and a
 * literal object seed — precisely the ambiguity that denies `seed` a long form
 * in the first place. One idiom that is occasionally a line longer beats two
 * that a reader has to merge.
 *
 * `seed` is `Type.Unknown()` because a seed is **arbitrary data** whose *shape*
 * is strategy-dependent: a seed for an `lmdb-fifo` key MUST be a list, each
 * element becoming one queue entry, and that rule needs the key table to
 * evaluate, so it is enforced by `validateStorageSizes` and `resolveWorkflow`
 * rather than here. It is a *structural* rule, not a tagged wrapper —
 * `[[a, b, c]]` still seeds one entry holding the list. `StrictObject` is what
 * keeps a mistyped `stratergy:` from being read as a key that declares nothing.
 *
 * ## `workflow:` — whose box this is
 *
 * `minLength: 1` because an empty name names nothing: `buildBoxRecord` treats a
 * falsy `workflow` as absent and silently substitutes the current workflow,
 * which would turn "another workflow's box" into "mine" without a word being
 * said — the same reason `ReadStorageRef.workflow` carries the bound
 * (`step-types.ts`).
 *
 * Widening `BoxStrategy` to carry ownership instead was never an option: it
 * would put a workflow name into the resolved `WriteBoxLocation` too, which is
 * the one shape that must stay incapable of naming another workflow
 * (`@rawbox/store`, `box.ts`). Ownership is a property of the key, and this is
 * where a key's properties are stated.
 */
export const StorageKeyEntry = StrictObject({
  strategy: Type.Optional(BoxStrategy),
  seed: Type.Optional(Type.Unknown()),
  workflow: Type.Optional(Type.String({ minLength: 1 })),
});
export type StorageKeyEntry = Static<typeof StorageKeyEntry>;

/** `storage.keys` — storage key → everything declared about it. */
export const StorageKeyRecord = Type.Record(Type.String(), StorageKeyEntry);
export type StorageKeyRecord = Static<typeof StorageKeyRecord>;

/**
 * `storage:` — the strategy is a property of the key, not of the location, so
 * it is declared once and serves seeds and step locations identically.
 *
 * `keys:` is the **only** way to declare a key; see {@link StorageKeyEntry} for
 * the two blocks that were removed and why. `defaultStrategy` is not a
 * shorthand for anything — it is the strategy every key that declares none
 * resolves to — and is unaffected. `resolveKeyTable` (`key-table.ts`) is the one
 * place `keys:` is read, and it is what every per-key rule is expressed against.
 */
export const Storage = StrictObject({
  defaultStrategy: BoxStrategy,
  keys: Type.Optional(StorageKeyRecord),
});
export type Storage = Static<typeof Storage>;

/**
 * A workflow document, as authored.
 *
 * Identity is flat with `kind:` at the root: `metadata:` and `settings:` are
 * reserved, which is why additional top-level properties are rejected.
 */
export const Workflow = StrictObject({
  kind: WorkflowKind,
  formatVersion: FormatVersion,
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  plugins: PluginSpecifierRecord,
  storage: Storage,
  steps: Type.Array(Step),
});
export type Workflow = Static<typeof Workflow>;

// ---------------------------------------------------------------------------
// Resolved runtime model
//
// The output of `resolveWorkflow` and the input of the XState machine layer.
// The authoring format and the addressing model are deliberately separate
// concerns, so this shape is defined independently of `Workflow`.
//
// Closed like the authoring model, but as an invariant on what the resolver
// builds rather than as a guard on what an author wrote: no document parses
// into these. `Seed.value` stays `Type.Unknown()` — a seed is arbitrary data,
// and closing the object says nothing about what it holds.
// ---------------------------------------------------------------------------

/**
 * One seeded write: `run-workflow.ts` performs exactly one `putSync` per `Seed`,
 * under every strategy.
 *
 * `key` is therefore **not** unique across `seedData`. An `lmdb-fifo` seed is
 * expanded by the resolver into one `Seed` per list element, so a three-element
 * queue seed appears as three entries sharing a key, in enqueue order.
 */
export const Seed = StrictObject({
  key: Type.String(),
  strategy: BoxStrategy,
  value: Type.Unknown(),
});

export type Seed = Static<typeof Seed>;

/**
 * A workflow in resolved form: every step already carries its
 * `DefinitionLocation` and expanded box locations, and every seed already
 * carries the strategy resolved from the `storage:` key table.
 *
 * `pluginPathList` holds the plugin package names whose contract registries must
 * be loaded before execution.
 */
export const ResolvedWorkflow = StrictObject({
  name: Type.String(),
  pluginPathList: Type.Array(Type.String()),
  stepList: Type.Array(ResolvedStep),
  seedData: Type.Optional(Type.Array(Seed)),
});

export type ResolvedWorkflow = Static<typeof ResolvedWorkflow>;
