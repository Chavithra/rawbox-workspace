import { ok } from '@rawbox/plugin/neverthrow';
import { emitRunEvent } from '@rawbox/plugin';
import { ReservedLabel } from '@rawbox/plugin/control-flow';
import { createControlFlowDefinition } from '../contract-registry.js';

/**
 * `control-flow/halt` — logs the reason (when given) before ending the workflow.
 *
 * Ends the run **successfully** (`__EXIT__`) by default, and as a **failure**
 * (`__FAIL__`) when `fail` is true — the one author-level way to make a run
 * report `outcome: "error"` and exit non-zero. A handler returning `err(...)` is
 * *not* that: it is a handled step failure that writes the step's `errors:`
 * bindings and lets the workflow continue.
 *
 * `reason` serves both modes, and there is deliberately no second field for the
 * failure text: one halt says one thing about why it stopped. On the failure
 * path it becomes the run's error message (`run.end.error.message`), which is
 * why it — and only it — travels out in the handler's output record; on the
 * success path the reason is a log line and nothing more, so the output stays
 * the bare `{ label }` it has always been.
 *
 * The line is routed through the host's run-event stream (`emitRunEvent`,
 * `@rawbox/plugin`) so the reason lands as an indented `log` line under the
 * running step, the same as `observability/log` — rather than as a raw JSON blob
 * interleaving the terminal renderer's own step lines. `console` is the fallback
 * for when no host channel is installed (a unit test, a different runtime
 * embedding the definition directly).
 */
const haltDefinition = createControlFlowDefinition(
  './control-flow/halt.definition.js',
  async (input) => {
    const { reason, fail } = input;
    const failing = fail === true;

    if (reason !== undefined) {
      // `error` rather than `info` when the run is being failed, so the line is
      // classified as an alarm by the one rule every consumer already applies
      // (OBSERVABILITY.md, "`severity`": a `log` event's severity mirrors its
      // level) instead of by re-reading its wording.
      const routed = emitRunEvent({
        event: 'log',
        level: failing ? 'error' : 'info',
        message: `${failing ? 'Workflow failed' : 'Workflow halted'}: ${reason}`,
        data: { reason },
      });

      if (!routed) {
        console.info(
          JSON.stringify({
            timestamp: Date.now(),
            event: 'halt',
            ...(failing ? { fail: true } : {}),
            reason,
          }),
        );
      }
    }

    if (failing) {
      return ok({
        label: ReservedLabel.FAIL,
        ...(reason === undefined ? {} : { reason }),
      });
    }

    return ok({ label: ReservedLabel.EXIT });
  },
);

export default haltDefinition;
