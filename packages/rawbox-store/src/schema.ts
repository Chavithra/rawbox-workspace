import { Type, type TObject, type TProperties } from 'typebox';

/**
 * `Type.Object` with `additionalProperties: false` — **the constructor every
 * schema of the workflow format is built with**.
 *
 * The format's rule is that an unrecognised field is an error, never silently
 * ignored. TypeBox — like JSON Schema — permits additional properties by
 * default, which makes that rule opt-in and its omission invisible. This
 * inverts the default: strictness is what you get for free, and being permissive
 * means deliberately reaching for `Type.Object`, which is a visible choice in a
 * diff.
 *
 * Two things it deliberately does **not** reach, both open by design:
 *
 * - **`Type.Record` maps.** `storage.keys`, `plugins:`, `backends:`
 *   and the box-location records are key → value maps whose *keys* are the
 *   author's. A `storage.keys` entry's `seed` in particular holds arbitrary
 *   data, which is the whole reason a seed has no long form: a binding value is
 *   always a storage-key *string*, so an object there unambiguously signals a
 *   long form, but a seed value is arbitrary data and `config: { value: 1 }`
 *   cannot be told apart from an intended literal object. Any long form would
 *   need a reserved wrapper and would still read ambiguously. A record is not an
 *   object schema, so this helper cannot be applied to one by accident.
 * - **Contract schemas.** `inputSchema`/`outputSchema`/`errorSchema` come from
 *   third-party plugins and are arbitrary JSON Schema. They are compiled as
 *   given (`@rawbox/plugin`), never rebuilt through here; forcing them strict
 *   would reject valid plugins.
 *
 * It lives in `@rawbox/store` because that is the only package both halves of
 * the format's schema graph can see: `@rawbox/runner` builds `Storage` and
 * `StorageLocation` out of the `BoxStrategy` and box-location schemas defined
 * next door, and depends on this package already.
 *
 * @param properties - The object's properties, exactly as `Type.Object` takes
 *                     them.
 * @returns The object schema, closed to properties it does not name.
 */
export function StrictObject<Properties extends TProperties>(
  properties: Properties,
): TObject<Properties> {
  return Type.Object(properties, { additionalProperties: false });
}
