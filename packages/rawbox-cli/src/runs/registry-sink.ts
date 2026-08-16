/**
 * The registry's `RunEventSink` — advances a `bootstrapping` entry through
 * `running` to its terminal status, following the run's own event stream
 * (OBSERVABILITY.md, "Lifecycle and crash detection"). Registered into `workflow run`'s
 * `sinkList` (`commands/workflow/run.ts`) alongside the terminal renderer and
 * the optional OTel bridge — `runWorkflowInstance`'s core stays untouched.
 */

import { OUTCOME, RUN_EVENT, type RunEvent, type RunEventSink } from '@rawbox/runner';

import { updateRegistryEntrySync } from './registry-io.js';
import { RUN_STATUS } from './types.js';

/**
 * @param registryFilePath - The entry this sink updates — already written as
 *   `bootstrapping` by the CLI before `runWorkflowInstance` is called.
 */
export function createRunRegistrySink(registryFilePath: string): RunEventSink {
  // A `bootstrap.error` firing after `run.start` (the `lock`/`resolve`/
  // `seed-validation`/`store`/`seed` stages — see `event-types.ts`'s
  // `BOOTSTRAP_STAGE`) is always followed by a `run.end` with
  // `outcome: "error"` (`RunEventProducer.end` is only a no-op when
  // `run.start` was never emitted). That later `run.end` must not overwrite
  // the more specific `bootstrap-failed` status this sink already wrote —
  // hence the latch.
  let bootstrapFailed = false;

  return {
    emit(event: RunEvent): void {
      switch (event.event) {
        case RUN_EVENT.RUN_START:
          updateRegistryEntrySync(registryFilePath, (entry) => ({
            ...entry,
            status: RUN_STATUS.RUNNING,
          }));
          return;

        case RUN_EVENT.BOOTSTRAP_ERROR:
          bootstrapFailed = true;
          updateRegistryEntrySync(registryFilePath, (entry) => ({
            ...entry,
            status: RUN_STATUS.BOOTSTRAP_FAILED,
            ended_at: event.ts,
            error: { message: event.message },
          }));
          return;

        case RUN_EVENT.RUN_END:
          if (bootstrapFailed) {
            return;
          }
          // `interrupted` maps to its own terminal status — an operator stop
          // that still wrote its `run.end` (ended_at/duration/steps recorded
          // like ok/error, never an `error` field). A SIGKILLed run writes no
          // `run.end` at all and stays non-terminal, which is exactly what
          // read-time crash detection classifies as `crashed`
          // (OBSERVABILITY.md, "Lifecycle and crash detection").
          updateRegistryEntrySync(registryFilePath, (entry) => ({
            ...entry,
            status:
              event.outcome === OUTCOME.OK
                ? RUN_STATUS.OK
                : event.outcome === OUTCOME.INTERRUPTED
                  ? RUN_STATUS.INTERRUPTED
                  : RUN_STATUS.ERROR,
            ended_at: event.ts,
            duration_ms: event.duration_ms,
            steps_total: event.steps_total,
            steps_failed: event.steps_failed,
            ...(event.error ? { error: event.error } : {}),
          }));
          return;

        default:
          return;
      }
    },
  };
}
