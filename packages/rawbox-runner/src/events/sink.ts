/**
 * Sinks: the N half of "one producer, N sinks".
 *
 * The contract is `{ emit(event): void; flush?(): Promise<void>; close?():
 * Promise<void> }`. `emit` is **synchronous and MUST NOT throw** — a sink
 * needing I/O buffers in `emit` and drains in `flush`. After a run's last event
 * the producer awaits `flush()` then `close()` on each sink exactly once, and a
 * sink that throws is reported and isolated so it cannot cost the other sinks
 * or the run's result.
 *
 * A sink is the only thing that decides where an event *goes*. The producer
 * decides what an event *is*. Nothing in this file knows about XState, and
 * nothing in the producer knows about files or terminals.
 */

import { getErrorMessage } from '../utils/error.js';
import type { RunEvent } from './event-types.js';

/**
 * A destination for the run-event stream.
 *
 * `emit` is **synchronous and must not throw**. Synchronous because events are
 * produced from an XState subscription and from a plugin's handler, neither of
 * which has anywhere to await; a sink that needs I/O buffers in `emit` and
 * drains in `flush`/`close`. Must-not-throw because a broken log destination has
 * no business failing a run — {@link RunEventEmitter} enforces it defensively
 * anyway, but a sink that relies on that is a sink with a bug.
 *
 * Both async methods are optional, and the runner calls them in this order,
 * exactly once, after the run's last event:
 *
 * 1. `flush()` — make everything emitted so far durable/visible.
 * 2. `close()` — release the destination (file handle, socket, exporter).
 *
 * Both are awaited and both are best-effort: a rejection is reported and
 * swallowed, never returned to the caller of `runWorkflowInstance`, because the
 * run's own result is the answer that matters.
 */
export interface RunEventSink {
  emit(event: RunEvent): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/**
 * Fans one event out to every registered sink, isolating them from each other.
 *
 * A sink that throws is reported once per failure on `console.error` and the
 * remaining sinks still receive the event. That isolation is the whole reason
 * this is a class rather than a `for` loop at the call site: an unwritable log
 * file must not cost you the terminal output, and a terminal renderer bug must
 * not cost you the file.
 */
export class RunEventEmitter {
  private readonly sinkList: readonly RunEventSink[];

  constructor(sinkList: readonly RunEventSink[]) {
    this.sinkList = sinkList;
  }

  /** Hands `event` to every sink. Never throws. */
  emit(event: RunEvent): void {
    for (const sink of this.sinkList) {
      try {
        sink.emit(event);
      } catch (error) {
        console.error(
          `[rawbox] run-event sink failed on "${event.event}": ${getErrorMessage(error)}`,
        );
      }
    }
  }

  /**
   * Flushes then closes every sink, in registration order.
   *
   * Each call is independently guarded: one exporter timing out must not strand
   * the file sink's buffer.
   */
  async close(): Promise<void> {
    for (const sink of this.sinkList) {
      await this.settle(sink, 'flush');
    }
    for (const sink of this.sinkList) {
      await this.settle(sink, 'close');
    }
  }

  /** Awaits one optional lifecycle hook, reporting and swallowing failures. */
  private async settle(sink: RunEventSink, hook: 'flush' | 'close'): Promise<void> {
    const method = sink[hook];
    if (!method) {
      return;
    }
    try {
      await method.call(sink);
    } catch (error) {
      console.error(
        `[rawbox] run-event sink ${hook}() failed: ${getErrorMessage(error)}`,
      );
    }
  }
}

/**
 * A sink that keeps every event in an array.
 *
 * Exported rather than left to test files because it is the natural way to
 * assert on the stream — the format's own tests use it, and so should anything
 * embedding the runner that wants the recap without a file. It records
 * `flush`/`close` calls so the lifecycle contract above is testable too.
 */
export class MemoryRunEventSink implements RunEventSink {
  /** Every event received, in emission order. */
  readonly eventList: RunEvent[] = [];

  /** How many times {@link flush} was called. */
  flushCount = 0;

  /** How many times {@link close} was called. */
  closeCount = 0;

  emit(event: RunEvent): void {
    this.eventList.push(event);
  }

  async flush(): Promise<void> {
    this.flushCount += 1;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }

  /** Every event of one kind, narrowed. */
  ofKind<Kind extends RunEvent['event']>(
    kind: Kind,
  ): Extract<RunEvent, { event: Kind }>[] {
    return this.eventList.filter(
      (event): event is Extract<RunEvent, { event: Kind }> => event.event === kind,
    );
  }
}
