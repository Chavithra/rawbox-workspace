/**
 * Turns a stored `RunRegistryEntry.status` into the status an operator should
 * be told — the liveness rule of OBSERVABILITY.md, "Lifecycle and crash detection":
 *
 * > `running`/`bootstrapping` only if the pid **and its start time** match a
 * > live process; otherwise reported as **`crashed`**.
 *
 * A terminal status (`ok` / `error` / `interrupted` / `bootstrap-failed`) is
 * trusted as-is — there is nothing to probe once a run has already reported
 * how it ended. In particular a stored `interrupted` (a graceful SIGTERM/
 * SIGINT stop that wrote its `run.end`) is never reclassified `crashed`, even
 * though its process is by then certainly gone: `crashed` remains reserved
 * for a non-terminal entry whose process died without writing an end —
 * which is what SIGKILL still produces (OBSERVABILITY.md, "Lifecycle and crash detection").
 */

import { probeProcess, startTimesMatch, type ProbeFn } from './pid-probe.js';
import { DISPLAY_STATUS, isTerminalStatus, type DisplayStatus, type RunRegistryEntry } from './types.js';

/**
 * @param entry - The registry entry as read from disk.
 * @param probe - Defaults to the real {@link probeProcess}; tests inject a
 *   fake to simulate a dead pid or a same-numbered pid with the wrong start
 *   time (pid reuse) without racing a real process.
 */
export function classifyDisplayStatus(
  entry: RunRegistryEntry,
  probe: ProbeFn = probeProcess,
): DisplayStatus {
  if (isTerminalStatus(entry.status)) {
    return entry.status;
  }

  // Non-terminal: `bootstrapping` or `running`. Both claim the run is alive,
  // so both are checked identically.
  const result = probe(entry.pid);
  if (!result.alive) {
    return DISPLAY_STATUS.CRASHED;
  }
  if (!startTimesMatch(entry.pid_started_at, result.startedAtMs)) {
    // Alive, but a different process now holds this pid number.
    return DISPLAY_STATUS.CRASHED;
  }
  return entry.status;
}
