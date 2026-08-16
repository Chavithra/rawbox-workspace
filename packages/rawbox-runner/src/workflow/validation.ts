import { ok, err, type Result } from 'neverthrow';
import { Compile } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';

import type { ContractRegistryCache } from '@rawbox/plugin/core';
import {
  BoxStrategy,
  RAWBOX_KEY_SIZE_MAX,
  descriptorFor,
  measureKeySize,
  measureValueSize,
  seedCapacityOf,
  storeIdentityOf,
  type StoreIdentity,
} from '@rawbox/store';

import {
  DOCUMENT_KIND,
  FORMAT_VERSION,
  ResolvedWorkflow,
  type Storage,
  Workflow,
} from './workflow-types.js';
import {
  keyPath,
  resolveKeyOwnerMap,
  resolveKeyTable,
  type ResolvedStorageKey,
} from './key-table.js';
import { TIMEOUT_MS_MAX, UNBOUNDED_TIMEOUT } from './step-types.js';

// ---------------------------------------------------------------------------
// Compiled validators
//
// `Workflow` is the *authoring* model — what a `.yaml`/`.json` file parses
// into. `ResolvedWorkflow` is the runtime model the XState layer consumes.
// They are different schemas on purpose, so each gets its own entry point
// below.
// ---------------------------------------------------------------------------

const workflowValidator = Compile(Workflow);
const resolvedWorkflowValidator = Compile(ResolvedWorkflow);

/** Placeholder used when the caller does not supply the document's path. */
const UNKNOWN_SOURCE = '<file>';

const VALID_KIND_LIST = Object.values(DOCUMENT_KIND);

/** Longest rendering of an offending value before it is elided. */
const RECEIVED_VALUE_MAX = 60;

/**
 * The value one error points at, resolved from the document by the JSON
 * pointer TypeBox reports as `instancePath`.
 *
 * A `TValidationError` carries `keyword`, `instancePath`, `schemaPath` and
 * `params` — and deliberately not the value itself. So a diagnostic that wants
 * to quote what was actually written has to go and get it, which is what this
 * does. Returns `undefined` for a path that resolves to nothing, which is the
 * normal case for a missing required property.
 */
function valueAtInstancePath(document: unknown, instancePath: string): unknown {
  if (instancePath === '') {
    return document;
  }

  let current: unknown = document;
  for (const rawSegment of instancePath.slice(1).split('/')) {
    // JSON Pointer escaping: `~1` is `/`, `~0` is `~`, in that order.
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      current = current[Number(segment)];
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * ` (received …)`, naming what the document actually holds — or `''` when
 * there is nothing worth quoting.
 *
 * Only **primitives** are quoted. On a wrong-type error the useful fact is the
 * scalar the author typed (`"50mb"` where an integer belongs, `0` under a
 * minimum); an object or an array is named by kind rather than dumped, because
 * the error at that path is about the container's shape and the container may
 * be the whole document. A `required` error resolves to `undefined` and so
 * quotes nothing, which is right: the value it is about was never written.
 */
function receivedDetail(document: unknown, error: TLocalizedValidationError): string {
  if (error.keyword === 'additionalProperties') {
    return '';
  }

  const value = valueAtInstancePath(document, error.instancePath);

  if (value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return ' (received an array)';
  }
  if (typeof value === 'object' && value !== null) {
    return ' (received an object)';
  }

  const rendered = JSON.stringify(value) ?? String(value);
  const shown =
    rendered.length > RECEIVED_VALUE_MAX
      ? `${rendered.slice(0, RECEIVED_VALUE_MAX)}…`
      : rendered;
  return ` (received ${shown})`;
}

/**
 * Render one schema error as a line an author can act on.
 *
 * TypeBox's own message for a closed object is "must not have additional
 * properties", at the *object's* path — so on a root-level stray field it reads
 * `Path: "" : must not have additional properties`, naming neither the field nor
 * anything else. A diagnostic has to name the field that is wrong, so the
 * offending property names are appended here. Every schema in the format is
 * closed, which makes this the most common schema error there is rather than an
 * edge case.
 *
 * With `document` in hand the line also names the **value**, so the three facts
 * an author needs — where, what they wrote, what was expected — are all on it:
 * `Path: "/logs/rotate/maxBytes" : must be integer (received "50mb")`.
 */
function formatValidationError(
  error: TLocalizedValidationError,
  document?: unknown,
): string {
  const detail =
    error.keyword === 'additionalProperties'
      ? `: ${error.params.additionalProperties.map((property) => `"${property}"`).join(', ')}`
      : document === undefined
        ? ''
        : receivedDetail(document, error);

  return `  - Path: "${error.instancePath}" : ${error.message}${detail}`;
}

/**
 * The schema-error block shared by every entry point that validates a document
 * against a compiled schema — workflow, resolved workflow and workspace — so
 * they cannot drift into reporting the same failure three different ways.
 *
 * @param errorList - What the compiled validator's `Errors()` yielded.
 * @param document - The value that was validated. Optional only so a caller
 *   that no longer has it can still render; every caller in this repo passes
 *   it, because without it a line can say what was expected but not what was
 *   written — and "must be integer" alone sends an author back to the file to
 *   find out which of the two numbers they mistyped.
 */
export function formatValidationErrors(
  errorList: Iterable<TLocalizedValidationError>,
  document?: unknown,
): string {
  return Array.from(errorList)
    .map((error) => formatValidationError(error, document))
    .join('\n');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Storage size budget
//
// A `storage:` block declares, per key, how many bytes one stored value may
// occupy (`valueSizeMax`). A seed value is known at authoring time, so a value
// that cannot be stored is a *document* error and belongs here rather than in
// the store's `put` guard, where it would surface as a runtime surprise partway
// through a run.
//
// `queueSizeMax` bounds a seed and nothing else. Nothing static bounds how many
// entries a queue accumulates once steps start writing to it, but a seed's
// entry count *is* static: an `lmdb-fifo` seed MUST be a list and each element
// becomes one queue entry, so the list length is checkable against the ring's
// usable capacity, `queueSizeMax - 1`.
//
// Every key resolves its strategy by the format's one rule,
// `keys[key].strategy ?? defaultStrategy`, so seeds and step bindings are both
// measured against the same table.
//
// Diagnostics here name the field that is wrong and give the value that would
// be right. "Value too large" without the key and both numbers is not good
// enough — verification is run in a loop by an author (frequently an AI
// assistant) iterating until the document is correct.
// See FORMAT.md, "Validation".
// ---------------------------------------------------------------------------

/** Continuation indent for the extra lines of one diagnostic. */
const DETAIL = '\n    ';

/**
 * The whole character set a storage key may draw on: ASCII letters, digits,
 * underscore, dot and hyphen — at least one of them, so
 * the empty key is excluded by the same expression.
 */
export const RAWBOX_KEY_CHARACTER_SET = /^[A-Za-z0-9_.-]+$/;

/** The same set as a single character, used to point at what offends. */
const KEY_CHARACTER = /[A-Za-z0-9_.-]/;

/**
 * Re-exported from `key-table.ts`, which is where it now lives: every
 * `declaredAt` path the key table builds goes through it, and a diagnostic that
 * quoted a key differently from the table would name a second spelling of one
 * field. Re-exported rather than moved-and-forgotten so that the resolver and
 * `@rawbox/runner`'s public surface keep importing the name they already do.
 */
export { keyPath };

/**
 * Measure one value against the `valueSizeMax` of the strategy that will store
 * it, returning an author-facing diagnostic or `undefined`.
 *
 * Exported for the same reason {@link checkFifoSeedIsList} is: a *second* layer
 * now measures a seed value the document did not write — a workspace's
 * `seedOverrides:` block (`workspace/seed-overrides.ts`) — and it must produce
 * the identical sentence this one does, differing only in the `subject` that
 * names where the value came from. A parallel implementation there would drift
 * the first time either message was reworded.
 *
 * `measureValueSize` is called without a database on purpose. Static validation
 * has no environment open, and the standalone `Packr` it falls back to produces
 * byte-identical lengths to the live one (verified across a 23-shape corpus),
 * so the number reported here is the number the store will enforce.
 *
 * @param subject       how the value is named in the diagnostic, e.g.
 *                      `storage.keys.ticker.seed`. It becomes the sentence
 *                      subject, so it must read as a noun phrase.
 * @param strategyLabel document path of the strategy, from
 *                      `ResolvedStorageKey.declaredAt.strategy`.
 * @param note          optional sentence explaining *why* this limit applies to
 *                      this value, inserted before the remedy.
 */
export function checkValueSize(parameters: {
  value: unknown;
  strategy: BoxStrategy;
  subject: string;
  strategyLabel: string;
  note?: string;
}): string | undefined {
  const { value, strategy, subject, strategyLabel, note } = parameters;

  const measured = measureValueSize(value);

  if (measured.isErr()) {
    return (
      `${subject} cannot be stored: ${measured.error}.${DETAIL}` +
      `msgpack encoding fails on cycles, out-of-range BigInt and Symbol. ` +
      `Replace the value with one that encodes.`
    );
  }

  const size = measured.value;
  if (size <= strategy.valueSizeMax) {
    return undefined;
  }

  return (
    `${subject} is ${size} bytes when msgpack-encoded, which exceeds the ` +
    `valueSizeMax of ${strategy.valueSizeMax} declared at ${strategyLabel} ` +
    `(name: ${strategy.name}).` +
    (note ? `${DETAIL}${note}` : '') +
    `${DETAIL}Raise ${strategyLabel}.valueSizeMax to at least ${size}, ` +
    `or store a smaller value.`
  );
}

// ---------------------------------------------------------------------------
// The mandatory-list rule for `lmdb-fifo` seeds
//
// A key's strategy already decides what every operation on it *means*: `put`
// overwrites on `lmdb-kv` and enqueues on `lmdb-fifo`; `get` reads on the one
// and dequeues on the other. Seeding follows the same rule — a seed for an
// `lmdb-fifo` key is the queue's initial contents, one entry per element.
//
// Requiring the list removes an anomaly and buys a checkable invariant.
// Without it, seeding would be the single operation where the two strategies
// behaved identically — a key's declared strategy changing the meaning of
// every write in the workflow *except the first one*. And accepting either
// shape is the option that cannot be checked: any value would be valid, so an
// author who believed they were seeding three entries would get one, silently,
// with no diagnostic at any point. `queue_items: 5` is instead a loud error
// naming the key and the strategy that makes it wrong.
//
// Nesting keeps every value expressible, so no reserved wrapper is needed:
// `[[a, b, c]]` says "one entry holding a list" using the data model itself.
// ---------------------------------------------------------------------------

/** How a rejected seed value is named in the mandatory-list diagnostic. */
function describeValueKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'object':
      return 'a map';
    case 'undefined':
      return 'undefined';
    default:
      return `a ${typeof value}`;
  }
}

/**
 * Renders `value` wrapped in a single-element list, so the diagnostic can show
 * the author the exact text that would be right. Returns `undefined` when
 * the value does not render — cycles, `BigInt`, `Symbol` — in which case the
 * caller falls back to prose.
 */
function renderAsSingletonList(value: unknown): string | undefined {
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? '';
  } catch {
    return undefined;
  }
  if (rendered === '' || rendered.length > 60) return undefined;
  return `[${rendered}]`;
}

/**
 * Enforce the mandatory-list rule: a seed for an `lmdb-fifo` key MUST be a
 * list, because each element becomes one queue entry.
 *
 * Returns an author-facing diagnostic, or `undefined` when the value is
 * acceptable (which includes every seed for a non-FIFO key — the rule is
 * strategy-dependent, so this is a no-op on `lmdb-kv`).
 *
 * Exported because two layers need the identical sentence: `validateStorageSizes`
 * runs on the authored document at verify time, and `resolveWorkflow` needs the
 * same guard before it can expand a FIFO seed into one `Seed` per element. The
 * resolver's copy is defensive rather than expected — every production entry
 * point validates the document first — but `resolveWorkflow` is exported and
 * pure, so it must not depend on having been called in order.
 *
 * @param subject       how the value is named in the diagnostic, e.g.
 *                      `storage.keys.queue_items.seed`.
 * @param strategyLabel document path of the strategy, from
 *                      `ResolvedStorageKey.declaredAt.strategy`.
 */
export function checkFifoSeedIsList(parameters: {
  value: unknown;
  strategy: BoxStrategy;
  subject: string;
  strategyLabel: string;
}): string | undefined {
  const { value, strategy, subject, strategyLabel } = parameters;

  // The mandatory-list rule applies to any strategy whose seed expands into
  // N writes, not specifically to `lmdb-fifo` — the descriptor states that
  // once (`descriptorFor(strategy).seedExpandsList`,
  // `strategy/descriptor.ts`) so this stays correct for a future
  // list-expanding strategy without a second name check here.
  if (!descriptorFor(strategy).seedExpandsList || Array.isArray(value)) {
    return undefined;
  }

  const singleton = renderAsSingletonList(value);

  return (
    `${subject} is ${describeValueKind(value)}, but its strategy is ` +
    `${strategy.name} (declared at ${strategyLabel}), and a seed for an ` +
    `${strategy.name} key MUST be a list: each element becomes one queue ` +
    `entry.${DETAIL}` +
    (singleton
      ? `Write ${singleton} to seed a single entry holding that value, `
      : `Wrap the value in a list to seed a single entry holding it, `) +
    `[] to seed an empty queue, or list the entries to enqueue.`
  );
}

/**
 * Any strategy that declares a `queueSizeMax` — today `lmdb-fifo` and
 * `redis-fifo`, tomorrow whatever else does.
 *
 * Structural rather than a list of names, so the set is read off the schema
 * union exactly like `STRATEGY_SHAPE_LIST` reads the field tables off
 * `BoxStrategy.anyOf`. A queue strategy added to the union joins this type
 * without an edit here, and a strategy that declares no ceiling cannot
 * accidentally be handed to a diagnostic that quotes one.
 */
export type QueueCeilingStrategy = Extract<BoxStrategy, { queueSizeMax: number }>;

