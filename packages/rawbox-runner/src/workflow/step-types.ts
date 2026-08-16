import { Type, type Static } from 'typebox';

import { Box, StrictObject, WriteBoxLocation, ReadBoxLocation } from '@rawbox/store';
import { Uint8Array } from './uint8array.js';
import { DefinitionLocation, TIMEOUT_MS_MAX } from '@rawbox/plugin/core';

export { DefinitionLocation };

/**
 * Re-exported rather than restated: the ceiling is a property of Node's timer
 * API, and a document's bound and a contract's bound are enforced by the same
 * `setTimeout`. A second literal here would be free to drift from the one the
 * SDK rejects against, which is exactly the divergence a shared constant
 * exists to prevent. See `Contract.timeoutMs` in `@rawbox/plugin/core` for why
 * the number is what it is.
 */
export { TIMEOUT_MS_MAX };

// ---------------------------------------------------------------------------
// Workflow format — authoring model
//
// These schemas describe the *parsed data model* of an authored step, so they
// hold identically for YAML and JSON sources. They are deliberately separate
// from the resolved runtime model further down.
// ---------------------------------------------------------------------------

export const CONTROL_FLOW_OPERATION_PREFIX = 'control-flow/';

/**
 * A single path segment of an `operation:` value. Deliberately excludes `/`,
 * so `..` traversal cannot be smuggled into the generated `definitionPath`.
 */
const OPERATION_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]*';

/** `time/sleep`, `control-flow/branch`, … */
export const OPERATION_PATH_PATTERN =
  `^${OPERATION_SEGMENT}(?:/${OPERATION_SEGMENT})*$`;

export const CONTROL_FLOW_OPERATION_PATTERN =
  `^control-flow/${OPERATION_SEGMENT}(?:/${OPERATION_SEGMENT})*$`;

export const NON_CONTROL_FLOW_OPERATION_PATTERN =
  `^(?!control-flow/)${OPERATION_SEGMENT}(?:/${OPERATION_SEGMENT})*$`;

/**
 * A package name declared as a key of the workflow's `plugins:` map.
 * Cross-referencing is an exact string match, checked by the resolver.
 */
export const PluginName = Type.String({ minLength: 1 });
export type PluginName = Static<typeof PluginName>;

/** An `operation:` value: resolves to `./<operation>.definition.js`. */
export const OperationPath = Type.String({ pattern: OPERATION_PATH_PATTERN });
export type OperationPath = Static<typeof OperationPath>;

/** A storage key. The shorthand form of an input/output/error binding. */
export const StorageKey = Type.String({ minLength: 1 });
export type StorageKey = Static<typeof StorageKey>;

/**
 * Long form of a **read** binding. `workflow:` makes it a cross-workflow read;
 * the strategy is *not* here — it comes from the key table
 * (`storage.keys[key].strategy ?? storage.defaultStrategy`).
 *
 * ## `workflow:` is also declarable on the key table, and both stay
 *
 * `storage.keys.<key>.workflow` says the same thing about the box rather than
 * about one read (`StorageKeyEntry`, `workflow-types.ts`). The key table is the
 * better home for it — ownership is a property of the box, so declared there
 * two steps structurally cannot disagree, and every rule that cares reads a
 * field instead of walking the step list — but this form is **kept**, for two
 * reasons:
 *
 *   - it is `formatVersion: "1.0"`, and removing it would break documents this
 *     runner promises to read;
 *   - it says something the key table cannot. A key table maps a key *name* to
 *     one owner, so two bindings reading the same name from two different
 *     workflows — `{ key: metrics, workflow: a }` and
 *     `{ key: metrics, workflow: b }`, two genuinely different boxes — is
 *     expressible here and nowhere else.
 *
 * What is refused is the two sites **disagreeing** about one key:
 * `validateStorageOwnership` (`validation.ts`) names both ends rather than
 * picking a winner, exactly as `validateStorageKeyTable` refuses a key split
 * across the two `storage:` idioms. Agreement is legal and is a restatement,
 * not a conflict.
 */
export const ReadStorageRef = StrictObject({
  key: StorageKey,
  workflow: Type.Optional(Type.String({ minLength: 1 })),
});
export type ReadStorageRef = Static<typeof ReadStorageRef>;

