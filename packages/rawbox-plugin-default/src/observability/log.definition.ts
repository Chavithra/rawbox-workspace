import { ok } from '@rawbox/plugin/neverthrow';
import { emitRunEvent } from '@rawbox/plugin';
import { createOperationDefinition } from '../contract-registry.js';

/** JSON-encodable, or the marker that replaces it when it is not. */
const UNSERIALIZABLE = '[unserializable]';

/**
 * Replaces `data` with {@link UNSERIALIZABLE} when it cannot be JSON-encoded.
 *
 * Done here, before the value goes anywhere, rather than at each destination:
 * the contract promises that circular `data` degrades without failing the step,
 * and that promise must hold identically whether the line is routed to a host or
 * printed to `console`. A host writing NDJSON cannot make that repair itself
 * without risking a half-written line.
 */
function toSerializable(data: unknown): unknown {
  try {
    JSON.stringify(data);
    return data;
  } catch {
    return UNSERIALIZABLE;
  }
}

/**
 * `observability/log` — one structured line, authored by the workflow.
 *
 * The line goes to the **host's run-event stream** when there is a host
 * (`emitRunEvent`, `@rawbox/plugin`), so that under `@rawbox/runner` a
 * workflow-authored log lands in the same NDJSON file, the same terminal
 * renderer and the same OTel exporter as the runner's own `step.*` events,
 * sharing their envelope (OBSERVABILITY.md, "The run-event stream").
 *
 * `console` is the **fallback**, not the primary path: with no host installed —
 * a unit test, a different runtime embedding the definition directly — the line
 * must still be visible somewhere rather than silently dropped.
 *
 * The seam is deliberately thin. This definition names the event *kind*
 * (`"log"`), which the host owns and documents; the host never asks which plugin
 * an event came from. Any plugin may emit the same kind and be routed
 * identically.
 */
const logDefinition = createOperationDefinition(
  './observability/log.definition.js',
  async (input) => {
    const { level, message, data } = input;
    const timestamp = Date.now();

    const hasData = data !== undefined;
    const safeData = hasData ? toSerializable(data) : undefined;

    // The host takes the payload structured; only the fallback serialises.
    const routed = emitRunEvent({
      event: 'log',
      level,
      message,
      ...(hasData ? { data: safeData } : {}),
    });

    if (!routed) {
      const line = hasData
        ? { timestamp, level, message, data: safeData }
        : { timestamp, level, message };
      const serialized = JSON.stringify(line);

      switch (level) {
        case 'debug':
          console.debug(serialized);
          break;
        case 'info':
          console.info(serialized);
          break;
        case 'warn':
          console.warn(serialized);
          break;
        case 'error':
          console.error(serialized);
          break;
      }
    }

    return ok({ timestamp });
  },
);

export default logDefinition;
