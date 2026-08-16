import { Type, type Static } from 'typebox';

import { StrictObject } from '@rawbox/store';

import { keyPath } from '../workflow/key-table.js';
// Type-only, and it has to stay that way: `events/ndjson-file-sink.ts` imports
// this module's rotation constants at runtime, so a value import back the
// other way would close a cycle whose module-evaluation order leaves that
// file's `DEFAULT_ROTATE` reading an uninitialised binding. `import type` is
// erased outright (`verbatimModuleSyntax`), so this costs nothing at runtime
// and still lets {@link LogSteps} be checked against the sink's own spelling
// of the same three values — see the assertions below it.
import type { StepDetail } from '../events/ndjson-file-sink.js';
import type { Workspace } from './workspace-types.js';

// ---------------------------------------------------------------------------
// `logs:` — how a workspace's run-event files are written, rotated and pruned
//
// ## Why this is on the workspace document
//
// A log bound is a deployment fact, not a workflow fact. The same workflow runs
// on a laptop with a 500 MB disk budget and on a box that keeps a fortnight of
// history; nothing about the workflow's steps changes between them. That is the
// same argument `backends:` makes for connection strings and `seedOverrides:`
// makes for per-environment values — a workspace is ONE storage environment
// (root README, "How It Works"), and the environment's limits are the
// workspace's to state.
//
// ## Why it is in the validated document rather than `rawbox.config.json`
//
// These bounds used to live in an untyped `rawbox.config.json`, whose reader
// *silently dropped* anything of the wrong type: `"maxBytes": "50mb"` was not
// an error, it was a `50 MB` default and no diagnostic anywhere. An author who
// mistyped a retention bound therefore discovered it as a full disk weeks
// later. That file is gone — `resolveLogsConfig`, below, is what every reader
// now asks for these bounds instead.
//
// Every object here is consequently `StrictObject` — closed — for the same
// reason every other authoring schema in the format is: a misspelt
// `maxFiles`/`maxfiles` must be reported as an unknown property, not accepted
// and ignored. Closing the schema is the *point* of moving the block here, not
// a tidiness preference.
//
// ## What is specified here and what is not
//
// This module states the format. It does not rotate, prune or write anything:
// the file sink (`events/ndjson-file-sink.ts`) and `runs prune`
// (`rawbox-cli`, `runs/prune.ts`) read these fields, and their behaviour is
// documented at each field below so the two implementations cannot disagree
// about what a number means.
// ---------------------------------------------------------------------------

/**
 * Smallest legal `rotate.maxBytes`, in bytes.
 *
 * 4096 is one filesystem block on every platform this runs on — a segment
 * smaller than that occupies a block anyway, so nothing below it buys any
 * disk back. It is also comfortably above one run event: events are one
 * `JSON.stringify`d line each, so a bound of, say, `100` would start a new
 * segment on *every* line, produce `maxFiles` files within a second and then
 * delete the run's whole history on the next one. The floor exists to make
 * that misconfiguration unrepresentable rather than merely unlikely.
 */
export const LOG_ROTATE_MAX_BYTES_MIN = 4096;

/**
 * `logs.rotate:` — when the run-event sink starts a new segment, and how many
 * segments of one run survive.
 *
 * **Segment naming, fixed here so every later reader agrees.** `<run_id>.ndjson`
 * is segment 0 — the live file, byte-for-byte the file that exists today — and
 * its successors are `<run_id>.1.ndjson`, `<run_id>.2.ndjson`, … Numbering is
 * forward: a segment is written once, is immutable the moment it is superseded,
 * and is never renamed and never truncated. (The alternative, logrotate's
 * shift-everything-up-by-one scheme, renames every file on every roll, which
 * breaks any reader holding a path — `workspace logs -f` among them — and
 * rewrites N files to retire one.)
 *
 * **One run's worst case is therefore `maxBytes * maxFiles`**, which is the
 * number an operator actually sizes a volume against, and it is a product of
 * exactly these two fields — which is why {@link collectLogRotationProblems}
 * refuses one of them without the other.
 *
 * Both fields optional, and both absent means **the built-in default pair**
 * ({@link LOG_ROTATE_DEFAULT_MAX_BYTES} * {@link LOG_ROTATE_DEFAULT_MAX_FILES}
 * = 1 GiB per run): rotation is **on by default**. Declaring one field without
 * the other is still refused by {@link collectLogRotationProblems} — a default
 * pair is a policy, half a declared pair is a mistake.
 *
 * On-by-default was chosen deliberately, and it does delete history: a run
 * whose single log passes 1 GiB loses its oldest segment. Only daemon-shaped
 * workflows reach that — a short run never opens segment 1 — so the runs it
 * changes are exactly the ones whose logs grow without bound, and the
 * alternative left the framework with no default ceiling at all once the
 * registry-wide byte budget became rotation-aware.
 */
