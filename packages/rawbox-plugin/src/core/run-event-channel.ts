/**
 * The host ↔ plugin **run-event channel**: the one seam a definition handler has
 * for handing a structured event to whatever is executing it.
 *
 * ## Why it exists
 *
 * A handler's signature is `(input) => Result<…>` and nothing more. It receives
 * no run context, no logger and no span — deliberately, because context
 * propagation *into* handlers is a later, larger design (the door
 * rawbox-runner README, "Not built (yet)" documents but does not walk through yet). Yet the
 * built-in `observability/log` operation exists precisely so a workflow author
 * can put a line in the run's log, and a line that only reaches `console` is
 * invisible to the NDJSON file, the terminal renderer and any OTel exporter.
 *
 * This module is the minimal thing that closes that gap without touching the
 * handler signature: an **ambient, process-wide channel** that a host installs
 * for the duration of a run and that any definition may emit into.
 *
 * ## Why a `Symbol.for` global rather than an import
 *
 * A plugin package declares `@rawbox/plugin` as a *peer* dependency and is
 * installed into the workspace's target folder, so the copy of this module a
 * plugin imports is frequently **not** the copy the host imported. Module-level
 * state would therefore be two separate states. `Symbol.for` looks up the
 * cross-realm symbol registry by string, so every copy addresses the same slot
 * on `globalThis` and they agree by construction.
 *
 * ## What is and is not promised
 *
 * - The channel is **ambient and singular**: one installed channel at a time.
 *   {@link setRunEventChannel} returns the previous one so a host can restore it,
 *   which gives nesting a stack discipline. Two *concurrent* runs in one process
 *   would misattribute each other's events; hosts that need that must run in
 *   separate processes.
 * - Emitting is **best-effort and never throws**: a channel whose `emit` throws
 *   is swallowed here, because a logging failure must never fail a step.
 * - The payload is opaque to this module beyond its `event` discriminator. The
 *   *host* owns the event vocabulary and is expected to recognise the kinds it
 *   knows and ignore the rest — never to branch on which plugin sent them.
 */

/**
 * An event a definition hands to its host. `event` is the discriminator the host
 * dispatches on; every other field is payload the host's schema for that kind
 * defines.
 */
export interface HostRunEvent {
  event: string;
  [field: string]: unknown;
}

/** What a host installs to receive {@link HostRunEvent}s. */
export interface RunEventChannel {
  emit(event: HostRunEvent): void;
}

/**
 * The `globalThis` slot every copy of this module shares.
 *
 * Versioned in the string: a future incompatible payload contract takes a new
 * symbol rather than silently reinterpreting events emitted by an older plugin.
 */
const RUN_EVENT_CHANNEL_KEY = Symbol.for('rawbox.plugin.run-event-channel.v1');

/** `globalThis`, typed for the one slot this module owns. */
type ChannelHost = typeof globalThis & {
  [RUN_EVENT_CHANNEL_KEY]?: RunEventChannel | undefined;
};

/** Returns the channel currently installed, or `undefined` when there is none. */
export function getRunEventChannel(): RunEventChannel | undefined {
  return (globalThis as ChannelHost)[RUN_EVENT_CHANNEL_KEY];
}

/**
 * Installs (or, with `undefined`, clears) the ambient channel.
 *
 * @returns The channel that was installed before this call, so the caller can
 *   restore it in a `finally` and keep nesting well-behaved.
 */
export function setRunEventChannel(
  channel: RunEventChannel | undefined,
): RunEventChannel | undefined {
  const host = globalThis as ChannelHost;
  const previous = host[RUN_EVENT_CHANNEL_KEY];
  host[RUN_EVENT_CHANNEL_KEY] = channel;
  return previous;
}

/**
 * Hands one event to the installed channel.
 *
 * @returns `true` when a channel took it, `false` when none is installed — which
 *   is the signal a definition uses to fall back to its standalone behaviour
 *   (writing to `console`, typically) rather than losing the line.
 */
export function emitRunEvent(event: HostRunEvent): boolean {
  const channel = getRunEventChannel();
  if (!channel) {
    return false;
  }
  try {
    channel.emit(event);
    return true;
  } catch {
    // A host whose sink throws must not fail the step that logged. Reporting
    // `false` here would additionally print the line to `console`, which is the
    // better of the two failure modes.
    return false;
  }
}