/**
 * Long form of a **write** binding. There is deliberately no `workflow:`: a
 * step may only write inside its own workflow, a boundary the schema keeps
 * structurally rather than by a check.
 *
 * The structural half is not the whole of the boundary any more. A key may now
 * declare its owner on the key table (`storage.keys.<key>.workflow`), and a
 * *shorthand* write binding — `outputs: { result: shared_state }` — is just a
 * key name, so nothing about the binding's shape reveals that the key is
 * another workflow's. That case is refused by name at verify time by
 * `validateStorageOwnership` (`validation.ts`); this schema, and
 * `WriteBoxLocation` behind it (`@rawbox/store`, `box.ts`), keep the resolved
 * model incapable of *expressing* the write even if the check were bypassed.
 */
export const WriteStorageRef = StrictObject({
  key: StorageKey,
});
export type WriteStorageRef = Static<typeof WriteStorageRef>;

/**
 * An `inputs:` value — shorthand key or long-form read.
 *
 * There is deliberately no inline-literal form. An inline form would buy a
 * jump target without a seed, at the cost of a second way for a value to reach
 * a handler, a second population of storage keys the author never wrote, and a
 * second place to type-check. Having none is what makes the key-scope rules and
 * the storage budget *complete* rather than approximate: with no synthesised
 * keys, every key a workflow writes is one the author typed. The known cost is
 * that a seeded key is writable by a later step's `outputs:`, where a key behind
 * an inline literal would be writable by nothing — accepted, since one
 * addressing rule for every binding is worth more than an unwritable corner of
 * the key space. `{ value: … }` is rejected with a migration
 * diagnostic by `validateWorkflowType`, which names the step, the field, and
 * the seed plus key that replace it.
 */
export const InputRef = Type.Union([StorageKey, ReadStorageRef]);
export type InputRef = Static<typeof InputRef>;

/** An `outputs:` value — shorthand key or long-form write. */
export const OutputRef = Type.Union([StorageKey, WriteStorageRef]);
export type OutputRef = Static<typeof OutputRef>;

/** An `errors:` value — same shape as an output. */
export const ErrorRef = Type.Union([StorageKey, WriteStorageRef]);
export type ErrorRef = Static<typeof ErrorRef>;

export const InputRefRecord = Type.Record(Type.String(), InputRef);
export type InputRefRecord = Static<typeof InputRefRecord>;

export const OutputRefRecord = Type.Record(Type.String(), OutputRef);
export type OutputRefRecord = Static<typeof OutputRefRecord>;

export const ErrorRefRecord = Type.Record(Type.String(), ErrorRef);
export type ErrorRefRecord = Static<typeof ErrorRefRecord>;

/**
 * The literal that spells "this step is deliberately not bounded".
 *
 * A document needs a *word* for it where a contract needs only absence: on a
 * step, `timeoutMs` composes by override
 * (`step.timeoutMs ?? contract.timeoutMs ?? unbounded`), so omitting the key
 * already means "whatever the contract says" and cannot also mean "no bound".
 * Removing a bound the contract declares is a thing an author must be able to
 * write down — a feed operation that blocks until the next tick is its
 * workflow's pacing mechanism, and a bound inherited onto it turns a working
 * document into a crashing one.
 */
export const UNBOUNDED_TIMEOUT = 'unbounded';

/**
 * A step's `timeoutMs:` as an author may write it: a positive whole number of
 * milliseconds, or the literal `unbounded`.
 *
 * The two rejected spellings are rejected on purpose, and both of them are
 * spellings a reasonable author reaches for first:
 *
 * - **`null`** — because YAML parses a bare `timeoutMs:` with nothing after it
 *   as `null`. If `null` meant "no bound", an interrupted edit would silently
 *   mean the opposite of a bound rather than failing.
 * - **`0`** — because it reads as "no limit" in the C tradition and as "fire
 *   immediately" to `setTimeout`, and because a bound is frequently computed
 *   (`attempts * interval`), where a `0` is arithmetic that went wrong. Under
 *   `minimum: 1` that is a stopped document instead of a discarded safety
 *   bound.
 *
 * `maximum` is {@link TIMEOUT_MS_MAX}: past it Node clamps the delay to 1ms
 * with a `TimeoutOverflowWarning`, so a larger number does not widen the bound,
 * it inverts it.
 *
 * The union produces the branch-dump diagnostic this format works hard to avoid
 * whenever it fails, so `collectTimeoutSpellingProblems` in `validation.ts`
 * runs *before* the schema and answers with the spelling to write instead.
 */