export const LogRotate = StrictObject({
  /**
   * Maximum bytes of ONE segment before the sink starts the next one.
   *
   * `Type.Integer` rather than `Type.Number`: a byte count is a count, and
   * `134217728.5` is a typo rather than a policy. Minimum
   * {@link LOG_ROTATE_MAX_BYTES_MIN} — see there for why a small value is a
   * history-destroying misconfiguration rather than a tight budget.
   *
   * The bound is checked between lines, so a segment closes at the first line
   * that carries it past `maxBytes` rather than being split mid-line: a
   * segment file is always whole NDJSON, and may end slightly above the bound
   * by the length of that last event.
   */
  maxBytes: Type.Optional(Type.Integer({ minimum: LOG_ROTATE_MAX_BYTES_MIN })),
  /**
   * How many segments of ONE run are kept. When a roll would exceed this, the
   * OLDEST segment is deleted.
   *
   * Minimum `1`, because segment 0 is the file the sink is writing: `1` means
   * "keep the live segment only", i.e. roll and immediately discard what came
   * before — a legal, if aggressive, policy. `0` would mean deleting the file
   * currently being appended to, which is not a retention policy but a broken
   * run, so the schema refuses it rather than leaving the sink to decide.
   *
   * There is no upper bound: `maxBytes * maxFiles` is the operator's budget to
   * set, and any ceiling picked here would be a guess about someone else's
   * disk.
   */
  maxFiles: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type LogRotate = Static<typeof LogRotate>;

/**
 * `logs.prune:` — the three `runs prune` bounds, as a workspace-level default.
 *
 * These are the bounds `rawbox-cli`'s `runs/prune.ts` already applies (and the
 * ones `workflow run` applies opportunistically at start); this block is where
 * a workspace declares them, replacing `rawbox.config.json`'s `runs.prune`
 * section. Semantics are unchanged and are documented in full at `pruneRuns`:
 * the three compose in the order `olderThanDays` → `keep` → `maxBytes`, a live
 * run is exempt from all three, and at least one entry always survives a pass.
 *
 * A CLI flag still wins over what is written here, matching the precedence
 * `seedOverrides:` already establishes for values: **CLI > workspace >
 * built-in default**.
 *
 * Every field optional, and an absent field means "no bound of this kind" —
 * not zero. That distinction is why the minimum below can safely be `0`. The
 * one exception is `keep`: it carries a built-in default
 * ({@link DEFAULT_PRUNE_KEEP}), so it is the bound always in effect even when
 * this whole block, or the whole `logs:` block, is omitted — see below.
 *
 * **`keep`, not `maxBytes`, is now the primary always-on bound.** Before
 * segment rotation ({@link LogRotate}) existed, `maxBytes` carried an
 * unconditional built-in default because it was the only bound that could
 * ever apply with zero configuration. Rotation gives every run a ceiling of
 * its own — `rotate.maxBytes * rotate.maxFiles` — which makes a directory's
 * ceiling naturally a run *count* instead: **the worst case a workspace's
 * `.rawbox/runs/` + log directory can reach is `keep * rotate.maxBytes *
 * rotate.maxFiles`**, at the defaults `20 * 128 MiB * 8 = 20 GiB`. That
 * product is what an operator sizing a volume actually needs, and it spans
 * both halves of this document — see {@link DEFAULT_PRUNE_KEEP} for the full
 * reasoning behind `20`, and {@link LogRotate} for the `maxBytes * maxFiles`
 * half of the same product. `logs.rotate` and `logs.prune` are two halves of
 * one disk budget; a reader tuning either should look at the other too.
 * `maxBytes` here remains fully supported, and is still the primary bound
 * *when set* — explicit or via this document — but it no longer has a
 * built-in fallback of its own: an unconfigured workspace is bounded by
 * `keep` alone.
 */
export const LogPrune = StrictObject({
  /**
   * Keep only the `keep` most recently started runs.
   *
   * **The always-on bound.** Left undeclared here, `keep` still resolves to
   * {@link DEFAULT_PRUNE_KEEP} (`resolveLogsConfig`) rather than to "no bound
   * of this kind" the way `olderThanDays` and `maxBytes` do — see this
   * block's own doc for why the built-in default lives on `keep` rather than
   * `maxBytes` now.
   *
   * Minimum `0`, and `0` is meaningful rather than a degenerate case: it asks
   * for no retained history at all, which `pruneRuns` honours as far as it can
   * (live runs stay, and one entry always survives). A negative count names
   * nothing — `pruneRuns` already clamps with `Math.max(0, keep)`, and this
   * schema is what stops an author from ever relying on that clamp.
   *
   * Integer for the obvious reason: it counts runs.
   */
  keep: Type.Optional(Type.Integer({ minimum: 0 })),
  /**
   * Delete anything started more than this many days ago.
   *
   * Minimum `0`; `0` means "every finished run is past the cutoff". Days
   * rather than hours or seconds because that is the unit an operator states
   * retention in, and integer days rather than fractional ones because
   * `olderThanDays: 0.5` is indistinguishable from a units mistake — anyone
   * wanting sub-day precision is really asking for `maxBytes`, which bounds
   * the thing they actually care about.
   */
  olderThanDays: Type.Optional(Type.Integer({ minimum: 0 })),
  /**
   * Delete oldest-first until the surviving set's total bytes are at or under
   * this.
   *
   * Minimum `0` and no floor beyond it, unlike {@link LogRotate.maxBytes}:
   * this bounds a whole directory rather than one file, `pruneRuns` guarantees
   * at least one survivor regardless, and a deliberately tiny budget ("keep
   * essentially nothing between runs") is a coherent thing to ask for on a
   * constrained device.
   *
   * This is the primary bound *when it is set* — see `pruneRuns` — because
   * bytes are what a disk runs out of and a run count is only a proxy for it.
   * Left undeclared, though, it stays undefined — "no bound of this kind" —
   * with no built-in fallback of its own; `keep` (above) is what always
   * bounds the directory when nobody sets this.
   */
  maxBytes: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type LogPrune = Static<typeof LogPrune>;

/**
 * `logs.steps:` — how much of a `step.start` / `step.end` the **main** run-event
 * log keeps. Three values, and `full` is the default.
 *
 * The other two bounds in this block cap a log *after* it has been written —
 * `rotate` decides when a segment ends, `prune` decides which runs survive.
 * This one is the only field here that changes what is written in the first
 * place, and it exists because of where the bytes actually come from: in a
 * measured workspace of four looping workflows, `step.start`/`step.end` were
 * **91% of all log bytes** (9.66 GB of 10.6 GB a day), because those two kinds
 * carry `input` and `output` — the records the workflow read and produced —
 * and those grow with the state the workflow accumulates. One measured payload
 * went from ~1 KB to ~120 KB as a retention window filled, written ~9 times a
 * second.
 *
 * Rotation bounds that, but only by deleting: at the default pair, a workflow
 * writing at that rate loses its entire history to `maxFiles` in hours, so what
 * survives is a few minutes of very detailed logs rather than a day of usable
 * ones. `steps: summary` keeps the day.
 *
 * - **`full`** (default) — every field, exactly as the producer emitted it.
 * - **`summary`** — `step.start`/`step.end` reach the main log with `input`
 *   and `output` omitted. Everything else is kept: `step`, `outcome`,
 *   `duration_ms`, `error`, `severity` and the whole envelope, so the run's
 *   shape, its timings and its failures are all still on disk — only the
 *   values the steps moved are gone. Both fields are optional on their
 *   schemas, so the line still validates as the same event kind.
 * - **`off`** — no `step.start`/`step.end` in the main log at all.
 *
 * **The error log is not affected by any of the three.** A failed `step.end`
 * keeps its full `input`/`output` in `<run-id>.error.ndjson` even under `off`
 * — losing successful step records is the trade this field offers, losing the
 * failing step's diagnostics is not, and a value that did that would be one
 * nobody could afford to set. The sink is where that invariant lives
 * (`events/ndjson-file-sink.ts`, its "`logs.steps`" section); this is where
 * the field is declared.
 *
 * A union of three string literals rather than a boolean pair or an integer
 * level: the three are a *policy*, not a threshold, and there is no fourth
 * point on the line to leave room for. A closed set also means the schema
 * refuses `steps: sumary` outright, which is the whole reason this block lives
 * in the validated document (see this module's header) — a mistyped retention
 * policy must be a diagnostic, never a silent default.
 */
export const LogSteps = Type.Union([
  Type.Literal('full'),
  Type.Literal('summary'),
  Type.Literal('off'),
]);
export type LogSteps = Static<typeof LogSteps>;

/** A compile-time `T extends true` assertion: fails the build, emits nothing. */
type Assert<T extends true> = T;

/**
 * {@link LogSteps} and the sink's {@link StepDetail} are one set of values,
 * checked here in both directions.
 *
 * The three literals are spelled out twice — once as a schema here, once as a
 * const object in `events/ndjson-file-sink.ts` — because this module may not
 * take a runtime import from `events/` (see the `import type` at the top for
 * the cycle that would create). These two lines are what make the duplication
 * safe: add a fourth value on either side alone and the build fails here,
 * rather than a document accepting a value the sink silently treats as `full`.
 */
type _StepsCoverSink = Assert<StepDetail extends LogSteps ? true : false>;
type _SinkCoversSteps = Assert<LogSteps extends StepDetail ? true : false>;

/**
 * `logs:` — the workspace's run-event log configuration.
 *
 * Every field is optional and so is the block itself: `logs: {}` is legal and
 * means exactly what omitting it means — all defaults. It is spelled out rather
 * than refused because an author who has written the key and is about to fill
 * it in should not be told the empty form is an error.
 *
 * Closed, like every other authoring schema here, so `logs: { rotation: … }`
 * is reported as the unknown property it is instead of being dropped on the
 * floor the way `rawbox.config.json` used to drop it.
 */
export const WorkspaceLogs = StrictObject({
  /**
   * Whether the run-event file sink buffers its writes. **Default `false`,
   * deliberately.**
   *
   * The sink writes synchronously (`appendFileSync`, see
   * `events/ndjson-file-sink.ts`) so that a run killed mid-workflow still has
   * its last events on disk — which is precisely the run whose log someone
   * needs, and precisely the moment a buffered writer loses the lines
   * explaining why. Event volume is one line per step rather than per byte of
   * data, so the synchronous cost is not the bottleneck it would be in a
   * request logger.
   *
   * `true` trades that durability for throughput and exists for high-volume
   * users who have measured the cost and know what they are giving up. The
   * safe value being the default is a decision, not an oversight: the failure
   * modes are not symmetric — buffering costs a diagnostic exactly when one is
   * needed, while not buffering costs some syscalls on a workload that is not
   * syscall-bound.
   */
  async: Type.Optional(Type.Boolean()),
  /**
   * How much of a step event the main log keeps — see {@link LogSteps}. The
   * only field here that changes what is *written*, rather than how much of it
   * is kept afterwards.
   */
  steps: Type.Optional(LogSteps),
  /** Segment rotation for one run's log — see {@link LogRotate}. */
  rotate: Type.Optional(LogRotate),
  /** Cross-run retention — see {@link LogPrune}. */
  prune: Type.Optional(LogPrune),
});
export type WorkspaceLogs = Static<typeof WorkspaceLogs>;

/** Continuation indent for the extra lines of one diagnostic. */
const DETAIL = '\n    ';

/**
 * The rule stated once, so both directions of the diagnostic below read the
 * same way round.
 */
const ROTATION_RULE =
  `Rotation is defined by both numbers together: maxBytes decides when a ` +
  `segment ends, maxFiles decides how many of a run's segments are kept, and ` +
  `their product (maxBytes * maxFiles) is the disk one run can occupy. ` +
  `Neither one alone states a policy.`;

/**
 * The cross-field check a schema cannot make: `logs.rotate` must declare
 * **both** `maxBytes` and `maxFiles`, or neither.
 *
 * TypeBox can require a field or make it optional; it cannot say "these two are
 * optional together". And the pair genuinely is one setting: with `maxBytes`
 * alone the sink would roll forever and keep every segment, so a bound meant to
 * cap disk use would instead guarantee unbounded growth in file *count*; with
 * `maxFiles` alone there is no size at which to roll, so nothing ever rotates
 * and the field reads as configured while doing nothing. Half-configured
 * rotation is worse than none, because it looks like a policy in the document.
 *
 * There is deliberately no defaulting of the missing half. A guessed segment
 * size decides how much of a run's history one file holds and how often the
 * oldest is deleted — that is the operator's call, and inventing it silently is
 * the exact `rawbox.config.json` behaviour this block exists to end.
 *
 * Returns `string[]` rather than a `Result`, matching
 * `collectSeedOverridePathProblems` and `collectBackendEnvProblems`: the
 * three callers that verify a workspace document each collect problems from
 * several sources and report them together, so a per-problem list composes
 * where an `Error` would not.
 *
 * Reads `unknown` rather than {@link WorkspaceLogs}, for the same reason
 * `collectSeedOverridePathProblems` reads defensively: `workflow verify` holds
 * a workspace document it has deliberately not schema-validated, and this check
 * must still be able to run against it.
 *
 * @param parameters.logs - The workspace's `logs:` block, if it has one.
 * @param parameters.source - How the workspace document is named in a
 *   diagnostic.
 * @returns One diagnostic when rotation is half-configured; empty otherwise.
 */
export function collectLogRotationProblems(parameters: {
  logs: unknown;
  source: string;
}): string[] {
  const { logs, source } = parameters;

  if (typeof logs !== 'object' || logs === null || Array.isArray(logs)) {
    return [];
  }

  const rotate = (logs as { rotate?: unknown }).rotate;
  if (typeof rotate !== 'object' || rotate === null || Array.isArray(rotate)) {
    return [];
  }

  const { maxBytes, maxFiles } = rotate as {
    maxBytes?: unknown;
    maxFiles?: unknown;
  };

  const hasMaxBytes = maxBytes !== undefined;
  const hasMaxFiles = maxFiles !== undefined;

  if (hasMaxBytes === hasMaxFiles) {
    return [];
  }

  const declared = hasMaxBytes
    ? { name: 'maxBytes', value: maxBytes }
    : { name: 'maxFiles', value: maxFiles };
  const missing = hasMaxBytes ? 'maxFiles' : 'maxBytes';
  const remedy = hasMaxBytes
    ? `Add ${keyPath('logs.rotate', 'maxFiles')} (how many segments of one run ` +
      `to keep, 1 or more)`
    : `Add ${keyPath('logs.rotate', 'maxBytes')} (the size one segment reaches ` +
      `before the next begins, ${LOG_ROTATE_MAX_BYTES_MIN} bytes or more)`;

  return [
    `Log rotation is half-configured: ${keyPath('logs.rotate', declared.name)} ` +
      `is set to ${JSON.stringify(declared.value)}, but ` +
      `${keyPath('logs.rotate', missing)} is missing.${DETAIL}` +
      `Declared at logs.rotate in "${source}".${DETAIL}` +
      `${ROTATION_RULE}${DETAIL}` +
      `${remedy}, or remove ${keyPath('logs.rotate', declared.name)} to fall ` +
      `back to the built-in pair (${LOG_ROTATE_DEFAULT_MAX_BYTES} bytes * ` +
      `${LOG_ROTATE_DEFAULT_MAX_FILES} segments). Rotation is on by default, ` +
      `so removing both fields is a policy; declaring one is not. The missing ` +
      `field is not defaulted on its own on purpose: pairing a stated number ` +
      `with a guessed one would decide how much of a run's history survives ` +
      `without you having said so.`,
  ];
}

// ---------------------------------------------------------------------------
// Resolving `logs:` — CLI override, then the workspace document, then a
// built-in default, decided independently PER FIELD.
//
// `WorkspaceLogs` states what a document MAY declare, which is why every
// field on it is optional; a consumer needs a number, not "check three
// places and decide what absence means" repeated at every call site. This is
// the one place that decision is made, so the sink (`async`/`rotate`, via
// `runWorkflowInstance`'s `logsAsync`/`logsRotate`) and `runs prune`
// (`prune`, `rawbox-cli`'s `runs/prune.ts` and `commands/runs/prune.ts`) both
// read a fully-populated {@link ResolvedLogsConfig} and never re-implement it.
//
// The precedence — CLI > workspace.yaml > built-in default — is the same
// order `seedOverrides:` establishes for a seed value (`seed-overrides.ts`'s
// module doc), but applied here PER FIELD rather than to a whole block: a
// workspace may declare `prune.keep` while a `--max-bytes` flag supplies the
// byte bound, and the two compose instead of one replacing the other's whole
// `prune:` object the way a seed override replaces a whole seed.
// ---------------------------------------------------------------------------

/**
 * `rotate.maxBytes` / `rotate.maxFiles` {@link resolveLogsConfig} falls back
 * to when neither a CLI override nor the workspace document supplies either
 * half of the pair. 128 MiB * 8 segments = 1 GiB per run.
 *
 * **Rotation is on by default**, so a workspace declaring no `logs:` at all
 * still resolves to this pair and its runs rotate. That is the settled
 * decision, and there is deliberately no `enabled` flag: a workspace that
 * wants unbounded logs raises `maxFiles`, which states the ceiling it wants
 * rather than removing the concept of one.
 *
 * It is a data-deleting default, which is why it is written down here. A run
 * only ever loses a segment once its log passes `maxBytes * maxFiles`, so
 * short runs never reach segment 1 and nothing they wrote is touched; the
 * runs that do reach it are the unbounded ones this exists to bound. The
 * alternative — off by default — left no ceiling at all in the default
 * configuration once the registry-wide byte budget became rotation-aware.
 */
export const LOG_ROTATE_DEFAULT_MAX_BYTES = 134217728;

/** Paired with {@link LOG_ROTATE_DEFAULT_MAX_BYTES} — see its doc. */
export const LOG_ROTATE_DEFAULT_MAX_FILES = 8;

/**
 * `runs prune`'s built-in `keep` default, applied when neither an explicit
 * `--keep` flag nor a workspace's `logs.prune.keep` supplies one — so the
 * opportunistic pass at every `workflow run` start always has *some* ceiling
 * (`rawbox-cli`, `runs/prune.ts`'s `pruneRunsOpportunistically`), the way an
 * unconditional `maxBytes` default used to provide before rotation.
 *
 * **Why `keep` and not `maxBytes` now carries the unconditional default.**
 * Before segment rotation (`LogRotate`, above) existed, a run's log had no
 * ceiling of its own, so a byte total was the only bound that could ever
 * apply without configuration. Rotation changes that: a run is now
 * self-bounding at `rotate.maxBytes * rotate.maxFiles`
 * ({@link LOG_ROTATE_DEFAULT_MAX_BYTES} * {@link LOG_ROTATE_DEFAULT_MAX_FILES}
 * = 1 GiB, at the defaults). Once one run has a ceiling, a *directory's*
 * ceiling is naturally a run *count* — `keep` runs, each at most one run's
 * worth of disk — rather than a byte total the pass has to re-derive by
 * walking every entry's segments. A default `maxBytes` on top would still be
 * defensible in principle, but no single byte total is right for every shape
 * of workload: the old unconditional 50 MB default was passed by one daemon
 * run in minutes, and the pass cannot fix that by deleting — the run causing
 * the overflow is the live one it must not touch. `keep` has no such failure
 * mode: it bounds a *count*, which every workload has in the same units,
 * live or finished.
 *
 * **The number itself: `20`.**
 *
 * - **Worst case at the defaults:** `20 * 1 GiB = 20 GiB`. This is reached
 *   only by a workspace of daemon-shaped workflows that each actually fill
 *   their rotation budget — a short run never opens even its second segment,
 *   let alone its eighth.
 * - **Realistic case:** most runs — a scaffolded example workflow, a typical
 *   CI job — write a log measured in KB, not GB, because they finish before
 *   ever approaching `rotate.maxBytes`. Twenty of those cost well under a
 *   megabyte combined, so the default is not felt at all by the common case;
 *   it only bites the workload it exists to bound.
 * - **Why 20 and not the README's illustrative `200`:** `200` is this
 *   module's own documented example value (see `LogPrune.keep`'s doc and the
 *   CLI README), and at `200 * 1 GiB = 200 GiB` it is clearly an example, not
 *   a default — no unconfigured workspace should be handed a 200 GiB
 *   worst case by a package that has never seen its disk. `20` keeps an
 *   order of magnitude of headroom below that while still preserving a
 *   useful run of history (twenty is enough to look back over "yesterday's
 *   failures" or a day of periodic runs) rather than the single-digit count
 *   a maximally conservative default would pick, which would make `runs
 *   list` useless for debugging moments after the pass that ran it.
 * - **Why not scale to zero:** a default that assumed every run were a
 *   daemon (to protect the worst case) would throw away useful history for
 *   every non-daemon workflow, which is the overwhelming majority of what
 *   `keep` actually has to bound day to day. `20` is a deliberate bet that
 *   most workspaces are not daemon-shaped, with `maxBytes` and a lower
 *   `keep` available as an explicit, disk-aware override for the workspaces
 *   that are.
 *
 * The single source of truth for this number: `rawbox-cli` depends on
 * `@rawbox/runner`, never the other way around, so this is where it has to
 * live for both packages to read the same constant instead of two that can
 * drift apart.
 */
export const DEFAULT_PRUNE_KEEP = 20;

/**
 * The `logs:` fields a caller may override, taking precedence over the
 * workspace document — today, `runs prune`'s `--keep` / `--older-than` /
 * `--max-bytes` flags build a `prune` override, and `workflow run`'s
 * `--log-async` / `--log-steps` build the two flat ones. `rotate` has no CLI
 * surface yet; the shape carries it anyway so a future flag is one more field
 * filled in here, not a second override mechanism next to this one.
 *
 * Every field at every level optional, unlike {@link WorkspaceLogs}'s "half a
 * `rotate:` pair is refused": an override isn't authored once and verified
 * the way a workspace document is, it's assembled fresh from whatever flags
 * one command invocation happened to receive, so supplying only `prune.keep`
 * is the ordinary case, not an error.
 */
export interface LogsOverride {
  readonly async?: boolean;
  readonly steps?: LogSteps;
  readonly rotate?: {
    readonly maxBytes?: number;
    readonly maxFiles?: number;
  };
  readonly prune?: {
    readonly keep?: number;
    readonly olderThanDays?: number;
    readonly maxBytes?: number;
  };
}

/** {@link resolveLogsConfig}'s resolved `rotate:` — always a complete pair. */
export interface ResolvedLogRotate {
  readonly maxBytes: number;
  readonly maxFiles: number;
}

/**
 * {@link resolveLogsConfig}'s resolved `prune:`.
 *
 * `keep` is always a number: it is the one bound with a built-in default
 * ({@link DEFAULT_PRUNE_KEEP}), so "nothing configured it" and "it is unset"
 * are not distinguishable outcomes here the way they are for the other two —
 * see {@link DEFAULT_PRUNE_KEEP} for why `keep`, and not `maxBytes`, is the
 * field that always resolves to a number now.
 *
 * `olderThanDays` / `maxBytes` stay `number | undefined` rather than being
 * defaulted to some number — see {@link LogPrune} — because "no bound of this
 * kind" is a real, distinct outcome, not the same thing as any particular
 * number, and inventing one here would be exactly the silent defaulting
 * `logs:` exists to end. Neither field is *optional*, though: a consumer
 * reads `resolved.prune.maxBytes` unconditionally, the same way it reads
 * `resolved.prune.keep`, rather than checking for the property's existence
 * first — it is simply `undefined` when there is truly no bound.
 */
export interface ResolvedLogPrune {
  readonly keep: number;
  readonly olderThanDays: number | undefined;
  readonly maxBytes: number | undefined;
}

/**
 * `logs:`, fully resolved: CLI override, then the workspace document, then a
 * built-in default, decided independently per field. No field here is
 * optional — every consumer reads `resolved.async`, `resolved.rotate.maxBytes`,
 * `resolved.prune.maxBytes`, etc. directly, with no `?? someDefault` of its
 * own that could drift from this function's.
 */
export interface ResolvedLogsConfig {
  readonly async: boolean;
  /**
   * Always one of the three values, never `undefined`: `full` is a real
   * policy — "write the step payloads" — rather than the absence of one, so
   * unlike `prune.maxBytes` there is nothing here for a consumer to
   * distinguish between "unset" and "set to the default".
   */
  readonly steps: LogSteps;
  readonly rotate: ResolvedLogRotate;
  readonly prune: ResolvedLogPrune;
}

/**
 * Resolves a workspace's effective `logs:` configuration: CLI override, then
 * `workspace.logs`, then a built-in default, per field.
 *
 * This performs no cross-field validation of its own — {@link
 * collectLogRotationProblems} is what refuses a half-configured
 * `workspace.logs.rotate` before a document reaches this function, at every
 * command that loads one (`workflow verify`, `workspace verify`, and the run
 * path). Called directly against an unvalidated `logs.rotate` — as a unit
 * test might — this simply resolves each of `maxBytes`/`maxFiles`
 * independently, same as every other field.
 *
 * @param parameters.workspace - The loaded workspace, or `undefined` for a
 *   workspace-less run (`--workspace-name`; rawbox-runner README, "Implicit
 *   (workspace-less) workspaces") — there is no document to read a `logs:`
 *   block from, so every field falls straight to `override` or its built-in
 *   default.
 * @param parameters.override - Highest-precedence values, from a CLI flag.
 *   `undefined`, or a field left unset within it, defers to the workspace and
 *   then the built-in default.
 */
export function resolveLogsConfig(parameters: {
  workspace?: Workspace | undefined;
  override?: LogsOverride | undefined;
}): ResolvedLogsConfig {
  const { workspace, override } = parameters;
  const logs = workspace?.logs;

  return {
    async: override?.async ?? logs?.async ?? false,
    // `'full'` spelled as the literal, exactly as `async` spells `false`: the
    // built-in default of a closed three-value policy is not a number an
    // operator sizes anything against, so it needs no exported constant of its
    // own the way `LOG_ROTATE_DEFAULT_MAX_BYTES` and `DEFAULT_PRUNE_KEEP` do.
    // What it does need is to stay `full` — see {@link LogSteps}; every other
    // value drops data a reader may be looking for, and a default that did
    // that would be one nobody asked for.
    steps: override?.steps ?? logs?.steps ?? 'full',
    rotate: {
      maxBytes:
        override?.rotate?.maxBytes ?? logs?.rotate?.maxBytes ?? LOG_ROTATE_DEFAULT_MAX_BYTES,
      maxFiles:
        override?.rotate?.maxFiles ?? logs?.rotate?.maxFiles ?? LOG_ROTATE_DEFAULT_MAX_FILES,
    },
    prune: {
      keep: override?.prune?.keep ?? logs?.prune?.keep ?? DEFAULT_PRUNE_KEEP,
      olderThanDays: override?.prune?.olderThanDays ?? logs?.prune?.olderThanDays,
      maxBytes: override?.prune?.maxBytes ?? logs?.prune?.maxBytes,
    },
  };
}