/**
 * Check how many entries a queue seed enqueues against the capacity its
 * strategy declares.
 *
 * **None of the arithmetic is this function's.** The capacity comes from
 * {@link seedCapacityOf}, which reads the strategy's own row in the registry
 * (`@rawbox/store`'s `strategy/descriptor.ts`), so this cannot drift from what
 * the store itself will hold. That indirection is not tidiness — the two queue
 * strategies genuinely disagree: `lmdb-fifo`'s ring keeps one slot permanently
 * free so `head === tail` can mean *empty* rather than *full*, so a declared
 * `queueSizeMax` of N holds N-1; `redis-fifo`'s native list has no cursors to
 * disambiguate, so N holds N. A `- 1` written here would have been right for
 * the first queue strategy and wrong for the second, refusing a legal
 * full-capacity seed and telling the author to raise a ceiling that already
 * fit.
 *
 * **The prose is not this function's either, and that is the subtler half.**
 * The message used to end on "one slot is permanently reserved to distinguish a
 * full queue from an empty one" as a literal, which was true while `lmdb-fifo`
 * was the only queue and became false the day `redis-fifo` joined — a verifier
 * asserting, inside the author's own diagnostic, a property their queue does
 * not have. So the explanation is now
 * {@link StrategyDescriptor.seedCapacityNote}, declared by the strategy it
 * describes and absent from the strategy with nothing to explain. Both the
 * clause and the "raise it to at least N" figure are then derived from the one
 * quantity that decides both — `queueSizeMax - capacity`, the shortfall — so
 * the sentence and the number cannot disagree with each other or with the
 * registry. `lmdb-fifo`'s wording is byte-for-byte what it always was, which
 * `tests/validation.test.ts` (T12) pins.
 *
 * The parameter is narrowed to {@link QueueCeilingStrategy} rather than widened
 * to the bare `BoxStrategy` union because the message quotes
 * `strategy.queueSizeMax`, and reaching that field needs a strategy that has
 * one. `validateStorageSizes` narrows with an `in` test, once — on the *shape*,
 * not on `strategy.name`, so no strategy is named at that call site either.
 *
 * Exported alongside {@link checkFifoSeedIsList} and {@link checkValueSize},
 * and for the same reason: `workspace/seed-overrides.ts` measures a replacement
 * seed against the strategy the workflow declared, and must produce this exact
 * sentence rather than a second wording of the same rule.
 */
export function checkFifoSeedLength(parameters: {
  entryList: readonly unknown[];
  strategy: QueueCeilingStrategy;
  subject: string;
  strategyLabel: string;
}): string | undefined {
  const { entryList, strategy, subject, strategyLabel } = parameters;

  const capacity = seedCapacityOf(strategy);

  // Both queue rows always define `seedCapacity` (`strategy/descriptor.ts`), so
  // this is unreachable for the strategies this function is narrowed to. The
  // check exists because `seedCapacityOf`'s return type is `number | undefined`
  // for any `BoxStrategy` — it does not (and cannot) know it was handed one of
  // the strategies that always answers — not because a queue might really have
  // no capacity.
  if (capacity === undefined || entryList.length <= capacity) {
    return undefined;
  }

  // How many of the declared entries the author does not get to use: 1 for
  // `lmdb-fifo`'s reserved slot, 0 for `redis-fifo`. It decides the ceiling the
  // remedy asks for, so a strategy that reserves nothing is told to raise
  // `queueSizeMax` to exactly the element count rather than one past it.
  const shortfall = strategy.queueSizeMax - capacity;

  // Present exactly when there IS a shortfall — the invariant asserted per row
  // in `@rawbox/store`'s `tests/strategy-descriptor.test.ts`. A strategy whose
  // capacity is its ceiling has nothing to explain, and the sentence simply
  // ends after the number.
  const capacityNote = descriptorFor(strategy).seedCapacityNote;

  const entryWord = capacity === 1 ? 'entry' : 'entries';

  return (
    `${subject} has ${entryList.length} elements, and each element becomes one ` +
    `queue entry, but the queue declared at ${strategyLabel} holds ${capacity} ` +
    `${entryWord} — its queueSizeMax is ${strategy.queueSizeMax}` +
    `${capacityNote === undefined ? '' : `, and ${capacityNote}`}.${DETAIL}` +
    `Raise ${strategyLabel}.queueSizeMax to at least ` +
    `${entryList.length + shortfall}, or seed at most ${capacity} ${entryWord}.`
  );
}

/**
 * Check a storage key against Rawbox's key-size contract,
 * {@link RAWBOX_KEY_SIZE_MAX} (79 bytes, UTF-8).
 *
 * **The measured quantity is the author's key, and nothing derived from it**,
 * so the cutoff is one fixed number rather than one that moves with the
 * strategy and with `queueSizeMax`. No `strategy` reaches this function, which
 * makes a strategy-dependent cutoff not merely absent but unreachable.
 * Bounding the *derived* key instead would move the cutoff with the strategy —
 * 1978 under `lmdb-kv`, 1964 at `queueSizeMax: 1000`, less again for a bigger
 * queue — and one number that never moves is what a format rule can be written
 * down as. `@rawbox/store`'s {@link RAWBOX_KEY_SIZE_MAX} carries the full
 * argument for the figure, including the backend limits it clears.
 *
 * **The limit is Rawbox's, not LMDB's**, so the diagnostic must not send an
 * author looking for an LMDB setting to change — there is none, and under this
 * contract LMDB is nowhere near binding anyway. `LMDB_KEY_SIZE_MAX_DEFAULT` and
 * the store's write-time guard survive as a backend backstop expected never to
 * fire (`box-store-lmdb.ts`): 79 plus the worst derivation still clears it.
 *
 * The message names the key, its length and the limit, and deliberately says
 * nothing about derived keys or prefix overhead, which under this rule are not
 * the author's concern.
 *
 * **Every key it measures was written by the author**, in `storage.keys` or in
 * a step binding, so shortening one is always a one-line edit to their own
 * document and the remedy can say so without qualification. That is a property of the format rather than of this
 * function: every storage key a workflow writes is named in the document.
 */
export function checkKeySize(parameters: {
  key: string;
  keyLabel: string;
}): string | undefined {
  const { key, keyLabel } = parameters;

  const keySize = measureKeySize(key);

  if (keySize <= RAWBOX_KEY_SIZE_MAX) {
    return undefined;
  }

  return (
    `${keyLabel} is ${keySize} bytes long, which exceeds Rawbox's maximum ` +
    `storage key size of ${RAWBOX_KEY_SIZE_MAX} bytes.${DETAIL}` +
    `Shorten the key to at most ${RAWBOX_KEY_SIZE_MAX} bytes.${DETAIL}` +
    `The limit is Rawbox's own, not the storage backend's, and is the same for ` +
    `every strategy: it is a portability contract, so that a key written today ` +
    `is one every supported backend can hold. It is not configurable.`
  );
}

/**
 * The characters of `key` that fall outside {@link RAWBOX_KEY_CHARACTER_SET},
 * deduplicated and in first-appearance order, each rendered so that a space, a
 * tab or a control character is visible in the diagnostic rather than invisible
 * in it.
 */
function describeIllegalKeyCharacters(key: string): string {
  const seen = new Set<string>();

  for (const character of key) {
    if (KEY_CHARACTER.test(character)) continue;
    seen.add(JSON.stringify(character));
  }

  return Array.from(seen).join(', ');
}

/**
 * Check a storage key against Rawbox's key **character set**,
 * {@link RAWBOX_KEY_CHARACTER_SET} — `[A-Za-z0-9_.-]+`.
 *
 * **The point is portability, not tidiness.** The 79-byte rule above bounds how
 * *long* a key is; length alone does not make a key usable as a filename, a
 * path segment or a column value. `/` separates path components on every
 * filesystem; NUL terminates a C string; whitespace is mangled by shells, by
 * CSV and by anything that splits on it; and two Unicode spellings of one word
 * are two distinct keys unless something normalises them, so a non-NFC key is
 * a key that can silently fail to match itself. The set admits none of them.
 *
 * `:` is excluded for a reason particular to this store: it is the separator
 * in the `lmdb-fifo` derivation `fifo:<key>:data:<n>`. Nothing would actually
 * break if it were admitted — that derivation is built, never parsed — but an
 * author key containing one produces stored keys that read as though they had
 * a structure they do not have, and a key is a thing people read.
 *
 * **The set permits both cases**, so `Foo` and `foo` are two distinct Rawbox
 * keys that a case-insensitive filesystem (macOS, Windows) would collide. That
 * is a known residual gap in the portability contract rather than an oversight.
 *
 * Like {@link checkKeySize}, the limit is Rawbox's own and is not configurable,
 * and every key it measures was typed by the author, so the remedy is always a
 * one-line rename of their own document.
 */
export function checkKeyCharacterSet(parameters: {
  key: string;
  keyLabel: string;
}): string | undefined {
  const { key, keyLabel } = parameters;

  if (RAWBOX_KEY_CHARACTER_SET.test(key)) {
    return undefined;
  }

  const offending = describeIllegalKeyCharacters(key);

  return (
    (key.length === 0
      ? `${keyLabel} is empty.`
      : `${keyLabel} contains ${offending}, which a storage key may not.`) +
    `${DETAIL}A storage key MUST match [A-Za-z0-9_.-]+ — one or more ASCII ` +
    `letters, digits, underscores, dots or hyphens, and nothing else.${DETAIL}` +
    `${key.length === 0 ? 'Name the key' : 'Rename the key'} using only those ` +
    `characters.${DETAIL}` +
    `The set is Rawbox's own portability contract, not the storage backend's, ` +
    `and it is not configurable: a key may have to serve as a filename, a path ` +
    `segment or a column value, so "/", NUL, whitespace and non-NFC Unicode are ` +
    `excluded. ":" is excluded because it separates the parts of the lmdb-fifo ` +
    `derivation fifo:<key>:data:<n>.`
  );
}

// ---------------------------------------------------------------------------
// Step bindings as a source of storage keys
//
// A key named in a step binding and absent from `storage.keys` is entirely
// legal: the format resolves it through `keys[key].strategy ?? defaultStrategy`
// like any other, and the runtime writes it. Sweeping those keys is what keeps
// two things honest —
//
//   - the budget, which without them under-counts structurally rather than
//     approximately: a workflow declaring no `keys:` at all would report
//     `dataBytesMax: 0` while writing one key per output and error binding;
//   - the key checks, since a key appearing *only* in a binding is otherwise
//     swept by neither, so an over-long key would pass `verify` and fail hard
//     at the first write.
//
// This is where the sweep lives, because this is the package that owns the step
// schema. `@rawbox/store` cannot do it — it cannot see `Workflow` — so it takes
// the resulting key names through `BoxStorage.boundKeyList` instead.
// ---------------------------------------------------------------------------

/** One storage key named by a step binding, and where it was named. */
export interface BoundStorageKey {
  readonly key: string;
  /** Document path of the first binding naming it, e.g. `steps[0].outputs.timestamp`. */
  readonly path: string;
}

/** The three binding records a step may carry, in document order. */
const BINDING_ROLE_LIST = ['inputs', 'outputs', 'errors'] as const;

/** Which of a step's three binding records an entry came from. */
export type BindingRole = (typeof BINDING_ROLE_LIST)[number];

/**
 * One `inputs:`/`outputs:`/`errors:` entry that names a storage key, with
 * everything a diagnostic or a sweep needs to say about it.
 *
 * This is the raw traversal, one record per binding rather than one per key:
 * the callers below derive their own views from it, so there is exactly one
 * walk of the step list in this package and no second one to drift from it.
 */
export interface StorageBinding {
  readonly key: string;
  /** Which record named it — `inputs` reads, `outputs`/`errors` write. */
  readonly role: BindingRole;
  /** Document path of the binding, e.g. `steps[0].outputs.timestamp`. */
  readonly path: string;
  /** The step's `label:`, when it has one, for naming the step in a message. */
  readonly stepLabel: string | undefined;
  /**
   * The workflow the **binding itself** names — `{ key, workflow }` — or
   * `undefined` for the bare-key form and for a `workflow:` that is not a
   * non-empty string (which the schema reports by path).
   */
  readonly bindingWorkflow: string | undefined;
  /**
   * The workflow the **key table** names — `storage.keys.<key>.workflow` — or
   * `undefined` when the key is this workflow's.
   *
   * Read off `resolveKeyOwnerMap` (`key-table.ts`), which is the whole of what
   * used to require walking the step list looking for `{ key, workflow }`: a
   * key declared foreign is foreign in *every* binding that names it, including
   * the bare-key ones that carry no marker of their own.
   */
  readonly keyWorkflow: string | undefined;
  /**
   * Who owns the box this binding names: `bindingWorkflow ?? keyWorkflow`, and
   * `undefined` when it is this workflow's.
   *
   * The `??` is a *precedence-free* pick, not a resolution rule: the two are
   * only ever both present when they agree, because disagreeing is an error
   * `validateStorageOwnership` reports by name rather than resolving.
   */
  readonly owningWorkflow: string | undefined;
  /**
   * True when this binding names **another** workflow's box — because the
   * binding says so (`{ key, workflow }`), or because the key table says so
   * (`storage.keys.<key>.workflow`). Either way it is excluded from both things
   * this traversal feeds:
   *
   * - the **budget**, because those bytes belong to the owning workflow and a
   *   workspace total is a plain sum over workflows, so counting them here
   *   would double-count them;
   * - the **unwritten-read check**, because the workflow it names is what is
   *   responsible for writing the key, and flagging it would reject a
   *   legitimate document.
   *
   * The binding half of the flag is set from the *presence* of a `workflow`
   * field, not from its value, so it still includes the schema-illegal cases —
   * one on an output or an error, or one holding a non-string —
   * `validateStorageBoundaries` and the schema report those separately.
   */
  readonly crossWorkflow: boolean;
}

/**
 * What one binding value names, or `undefined` when it names no storage key —
 * an empty key, or a shape the schema will reject on its own.
 *
 * `declaresWorkflow` is presence and `workflow` is the value, because the two
 * differ on a document the schema has not yet seen: `{ key, workflow: 7 }`
 * declares a cross-workflow read badly, and reading it as "no workflow" would
 * quietly enrol another workflow's key in this one's budget while the schema
 * error is still being fixed.
 */
function describeBindingRef(
  ref: unknown,
): { key: string; declaresWorkflow: boolean; workflow: string | undefined } | undefined {
  if (typeof ref === 'string') {
    return ref.length > 0
      ? { key: ref, declaresWorkflow: false, workflow: undefined }
      : undefined;
  }

  if (!isPlainObject(ref)) {
    return undefined;
  }

  if (typeof ref.key !== 'string' || ref.key.length === 0) {
    return undefined;
  }

  return {
    key: ref.key,
    declaresWorkflow: 'workflow' in ref,
    workflow:
      typeof ref.workflow === 'string' && ref.workflow.length > 0
        ? ref.workflow
        : undefined,
  };
}

/**
 * Every storage-key binding in a document's steps, in document order: step by
 * step, and within a step `inputs` then `outputs` then `errors`.
 *
 * Nothing is deduplicated here and nothing is filtered beyond "names no key at
 * all", because the two rules built on this traversal need different subsets of
 * it — the budget wants distinct keys with cross-workflow reads removed, the
 * unwritten-read check wants reads and writes told apart.
 *
 * Takes `unknown` rather than `Workflow` on purpose: it is called from
 * `validateStorageSizes`, which is exported and must tolerate a document that
 * has not been through the schema, and from the CLI's `verify` commands, which
 * budget a document as soon as it is schema-valid.
 */