export const StepTimeout = Type.Union([
  Type.Integer({ minimum: 1, maximum: TIMEOUT_MS_MAX }),
  Type.Literal(UNBOUNDED_TIMEOUT),
]);
export type StepTimeout = Static<typeof StepTimeout>;

const stepCommonProperties = {
  label: Type.Optional(Type.String({ minLength: 1 })),
  plugin: PluginName,
  inputs: Type.Optional(InputRefRecord),
  errors: Type.Optional(ErrorRefRecord),
  /**
   * Common to both variants rather than a property of `OperationStep`, and that
   * placement is load-bearing. `Step` is a union discriminated by the
   * `control-flow/` path prefix, so a field on one arm only is not "ignored" on
   * the other — it fails that arm, fails the union, and reports itself as a
   * dump of every branch that did not match, naming neither the field nor the
   * step. A bound on a control-flow step is a *questionable* document, not an
   * unparseable one; `collectTimeoutWarnings` says so in words.
   */
  timeoutMs: Type.Optional(StepTimeout),
};

/** A regular operation step: `inputs:`, `outputs:`, `errors:`. */
export const OperationStep = StrictObject({
  ...stepCommonProperties,
  operation: Type.String({ pattern: NON_CONTROL_FLOW_OPERATION_PATTERN }),
  outputs: Type.Optional(OutputRefRecord),
});
export type OperationStep = Static<typeof OperationStep>;

/**
 * A control-flow step. Control-flow contracts declare no `outputSchema` — they
 * return `{ label }`, which steers execution — so `outputs:` is rejected here
 * at the schema level rather than surfacing at runtime.
 */
export const ControlFlowStep = StrictObject({
  ...stepCommonProperties,
  operation: Type.String({ pattern: CONTROL_FLOW_OPERATION_PATTERN }),
  outputs: Type.Optional(Type.Never()),
});
export type ControlFlowStep = Static<typeof ControlFlowStep>;

/**
 * An authored step. The two variants are discriminated by the `control-flow/`
 * prefix of `operation:`, which is the only signal available before the
 * plugin's contract registry is loaded. The resolver re-checks the asymmetry
 * against the contract's real `type` once the registry is in hand.
 */
export const Step = Type.Union([OperationStep, ControlFlowStep]);
export type Step = Static<typeof Step>;

// ---------------------------------------------------------------------------
// Resolved runtime model
//
// What `resolveWorkflow` emits and what the XState machine layer consumes: the
// `(contractRegistryHash, definitionPath)` addressing pair plus fully expanded
// box locations. Deliberately independent of the authoring model.
//
// Closed like the authoring model above, but for a weaker reason: nothing
// parses a document into these, so strictness here is an invariant on the
// resolver's own output rather than a guard on what a user wrote. The three
// records stay open — their keys are the contract's field names.
// ---------------------------------------------------------------------------

export const StorageLocation = StrictObject({
  error: Type.Record(Type.String(), WriteBoxLocation),
  input: Type.Record(Type.String(), ReadBoxLocation),
  output: Type.Record(Type.String(), WriteBoxLocation),
});
export type StorageLocation = Static<typeof StorageLocation>;

export const ResolvedStep = StrictObject({
  definitionLocation: DefinitionLocation,
  storageLocation: StorageLocation,
  label: Type.Optional(Type.String()),
  /**
   * The step's effective bound, in milliseconds — **two states, not three**.
   * Present means bounded by this many milliseconds; absent means unbounded.
   *
   * `unbounded` is an *authoring* spelling and must not survive resolution: it
   * exists only because a step's `timeoutMs:` overrides its contract's, so a
   * document needs a word for "remove the inherited bound". Once the override
   * has been applied there is nothing left for a third state to say, and
   * carrying one forward would oblige every future reader of this field to
   * handle `'unbounded'` and `undefined` as separate cases that mean the same
   * thing. The resolver therefore drops the key rather than emitting the word —
   * see the conditional spread in `resolveWorkflow`, which `label` uses for the
   * `exactOptionalPropertyTypes` reason.
   */
  timeoutMs: Type.Optional(
    Type.Integer({ minimum: 1, maximum: TIMEOUT_MS_MAX }),
  ),
});

export type ResolvedStep = Static<typeof ResolvedStep>;

export const BoxRecord = Type.Record(Type.String(), Box(Uint8Array()));
export type BoxRecord = Static<typeof BoxRecord>;
