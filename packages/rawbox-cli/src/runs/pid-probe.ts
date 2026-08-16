/**
 * Process identity for the run registry (OBSERVABILITY.md, "Lifecycle and crash detection").
 *
 * `pid` alone is not identity: `process.kill(pid, 0)` on a recycled pid would
 * report a crashed run as `running`. Every registry entry pairs its `pid` with
 * `pid_started_at`, and liveness is only ever reported when *both* match a
 * freshly-probed process.
 *
 * Two mechanisms produce a start time, in this order of preference:
 *
 * 1. **Linux `/proc/<pid>/stat`, field 22** — `starttime`, in clock ticks
 *    since boot. Converted to epoch milliseconds via `/proc/uptime` (system
 *    uptime in seconds) and `USER_HZ` (assumed 100, which is the value on
 *    every mainstream Linux distribution's kernel config — there is no
 *    portable syscall exposed to Node to read it, and getting this wrong
 *    only costs precision inside the tolerance window below, never
 *    correctness of the alive/dead check itself). This is exact enough that
 *    two probes of the *same* process, taken from two different processes
 *    (the run that wrote the entry, and a `runs list` reading it back later),
 *    agree to the tick.
 * 2. **Portable fallback** — used when `/proc` does not exist (non-Linux) or
 *    is unreadable for that pid. For the *current* process, `process.uptime()`
 *    gives an exact wall-clock start time with no external command. For
 *    *another* process, `ps -o etimes=` reports elapsed seconds, which is
 *    reduced to a start time by subtracting from "now" — accurate to the
 *    second, which is exactly why comparisons use a tolerance rather than
 *    exact equality.
 *
 * Both mechanisms are tried through the same entry point ({@link
 * probeProcess}), so a registry entry never needs to record which one wrote
 * it — the comparison is always "two epoch-millisecond values, within
 * tolerance", regardless of provenance.
 */

import fsSync from 'node:fs';
import { execFileSync } from 'node:child_process';

/** How far apart two start-time readings of the same process are allowed to drift and still count as a match. */
export const START_TIME_TOLERANCE_MS = 2_000;

/** Linux's near-universal `USER_HZ` — the unit `/proc/<pid>/stat`'s `starttime` field is expressed in. */
const ASSUMED_CLOCK_TICKS_PER_SEC = 100;

/** The result of probing one pid at a point in time. */
export interface ProcessProbe {
  alive: boolean;
  /** Epoch milliseconds, when determinable. Never present when `alive` is `false`. */
  startedAtMs?: number;
}

/** Injectable so tests can simulate a dead pid or a recycled one without touching a real process. */
export type ProbeFn = (pid: number) => ProcessProbe;

/**
 * `true` if `pid` is alive, using the standard `kill(pid, 0)` liveness check.
 *
 * `EPERM` (the pid exists but is owned by another user) still counts as
 * alive — the process is there, this user simply cannot signal it. Any other
 * failure (`ESRCH`, or the number is out of range) means it is not.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads `/proc/<pid>/stat`'s field 22 (`starttime`, in clock ticks since boot), or `undefined`. */
function readProcStatStartTimeTicks(pid: number): number | undefined {
  let raw: string;
  try {
    raw = fsSync.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  } catch {
    return undefined;
  }

  // Fields 1 and 2 are `pid` and `(comm)` — `comm` may itself contain spaces
  // or parentheses, so the split point is the *last* ')' on the line, not the
  // first space. Everything after it, split on spaces, is field 3 onward:
  // field 22 is therefore index 22 - 3 = 19 of that remainder.
  const closeParen = raw.lastIndexOf(')');
  if (closeParen === -1) {
    return undefined;
  }
  const rest = raw.slice(closeParen + 2).trim().split(/\s+/);
  const ticksText = rest[19];
  if (ticksText === undefined) {
    return undefined;
  }
  const ticks = Number(ticksText);
  return Number.isFinite(ticks) ? ticks : undefined;
}

/** Reads `/proc/uptime`'s first field (system uptime, seconds), or `undefined`. */
function readProcUptimeSeconds(): number | undefined {
  try {
    const raw = fsSync.readFileSync('/proc/uptime', 'utf-8');
    const seconds = Number.parseFloat(raw.split(' ')[0] ?? '');
    return Number.isFinite(seconds) ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/** Mechanism 1: `/proc/<pid>/stat` + `/proc/uptime`, converted to epoch milliseconds. */
function probeViaProc(pid: number): number | undefined {
  const ticks = readProcStatStartTimeTicks(pid);
  const uptimeSeconds = readProcUptimeSeconds();
  if (ticks === undefined || uptimeSeconds === undefined) {
    return undefined;
  }
  const bootTimeMs = Date.now() - uptimeSeconds * 1000;
  return Math.round(bootTimeMs + (ticks / ASSUMED_CLOCK_TICKS_PER_SEC) * 1000);
}

/** Mechanism 2b: shells out to `ps -o etimes=` for a pid that is not this process. */
function probeViaPs(pid: number): number | undefined {
  try {
    const output = execFileSync('ps', ['-o', 'etimes=', '-p', String(pid)], {
      encoding: 'utf-8',
    }).trim();
    const elapsedSeconds = Number.parseInt(output, 10);
    return Number.isFinite(elapsedSeconds) ? Date.now() - elapsedSeconds * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The best available start time for `pid`, epoch milliseconds, or `undefined`
 * when neither mechanism could determine one (the process is gone, `/proc`
 * and `ps` are both unavailable).
 *
 * Exported separately from {@link probeProcess} so `workflow run` can call it
 * for its *own* pid — `process.pid` — the moment it writes the initial
 * `bootstrapping` registry entry, before there is anything to probe for
 * liveness.
 */
export function getProcessStartedAtMs(pid: number): number | undefined {
  const viaProc = probeViaProc(pid);
  if (viaProc !== undefined) {
    return viaProc;
  }
  if (pid === process.pid) {
    return Date.now() - Math.round(process.uptime() * 1000);
  }
  return probeViaPs(pid);
}

/**
 * The real, unmocked probe: alive-ness plus start time for an arbitrary pid.
 * The default `probe` argument everywhere a `ProbeFn` is accepted; tests
 * substitute their own to simulate a dead pid or a same-numbered, wrong-start
 * -time recycled one without racing a real process.
 */
export function probeProcess(pid: number): ProcessProbe {
  const alive = isProcessAlive(pid);
  if (!alive) {
    return { alive: false };
  }
  const startedAtMs = getProcessStartedAtMs(pid);
  return startedAtMs === undefined ? { alive: true } : { alive: true, startedAtMs };
}

/**
 * `true` when two start-time readings are close enough to call the same
 * process. `undefined` on either side (a probe that could not determine a
 * start time at all) is treated as a match — a degraded environment with
 * neither `/proc` nor `ps` should fall back to trusting `pid` alone rather
 * than manufacturing false `crashed` reports.
 */
export function startTimesMatch(
  recordedMs: number,
  probedMs: number | undefined,
): boolean {
  if (probedMs === undefined) {
    return true;
  }
  return Math.abs(recordedMs - probedMs) <= START_TIME_TOLERANCE_MS;
}