export function collectStorageBindingList(workflow: unknown): StorageBinding[] {
  const steps = isPlainObject(workflow) ? workflow.steps : undefined;

  if (!Array.isArray(steps)) {
    return [];
  }

  // Which keys `storage:` declares to be another workflow's. Computed once for
  // the whole walk, and read per binding — the field read that replaced this
  // traversal's old job of *discovering* cross-workflow keys from the shape of
  // each binding. `resolveKeyOwnerMap` takes `unknown` and tolerates a
  // pre-schema document, which is this function's own contract too.
  const ownerMap = resolveKeyOwnerMap(
    isPlainObject(workflow) ? workflow.storage : undefined,
  );

  const bindingList: StorageBinding[] = [];

  for (const [stepIndex, step] of steps.entries()) {
    if (!isPlainObject(step)) continue;

    const stepLabel =
      typeof step.label === 'string' && step.label.length > 0
        ? step.label
        : undefined;

    for (const role of BINDING_ROLE_LIST) {
      const record = step[role];
      if (!isPlainObject(record)) continue;

      for (const [field, ref] of Object.entries(record)) {
        const described = describeBindingRef(ref);
        if (described === undefined) continue;

        const keyWorkflow = ownerMap.get(described.key)?.workflow;

        bindingList.push({
          key: described.key,
          role,
          path: keyPath(`steps[${stepIndex}].${role}`, field),
          stepLabel,
          bindingWorkflow: described.workflow,
          keyWorkflow,
          owningWorkflow: described.workflow ?? keyWorkflow,
          crossWorkflow: described.declaresWorkflow || keyWorkflow !== undefined,
        });
      }
    }
  }

  return bindingList;
}

/**
 * Every storage key a document's steps bind *in this workflow*, deduplicated,
 * in binding order, each paired with the document path of the first binding
 * that names it.
 *
 * A view over {@link collectStorageBindingList}: everything naming another
 * workflow's box dropped — whether the binding said so or the key table did —
 * then first occurrence per key.
 */
export function collectBoundStorageKeyList(
  workflow: unknown,
): BoundStorageKey[] {
  const boundKeyList: BoundStorageKey[] = [];
  const seen = new Set<string>();

  for (const binding of collectStorageBindingList(workflow)) {
    if (binding.crossWorkflow || seen.has(binding.key)) continue;

    seen.add(binding.key);
    boundKeyList.push({ key: binding.key, path: binding.path });
  }

  return boundKeyList;
}

/**
 * The same sweep, as the plain key list `BoxStorage.boundKeyList` takes.
 *
 * This is the whole of what `@rawbox/store` needs to make its budget cover
 * bound keys, and keeping it to a `string[]` is why that package needs no
 * knowledge of the step schema at all.
 */
export function collectBoundStorageKeys(workflow: unknown): string[] {
  return collectBoundStorageKeyList(workflow).map((bound) => bound.key);
}

// ---------------------------------------------------------------------------
// A key read but never written
//
// A key bound by an `inputs:` binding, written by no step's `outputs:`/
// `errors:`, and seeded by no `storage.keys` entry, is a guaranteed runtime
// failure rather than a stylistic complaint. Measured against the real store:
//
//   read an unwritten lmdb-kv key   -> "Value not found"
//   read an unwritten lmdb-fifo key -> "Queue empty"
//
// So the workflow cannot run, and the failure is entirely visible in the
// document. Rejecting it at verify time puts it where the author is looking,
// rather than partway through a run at the first `get`. A constant is an
// ordinary seeded key, so forgetting the seed produces exactly this shape.
//
// Two exclusions decide whether the rule is correct rather than merely strict:
//
//   - **Reads of another workflow's box are exempt.** They name a box that
//     workflow writes. They never reach the read set, because
//     `collectStorageBindingList` flags them — from the binding's own
//     `{ key, workflow }`, or from `storage.keys.<key>.workflow`, which says
//     the same thing about every binding of that key at once and so covers the
//     bare `inputs: { ms: shared_state }` that carries no marker.
//   - **A write by *any* step counts, in any order.** Reading at step 1 what
//     step 5 writes fails on the first run and works thereafter, which is a
//     legitimate pattern for state that accumulates across runs. No order
//     analysis is attempted, and none should be.
//
// See FORMAT.md, "Storage keys".
// ---------------------------------------------------------------------------

/**
 * How an unwritten key fails when it is finally read, per its strategy.
 *
 * The quoted sentence comes from {@link StrategyDescriptor.emptyReadMessage}
 * rather than being restated here, so this and the store's real failure
 * (`box-peek.ts`, `box-store-lmdb.ts`) cannot drift apart — see that field's
 * doc comment in `@rawbox/store`'s `strategy/descriptor.ts`.
 *
 * `strategy` is `undefined` when `collectUnwrittenReadProblems` is reached
 * on a `storage:` block whose `defaultStrategy` is missing — the schema
 * requires that field, but this function's caller, `validateStorageSizes`,
 * only checks `isPlainObject(storage)` before reaching here, defensively,
 * rather than re-running the schema. With no strategy instance there is
 * nothing to hand `descriptorFor`, so this one branch falls back to the
 * literal `lmdb-kv` message rather than a descriptor lookup — the schema
 * error for the missing `defaultStrategy` is what an author actually sees
 * in that case, this sentence never reaches them.
 */
function describeEmptyRead(strategy: BoxStrategy | undefined): string {
  if (strategy === undefined) {
    return 'there is no value under the key, and the read fails with "Value not found"';
  }

  const emptyReadMessage = descriptorFor(strategy).emptyReadMessage;

  return strategy.name === 'lmdb-fifo'
    ? `the queue is empty, and the read fails with "${emptyReadMessage}"`
    : `there is no value under the key, and the read fails with "${emptyReadMessage}"`;
}

/**
 * Where to tell the author to add `seed:` for a key that has none yet.
 *
 * One expression either way, since `keys:` is the only declaration block: a key
 * the table already knows is told about the entry it is already in, and a key
 * named only by a binding is told about the entry it would gain. `keyPath` and
 * `declaredAt.key` build the same string for the same key, so the branch is
 * about whether an entry exists rather than about where it would go.
 */
function suggestSeedPath(key: string, entry: ResolvedStorageKey | undefined): string {
  return `${entry?.declaredAt.key ?? keyPath('storage.keys', key)}.seed`;
}

/**
 * Every `inputs:` binding whose key nothing in the document ever writes, as a
 * diagnostic naming the key, the binding that reads it, and the ways to fix
 * it.
 *
 * Reported once per key rather than once per binding: an author who forgot one
 * seed wants one line about it, not one line per step that reads it.
 */
function collectUnwrittenReadProblems(
  workflow: unknown,
  storage: Storage,
): string[] {
  const bindingList = collectStorageBindingList(workflow);

  // `resolveKeyTable` is the one place `keys:` is read — see `key-table.ts`.
  // Used for both the "is this key supplied" test below and the strategy each
  // unwritten binding resolves to, so a key's seed and its strategy come off
  // one table rather than from two independent reads that could disagree about
  // which keys the block even names.
  const { byKey } = resolveKeyTable(storage);

  // A key gets a value from a seed or from a write, and the two are
  // interchangeable here — this rule asks only whether *something* supplies
  // one. A strategy alone deliberately does not count: declaring a key's box
  // says how it stores, not that anything ever puts something in it.
  const suppliedKeySet = new Set<string>();
  for (const entry of byKey.values()) {
    if (entry.hasSeed) {
      suppliedKeySet.add(entry.key);
    }
  }
  for (const binding of bindingList) {
    if (binding.role !== 'inputs') {
      suppliedKeySet.add(binding.key);
    }
  }

  const problems: string[] = [];
  const reportedKeySet = new Set<string>();

  for (const binding of bindingList) {
    if (binding.role !== 'inputs' || binding.crossWorkflow) continue;
    if (suppliedKeySet.has(binding.key) || reportedKeySet.has(binding.key)) {
      continue;
    }
    reportedKeySet.add(binding.key);

    const entry = byKey.get(binding.key);
    const strategy = entry?.strategy ?? storage.defaultStrategy;
    const stepName = binding.stepLabel ? ` (step "${binding.stepLabel}")` : '';
    const rendered = JSON.stringify(binding.key);

    problems.push(
      `${binding.path}${stepName} reads storage key ${rendered}, but no step ` +
        `writes it and no storage.keys entry seeds it. That read cannot ` +
        `succeed: ${describeEmptyRead(strategy)}.${DETAIL}` +
        `Supply the key, either way round:${DETAIL}` +
        `  - seed it — set ${suggestSeedPath(binding.key, entry)} to the value ` +
        `it should start with; or${DETAIL}` +
        `  - have a step write it — name ${rendered} in some step's outputs: ` +
        `or errors: binding.${DETAIL}` +
        `A write by any step counts, whatever the order: reading at step 1 what ` +
        `step 5 writes is legal and is not reported here.${DETAIL}` +
        `If the key belongs to another workflow, say so — set ` +
        `${keyPath('storage.keys', binding.key)}.workflow to that workflow's ` +
        `name, or write this binding as ` +
        `{ key: ${binding.key}, workflow: <workflow name> }. Either spelling ` +
        `makes it a cross-workflow read, and neither is reported here.`,
    );
  }

  return problems;
}

/**
 * Everything about a `storage:` block that is decidable from the document
 * alone: every key's length and character set, every seed value's size and
 * shape against the strategy that key resolves to, and every `inputs:` binding
 * that reads a key nothing ever writes.
 *
 * Keys come from two places, each taking `keys[key].strategy ??
 * defaultStrategy`: the `storage.keys` entries, and every key a step binds. The
 * second is key-checked but has no value to measure, and missing it is what
 * would let an over-long binding-only key through `verify` and into a hard LMDB
 * failure at the first write.
 *
 * Those two places are *every* place a storage key can come from: the resolver
 * invents no keys, so this sweep sees the whole of what a workflow writes rather
 * than the whole of what it declares.
 *
 * Every problem found is reported, not just the first — these documents are
 * authored against `workflow verify` in a loop, so one pass should surface the
 * whole fix list. That is also why the unwritten-read rule is reported from
 * here rather than from a second entry point with a second header: an author
 * fixing a `storage:` block should see one list.
 */
