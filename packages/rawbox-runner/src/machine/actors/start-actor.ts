/**
 * The preflight actor: the last checks that run before the machine executes
 * anything — and, since the definition preload is the one thing here that can
 * block forever, the **preflight bound** that stops waiting on it.
 *
 * ## Why preflight needs a bound of its own
 *
 * `preloadStepDefinitions` `await import()`s every step's definition module
 * before step 0 is selected. A module with a top-level `await` that never
 * settles, or one that opens a socket at import, hangs there — and until this
 * bound existed, it hung with nothing to observe:
 *
 * - **No heartbeat.** `run.heartbeat` fires only while a step is in flight
 *   (`producer.ts`), and preflight has no step. A hang here emitted `run.start`
 *   and then *nothing at all* — no `step.start`, no `run.end` — which
 *   `workspace status` cannot tell apart from a slow startup, forever.
 * - **A step's own `timeoutMs` cannot cover it, structurally.** That bound is
 *   declared *inside* the contract, and the contract is not readable until the
 *   module has loaded. Chicken and egg; see `run-actor.ts`'s "Known
 *   limitations".
 *
 * So the bound is a **runner-level option** rather than anything an author
 * writes: `RunWorkflowOptions.preflightTimeoutMs`, `--preflight-timeout <ms>`
 * on the CLI, plumbed exactly the way `heartbeatMs` / `--heartbeat` already is.
 * There is nothing to put in the workflow document, because at the moment the
 * bound must already be armed the document's own declarations are still
 * unreadable.
 *
 * ## Why this one defaults to a bound and a step's does not
 *
 * A step is unbounded unless the author says otherwise, and that asymmetry is
 * deliberate on both sides:
 *
 * - **A step blocks by design.** `feed/next-tick` waiting hours for a market
 *   tick is the product working. A default bound there would break correct
 *   workflows on a timer nobody chose, which is why "absent means unbounded" is
 *   load-bearing in `run-actor.ts`.
 * - **Module evaluation has no such case.** Evaluating a module means running
 *   its top level: defining a handler, compiling a schema, reading a constant.
 *   There is no legitimate plugin that takes minutes to *load*, and none at all
 *   that should take forever — a module that waits on I/O at import is already
 *   a bug in that plugin, whatever the workflow is doing. So the default here
 *   is a real bound, {@link DEFAULT_PREFLIGHT_TIMEOUT_MS}, chosen generously
 *   (tens of seconds, not hundreds of milliseconds) so that a cold filesystem,
 *   a large registry or a slow container can never trip it: it is a backstop
 *   against a hang, not a performance budget.
 *
 * `0` disables it, the same spelling `--heartbeat 0` already uses, for the
 * operator who would rather hang than risk a false positive.
 *
 * ## One deadline for the whole pass, not one per step
 *
 * The loop is sequential, so a per-step bound would let a workflow with fifty
 * steps wait fifty times the number the operator set. The bound is on
 * *preflight*, which is what an operator is actually choosing when they set it,
 * and the diagnostic names the step the pass was on when it expired — which is
 * the whole diagnostic value, since that is the module that hung.
 *
 * ## The rest of preflight is synchronous
 *
 * `validateStorageBoundaries`, `validateResolvedWorkflow` and `validateSeedData`
 * all return a `Result` synchronously, so the preload is the only `await` in
 * {@link startFunc}. The bound therefore wraps the preload specifically rather
 * than the whole actor: a timer armed around synchronous work could only ever
 * expire while that work was *not* running.
 */

import { fromPromise } from 'xstate';
import { ok, err, type Result } from 'neverthrow';

import { loadDefinition } from '@rawbox/plugin/core';
import { ResolvedWorkflow } from '../../workflow/workflow-types.js';
import type { ContractRegistryCache } from '@rawbox/plugin/core';
import { validateResolvedWorkflow, validateStorageBoundaries, validateSeedData } from '../../workflow/validation.js';
import { TIMED_OUT, startDeadline } from './deadline.js';

export interface StartActorInput {
  contractRegistryCache: ContractRegistryCache;
  workflow: ResolvedWorkflow;
  workspace: string;
  /**
   * The preflight bound in milliseconds — `RunWorkflowOptions.preflightTimeoutMs`
   * as the runner received it. `undefined` means "not configured" and takes
   * {@link DEFAULT_PREFLIGHT_TIMEOUT_MS}; `0` disables the bound.
   */
  preflightTimeoutMs?: number | undefined;
}

/**
 * Default bound on the whole definition-preload pass, in milliseconds, when
 * {@link StartActorInput.preflightTimeoutMs} is omitted.
 *
 * Thirty seconds is chosen to be *unreachable by a healthy plugin* rather than
 * to be tight: importing a built module is milliseconds of work, so the two
 * orders of magnitude between them are headroom for a cold page cache, a
 * network filesystem or a throttled container — never a budget a correct plugin
 * has to fit inside. See this module's header for why preflight defaults to a
 * bound at all when a step defaults to none.
 */
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 30_000;

