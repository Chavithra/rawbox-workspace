/**
 * Small, dependency-free rendering helpers shared by the `runs` command
 * group — durations, ages and a plain aligned table. Kept separate from
 * `render/terminal-sink.ts` (the run-event stream's own renderer): these
 * commands render registry entries and log summaries, never a `RunEvent`.
 */

import pc from 'picocolors';

import { DISPLAY_STATUS, type DisplayStatus } from './types.js';

/** `123ms`, `45s`, `12m`, `3h`, `2d` — one unit, no fractional composition. */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours}h`;
  }
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}

/** How long ago `sinceIso` was, rendered with {@link formatDurationMs}. `?` for an unparseable instant. */
export function formatAge(sinceIso: string, nowMs: number = Date.now()): string {
  const sinceMs = Date.parse(sinceIso);
  if (Number.isNaN(sinceMs)) {
    return '?';
  }
  return formatDurationMs(Math.max(0, nowMs - sinceMs));
}

/** Colours a display status for a TTY; identity function's worth of a no-op for `--output json`, which never calls this. */
export function colourStatus(status: DisplayStatus): string {
  switch (status) {
    case DISPLAY_STATUS.OK:
      return pc.green(status);
    case DISPLAY_STATUS.ERROR:
    case DISPLAY_STATUS.BOOTSTRAP_FAILED:
    case DISPLAY_STATUS.CRASHED:
      return pc.red(status);
    case DISPLAY_STATUS.RUNNING:
      return pc.cyan(status);
    case DISPLAY_STATUS.BOOTSTRAPPING:
      return pc.yellow(status);
    case DISPLAY_STATUS.INTERRUPTED:
      // An operator stop: terminal but neither good news (green) nor an alarm
      // (red) — dimmed yellow, distinct from the bright-yellow transitional
      // `bootstrapping`.
      return pc.dim(pc.yellow(status));
    default:
      return status;
  }
}

/**
 * Renders `rows` (each row's cells already stringified, `rows[0]` the
 * header) as a plain space-padded table, one line per row, columns aligned
 * to the widest cell — no box-drawing characters, so it stays easy to `grep`.
 */
export function renderTable(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) {
    return '';
  }
  const columnCount = rows[0]!.length;
  const widthList = Array.from({ length: columnCount }, (_unused, columnIndex) =>
    Math.max(...rows.map((row) => stripAnsi(row[columnIndex] ?? '').length)),
  );

  return rows
    .map((row) =>
      row
        .map((cell, columnIndex) => padCell(cell, widthList[columnIndex]!))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

/** Right-pads `cell` to `width`, accounting for ANSI escape codes that add no visible width. */
function padCell(cell: string, width: number): string {
  const visibleLength = stripAnsi(cell).length;
  return cell + ' '.repeat(Math.max(0, width - visibleLength));
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}