export function validateStorageSizes(
  workflow: Workflow,
  source: string = UNKNOWN_SOURCE,
): Result<void, Error> {
  const storage = workflow?.storage;

  // Defensive rather than expected: `validateWorkflowType` runs the schema
  // first, so a document reaching here always has a `storage:` block. Nothing
  // in this package throws across its API boundary, and this function is
  // exported, so a caller who skips the schema gets an `Ok` rather than a
  // `TypeError` on a field the schema would have reported by name.
  if (!isPlainObject(storage)) {
    return ok(undefined);
  }

  // `resolveKeyTable` is the one place `keys:` is read — see `key-table.ts`.
  // Every per-key check below is expressed against its `ResolvedStorageKey`
  // list rather than against the `storage:` block directly, so the fallback to
  // `defaultStrategy` and the declaration paths these messages print are the
  // ones every other rule uses.
  //
  // The variable is named `keyEntryList` rather than `entryList` because the
  // FIFO branch below already uses `entryList` for a seed's own elements, and
  // the two must not collide.
  const { entryList: keyEntryList } = resolveKeyTable(storage);

  const problems: string[] = [];

  for (const { key, strategy, hasSeed, seed: seedValue, declaredAt } of keyEntryList) {
    // `storage.keys.<key>.strategy`, or `storage.defaultStrategy` for a key
    // that declares none — the field an author edits to change what this key's
    // box will hold.
    const strategyLabel = declaredAt.strategy;
    // `storage.keys.<key>`: the one block the author actually wrote.
    const keyLabel = `Storage key ${JSON.stringify(key)} (declared at ${declaredAt.key})`;

    const keySizeProblem = checkKeySize({ key, keyLabel });
    if (keySizeProblem) problems.push(keySizeProblem);

    const keyCharacterProblem = checkKeyCharacterSet({ key, keyLabel });
    if (keyCharacterProblem) problems.push(keyCharacterProblem);

    if (!hasSeed) continue;

    // Present exactly when `hasSeed` is (`ResolvedStorageKey`'s invariant,
    // `key-table.ts`), which the guard above already established.
    const seedLabel = declaredAt.seed!;

    if (descriptorFor(strategy).seedExpandsList) {
      // A FIFO seed is the queue's initial contents, one entry per element.
      // Two consequences follow, and both are checkable from the document
      // alone:
      //
      //   - `valueSizeMax` bounds *an element*, not the list, because it is an
      //     element that becomes a stored value. Measuring the list whole would
      //     accept a document whose third item cannot be written.
      //   - the element count is the queue's initial depth, so it is bounded by
      //     whatever capacity the strategy declares, `seedCapacityOf(strategy)`
      //     — its own row in the strategy registry, not this function. The two
      //     queue strategies answer differently (`lmdb-fifo` reserves a slot,
      //     `redis-fifo` does not), which is exactly why it is read rather than
      //     computed here.
      //
      // The mandatory list is what makes both of these well defined: without it
      // there is no element to measure and no count to check. `resolveWorkflow`
      // expands the same list into one `Seed` per element, so what is measured
      // here and what is written at run time are the same values.
      const shapeProblem = checkFifoSeedIsList({
        value: seedValue,
        strategy,
        subject: seedLabel,
        strategyLabel,
      });
      if (shapeProblem) {
        problems.push(shapeProblem);
        continue;
      }

      const entryList = seedValue as readonly unknown[];

      // `checkFifoSeedLength`'s message quotes `queueSizeMax`, so it needs a
      // strategy that declares one — hence a narrowing here that the branch
      // above does not need. It is a test on the **shape**, not on
      // `strategy.name`: every queue strategy passes it and any future
      // list-expanding strategy with no declared ceiling is simply skipped,
      // with no name to add. What differs *between* queue strategies —
      // capacity, and whether a slot is reserved — is read from the registry
      // inside that function, not decided here.
      if ('queueSizeMax' in strategy) {
        const lengthProblem = checkFifoSeedLength({
          entryList,
          strategy,
          subject: seedLabel,
          strategyLabel,
        });
        if (lengthProblem) problems.push(lengthProblem);
      }

      entryList.forEach((entry, entryIndex) => {
        const problem = checkValueSize({
          value: entry,
          strategy,
          subject: `${seedLabel}[${entryIndex}]`,
          strategyLabel,
          note:
            `Each element of an ${strategy.name} seed becomes one queue entry, ` +
            `so valueSizeMax bounds the element rather than the whole list.`,
        });
        if (problem) problems.push(problem);
      });

      continue;
    }

    // `lmdb-kv`: one seed, one stored value, measured whole.
    const problem = checkValueSize({
      value: seedValue,
      strategy,
      subject: seedLabel,
      strategyLabel,
    });
    if (problem) problems.push(problem);
  }

  // Keys a step binds and `storage:` never mentions. There is no seed value to
  // measure, but the key itself is as real a failure as a declared key's: the
  // contract binds every key a workflow writes, however it got named.
  const declaredKeySet = new Set(keyEntryList.map((entry) => entry.key));
  for (const bound of collectBoundStorageKeyList(workflow)) {
    if (declaredKeySet.has(bound.key)) continue;

    const keyLabel =
      `Storage key ${JSON.stringify(bound.key)} ` +
      `(bound at ${bound.path}, declared nowhere in storage:)`;

    const keySizeProblem = checkKeySize({ key: bound.key, keyLabel });
    if (keySizeProblem) problems.push(keySizeProblem);

    const keyCharacterProblem = checkKeyCharacterSet({ key: bound.key, keyLabel });
    if (keyCharacterProblem) problems.push(keyCharacterProblem);
  }

  // Reads that nothing feeds. Last, because it is about the document's
  // shape rather than about any one key's declaration, and an author reading
  // the list top-down has finished with the key table by the time they reach it.
  problems.push(...collectUnwrittenReadProblems(workflow, storage));

  if (problems.length === 0) {
    return ok(undefined);
  }

  const where = source === UNKNOWN_SOURCE ? '' : ` in ${source}`;

  return err(
    new Error(
      `Preflight Check: Storage validation failed${where}:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    ),
  );
}

// ---------------------------------------------------------------------------
// One workflow, one store
//
// A step's outputs are written and the *next* step's inputs are read inside a
// **single transaction** — `syncData` opens one and does both halves in it
// (`machine/actors/sync-db-actor.ts:32-51`), over `BoxStoreLmdb.transaction`,
// which runs the whole callback inside one `transactionSync`
// (`@rawbox/store`, `box-store/box-store-lmdb.ts:817`). Both halves in one
// commit is the point of that actor: a crash between them would leave a run
// having consumed an input without recording the output that consumed it.
//
// **A transaction cannot span two stores.** There is no distributed commit here
// and none is planned: two LMDB environments have two write locks, two Redis
// servers have two `MULTI` scopes, and nothing brackets a pair of them. So a
// workflow whose keys do not all live in one store cannot execute its very
// first step-to-step hand-off, whatever the strategies are individually.
//
// That is decidable from the document alone — every strategy is written out in
// it — which is why it is rejected at verify time rather than discovered
// partway through a run, with a box already written and no way to unwrite it
// (FORMAT.md, "Strategies" and "Validation").
//
// ## The discriminator is store identity, never a backend label
//
// The tempting check is a `backend` category — `'lmdb' | 'redis'` — and it is
// **wrong**, not merely coarse: two `redis-kv` keys pointed at two different
// servers are not co-transactional either, and a label saying "both are redis"
// would call them compatible and let the document through. So the question each
// strategy answers is *which concrete store*, and it answers it itself, in the
// strategy registry (`storeIdentityOf`, `@rawbox/store`'s
// `strategy/descriptor.ts`). Two consequences that a category gets backwards:
//
//   - `lmdb-kv` and `lmdb-fifo` are **one** store — one environment, one
//     `transactionSync` — so a cell beside a queue is fine;
//   - `redis-kv` and `redis-kv` are **two** stores whenever their `backend:`
//     ids differ.
//
// Nothing here branches on `strategy.name`, and nothing here knows what a
// backend is. A strategy joining the union is covered by this rule the day its
// descriptor row states its store, with nothing in this file to update — the
// same property `seedExpandsList` and `emptyReadMessage` already have, and the
// reason there is deliberately no `BoxStrategyKind`/`BoxBackend` type in this
// codebase (see that module's header). A `backend` label would have been
// *actively wrong* here rather than merely imprecise: two `redis-kv` keys on
// different servers are not co-transactional, and a `backend: 'redis'` label
// would have said they were.
//
// ## What participates, and what does not
//
// Everything the document *names*: `storage.defaultStrategy` (which every key
// without an override resolves through, so it is in play even when no key
// currently uses it), every `storage.keys` entry, and every key a step binds —
// each resolving by the format's one rule, `keys[key].strategy ??
// defaultStrategy` (FORMAT.md, "`storage`").
//
// **Another workflow's keys are excluded**, and that exclusion is what keeps
// the rule correct rather than merely strict: such a key's box is owned,
// written and stored by the workflow that owns it. It is not part of this
// workflow's transaction, and its store is that workflow's business to keep
// consistent. Both spellings are dropped, and by the same two mechanisms that
// drop them from the budget and from the unwritten-read rule: a
// `{ key, workflow }` binding never reaches `collectBoundStorageKeyList`, and a
// key the table declares foreign (`storage.keys.<key>.workflow`) is skipped
// from `entryList` below.
//
// The consequence is worth stating, because it is the point of declaring
// ownership rather than merely tolerating it: a workflow whose own keys are all
// LMDB may read a `redis-kv` box belonging to another workflow without this
// rule firing. That is not a store split — nothing in this workflow's
// transaction touches Redis — it is a read of a box another workflow keeps
// consistent, which is exactly what a cross-workflow read is.
// ---------------------------------------------------------------------------

/**
 * One thing a document names that resolves to a store, with everything a
 * diagnostic needs to say about it.
 */
interface StoreParticipant {
  /**
   * The storage key, or `undefined` for `storage.defaultStrategy` itself —
   * which is a strategy the document names whether or not any key currently
   * falls through to it.
   */
  readonly key: string | undefined;
  /** Where the strategy is declared, from `ResolvedStorageKey.declaredAt`. */
  readonly source: string;
  readonly strategy: BoxStrategy;
  readonly store: StoreIdentity;
}

/**
 * Everything a document names that resolves to a store, in a **fixed** order:
 * `storage.defaultStrategy`, then `storage.keys` entries, then keys bound by a
 * step — each in document order, deduplicated by key, and cross-workflow reads
 * dropped.
 *
 * The order is the diagnostic's determinism: the first participant's store is
 * the one every other participant is reported against, so a stable order is what
 * makes the same document produce the same message with the same keys in the
 * same places. Nothing here iterates an unordered set — the `Set` is a
 * membership test only, and the output is an array built in traversal order.
 *
 * `storage.defaultStrategy` comes first deliberately. It is the store the
 * workflow is in unless a key says otherwise, so reporting divergences *against*
 * it puts the odd keys on the reported side rather than the majority of them,
 * and it means a document whose default is unused but points elsewhere is still
 * covered.
 *
 * Takes `unknown` for the same reason the sweeps above do: it must tolerate a
 * document that has not been through the schema without throwing.
 */
function collectStoreParticipantList(workflow: unknown): StoreParticipant[] {
  const storage = isPlainObject(workflow) ? workflow.storage : undefined;

  if (!isPlainObject(storage)) {
    return [];
  }

  const defaultStrategy = storage.defaultStrategy;

  // Without a default there is no `keys[key].strategy ?? defaultStrategy` to
  // resolve with, so most keys have no store at all and any comparison would be
  // over a fraction of the document. The schema requires the field, and its
  // error for the missing one is what the author needs to see.
  if (!isPlainObject(defaultStrategy)) {
    return [];
  }

  // `resolveKeyTable` is the one place `keys:` is read (`key-table.ts`), so
  // every declared `redis-*` strategy reaches this sweep through the same
  // table the budget and the size rules use.
  //
  // `keys:` is re-narrowed defensively first, because this function's own
  // contract — stated above — is to tolerate a document that never reached the
  // schema, and `resolveKeyTable`'s precondition is the opposite (a
  // schema-valid block). A malformed `keys:` is dropped here rather than
  // handed across that boundary.
  const keys = isPlainObject(storage.keys) ? storage.keys : {};

  const { entryList, byKey } = resolveKeyTable({
    defaultStrategy: defaultStrategy as BoxStrategy,
    keys,
  } as unknown as Storage);

  const participantList: StoreParticipant[] = [
    {
      key: undefined,
      source: 'storage.defaultStrategy',
      strategy: defaultStrategy as BoxStrategy,
      store: storeIdentityOf(defaultStrategy as BoxStrategy),
    },
  ];

  const seenKeySet = new Set<string>();

  const keyList = [
    // Keys the table declares to be another workflow's are not this workflow's
    // to keep co-transactional — see the section header. A field read, where
    // the binding half of the same exclusion needs `collectBoundStorageKeyList`
    // to have walked the steps.
    ...entryList
      .filter((entry) => entry.workflow === undefined)
      .map((entry) => entry.key),
    ...collectBoundStorageKeyList(workflow).map((bound) => bound.key),
  ];

  for (const key of keyList) {
    if (seenKeySet.has(key)) continue;
    seenKeySet.add(key);

    const entry = byKey.get(key);
    const strategy = entry?.strategy ?? (defaultStrategy as BoxStrategy);

    // Defensive, and only reachable ahead of the schema: a strategy block that
    // is not an object has no `name` to look up, and the schema reports it by
    // path. Skipping it loses no coverage, because a document that reaches
    // this check in production has already passed the schema.
    if (!isPlainObject(strategy)) continue;

    participantList.push({
      key,
      // `storage.keys.<key>.strategy` for a key that declares one. A key bound
      // only by a step (`entry` undefined), or declared with no `strategy:`,
      // has no per-key block to name and falls back to
      // `storage.defaultStrategy` — which is the field that actually chose its
      // store.
      source: entry?.declaredAt.strategy ?? 'storage.defaultStrategy',
      strategy: strategy as BoxStrategy,
      store: storeIdentityOf(strategy as BoxStrategy),
    });
  }

  return participantList;
}

/** How a participant is named as the subject of a sentence. */
function describeStoreSubject(participant: StoreParticipant): string {
  return participant.key === undefined
    ? 'storage.defaultStrategy'
    : `storage key ${JSON.stringify(participant.key)}`;
}

/**
 * A participant as a full statement: what it is, which store it resolves to, and
 * which field chose that store.
 *
 * The store is named by its {@link StoreIdentity.description} rather than by its
 * id, because the id is an opaque equality token — telling an author that
 * `lmdb:workspace` and `redis:cache` differ names nothing they can go and edit.
 */
function describeStoreParticipant(participant: StoreParticipant): string {
  const store = participant.store.description;
  const name = participant.strategy.name;

  return participant.key === undefined
    ? `storage.defaultStrategy resolves to ${store} (name: ${name}), and every ` +
        `key with no strategy: of its own resolves through it`
    : `storage key ${JSON.stringify(participant.key)} resolves to ${store} — ` +
        `its strategy is declared at ${participant.source} (name: ${name})`;
}

/**
 * The participant a group is reported by: the first one holding an actual
 * **key**, falling back to the group's first member.
 *
 * A key is what an author searches their file for, so a message naming two keys
 * is one they can act on directly. The fallback is reached only when a whole
 * store is represented by `storage.defaultStrategy` alone — a default nothing
 * currently resolves through — and there the field path *is* the thing to edit.
 */
function pickStoreSpokesman(group: readonly StoreParticipant[]): StoreParticipant {
  return group.find((participant) => participant.key !== undefined) ?? group[0]!;
}

/**
 * Every store this document's keys resolve to, beyond the first, as an
 * author-facing diagnostic naming both sides of the split.
 *
 * **One problem per divergent store, not per key.** A document with one Redis
 * key and eight LMDB ones is one mistake, and eight lines saying so would bury
 * it; the extra keys in the divergent group are listed inside the one message
 * instead, so nothing is hidden.
 *
 * Reported against the first group — the one `storage.defaultStrategy` is in —
 * because that is the workflow's baseline store. The message deliberately does
 * **not** say which side is wrong: only the author knows whether the Redis key
 * was the mistake or the LMDB default was, so it names both fields and offers
 * both edits.
 */
function collectStoreSplitProblems(workflow: unknown): string[] {
  const participantList = collectStoreParticipantList(workflow);

  if (participantList.length === 0) {
    return [];
  }

  // A `Map` keyed by store id, populated in participant order: insertion order
  // is the iteration order, so the grouping inherits the traversal's
  // determinism rather than needing a sort.
  const groupList = new Map<string, StoreParticipant[]>();

  for (const participant of participantList) {
    const group = groupList.get(participant.store.id);
    if (group === undefined) {
      groupList.set(participant.store.id, [participant]);
    } else {
      group.push(participant);
    }
  }

  if (groupList.size <= 1) {
    return [];
  }

  const [referenceGroup, ...divergentGroupList] = [...groupList.values()];
  const reference = pickStoreSpokesman(referenceGroup!);

  return divergentGroupList.map((group) => {
    const spokesman = pickStoreSpokesman(group);

    const alsoKeyList = group
      .filter(
        (participant) =>
          participant.key !== undefined && participant !== spokesman,
      )
      .map((participant) => JSON.stringify(participant.key));

    const also =
      alsoKeyList.length === 0
        ? ''
        : `Also resolving to ${spokesman.store.description}: ` +
          `${alsoKeyList.join(', ')}.${DETAIL}`;

    return (
      `This workflow's storage keys do not all resolve to one store: ` +
      `${describeStoreSubject(spokesman)} and ${describeStoreSubject(reference)} ` +
      `are in different stores.${DETAIL}` +
      `${describeStoreParticipant(spokesman)}.${DETAIL}` +
      `${describeStoreParticipant(reference)}.${DETAIL}` +
      also +
      `One step's outputs are written and the next step's inputs are read in a ` +
      `single transaction, and a transaction cannot span two stores — so this ` +
      `document cannot run, whichever of the two strategies is the mistaken ` +
      `one.${DETAIL}` +
      `Two strategies share a store only when they name the same store, not ` +
      `merely the same kind of storage: two keys on the same backend: id are ` +
      `one store, and two keys on different backend: ids are two.${DETAIL}` +
      `Point them at one store: change the strategy at ${spokesman.source}, ` +
      `or the one at ${reference.source}.`
    );
  });
}

/**
 * Reject a document whose keys do not all resolve to one store.
 *
 * Separate from {@link validateStorageSizes} rather than folded into it because
 * the two answer different questions about different subjects: that one measures
 * each key's own declaration — its length, its characters, its seed — and this
 * one compares the key table's declarations *against each other*. A key that is
 * individually perfect can still be in the wrong store, and no per-key loop is
 * where that gets noticed.
 *
 * **Requires a schema-valid document**, exactly as `validateStorageSizes` does
 * and for the same reason: it reads resolved strategy fields — `redis-kv`'s
 * `backend:` among them — as the types the schema guarantees, and a strategy
 * whose `name` is not a union member has no descriptor row to ask. Every
 * production caller reaches it through {@link validateWorkflowType}, which runs
 * the schema first; the defensive guards above exist because this function is
 * exported and must not throw on a document that skipped it.
 */
export function validateCoTransactionalStore(
  workflow: Workflow,
  source: string = UNKNOWN_SOURCE,
): Result<void, Error> {
  const problems = collectStoreSplitProblems(workflow);

  if (problems.length === 0) {
    return ok(undefined);
  }

  const where = source === UNKNOWN_SOURCE ? '' : ` in ${source}`;

  return err(
    new Error(
      `Preflight Check: Storage validation failed${where}:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    ),
  );
}

// ---------------------------------------------------------------------------
// An entry that contradicts itself
//
// The two rules below are about **one `keys:` entry read on its own**, which is
// what separates them from the binding rules further down: neither needs a
// step, and both are visible in the four lines an author just wrote.
//
// ## `workflow:` beside `seed:`
//
// Seeding is a **write**. `run-workflow.ts` performs one `putSync` per `Seed`
// into *this* workflow's store before the first step runs, and a `Seed` carries
// a key and a strategy and no workflow at all (`workflow-types.ts`) — there is
// nowhere for it to name someone else's store, by construction, exactly as
// `WriteBoxLocation` has nowhere for a step's write. So a seed on a key this
// workflow does not own cannot do what it says: it would either write a box of
// the same name in this workflow — two boxes, one name, silently — or it would
// have to reach into another workflow's store, which the format does not have.
//
// Refused rather than ignored, because both readings of an ignored seed are
// worse than a stopped document: an author who wrote it believes the box starts
// with a value, and the workflow that *does* own the box has its own idea about
// what it starts with.
//
// ## `workflow:` naming this workflow
//
// Refused, not treated as a no-op, and the reason is that it keeps "declares
// `workflow:`" and "is another workflow's" the same question. Every rule
// downstream — the budget exclusion, the read-set view, the co-transactional
// sweep, the write boundary — asks it as `entry.workflow !== undefined`
// (`ResolvedStorageKey`, `key-table.ts`). Were self-naming a no-op, each would
// instead have to compare a name against the running workflow's, which means
// `resolveKeyTable` and `boxStorageFor` would need a `Workflow` where today
// they need only a `storage:` block — a whole parameter threaded through the
// key table so that one spelling can mean nothing.
//
// It also says nothing an author can have meant. The field exists to name
// *another* workflow; pointing it at this one is a copy-paste from a sibling
// document or a misreading of what it does, and both are better answered than
// accepted.
// ---------------------------------------------------------------------------

/**
 * A `keys:` entry that both seeds a key and declares the key to be another
 * workflow's, as a diagnostic saying which of the two the author has to give up
 * and why the combination cannot be honoured.
 */
function describeSeededForeignKey(entry: ResolvedStorageKey): string {
  const { key, workflow, declaredAt } = entry;
  // Both present by the caller's guards: `declaredAt.seed` exactly when
  // `hasSeed`, `declaredAt.workflow` exactly when `entry.workflow` is set
  // (`StorageKeyDeclaration`, `key-table.ts`).
  const seedPath = declaredAt.seed!;
  const workflowPath = declaredAt.workflow!;

  return (
    `Storage key ${JSON.stringify(key)} is seeded at ${seedPath}, but ` +
    `${workflowPath} declares it to belong to workflow ` +
    `${JSON.stringify(workflow)}.${DETAIL}` +
    `A seed is a write: it is applied to the running workflow's own store ` +
    `before the first step, and a seed names a key and a strategy and no ` +
    `workflow — there is no form of it that can put a value into another ` +
    `workflow's box. Applied here it would create a second box of the same ` +
    `name in this workflow, which is not the box the rest of this document ` +
    `reads.${DETAIL}` +
    `Say one of the two things: drop ${workflowPath} if this workflow ` +
    `owns the key and starts it with a value; or drop ${seedPath} and ` +
    `let workflow ${JSON.stringify(workflow)} supply it, reading it here with ` +
    `an inputs: binding.`
  );
}

/**
 * A `keys:` entry naming the workflow it is written in, as a diagnostic saying
 * what the field is for rather than merely refusing it.
 */
function describeSelfOwnedKey(entry: ResolvedStorageKey, name: string): string {
  const { key, declaredAt } = entry;
  // Present exactly when `entry.workflow` is, which the caller has established.
  const workflowPath = declaredAt.workflow!;

  return (
    `Storage key ${JSON.stringify(key)} declares ` +
    `${workflowPath}: ${JSON.stringify(name)}, which is this ` +
    `workflow's own name.${DETAIL}` +
    `workflow: says the box belongs to a *different* workflow — that this ` +
    `document reads it and never writes it, that its bytes are counted in that ` +
    `workflow's budget, and that no step here may name it in outputs: or ` +
    `errors:. None of that is true of a key this workflow owns, so the field ` +
    `has nothing to say here.${DETAIL}` +
    `Delete ${workflowPath}. A key with no workflow: is this ` +
    `workflow's, which is what every key without one already means.`
  );
}

/**
 * Reject a document whose `storage:` block contradicts itself about a key:
 * seeded while owned by another workflow, or owned by the workflow it is
 * written in.
 *
 * Both are properties of the key table read on its own — no step participates
 * in either — which is what separates this from
 * {@link validateStorageOwnership}, the rule about bindings that contradict a
 * key's declared owner.
 *
 * Reads the entries off {@link resolveKeyTable} rather than walking
 * `storage.keys` again, so the rule and the normalisation cannot disagree about
 * what a key declares — the failure that would otherwise be possible is a
 * document this rejects and the resolver reads differently, or the reverse.
 *
 * Every offending key is reported, not just the first: a `storage:` block is
 * authored against `workflow verify` in a loop. The two rules are reported in
 * one list, in that order, for the same reason `validateStorageSizes` reports
 * its whole fix list at once.
 *
 * **Requires a schema-valid document**, for the same reason
 * {@link validateCoTransactionalStore} does: `resolveKeyTable` reads
 * `strategy:` blocks as the `BoxStrategy` the schema guarantees. Every
 * production caller reaches it through {@link validateWorkflowType}, which runs
 * the schema first.
 */
export function validateStorageKeyTable(
  workflow: Workflow,
  source: string = UNKNOWN_SOURCE,
): Result<void, Error> {
  // Defensive, exactly as `validateStorageSizes` is: this function is exported,
  // and a caller who skipped the schema must get an `Ok` rather than a
  // `TypeError` on a field the schema would have named.
  if (!isPlainObject(workflow?.storage)) {
    return ok(undefined);
  }

  const { entryList } = resolveKeyTable(workflow.storage);

  const problems: string[] = [];

  for (const entry of entryList) {
    if (entry.workflow === undefined) continue;

    if (entry.hasSeed) {
      problems.push(describeSeededForeignKey(entry));
    }

    // `workflow.name` is a required, non-empty string once the schema has
    // passed; the guard is for the exported-and-called-early case, where a
    // missing name must not turn every foreign key into a self-owned one.
    if (typeof workflow.name === 'string' && entry.workflow === workflow.name) {
      problems.push(describeSelfOwnedKey(entry, workflow.name));
    }
  }

  if (problems.length === 0) {
    return ok(undefined);
  }

  const where = source === UNKNOWN_SOURCE ? '' : ` in ${source}`;

  return err(
    new Error(
      `Preflight Check: Storage validation failed${where}:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    ),
  );
}

// ---------------------------------------------------------------------------
// The write boundary, as a rule about the document
//
// **A key declaring `workflow:` MUST NOT appear in any step's `outputs:` or
// `errors:`.**
//
// This is the author-facing half of the boundary `WriteBoxLocation` keeps
// structurally (`@rawbox/store`, `box.ts`) and `validateStorageBoundaries`
// reports on the resolved model (below, "Storage boundaries"). The three layers
// are not redundant, and moving ownership onto the key table is what made the
// middle one necessary:
//
//   - `WriteStorageRef` and `WriteBoxLocation` have no `workflow` field, so a
//     cross-workflow write cannot be *expressed*, in a document or in the
//     resolved model. That is unchanged and must stay unchanged.
//   - But a write binding may be a bare key — `outputs: { result: shared }` —
//     and nothing about its shape reveals that `storage.keys.shared` declares
//     an owner. The resolver would build a perfectly well-formed
//     `WriteBoxLocation` for it, addressed to *this* workflow's store: a second
//     box of the same name, written here, read from somewhere else, with the
//     document saying nothing about the divergence. No check on the resolved
//     model can see it, because by then the declaration is gone.
//   - So the rule is checked where both facts are still present: the authored
//     document, with the key table on one side and the step's bindings on the
//     other.
//
// ## The other half: a binding that contradicts the key table
//
// `{ key, workflow }` on an input remains the format (`ReadStorageRef`,
// `step-types.ts`, which says why it is kept rather than deprecated). Two
// spellings of one fact can now disagree — a key declaring `workflow: a` bound
// as `{ key, workflow: b }` — and that is refused **by name**, never resolved by
// precedence: a document whose meaning depends on which site wins is one its
// author cannot check by reading it, and each site here is individually
// plausible and says something the other flatly denies.
//
// Agreement is not a conflict. `{ key, workflow: a }` on a key declaring
// `workflow: a` is a restatement — redundant, readable from either end, and
// legal.
//
// ## What is deliberately *not* a rule here
//
// A binding naming a workflow for a key the table says nothing about. That is
// the pre-existing form working exactly as it always has, and it says something
// the key table cannot: a key table maps a key *name* to one owner, so two
// bindings reading `metrics` from two different workflows — two genuinely
// different boxes — are expressible only per binding.
// ---------------------------------------------------------------------------

/**
 * Every step binding that contradicts what `storage:` says about who owns its
 * key, as diagnostics naming the key, the declaration site, and the binding.
 *
 * Shared between {@link validateStorageOwnership} and `resolveWorkflow`, the
 * same way {@link collectLiteralBindingProblems} and {@link checkFifoSeedIsList}
 * are: the resolver is exported and pure, so it cannot assume it was called
 * after the verifier, and a foreign key reaching its `outputs:` loop would
 * silently become a local write — the exact outcome this rule exists to
 * prevent. One helper rather than two keeps the two diagnostics identical
 * rather than merely similar.
 *
 * Takes `unknown` for the reason {@link collectStorageBindingList} does, and
 * inherits that traversal's tolerance of a document that never reached the
 * schema.
 */
export function collectStorageOwnershipProblems(workflow: unknown): string[] {
  const problems: string[] = [];

  const ownerMap = resolveKeyOwnerMap(
    isPlainObject(workflow) ? workflow.storage : undefined,
  );

  if (ownerMap.size === 0) {
    return problems;
  }

  for (const binding of collectStorageBindingList(workflow)) {
    const owner = ownerMap.get(binding.key);
    if (owner === undefined) continue;

    const rendered = JSON.stringify(binding.key);
    const stepName = binding.stepLabel ? ` (step "${binding.stepLabel}")` : '';

    if (binding.role !== 'inputs') {
      problems.push(
        `${binding.path}${stepName} names storage key ${rendered} in ` +
          `${binding.role}:, but ${owner.declaredAt} declares that key to ` +
          `belong to workflow ${JSON.stringify(owner.workflow)}.${DETAIL}` +
          `A step may only write into its own workflow. A write is always ` +
          `resolved against the running workflow's store — there is no form of ` +
          `a write location that names another workflow — so this binding ` +
          `would not write the box the key names: it would create a second box ` +
          `called ${rendered} in this workflow, which nothing else reads.` +
          `${DETAIL}` +
          `Either drop ${owner.declaredAt}, if this workflow owns the key and ` +
          `writes it; or remove this binding and let workflow ` +
          `${JSON.stringify(owner.workflow)} write the key, reading it here ` +
          `with an inputs: binding.`,
      );
      continue;
    }

    if (
      binding.bindingWorkflow !== undefined &&
      binding.bindingWorkflow !== owner.workflow
    ) {
      problems.push(
        `${binding.path}${stepName} reads storage key ${rendered} from ` +
          `workflow ${JSON.stringify(binding.bindingWorkflow)}, but ` +
          `${owner.declaredAt} declares that key to belong to workflow ` +
          `${JSON.stringify(owner.workflow)}.${DETAIL}` +
          `A key belongs to one workflow. Both spellings are the format — the ` +
          `key table states it once for every binding, a binding states it for ` +
          `itself — but they must agree, because which of the two wins is a ` +
          `precedence rule rather than something this document states.` +
          `${DETAIL}` +
          `Say it once: delete workflow: from the binding and let ` +
          `${owner.declaredAt} answer for every read of ${rendered}; or change ` +
          `one of the two names so that they agree.`,
      );
    }
  }

  return problems;
}

/**
 * Reject a document whose steps contradict what `storage:` says about who owns
 * a key — a write to another workflow's box, or a read naming a different owner
 * from the one the key table declares.
 *
 * Separate from {@link validateStorageKeyTable}, which reads the key table on
 * its own, because this one compares it against the step list: a key table that
 * is perfectly coherent can still be contradicted by a binding, and no per-key
 * loop is where that gets noticed. Same division, and same reasoning, as
 * {@link validateStorageSizes} versus {@link validateCoTransactionalStore}.
 *
 * Every problem is reported, not just the first, for the reason every storage
 * rule in this file does: these documents are authored against
 * `workflow verify` in a loop.
 */
export function validateStorageOwnership(
  workflow: Workflow,
  source: string = UNKNOWN_SOURCE,
): Result<void, Error> {
  const problems = collectStorageOwnershipProblems(workflow);

  if (problems.length === 0) {
    return ok(undefined);
  }

  const where = source === UNKNOWN_SOURCE ? '' : ` in ${source}`;

  return err(
    new Error(
      `Preflight Check: Storage validation failed${where}:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    ),
  );
}

// ---------------------------------------------------------------------------
// The removed `{ value: … }` binding
//
// An input once accepted an inline literal, which the resolver desugared into a
// storage key it synthesised. The format has no such form: an input reads from
// storage and from nowhere else, and a constant is declared as a key and seeded
// exactly like every other input.
//
// The schema alone would reject `{ value: … }` — `InputRef` is
// `string | { key, workflow? }` with `additionalProperties: false` — but it
// would reject it as a union failure listing every branch that did not match,
// which tells an author holding a working example from a month ago nothing
// about what to write instead. Examples outlive formats, so this runs *before*
// the schema and the message is the migration path itself.
// ---------------------------------------------------------------------------

/** Longest rendered literal worth inlining into the suggested `seed:` block. */
const SEED_VALUE_RENDER_MAX = 60;

/**
 * A value as it would be written in the document, or `placeholder` when it will
 * not fit on one line.
 *
 * `JSON.stringify` is exactly right here despite the target being YAML: JSON is
 * a subset of YAML 1.2, so whatever this renders can be pasted as-is. A value
 * too long to sit on one line, or one that does not render at all, falls back to
 * the placeholder rather than to a diagnostic the author has to scroll.
 */
function renderInlineValue(
  value: unknown,
  limit: number,
  placeholder: string,
): string {
  let rendered: string | undefined;
  try {
    rendered = JSON.stringify(value);
  } catch {
    rendered = undefined;
  }

  return rendered === undefined || rendered.length > limit ? placeholder : rendered;
}

/** The literal, as it would be written under `storage.keys.<key>.seed`. */
function renderSeedValue(value: unknown): string {
  return renderInlineValue(value, SEED_VALUE_RENDER_MAX, '<the value you wrote>');
}

/**
 * A storage key to suggest for a literal on input `field`, in the snake_case
 * every key in the format's own examples uses. `thenLabel` → `then_label`.
 *
 * It is a suggestion and nothing depends on it: the author may name the key
 * whatever they like, and the point of printing one is that the replacement can
 * be copied rather than composed.
 */
function suggestSeedKey(field: string): string {
  const snake = field
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');

  return snake.length === 0 ? 'seeded_value' : snake;
}

/**
 * Every `{ value: … }` input binding in a document, as a diagnostic naming the
 * step, the field and the seed-plus-key that replaces it.
 *
 * Only `inputs` is swept. `{ value: … }` was never legal on an output or an
 * error — those write, and there is nothing to migrate — so the schema's own
 * error is the right one there.
 *
 * Takes `unknown` because it runs before the schema, on whatever `parseConfig`
 * returned.
 */
export function collectLiteralBindingProblems(document: unknown): string[] {
  const steps = isPlainObject(document) ? document.steps : undefined;

  if (!Array.isArray(steps)) {
    return [];
  }

  const problems: string[] = [];

  for (const [stepIndex, step] of steps.entries()) {
    if (!isPlainObject(step)) continue;

    const inputs = step.inputs;
    if (!isPlainObject(inputs)) continue;

    const stepName =
      typeof step.label === 'string' && step.label.length > 0
        ? ` (step ${describeStep(step.label, stepIndex)})`
        : '';

    for (const [field, ref] of Object.entries(inputs)) {
      if (!isPlainObject(ref) || !('value' in ref)) continue;

      const seedKey = suggestSeedKey(field);

      problems.push(
        `${keyPath(`steps[${stepIndex}].inputs`, field)}${stepName} is a ` +
          `{ value: … } inline literal. That binding form has been removed from ` +
          `the workflow format: an input reads from storage, so a constant is ` +
          `declared as a storage key and seeded like any other input.\n` +
          `    Seed the value and bind the key:\n` +
          `      storage:\n` +
          `        keys:\n` +
          `          ${seedKey}:\n` +
          `            seed: ${renderSeedValue(ref.value)}\n` +
          `      steps:\n` +
          `        - inputs:\n` +
          `            ${field}: ${seedKey}\n` +
          `    The seeded value is checked against the contract's inputSchema ` +
          `exactly as the literal was. A seeded key is writable by a later ` +
          `step's outputs, which a literal was not.`,
      );
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// The removed `storage.strategies` and `storage.seed` blocks
//
// `storage:` once stated a key's strategy and a key's seed in two top-level
// maps keyed by key name, beside the `keys:` entry that states them today.
// Both are gone: one key is one entry (`StorageKeyEntry`, `workflow-types.ts`),
// which is what lets every per-key rule read one table instead of merging two
// idioms, and what stops a document from saying two different things about one
// key in two places a reader has to hold at once.
//
// `Storage` is a `StrictObject`, so the schema *does* reject either block —
// but it rejects it as "must not have additional properties", which tells an
// author holding a working example from a month ago that a field is not
// recognised and nothing whatever about the field having existed, having been
// removed, or having a replacement. Examples outlive formats, and this format
// did not bump `formatVersion` for the removal, so the only thing standing
// between an older document and a mystery is this message. It therefore runs
// **before the schema** — the same reason `collectStrategyFieldProblems` and
// the `{ value: … }` sweep above do — and it prints the author's own keys,
// with the author's own values, as the `keys:` block that replaces theirs. The
// fix is meant to be copied, not composed.
//
// One diagnostic per block rather than per key: the block is what was removed,
// the move is identical for every key in it, and an author part-way through a
// migration wants one snippet holding all of them rather than one line each.
// ---------------------------------------------------------------------------

/** Longest rendered strategy block worth inlining into the suggested entry. */
const STRATEGY_BLOCK_RENDER_MAX = 120;

/** A key as it is written in a YAML mapping — quoted only when it must be. */
function renderYamlKey(key: string): string {
  return RAWBOX_KEY_CHARACTER_SET.test(key) ? key : JSON.stringify(key);
}

/**
 * The two removed blocks, in the order they were written in `storage:`, each
 * with the field a `keys:` entry states instead and how to render its value.
 *
 * A table rather than two near-identical functions, because the two messages
 * differ in exactly these four strings: everything else about them — that the
 * block is removed, that the replacement is one entry per key, the snippet
 * shape, the note about a key that was named in both — is the same sentence and
 * must stay the same sentence.
 */
const REMOVED_STORAGE_BLOCK_LIST = [
  {
    block: 'strategies',
    /** The `keys:` entry field that now states the same fact. */
    field: 'strategy',
    /** How the fact reads as the subject of "… is declared on the key itself". */
    noun: "A key's strategy",
    render: (value: unknown): string =>
      renderInlineValue(
        value,
        STRATEGY_BLOCK_RENDER_MAX,
        '<the strategy block you wrote>',
      ),
  },
  {
    block: 'seed',
    field: 'seed',
    noun: "A key's initial value",
    render: renderSeedValue,
  },
] as const;

/**
 * Each removed `storage:` block the document still writes, as a diagnostic
 * naming the block, saying it was removed, and printing the `keys:` entries
 * that replace it — built from the document's own keys and values.
 *
 * Takes `unknown` because it runs before the schema, on whatever `parseConfig`
 * returned. A block that is not a plain object is still reported — it is still
 * a field the format does not have — but with no entries to render, so the
 * message stops at the removal and the replacement's shape.
 */
export function collectRemovedStorageBlockProblems(document: unknown): string[] {
  const storage = isPlainObject(document) ? document.storage : undefined;

  if (!isPlainObject(storage)) {
    return [];
  }

  const problems: string[] = [];

  for (const { block, field, noun, render } of REMOVED_STORAGE_BLOCK_LIST) {
    if (!(block in storage)) continue;

    const written = storage[block];
    const entryList = isPlainObject(written) ? Object.entries(written) : [];

    // A key the *other* removed block also names becomes one entry with both
    // fields, not two entries. Said only when it is true, and said in both
    // messages, because an author reading either one in isolation would
    // otherwise paste two mappings under the same key.
    const otherBlock = block === 'seed' ? 'strategies' : 'seed';
    const other = storage[otherBlock];
    const sharedKeyList = isPlainObject(other)
      ? entryList.filter(([key]) => key in other).map(([key]) => key)
      : [];

    problems.push(
      `storage.${block} has been removed from the workflow format. ${noun} is ` +
        `declared on the key itself, in a storage.keys entry, so that ` +
        `everything one key says is in one place.` +
        (entryList.length === 0
          ? `${DETAIL}Move each key into storage.keys as a ${field}: field.`
          : `${DETAIL}Write ` +
            (entryList.length === 1
              ? `it as a storage.keys entry:`
              : `them as storage.keys entries:`) +
            `\n      storage:\n        keys:\n` +
            entryList
              .map(
                ([key, value]) =>
                  `          ${renderYamlKey(key)}:\n` +
                  `            ${field}: ${render(value)}`,
              )
              .join('\n')) +
        (sharedKeyList.length === 0
          ? ''
          : `${DETAIL}${sharedKeyList.map((key) => JSON.stringify(key)).join(', ')} ` +
            `${sharedKeyList.length === 1 ? 'is' : 'are'} also named in ` +
            `storage.${otherBlock}: one key is one storage.keys entry, so put ` +
            `both fields in the one entry rather than writing it twice.`) +
        `${DETAIL}storage.defaultStrategy is unaffected: it is the strategy a ` +
        `key with no strategy: of its own resolves to, not a shorthand for a ` +
        `keys: entry.`,
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// How a bounded step is spelled
//
// `timeoutMs:` on a step is `<positive whole milliseconds> | unbounded`, and
// every other spelling an author reaches for is rejected here rather than by
// the schema. `StepTimeout` is a union, so a schema rejection is a branch dump
// — "must be integer", "must be equal to constant", "must match a schema in
// anyOf" — which tells an author who wrote `timeoutMs: 0` nothing at all. This
// is the fifth instance of that reasoning in this file, after `{ value: … }`,
// the two removed `storage:` blocks, the strategy-field check and the key
// character set.
//
// The two spellings worth rejecting *hardest* are the two that would otherwise
// pass for "no bound":
//
//   - `null`, which is what YAML makes of a bare `timeoutMs:` with nothing
//     after it. An interrupted edit must not silently mean the opposite of a
//     bound.
//   - `0`, which reads as "no limit" in the C tradition and as "fire
//     immediately" to `setTimeout`, and which is also what a computed bound
//     (`attempts * interval`) lands on when the arithmetic goes wrong.
//
// Neither is a valid spelling of "unbounded", and the point of every message
// below is to print the one that is.
// ---------------------------------------------------------------------------

/** Word an author might reach for meaning "no bound". The answer to each is the same. */
const TIMEOUT_WORD_GUESS_LIST = [
  'never',
  'none',
  'off',
  'infinity',
  'inf',
  'unlimited',
  'forever',
  'no',
  'disabled',
  'null',
  'false',
];

/** The one remedy sentence every `timeoutMs` diagnostic ends on. */
const TIMEOUT_REMEDY =
  `Write timeoutMs: <whole milliseconds, 1 to ${TIMEOUT_MS_MAX}> to bound the ` +
  `step, or timeoutMs: ${UNBOUNDED_TIMEOUT} to declare it deliberately ` +
  `unbounded.${DETAIL}` +
  `Omitting the key is different from both: it inherits whatever the ` +
  `operation's contract declares, which may itself be a bound.`;

/**
 * Why one `timeoutMs:` value is not a spelling this format accepts, or
 * `undefined` when it is one.
 *
 * Every branch names what was written and what to write instead, because the
 * mistakes here are not typos — each of them is a *reasonable* guess at how the
 * field works, and correcting the guess is the whole job.
 */
function describeTimeoutSpelling(value: unknown): string | undefined {
  if (value === UNBOUNDED_TIMEOUT) return undefined;

  if (value === null) {
    return (
      `is null. In YAML a bare "timeoutMs:" with nothing after it parses as ` +
      `null, so this is usually an edit that was never finished.${DETAIL}` +
      `null is rejected precisely so that an unfinished edit cannot silently ` +
      `mean "no bound".${DETAIL}${TIMEOUT_REMEDY}`
    );
  }

  if (typeof value === 'boolean') {
    return (
      `is the boolean ${value}. A bound is a duration or the word ` +
      `${UNBOUNDED_TIMEOUT}, never on/off: there is no state in which a step ` +
      `is "bounded by true".${DETAIL}${TIMEOUT_REMEDY}`
    );
  }

  if (typeof value === 'string') {
    if (value.trim().toLowerCase() === UNBOUNDED_TIMEOUT) {
      return (
        `is ${JSON.stringify(value)}. The literal is exactly ` +
        `${UNBOUNDED_TIMEOUT}, lower-case and unpadded.${DETAIL}` +
        `${TIMEOUT_REMEDY}`
      );
    }

    if (TIMEOUT_WORD_GUESS_LIST.includes(value.trim().toLowerCase())) {
      return (
        `is ${JSON.stringify(value)}. The only word this field accepts is ` +
        `${UNBOUNDED_TIMEOUT} — one spelling, so that a document can be ` +
        `searched for the steps that have deliberately opted out.${DETAIL}` +
        `${TIMEOUT_REMEDY}`
      );
    }

    if (/^-?\d+(\.\d+)?$/.test(value.trim())) {
      return (
        `is the string ${JSON.stringify(value)}, not a number. Quoting a ` +
        `duration makes it text, and a bound is compared numerically.${DETAIL}` +
        `Remove the quotes: timeoutMs: ${value.trim()}.${DETAIL}` +
        `${TIMEOUT_REMEDY}`
      );
    }

    return `is ${JSON.stringify(value)}, which is neither a duration nor a recognised word.${DETAIL}${TIMEOUT_REMEDY}`;
  }

  if (typeof value !== 'number') {
    return (
      `is ${describeValueKind(value)}. A bound is a single duration in ` +
      `milliseconds.${DETAIL}${TIMEOUT_REMEDY}`
    );
  }

  if (!Number.isFinite(value)) {
    return (
      `is ${Number.isNaN(value) ? 'NaN' : String(value)}, which is not a ` +
      `duration.${DETAIL}` +
      `An infinite bound is spelled with the word: timeoutMs: ` +
      `${UNBOUNDED_TIMEOUT}.${DETAIL}${TIMEOUT_REMEDY}`
    );
  }

  if (!Number.isInteger(value)) {
    return (
      `is ${value}, which is not a whole number of milliseconds. A timer ` +
      `resolves to whole milliseconds, so the fraction decides nothing.${DETAIL}` +
      `${TIMEOUT_REMEDY}`
    );
  }

  if (value === 0) {
    return (
      `is 0, which is not "no bound": setTimeout(…, 0) fires on the next tick, ` +
      `so this bound would abandon the step almost immediately.${DETAIL}` +
      `0 is rejected rather than read either way, because a computed bound ` +
      `(attempts × interval) lands on it exactly when the arithmetic went ` +
      `wrong — and reading it as "unbounded" would discard a safety bound the ` +
      `author believed they had declared.${DETAIL}${TIMEOUT_REMEDY}`
    );
  }

  if (value < 0) {
    return (
      `is ${value}. A duration cannot be negative, and a negative bound is not ` +
      `a way to disable one.${DETAIL}${TIMEOUT_REMEDY}`
    );
  }

  if (value > TIMEOUT_MS_MAX) {
    return (
      `is ${value}, which exceeds the maximum of ${TIMEOUT_MS_MAX} ` +
      `(about 24.8 days).${DETAIL}` +
      `Past that, Node clamps a setTimeout delay to 1ms with a ` +
      `TimeoutOverflowWarning — so a larger number does not widen the bound, ` +
      `it inverts it, firing at once on the step meant to be given the most ` +
      `time.${DETAIL}` +
      `A wait with no sensible ceiling is a deliberate one: write timeoutMs: ` +
      `${UNBOUNDED_TIMEOUT}.${DETAIL}${TIMEOUT_REMEDY}`
    );
  }

  return undefined;
}

/**
 * Every step whose `timeoutMs:` is not a spelling this format accepts, as an
 * author-facing diagnostic naming the step and the correction.
 *
 * Takes `unknown` because it runs before the schema, on whatever `parseConfig`
 * returned, and reports every offending step rather than the first: these
 * documents are authored against `workflow verify` in a loop, and an author who
 * wrote `timeoutMs: 0` once has usually written it on every step they touched.
 *
 * It deliberately says nothing about *whether* a bound is a good idea on a
 * given step — that judgement needs the contract, so it lives in
 * {@link collectTimeoutWarnings}, on the resolved model.
 */
export function collectTimeoutSpellingProblems(document: unknown): string[] {
  const steps = isPlainObject(document) ? document.steps : undefined;

  if (!Array.isArray(steps)) {
    return [];
  }

  const problems: string[] = [];

  for (const [stepIndex, step] of steps.entries()) {
    if (!isPlainObject(step)) continue;
    // An absent key is the common case and is not a spelling at all: it means
    // "inherit the contract's declaration". `in` rather than `!== undefined`,
    // so that a key written with an explicitly undefined-ish value still
    // reaches the branches above.
    if (!('timeoutMs' in step)) continue;

    const problem = describeTimeoutSpelling(step.timeoutMs);
    if (problem === undefined) continue;

    const stepName =
      typeof step.label === 'string' && step.label.length > 0
        ? ` (step ${describeStep(step.label, stepIndex)})`
        : '';

    problems.push(`steps[${stepIndex}].timeoutMs${stepName} ${problem}`);
  }

  return problems;
}

// ---------------------------------------------------------------------------
// A field belonging to the other strategy
//
// `LmdbKV` and `LmdbFIFO` are closed schemas, so a stray field on a strategy is
// rejected. But `BoxStrategy` is a *union*, and a union rejects by failing
// every branch: `queueSizeMax` under `name: lmdb-kv` comes back as "must not
// have additional properties" against one variant, "must be equal to constant"
// against the other, and "must match a schema in anyOf" over the pair — three
// errors, none of which names the field the author actually got wrong. It is
// the third time this codebase has hit that: the key character-set rule is kept
// out of the schema for the same reason, and the removed `{ value: … }` check
// runs before the schema — against the `InputRef` union — for the same reason
// again.
//
// So this runs first and answers the question the author is really asking. The
// case that matters is a field belonging to the *other* strategy:
//
//     strategies:
//       queue_items:
//         name: lmdb-kv        # the author meant lmdb-fifo
//         valueSizeMax: 1900
//         queueSizeMax: 4      # silently ignored without this check
//
// which validated, and handed the author a key-value cell with no queue and no
// diagnostic. `name` is the one field that decides how every other field in the
// block is read, so naming which strategy the stray field belongs to is what
// turns "unknown property" into a question the author can answer.
// ---------------------------------------------------------------------------

/** One variant of the `BoxStrategy` union: its `name`, and the fields it takes. */
interface StrategyShape {
  readonly name: string;
  readonly fieldList: readonly string[];
}

/**
 * The strategy variants, read off `BoxStrategy` itself rather than written out
 * here.
 *
 * A hand-kept list would be a second statement of what a strategy is, free to
 * drift from the schema that decides it — and this diagnostic is only worth
 * having if it agrees with what actually gets rejected. Derived, a third
 * strategy is described here the day it joins the union, with no edit.
 */
const STRATEGY_SHAPE_LIST: readonly StrategyShape[] = (
  (BoxStrategy as unknown as { anyOf?: readonly unknown[] }).anyOf ?? []
).flatMap((variant): StrategyShape[] => {
  const properties = (
    variant as { properties?: Record<string, { const?: unknown }> }
  ).properties;
  const name = properties?.name?.const;

  return properties !== undefined && typeof name === 'string'
    ? [{ name, fieldList: Object.keys(properties) }]
    : [];
});

/** The strategy a `name:` value selects, or `undefined` if it selects none. */
function findStrategyShape(name: unknown): StrategyShape | undefined {
  return STRATEGY_SHAPE_LIST.find((shape) => shape.name === name);
}

/**
 * The one closing sentence both strategy-field diagnostics end on.
 *
 * **`The`, not `An`.** The name is interpolated from `STRATEGY_SHAPE_LIST`,
 * which is derived from the schema union — so the article cannot be chosen for
 * the word that follows it. It read "An lmdb-kv" correctly by luck while both
 * shipping names began with `l`, and produced "An redis-kv" the moment a third
 * joined. A definite article is right for every name a strategy can have, which
 * is what a derived list requires.
 */
function describeStrategyFields(shape: StrategyShape): string {
  return `The ${shape.name} strategy takes exactly: ${shape.fieldList.join(', ')}.`;
}

/**
 * One field a strategy block declares that its own strategy does not take.
 *
 * Two shapes, because they are two different author mistakes: a field another
 * strategy *does* take is almost always the wrong `name:`, and is worth asking
 * about by name; anything else is a typo or a leftover.
 */
function describeStrategyField(parameters: {
  path: string;
  declared: StrategyShape;
  field: string;
}): string {
  const { path, declared, field } = parameters;

  const owner = STRATEGY_SHAPE_LIST.find(
    (shape) => shape.name !== declared.name && shape.fieldList.includes(field),
  );

  if (owner === undefined) {
    return (
      `${path} sets "${field}", which is not a field of ${declared.name}, the ` +
      `strategy it declares.${DETAIL}` +
      `${describeStrategyFields(declared)}${DETAIL}` +
      `Remove the field, or correct its spelling: an unrecognised field is an ` +
      `error in this format, never silently ignored.`
    );
  }

  return (
    `${path} sets "${field}", but declares name: ${declared.name} — "${field}" ` +
    `is a field of ${owner.name}, which is a different strategy.${DETAIL}` +
    `Did you mean name: ${owner.name}? The name is what chooses the strategy, ` +
    `and every other field of this block is read according to it.${DETAIL}` +
    `If ${declared.name} is what you meant, remove "${field}": ${declared.name} ` +
    `has no such field, so it decides nothing. Earlier revisions accepted it and ` +
    `dropped it silently, so this key may have been running as ${declared.name} ` +
    `all along.${DETAIL}` +
    `${describeStrategyFields(declared)}`
  );
}

/**
 * Every strategy block in a document, as `(document path, block)` pairs:
 * `storage.defaultStrategy` and each `strategy:` under a `storage.keys` entry —
 * the two places the format spells a strategy out.
 *
 * The second is swept for the reason this whole check exists rather than for
 * completeness: `BoxStrategy` is a union, so a strategy block the sweep misses
 * gets the branch dump that FORMAT.md, "Validation" forbids. A `keys:` entry
 * carrying `queueSizeMax` under `name: lmdb-kv` is the same author mistake in a
 * different block, and it must get the same sentence.
 */
function collectStrategyBlockList(
  document: unknown,
): { path: string; block: Record<string, unknown> }[] {
  const storage = isPlainObject(document) ? document.storage : undefined;

  if (!isPlainObject(storage)) {
    return [];
  }

  const blockList: { path: string; block: Record<string, unknown> }[] = [];

  if (isPlainObject(storage.defaultStrategy)) {
    blockList.push({
      path: 'storage.defaultStrategy',
      block: storage.defaultStrategy,
    });
  }

  if (isPlainObject(storage.keys)) {
    for (const [key, entry] of Object.entries(storage.keys)) {
      if (!isPlainObject(entry)) continue;
      if (!isPlainObject(entry.strategy)) continue;

      blockList.push({
        path: `${keyPath('storage.keys', key)}.strategy`,
        block: entry.strategy,
      });
    }
  }

  return blockList;
}

/**
 * Every field a strategy block declares that its declared strategy does not
 * take, as author-facing diagnostics.
 *
 * A block whose `name:` is missing or unrecognised is skipped: without a
 * strategy there is nothing to measure the fields against, and the schema's own
 * error for `name` is the one the author needs.
 *
 * Takes `unknown` because it runs before the schema, on whatever `parseConfig`
 * returned. Every problem is collected rather than the first: an author fixing
 * a `storage:` block should get the whole list in one pass.
 */
export function collectStrategyFieldProblems(document: unknown): string[] {
  const problems: string[] = [];

  for (const { path, block } of collectStrategyBlockList(document)) {
    const declared = findStrategyShape(block.name);

    if (declared === undefined) {
      continue;
    }

    for (const field of Object.keys(block)) {
      if (declared.fieldList.includes(field)) {
        continue;
      }

      problems.push(describeStrategyField({ path, declared, field }));
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Document-level validation (authoring model)
// ---------------------------------------------------------------------------

/**
 * Validate a parsed workflow *document* against the authoring schema.
 *
 * Identity detection lives here rather than in `parseConfig`, which returns
 * `any` and performs no schema check at all. `kind:` is what makes a file a
 * Rawbox document, so the check is a single field read rather than a shape
 * heuristic.
 *
 * @param document the result of `parseConfig` — untrusted, hence `unknown`.
 * @param source   the document's path, named in the error.
 */
export function validateWorkflowType(
  document: unknown,
  source: string = UNKNOWN_SOURCE,
): Result<void, Error> {
  if (!isPlainObject(document)) {
    return err(
      new Error(
        'Preflight Check: Workflow validation failed:\n' +
          '  - the document did not parse into an object.',
      ),
    );
  }

  // `kind:` is what identifies a file as a Rawbox document. It is
  // checked before the schema so a file that is not a Rawbox document at all
  // says exactly that, instead of emitting a wall of "required property"
  // errors about fields the author never meant to write.
  if (document.kind === undefined) {
    return err(
      new Error(
        `${source} is not a Rawbox workflow document: it has no "kind:" field.\n` +
          `  Expected "kind: ${DOCUMENT_KIND.WORKFLOW}" at the top level, ` +
          `alongside "formatVersion: ${FORMAT_VERSION}".`,
      ),
    );
  }

  if (document.kind !== DOCUMENT_KIND.WORKFLOW) {
    const kindList = VALID_KIND_LIST.map((kind) => `"${kind}"`).join(', ');
    const rendered = JSON.stringify(document.kind);
    if (VALID_KIND_LIST.includes(document.kind as (typeof VALID_KIND_LIST)[number])) {
      return err(
        new Error(
          `Expected a document of kind "${DOCUMENT_KIND.WORKFLOW}", but this file declares kind ${rendered}.`,
        ),
      );
    }
    return err(
      new Error(
        `Unrecognised document kind ${rendered}. Valid kinds are: ${kindList}.`,
      ),
    );
  }

  // `formatVersion` is identity, not compatibility metadata. Calling it
  // out by name beats a bare literal-mismatch error from the schema.
  if (
    document.formatVersion !== undefined &&
    document.formatVersion !== FORMAT_VERSION
  ) {
    return err(
      new Error(
        `Unsupported formatVersion ${JSON.stringify(document.formatVersion)}. ` +
          `This runner supports "${FORMAT_VERSION}".`,
      ),
    );
  }

  // Before the schema, for the same reason `kind:` is: the schema would report
  // a removed binding form as a union failure listing the branches it is not,
  // and an author migrating an older example needs to be told what to write
  // instead.
  const literalProblems = collectLiteralBindingProblems(document);
  if (literalProblems.length > 0) {
    return err(
      new Error(
        'Preflight Check: Workflow validation failed:\n' +
          literalProblems.map((problem) => `  - ${problem}`).join('\n'),
      ),
    );
  }

  // Immediately after, and before the schema for the same reason again:
  // `StepTimeout` is a union, so the schema would report `timeoutMs: 0` as a
  // dump of the branches it is not. Every mistake this catches is a plausible
  // guess at how the field works rather than a typo, so the message is the
  // spelling to write instead.
  const timeoutProblems = collectTimeoutSpellingProblems(document);
  if (timeoutProblems.length > 0) {
    return err(
      new Error(
        'Preflight Check: Workflow validation failed:\n' +
          timeoutProblems.map((problem) => `  - ${problem}`).join('\n'),
      ),
    );
  }

  // Also before the schema, and for the same reason a third time: `Storage` is
  // a `StrictObject`, so a document still writing `storage.strategies` or
  // `storage.seed` would be told a field is not recognised — never that it used
  // to exist, was removed, or has a replacement. `formatVersion` did not move
  // for the removal, so this message is the whole of what an author working
  // from an older example gets. Ahead of the strategy-field sweep below because
  // that sweep no longer looks inside `storage.strategies` at all: a stray field
  // in a removed block must be answered with "the block is gone", not passed
  // over in silence.
  const removedBlockProblems = collectRemovedStorageBlockProblems(document);
  if (removedBlockProblems.length > 0) {
    const where = source === UNKNOWN_SOURCE ? '' : ` in ${source}`;
    return err(
      new Error(
        `Preflight Check: Storage validation failed${where}:\n` +
          removedBlockProblems.map((problem) => `  - ${problem}`).join('\n'),
      ),
    );
  }

  // Also before the schema, and for the fourth instance of the same reason: the
  // strategy schemas are closed, but they are closed *inside a union*, so the
  // schema would report a stray field as a branch dump naming neither the
  // field nor the strategy it belongs to. Reported as a storage problem,
  // with the whole list in one pass, because that is where the author is
  // looking.
  const strategyProblems = collectStrategyFieldProblems(document);
  if (strategyProblems.length > 0) {
    const where = source === UNKNOWN_SOURCE ? '' : ` in ${source}`;
    return err(
      new Error(
        `Preflight Check: Storage validation failed${where}:\n` +
          strategyProblems.map((problem) => `  - ${problem}`).join('\n'),
      ),
    );
  }

  if (!workflowValidator.Check(document)) {
    const errorDetails = formatValidationErrors(
      workflowValidator.Errors(document),
      document,
    );
    return err(
      new Error(`Preflight Check: Workflow validation failed:\n${errorDetails}`),
    );
  }

  // First of the post-schema storage rules, and deliberately ahead of the two
  // below: a `keys:` entry that contradicts itself — seeding a key it declares
  // to be another workflow's, or claiming a key for the workflow it is written
  // in — is a key whose owner the two rules below would read wrongly, and both
  // of them measure a different set of keys depending on that answer. So an
  // entry is made coherent on its own first, and the rest of the `storage:`
  // block is measured once it is.
  const keyTableResult = validateStorageKeyTable(document as Workflow, source);
  if (keyTableResult.isErr()) {
    return keyTableResult;
  }

  // Second, and before the two below for the same shape of reason: they measure
  // and compare *this workflow's* keys, and which keys those are is what
  // ownership decides. `boxStorageFor` drops a foreign key from the budget, the
  // unwritten-read rule exempts it, and the co-transactional sweep skips it —
  // so a document that is wrong about who owns a key is a document those three
  // are measuring the wrong set with. Settling it here means the rest of the
  // `storage:` block is checked against the keys this workflow actually has.
  //
  // This is the only layer that can see the rule at all: a write to a foreign
  // key resolves into an ordinary `WriteBoxLocation` addressed to this
  // workflow, so by the time `validateStorageBoundaries` runs on the resolved
  // model there is nothing left to notice. See that section's header.
  const ownershipResult = validateStorageOwnership(document as Workflow, source);
  if (ownershipResult.isErr()) {
    return ownershipResult;
  }

  // Runs late, and only once the schema has passed: `validateStorageSizes`
  // reads `storage.keys[key].strategy.valueSizeMax` as a number, which is only
  // true of a document the schema has already accepted. Wiring it in here
  // rather than at each call site means every entry point that verifies a
  // document — `workflow verify`, `workflow lock`, `workspace verify`,
  // `runWorkflow` — enforces the declared budget without repeating the call.
  const sizeResult = validateStorageSizes(document as Workflow, source);
  if (sizeResult.isErr()) {
    return sizeResult;
  }

  // Last, and after the schema for the *same* requirement one step stronger:
  // this reads whole resolved strategies — `redis-kv`'s `backend:` among them —
  // and asks the strategy registry which store each names, so it needs a
  // document whose strategy blocks are genuine union members rather than
  // whatever the file happened to contain.
  //
  // After `validateStorageSizes` rather than before it because the two are
  // about different subjects, and this is the wider one. That function reports
  // each key's *own* declaration — its length, its characters, its seed — which
  // is what an author fixes field by field; this one reports the key table
  // compared against itself, which is a decision about the document as a whole.
  // Same ordering, and same reasoning, as the unwritten-read rule coming last
  // *within* `validateStorageSizes`: an author reading the list top-down has
  // finished with the individual declarations by the time they reach a
  // statement about how those declarations fit together.
  return validateCoTransactionalStore(document as Workflow, source);
}

/**
 * Validate a workflow in *resolved* form — the output of `resolveWorkflow` and
 * the input of the XState machine layer.
 *
 * Separate from {@link validateWorkflowType} because the two models are
 * genuinely different schemas: a resolved workflow has no `kind:`, carries
 * `stepList`/`pluginPathList`, and never comes from a file.
 */
export function validateResolvedWorkflow(workflow: unknown): Result<void, Error> {
  if (!resolvedWorkflowValidator.Check(workflow)) {
    const errorDetails = formatValidationErrors(
      resolvedWorkflowValidator.Errors(workflow),
      workflow,
    );
    return err(
      new Error(
        `Preflight Check: Resolved workflow validation failed:\n${errorDetails}`,
      ),
    );
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Storage boundaries
//
// The resolved-model half of the write boundary. `WriteBoxLocation` has no
// `workflow` field, so this layer's job is to say *in words* what the closed
// schema says as an unknown property, naming the workflow and workspace a
// location reached for.
//
// **It is not the whole of the boundary, and cannot be.** A key may declare its
// owner on the key table (`storage.keys.<key>.workflow`), and a write to such a
// key resolves into an entirely well-formed `WriteBoxLocation` addressed to the
// running workflow — the declaration is an authoring fact and does not survive
// resolution, so there is nothing here to detect. That case is refused against
// the *document*, by `collectStorageOwnershipProblems` above, which is the only
// layer that can still see both the key table and the binding. The two are
// halves of one rule and are written to be read together.
// ---------------------------------------------------------------------------

/**
 * Properties a *write* location may carry. `WriteBoxLocation` is
 * `{ key, strategy }`: deliberately no `workflow` and no `workspace`, because
 * `buildBoxRecord` always resolves a write against the *current* workflow and
 * workspace. A step can therefore only ever write into its own workflow.
 *
 * This set must stay in step with `WriteBoxLocation` (`@rawbox/store`,
 * `box.ts`), which must itself stay without a `workflow` field: moving the
 * cross-workflow *declaration* onto the key table changed where the rule is
 * checked, not what the resolved model is able to express.
 */
const WRITE_LOCATION_PROPERTIES = new Set(['key', 'strategy']);

/**
 * Properties a *read* location may carry. `ReadBoxLocation` adds an optional
 * `workflow`, which is what makes cross-workflow reads expressible — but still
 * no `workspace`, so a read never crosses a workspace boundary.
 */
const READ_LOCATION_PROPERTIES = new Set(['key', 'strategy', 'workflow']);

function describeStep(label: string | undefined, index: number): string {
  return label ? `"${label}"` : `#${index}`;
}

/**
 * Check one box location against the properties its role permits.
 *
 * The runtime schemas express the boundary purely as *absent fields*, and
 * `WriteBoxLocation`/`ReadBoxLocation` are closed, so a stray `workspace:` does
 * not pass the schema to be silently discarded by `buildBoxRecord`.
 *
 * This function is what remains necessary on top: the schema can say that
 * `workspace` is not a property of a write location, but only this can say that
 * a step may never write outside its own workspace, and which workspace it
 * named. It therefore runs *before* the resolved-model schema, the way every
 * targeted check in this file runs before the schema it improves on.
 */
function checkBoxLocation(parameters: {
  location: unknown;
  allowedProperties: Set<string>;
  role: 'input' | 'output' | 'error';
  field: string;
  stepDescription: string;
  workflowName: string;
  workspace: string;
}): string | undefined {
  const {
    location,
    allowedProperties,
    role,
    field,
    stepDescription,
    workflowName,
    workspace,
  } = parameters;

  if (!isPlainObject(location)) {
    return `Step ${stepDescription}: ${role} "${field}" is not a storage location object.`;
  }

  const isWrite = role !== 'input';
  const verb = isWrite ? 'write to' : 'read from';

  for (const property of Object.keys(location)) {
    if (allowedProperties.has(property)) {
      continue;
    }

    if (property === 'workspace') {
      const target = location.workspace;
      const named =
        typeof target === 'string' && target !== workspace
          ? ` (it names workspace "${target}", but this workflow runs in "${workspace}")`
          : '';
      return (
        `Step ${stepDescription}: ${role} "${field}" declares a "workspace" property${named}. ` +
        `A step may never ${verb} another workspace — storage locations are always scoped to the running workspace.`
      );
    }

    if (property === 'workflow' && isWrite) {
      const target = location.workflow;
      const named =
        typeof target === 'string' && target !== workflowName
          ? ` (it names workflow "${target}", but this workflow is "${workflowName}")`
          : '';
      return (
        `Step ${stepDescription}: ${role} "${field}" declares a "workflow" property${named}. ` +
        `A step may only write into its own workflow; only inputs may name another workflow.`
      );
    }

    return `Step ${stepDescription}: ${role} "${field}" declares an unknown storage property "${property}".`;
  }

  // A cross-workflow read is legal, but an empty name is not: `buildBoxRecord`
  // treats it as falsy and silently substitutes the current workflow.
  if (
    !isWrite &&
    'workflow' in location &&
    (typeof location.workflow !== 'string' || location.workflow.length === 0)
  ) {
    return `Step ${stepDescription}: input "${field}" declares an empty "workflow" property; omit it to read from the current workflow.`;
  }

  return undefined;
}

/**
 * Validate that every storage location in a *resolved* workflow respects the
 * workspace and workflow boundaries.
 *
 * Two boundaries are enforced:
 *
 * 1. **Writes never leave their own workflow.** Outputs and errors may not
 *    carry `workflow` or `workspace`.
 * 2. **Nothing ever leaves its workspace.** No location of any role may carry
 *    `workspace`. Inputs may carry `workflow`, which is a cross-workflow read
 *    and is permitted.
 *
 * The authoring schemas make both unrepresentable in a *file*: `WriteStorageRef`
 * has no `workflow` and no `workspace`, and is closed. This runs on the
 * resolved model, which the resolver builds rather than parsing from disk, so
 * it is the layer where a location that crossed a boundary would have to have
 * been constructed rather than written — and where the diagnostic can name the
 * workflow and workspace involved, which a schema error cannot.
 *
 * **A third boundary is enforced elsewhere and deliberately not here**: a write
 * to a key the document declares to be another workflow's. It is invisible in
 * this model — such a write resolves to an ordinary local `WriteBoxLocation` —
 * so it is checked against the document by {@link validateStorageOwnership}.
 * See this section's header.
 */
export function validateStorageBoundaries(
  workflow: ResolvedWorkflow,
  workspace: string,
): Result<void, Error> {
  const stepList = workflow.stepList ?? [];

  for (const [index, step] of stepList.entries()) {
    const stepDescription = describeStep(step.label, index);
    const storageLocation = step.storageLocation;

    if (!isPlainObject(storageLocation)) {
      return err(
        new Error(
          `Preflight Check: Storage boundary validation failed:\n  - Step ${stepDescription} has no storage locations.`,
        ),
      );
    }

    const roleList = [
      { role: 'input' as const, record: storageLocation.input, allowed: READ_LOCATION_PROPERTIES },
      { role: 'output' as const, record: storageLocation.output, allowed: WRITE_LOCATION_PROPERTIES },
      { role: 'error' as const, record: storageLocation.error, allowed: WRITE_LOCATION_PROPERTIES },
    ];

    for (const { role, record, allowed } of roleList) {
      if (record === undefined) {
        continue;
      }

      if (!isPlainObject(record)) {
        return err(
          new Error(
            `Preflight Check: Storage boundary validation failed:\n  - Step ${stepDescription}: "${role}" is not a record of storage locations.`,
          ),
        );
      }

      for (const [field, location] of Object.entries(record)) {
        const problem = checkBoxLocation({
          location,
          allowedProperties: allowed,
          role,
          field,
          stepDescription,
          workflowName: workflow.name,
          workspace,
        });

        if (problem) {
          return err(
            new Error(
              `Preflight Check: Storage boundary validation failed:\n  - ${problem}`,
            ),
          );
        }
      }
    }
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

interface ContractShape {
  inputSchema?: { properties?: Record<string, unknown> };
  /** `"operation"` or `"control-flow"`; see {@link collectTimeoutWarnings}. */
  type?: unknown;
}

/**
 * Validate seed values against the input schemas of the steps that consume
 * them.
 *
 * Runs on **resolver output**, not the raw file: a `storage.keys` entry states
 * a seed as arbitrary data, and it is the resolver that expands a binding into
 * a `ReadBoxLocation` and attaches each seed's strategy from the key table.
 * Only after that expansion can a seed be paired to the input *field* whose
 * `inputSchema` property types it.
 *
 * This is the *only* place a value an author wrote is type-checked against the
 * field that consumes it, and the only place one needs to be: a constant is
 * seeded like any other input.
 *
 * Pairing is "scan `storageLocation.input` for `readBoxLoc.key === seed.key`".
 * Two consequences follow:
 *
 * - A seed belongs to the workflow that declares it, so an input reading from
 *   *another* workflow is not fed by it and is skipped.
 * - An `lmdb-fifo` seed reaches this function already expanded, one `Seed` per
 *   list element, so each element is checked against the consuming field's
 *   schema on its own. That is the correct pairing rather
 *   than an accident of the expansion: one `get` on an `lmdb-fifo` key dequeues
 *   one entry, so the field's schema types one entry.
 *
 * Several entries therefore share a key here, which nothing in this function
 * assumes otherwise — the seed list is scanned, never indexed by key.
 *
 * A seed matching no input is not an error — seeding a key no step consumes is
 * harmless.
 */
export function validateSeedData(
  workflow: ResolvedWorkflow,
  contractRegistryCache: ContractRegistryCache,
): Result<void, Error> {
  if (!workflow.seedData || workflow.seedData.length === 0) {
    return ok(undefined);
  }

  for (const seed of workflow.seedData) {
    for (const [index, step] of workflow.stepList.entries()) {
      const { contractRegistryHash, definitionPath } = step.definitionLocation;

      const registry = contractRegistryCache.getContractRegistry(contractRegistryHash);
      if (!registry) {
        continue;
      }

      const contract = registry.contractRecord[definitionPath] as
        | ContractShape
        | undefined;
      const properties = contract?.inputSchema?.properties;
      if (!properties) {
        continue;
      }

      const inputRecord = step.storageLocation.input ?? {};
      for (const [fieldName, readBoxLocation] of Object.entries(inputRecord)) {
        if (readBoxLocation.key !== seed.key) {
          continue;
        }

        // Cross-workflow read: fed by the named workflow's storage, not
        // by a seed declared here.
        if (
          readBoxLocation.workflow !== undefined &&
          readBoxLocation.workflow !== workflow.name
        ) {
          continue;
        }

        const expectedSchema = properties[fieldName];
        if (!expectedSchema) {
          continue;
        }

        const validator = Compile(expectedSchema);
        if (!validator.Check(seed.value)) {
          const errorDetails = formatValidationErrors(
            validator.Errors(seed.value),
            seed.value,
          );
          return err(
            new Error(
              `Preflight Check: Seed validation failed for key "${seed.key}" used in step ${describeStep(step.label, index)} (input field "${fieldName}"):\n${errorDetails}`,
            ),
          );
        }
      }
    }
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Bounds that are legal but probably not meant
//
// A bound's spelling is decided by the document alone and is an error
// (`collectTimeoutSpellingProblems`). Whether a bound *makes sense* needs the
// contract behind the step, so it belongs here, on resolver output — and it is
// a warning rather than an error, because the runner enforces what a document
// says and an author is allowed to mean something surprising.
// ---------------------------------------------------------------------------

/**
 * Bounds a document declares that are worth a second look, as author-facing
 * lines. An empty list means nothing stood out; it never fails a run.
 *
 * **One rule for now: a bound on a control-flow step.** A control-flow handler
 * receives its inputs, decides a label and returns — it steers execution and
 * waits on nothing, so there is no third party for a timer to rescue the run
 * from. A bound there either never fires (and is noise in the document) or
 * fires on a handler that was merely slow, ending the run for no reason.
 *
 * A second rule was designed and deliberately **not** shipped: warning when a
 * bound is smaller than the step's own `ms`-style seed, e.g. `timeoutMs: 500`
 * on a `time/sleep` whose `ms` is seeded `2000`, which cannot do anything but
 * abandon the run every time. Deciding that from field *names* was measured
 * against a real downstream workflow set and produced four false positives:
 * most `*Ms` inputs out there are thresholds a handler compares against, not
 * durations it waits out, and the two are indistinguishable from the schema. It
 * needs a contract field saying which input is the wait
 * (`waitsForInputMs`), and that field is not worth adding for a warning.
 *
 * @param workflow - resolver output, where `timeoutMs` is already merged and
 *   `unbounded` has already collapsed into an absent key.
 * @param contractRegistryCache - the loaded registries, to reach each step's
 *   contract by its `definitionLocation`.
 */
export function collectTimeoutWarnings(
  workflow: ResolvedWorkflow,
  contractRegistryCache: ContractRegistryCache,
): string[] {
  const warnings: string[] = [];

  for (const [index, step] of workflow.stepList.entries()) {
    if (step.timeoutMs === undefined) continue;

    const { contractRegistryHash, definitionPath } = step.definitionLocation;
    const registry = contractRegistryCache.getContractRegistry(contractRegistryHash);
    const contract = registry?.contractRecord[definitionPath] as
      | ContractShape
      | undefined;

    if (contract?.type !== 'control-flow') continue;

    warnings.push(
      `Step ${describeStep(step.label, index)} declares timeoutMs: ` +
        `${step.timeoutMs}, but "${definitionPath}" is a control-flow ` +
        `contract.${DETAIL}` +
        `A control-flow handler chooses the next step and returns — it waits ` +
        `on nothing outside the process, so a bound on it has nothing to ` +
        `rescue the run from: it either never fires, or ends the run because ` +
        `a decision took a moment longer than expected.${DETAIL}` +
        `Bound the step that does the waiting instead, and remove this ` +
        `timeoutMs: (if the bound comes from the contract rather than from ` +
        `this document, it is the plugin that declared it).`,
    );
  }

  return warnings;
}
