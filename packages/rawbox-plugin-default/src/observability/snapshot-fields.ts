/**
 * The fixed set of `observability/snapshot` input/output value fields.
 *
 * Shared between the contract's `inputSchema` (in `contract-registry.ts`,
 * which every field name must be typed into by hand — TypeBox schemas are not
 * built from a runtime list) and the handler (`snapshot.definition.ts`, which
 * *does* iterate this list at run time). Kept in one place so the two cannot
 * drift on the count or the names: `contract-registry.test.ts`-style callers
 * can assert the schema declares exactly this list, and the handler has
 * nothing else to read.
 *
 * Eight is a deliberately round, ample number for the case this operation
 * exists to serve — a handful of cross-workflow reads snapshotted together —
 * not a protocol limit. Raising it is additive (OBSERVABILITY.md, "Versioning"'s
 * "a reader MUST ignore ... an envelope field it does not know" is the
 * spirit, not the letter, but the principle transfers: an unused `valueN`
 * costs nothing, so the count only needs to be "enough", not "exact").
 */
export const SNAPSHOT_VALUE_FIELD_LIST = [
  'value1',
  'value2',
  'value3',
  'value4',
  'value5',
  'value6',
  'value7',
  'value8',
] as const;

export type SnapshotValueField = (typeof SNAPSHOT_VALUE_FIELD_LIST)[number];
