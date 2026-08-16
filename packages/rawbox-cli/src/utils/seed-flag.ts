import { err, ok, type Result } from 'neverthrow';
import type { SeedOverrideLayer } from '@rawbox/runner';

import { getErrorMessage } from './error.js';

// ---------------------------------------------------------------------------
// `--seed key=<json>` — the CLI's own seed-override layer
// (`@rawbox/runner`'s `workspace/seed-overrides.ts` module doc, "CLI >
// workspace > workflow").
//
// This module owns exactly one job: turning the *strings* yargs collects from
// repeated `--seed` flags into the `Record<string, unknown>` a
// `SeedOverrideLayer` wants. Everything downstream of that — "is this key
// already seeded", "does the value fit the declared strategy", "is it a
// foreign key" — is `applySeedOverrides`'s job, unchanged, on a layer this
// module built. Nothing here re-implements or relaxes any of those rules; it
// only gets a value into the shape they already check.
//
// ## Why JSON, not a smarter guesser
//
// A seed is arbitrary data (`SeedOverrideRecord`'s own doc), so there is no
// type to coerce *to* — a heuristic ("looks like a number, parse it as one")
// would have to guess right for every strategy's element shape, including
// ones this flag has never seen. JSON is the one encoding that already means
// exactly what it looks like: `500` is the number 500, `"500"` is the string
// "500", `true`/`null`/`[1,2,3]`/`{"a":1}` all read as what they say. An
// author who wants a bare string has to quote it — `--seed name='"Ada"'` — and
// that one extra keystroke is what buys the hazard below being *impossible*
// rather than merely checked for.
//
// ## The hazard this exists to name
//
// A `--seed sleep_ms=500` with no JSON parsing at all would hand
// `applySeedOverrides` the *string* `"500"`, not the *number* `500`. Every
// rule that function runs — foreign-key, unseeded-key, `valueSizeMax` — is a
// **shape** check, and a string is a perfectly good shape: it passes every one
// of them. The failure shows up far away, the first time some step performs
// arithmetic on what it expected to be a number — nowhere near the flag that
// actually caused it, and with no error message that mentions `--seed` at
// all. Parsing here, eagerly, with a diagnostic that names the flag and the
// key, is what turns that failure from "silent and distant" into "immediate
// and pointed at its cause".
// ---------------------------------------------------------------------------

/**
 * Parses repeated `--seed key=<json>` flag values into one value record —
 * `SeedOverrideLayer.valueRecord` — or the first malformed entry's diagnostic.
 *
 * Splits each entry on its **first** `=`, so a JSON value that itself contains
 * `=` (a string, an object) is never truncated. A duplicate key across two
 * `--seed` flags behaves like a duplicate key in an object literal: the last
 * one given wins — the same "last one wins" `applySeedOverrides` already
 * applies *between* layers, just applied here *within* the one the CLI
 * supplies, before it ever becomes a layer.
 *
 * @param rawList - The `--seed` flag's raw values, in the order given.
 * @returns `ok({})` for an empty or absent list — a run with no `--seed`
 *   flags gets no CLI layer at all, see {@link seedOverrideLayerFromFlags} —
 *   or `err` naming `--seed`, the offending entry, and why it was refused.
 */
export function parseSeedFlagList(
  rawList: readonly string[],
): Result<Record<string, unknown>, string> {
  const valueRecord: Record<string, unknown> = {};

  for (const raw of rawList) {
    const separatorIndex = raw.indexOf('=');
    if (separatorIndex <= 0) {
      return err(
        `--seed value ${JSON.stringify(raw)} is not "key=<json>" — no key precedes an "=". ` +
          `Example: --seed sleep_ms=500`,
      );
    }

    const key = raw.slice(0, separatorIndex);
    const rawValue = raw.slice(separatorIndex + 1);

    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch (parseError) {
      return err(
        `--seed ${JSON.stringify(key)}=${JSON.stringify(rawValue)} is not valid JSON: ` +
          `${getErrorMessage(parseError)}\n` +
          `  A seed is data, not text, so --seed's value must be JSON: 500, true and null are ` +
          `already valid JSON, but a string needs its own quotes — --seed name='"Ada"', not ` +
          `--seed name=Ada.\n` +
          `  This is refused rather than silently treated as the string ${JSON.stringify(rawValue)}: ` +
          `an accidentally-stringified value passes every size and shape check `+
          `applySeedOverrides runs and only fails much later, the first time a step performs ` +
          `arithmetic on it — far from this flag.`,
      );
    }

    valueRecord[key] = value;
  }

  return ok(valueRecord);
}

/**
 * The CLI's `--seed` values as one {@link SeedOverrideLayer} — the layer
 * `run.ts`/`verify.ts` append after the workspace's own, per `CLI > workspace
 * > workflow`.
 *
 * `blockPath`/`source` name the flag rather than a document field or a
 * workflow path, because there is neither: `--seed` is not scoped by workflow
 * the way a workspace's `seedOverrides:` block is
 * (`seedOverrideLayerFor`'s own doc explains why that block needs the split) —
 * a single `run`/`verify` invocation names exactly one workflow already, so
 * every `--seed key=value` pair applies to it directly. The synthetic path
 * still reads sensibly in a diagnostic: `keyPath('--seed', 'sleep_ms')` is
 * `--seed.sleep_ms`, which an author recognises as "the --seed flag, key
 * sleep_ms" even though it is not a field in any file.
 *
 * @returns `undefined` when `valueRecord` is empty — no `--seed` flags were
 *   passed — so a caller filters it out exactly like
 *   `seedOverrideLayerFor`'s own `undefined` return, and a run with no
 *   `--seed` flags builds a `layerList` identical to one from before this
 *   flag existed.
 */
export function seedOverrideLayerFromFlags(
  valueRecord: Readonly<Record<string, unknown>>,
): SeedOverrideLayer | undefined {
  if (Object.keys(valueRecord).length === 0) {
    return undefined;
  }

  return {
    valueRecord,
    blockPath: '--seed',
    source: 'the --seed flag',
  };
}
