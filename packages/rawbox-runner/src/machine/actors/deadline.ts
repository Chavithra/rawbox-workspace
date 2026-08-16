/**
 * **The one bound primitive**: race an awaited thing against a timer, or do not.
 *
 * Two places in the runner stop waiting on their own initiative, and they are
 * deliberately built on the same three lines rather than on two lookalikes:
 *
 * - **A bounded step** (`run-actor.ts`) — the step's authored `timeoutMs`
 *   bounding its definition load and its handler call together.
 * - **The preflight bound** (`start-actor.ts`) — the runner-level
 *   `preflightTimeoutMs` bounding the definition preload that happens before
 *   any step exists.
 *
 * What is *not* here is the policy: what an expired bound means, which error it
 * mints, and how it reaches the event stream all differ between those two and
 * live with each of them. This module answers only "how do I stop waiting, and
 * what does an absent bound cost?".
 */

/**
 * What a lost race resolves with.
 *
 * A `Symbol` rather than `null`, `undefined` or a sentinel object: everything
 * the callers race is a `ValidatedResult` or a `Result<…, string>` — a
 * `neverthrow` object, never a symbol — so `value === TIMED_OUT` cannot collide
 * with a value a definition legitimately produced. A sentinel that *could*
 * collide would turn a plugin's own return value into a spurious timeout.
 */
export const TIMED_OUT = Symbol('rawbox.deadline.expired');

/** One bound, armed or deliberately absent. */
export interface Deadline {
  /**
   * Resolves with `work`'s value, or with {@link TIMED_OUT} when the bound
   * expired first.
   *
   * **The timeout side resolves; it never rejects.** That is what makes the
   * abandoned work promise safe: `Promise.race` attaches handlers to *every*
   * promise it is given, so the losing work promise is already awaited by this
   * race and its eventual rejection is consumed here rather than resurfacing as
   * an unhandled rejection that would crash the process minutes after the run
   * reported its failure. A rejecting timer would additionally throw out of the
   * `await` at the call site, where the caller wants a `Result` and not a
   * control-flow exception.
   *
   * Every call shares the *same* timer and the same expiry promise, so one
   * deadline spans everything its owner awaits — a step's definition load and
   * its handler call race one deadline between them, not one each, and a
   * preflight pass bounds the whole loop rather than each iteration.
   */
  race<Value>(work: Promise<Value>): Promise<Value | typeof TIMED_OUT>;
  /** Clears the timer. Idempotent, and a no-op on an unbounded deadline. */
  cancel(): void;
}

/**
 * The deadline unbounded work gets: the identity function and nothing else.
 *
 * Shared rather than constructed per call, because the whole point is that
 * unbounded work allocates **no timer and no extra promise** — an unbounded step
 * must cost exactly what it cost before bounded steps existed. A `Promise.race`
 * of one is not free: it allocates a second promise and a microtask hop per
 * await, on the hot path of every step of every workflow that declares no bound
 * (which is most of them).
 */
const UNBOUNDED_DEADLINE: Deadline = {
  race: <Value>(work: Promise<Value>): Promise<Value | typeof TIMED_OUT> => work,
  cancel: (): void => {},
};

/**
 * Arms a bound, or returns {@link UNBOUNDED_DEADLINE} when there is none.
 *
 * `undefined`, non-finite and `<= 0` are all treated as **unbounded** rather
 * than as "fire immediately". For a step, none of them can reach here from a
 * resolved document — `StepTimeout` and `setupContractRegistry` reject every one
 * of those spellings at authoring time, with diagnostics that name the spelling
 * to write instead — so that branch exists only for a hand-built `ResolvedStep`
 * (an embedder, a test). For the preflight bound, `0` is the documented
 * *disable* value (`RunWorkflowOptions.preflightTimeoutMs`), and it lands on the
 * same branch by the same rule. Given both, the layers must not disagree about
 * what a non-positive value means: everywhere else it is called "not a bound",
 * so it is called that here too. Failing immediately would invent a third
 * meaning at the one layer that has no way to explain it.
 *
 * **The timer is deliberately not `.unref()`ed**, and the asymmetry with the
 * heartbeat timer in `producer.ts` is the point rather than an oversight. The
 * heartbeat unrefs because it is a *repeating* timer that concludes nothing —
 * left refed, it would hang the very process whose hang it exists to make
 * visible — and `INTERRUPT_GRACE_MS` unrefs because it is a backstop behind a
 * conclusion that has already happened. This timer is the opposite of both: a
 * **one-shot timer whose firing is what concludes the run**. Unrefing it would
 * make the bound conditional on something *else* keeping the event loop alive,
 * so a workflow whose only remaining work is a hung handler — or a hung module
 * evaluation, which holds nothing open at all — would exit without ever
 * reporting the timeout. Do not "fix" this by adding `.unref()`.
 *
 * @param timeoutMs - The bound in milliseconds: a positive finite number means
 *   bounded, anything else means deliberately unbounded.
 */
export function startDeadline(timeoutMs: number | undefined): Deadline {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return UNBOUNDED_DEADLINE;
  }

  let timer: NodeJS.Timeout | undefined;
  // Created once, awaited by every `race` call: one timer per deadline,
  // whatever its owner ends up awaiting.
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });

  return {
    race: <Value>(work: Promise<Value>): Promise<Value | typeof TIMED_OUT> =>
      Promise.race([work, expired]),
    cancel: (): void => {
      if (timer === undefined) {
        return;
      }
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