/**
 * The failure preflight reports when its bound expired.
 *
 * A named class rather than a bare `Error` so a caller can tell "the module
 * never finished loading" from "the module failed to load" without parsing the
 * message — the two have different remedies, and the whole point of the bound
 * is making them distinguishable. `timeoutMs` is the field
 * `machine-instance.ts`'s error assigner copies *structurally* (never via
 * `instanceof`, which two copies of this package in one dependency tree would
 * break), and it is what puts `timed_out`/`timeout_ms` on the `run.end`.
 *
 * Deliberately a sibling of `run-actor.ts`'s `StepTimeoutError` rather than the
 * same class: they carry the same field for the same consumer, but they are
 * different failures with different fixes, and a stack that names which one
 * fired is worth more than one shared name.
 */
export class PreflightTimeoutError extends Error {
  /** The bound that expired, in milliseconds — the effective preflight bound. */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'PreflightTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The one sentence a human reads for a preflight timeout, in the terminal and
 * in `run.end.error.message`.
 *
 * It names the step **and its definition path** — the loop is sequential, so
 * the step in hand when the bound expired is the module that hung, and that
 * path is what the reader has to go and open. It states the bound rather than
 * the elapsed time, says in words what happened ("did not finish loading", not
 * "failed to load"), and points at the flag, because unlike a step bound this
 * one is the operator's own setting rather than something in the document.
 */
function describePreflightTimeout(
  stepIndex: number,
  label: string | undefined,
  definitionPath: string,
  timeoutMs: number,
): string {
  const named = label === undefined || label === '' ? '' : ` "${label}"`;
  return (
    `Preflight Check: timed out after ${timeoutMs} ms while loading the step ` +
    `definition for step ${stepIndex}${named} at "${definitionPath}" ` +
    `(the module did not finish loading — a definition module that blocks at ` +
    `import, e.g. on a top-level await, hangs the run before any step starts). ` +
    `Raise or disable the bound with --preflight-timeout <ms> (0 disables it).`
  );
}

/**
 * Imports every step's definition module, so a broken plugin fails the run
 * before any step has written anything — under one bound covering the whole
 * pass.
 *
 * @param preflightTimeoutMs - The bound; `undefined` takes
 *   {@link DEFAULT_PREFLIGHT_TIMEOUT_MS}, `0` (or any non-positive value)
 *   disables it. The default is applied here, at the one place that enforces
 *   it, exactly as `producer.ts` applies `DEFAULT_HEARTBEAT_MS`.
 */
export async function preloadStepDefinitions(
  workflow: ResolvedWorkflow,
  contractRegistryCache: ContractRegistryCache,
  preflightTimeoutMs?: number | undefined,
): Promise<Result<void, Error>> {
  const timeoutMs = preflightTimeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const deadline = startDeadline(timeoutMs);

  try {
    for (const [index, step] of workflow.stepList.entries()) {
      const loadResult = await deadline.race(
        loadDefinition(step.definitionLocation, contractRegistryCache),
      );

      if (loadResult === TIMED_OUT) {
        return err(
          new PreflightTimeoutError(
            describePreflightTimeout(
              index,
              step.label,
              step.definitionLocation.definitionPath,
              timeoutMs,
            ),
            timeoutMs,
          ),
        );
      }

      if (loadResult.isErr()) {
        return err(new Error(
          `Preflight Check: Failed to load step definition for step "${step.label ?? 'unlabeled'}" at "${step.definitionLocation.definitionPath}": ${loadResult.error}`
        ));
      }
    }
    return ok(undefined);
  } finally {
    // Every exit above disarms the timer, so a preflight that finished well
    // within its bound leaves nothing behind holding the event loop open. The
    // one path that skips this is an interrupt: a stopped actor's promise is
    // abandoned without ever resuming, so this `finally` never runs and the
    // timer stays armed for the remainder of the bound — the same trade the
    // step deadline makes, and for the same reason (see `startDeadline` and
    // `RunWorkflowOptions.signal`).
    deadline.cancel();
  }
}

export const startFunc = async ({
  input: { contractRegistryCache, workflow, workspace, preflightTimeoutMs },
}: {
  input: StartActorInput;
}): Promise<Result<void, Error>> => {
  // Boundaries before the schema: the box-location schemas are closed, so a
  // stray `workspace:` on a write is rejected either way — but the schema
  // rejects it as an unknown property, while this names the real rule, that a
  // step may never write outside its own workspace.
  // See FORMAT.md, "Validation".
  const boundaryResult = validateStorageBoundaries(workflow, workspace);
  if (boundaryResult.isErr()) return boundaryResult;

  const typeResult = validateResolvedWorkflow(workflow);
  if (typeResult.isErr()) return typeResult;

  const preloadResult = await preloadStepDefinitions(
    workflow,
    contractRegistryCache,
    preflightTimeoutMs,
  );
  if (preloadResult.isErr()) return preloadResult;

  return validateSeedData(workflow, contractRegistryCache);
};


export const startActor = fromPromise(startFunc);
