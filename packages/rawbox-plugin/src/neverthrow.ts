// ---------------------------------------------------------------------------
// `@rawbox/plugin/neverthrow` — neverthrow, passed through unchanged.
//
// The companion to `./typebox.ts`, for the same reason and on the same terms:
//
//   import { ok, err } from '@rawbox/plugin/neverthrow';
//
// Every definition handler returns a `Result`, so this is the second of the two
// imports a plugin cannot write itself out of. With both passthroughs in place a
// plugin package declares exactly one dependency — `@rawbox/plugin`, as a peer —
// and nothing else, unless it genuinely wraps a third-party library of its own.
//
// `neverthrow` was already a regular dependency of this package (the definition
// builders return `Result` themselves), so passing it through costs nothing in
// this manifest.
//
// The identity of a `Result` never matters across the host boundary: the runner
// reads handler results structurally, never with `instanceof` — see
// `machine/actors/run-actor.ts` in `@rawbox/runner`, which spells out why two
// copies of a class in one dependency tree must not be able to break a check.
// One copy is still preferable, and this is how a plugin gets it for free.
// ---------------------------------------------------------------------------

export * from 'neverthrow';
