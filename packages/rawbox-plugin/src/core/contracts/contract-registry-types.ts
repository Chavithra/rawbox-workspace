import { type Static, type TObject, Type } from 'typebox';

export const DefinitionPath = Type.String();
export type DefinitionPath = Static<typeof DefinitionPath>;

export const ContractRegistryPath = Type.String();
export type ContractRegistryPath = Static<typeof DefinitionPath>;

/**
 * The structural shape the SDK requires of a contract schema.
 *
 * Generic parameters throughout the SDK are constrained on this rather than on
 * typebox's `TObject` so that a plugin compiled against a *different* copy of
 * typebox still unifies with the framework's types. `TObject` declares
 * `required: TRequiredArray<Properties>` — a computed tuple — and across two
 * copies TypeScript falls back to a structural comparison, evaluates that tuple
 * on both sides and rejects e.g. `["a", "b"]` against `[string]`.
 *
 * The rule this interface must keep obeying: it may *name* fields, but it must
 * never *compute* them. Introducing a conditional or mapped type over a type
 * parameter here would reintroduce the failure it exists to remove.
 *
 * Inference is unaffected: typebox's `Static<>` is constrained on the empty
 * `TSchema` interface and dispatches structurally on the `'~kind'` literal, so
 * it keeps resolving concrete schemas exactly as before.
 */
export interface ObjectSchemaLike {
  readonly '~kind': 'Object';
  readonly type: 'object';
  readonly properties: Record<string, unknown>;
}

/**
 * The widest *concrete* object schema: typebox's `TObject` at its default
 * `TProperties`.
 *
 * This is deliberately **not** a constraint and must never be used as one — it
 * is the single remaining `TObject` in the SDK. It exists only for the erased
 * dynamic-load path (`loadDefinition` and the definition caches), where the
 * concrete schema is unknown at compile time and the loaded value is cast into
 * place rather than statically unified with anything a plugin wrote.
 *
 * The reason it cannot be `ObjectSchemaLike`: typebox's `Static<>` dispatches on
 * `Type extends TObject<infer Properties>`, and `ObjectSchemaLike` — lacking
 * `required` — does not match that branch, so `Static<ObjectSchemaLike>` widens
 * all the way to `object`. Hosts walking a dynamically loaded definition's
 * input/output need the record shape (`{ [x: string]: unknown }`) that
 * `Static<TObject>` yields.
 *
 * Cross-copy safety is not at stake here: this type sits on the host side of
 * the boundary, never in a position where a plugin's own `TObject` is compared
 * against it.
 */
export type AnyObjectSchema = TObject;

/**
 * The largest `timeoutMs` a contract or a step may declare, in milliseconds
 * (~24.8 days).
 *
 * The number is not a taste judgement about how long a step may reasonably
 * wait: it is the point at which Node's timer API stops meaning what the
 * declaration says. `setTimeout` stores its delay in a signed 32-bit integer,
 * and a larger one is clamped to **1ms** with a `TimeoutOverflowWarning` — so a
 * bound written just above this line does not widen, it *inverts*, firing
 * immediately on a step that was meant to be given a month. Rejecting it is the
 * only way the declaration cannot lie.
 *
 * `@rawbox/store`'s `SizeMax` is floored and capped by the same constant
 * (`0x7fffffff`) for the neighbouring reason — a size that no longer fits the
 * integer it is compared against.
 */
export const TIMEOUT_MS_MAX = 2147483647;

export interface Contract {
  type: string;

  /**
   * How long the host may let this component's handler run before the run is
   * abandoned, in milliseconds — a **bounded step**.
   *
   * It sits on the base `Contract`, beside `type` and away from the schemas,
   * because it is the same kind of field `type` is: host-*execution policy*
   * rather than a description of the data crossing the boundary. Both
   * sub-interfaces inherit it rather than redeclaring it, which is what lets
   * every host-side reader stay `Contract`-typed — the runner holds an
   * `OperationContract | ControlFlowContract` union at the point it would
   * enforce a bound, and a field declared on only one arm of that union is not
   * readable off it without a narrowing that has nothing to do with timeouts.
   *
   * **Absent is an answer, not a gap.** Omitting the key declares the component
   * *deliberately unbounded*, and that is the right declaration for a great
   * many handlers: everything purely synchronous (no timer can preempt it
   * anyway — see below), and everything whose wait duration is its own input,
   * where a second number in the contract would only be free to contradict the
   * first. There is no default and no fallback bound; a component the plugin
   * author never thought about is unbounded, which is the honest reading of
   * "never thought about".
   *
   * **Composition is override, not minimum.** A workflow step's own
   * `timeoutMs:` replaces this value outright:
   *
   * ```text
   * effective = step.timeoutMs ?? contract.timeoutMs ?? unbounded
   * ```
   *
   * so a document may tighten a contract's bound, loosen it, or remove it
   * entirely by writing `timeoutMs: unbounded`. Taking the minimum of the two
   * would make "explicitly unbounded" inexpressible wherever a contract already
   * declared a bound, and that shape is real rather than hypothetical: a feed
   * operation that blocks until the next websocket tick is its workflow's
   * pacing mechanism, and a bound on it converts a working document into a
   * crashing one. A workflow also knows things the plugin author cannot — a
   * bound is usually derived from other values seeded in the same document.
   *
   * **A bound is only meaningful where the handler awaits something a third
   * party controls** — a socket, an HTTP response, a lock, a queue that may
   * never be fed. That is the whole of what a timer can rescue.
   *
   * **It cannot preempt synchronous work.** The timer is an ordinary task on
   * the same event loop as the handler, so a handler that never yields — a
   * spinning loop, a synchronous parse of something enormous — never lets the
   * timer fire at all. A bound declared on such a component is not a weak
   * guarantee; it is no guarantee.
   *
   * **It does not cancel the work in flight.** The host stops *waiting*; the
   * request the handler issued is still open, its socket still held, and its
   * eventual settlement still queued. Nothing here is an abort signal, and a
   * handler that must release something on abandonment has to do it itself.
   *
   * Declared as a positive integer of milliseconds, at most
   * {@link TIMEOUT_MS_MAX}; `setupContractRegistry` rejects anything else at
   * module-eval time. The authoring spelling in a workflow document additionally
   * accepts the literal `'unbounded'`, which exists only there — a contract
   * expresses the same thing by leaving the key out.
   *
   * By convention this goes **last** in a contract literal, after `version`:
   * the schemas are what a reader is looking for, and an execution-policy field
   * wedged between them displaces them.
   */
  timeoutMs?: number;
}

export type ContractRecord<TContract extends Contract> = Record<
  DefinitionPath,
  TContract
>;

export interface ContractRegistry<TContract extends Contract> {
  contractRecord: ContractRecord<TContract>;
  contractRegistryPath: ContractRegistryPath;
  rawboxPluginVersion: string;
}

export type SpecificContractRegistry<
  TContractRecord extends ContractRecord<Contract>,
> = ContractRegistry<TContractRecord[keyof TContractRecord]> & {
  contractRecord: TContractRecord;
};
