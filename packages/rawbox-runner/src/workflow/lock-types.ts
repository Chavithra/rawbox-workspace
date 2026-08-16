import { Type, type Static } from 'typebox';

import { StrictObject } from '@rawbox/store';

// ---------------------------------------------------------------------------
// rawbox.lock
//
// The workflow is the manifest; this generated sibling file is the lock. It is
// keyed by **package name at the workspace level**, so workflows sharing a
// plugin share one entry. `workflow lock` writes it; the workflow file is
// never rewritten.
// ---------------------------------------------------------------------------

/** File name of the lock, written next to `workspace.yaml`. */
export const RAWBOX_LOCK_FILENAME = 'rawbox.lock';

/** Value of `version:` for this lock revision. */
export const RAWBOX_LOCK_VERSION = '1';

export const RawboxLockVersion = Type.Literal(RAWBOX_LOCK_VERSION);
export type RawboxLockVersion = Static<typeof RawboxLockVersion>;

/**
 * What a lock records for one package: the version npm actually resolved, and
 * the contract-registry hash that version produced.
 *
 * `registryHash` is the same primitive as
 * `DefinitionLocation.contractRegistryHash` in `@rawbox/plugin/core`.
 */
export const RawboxLockEntry = StrictObject({
  resolved: Type.String({ minLength: 1 }),
  registryHash: Type.String({ minLength: 1 }),
});
export type RawboxLockEntry = Static<typeof RawboxLockEntry>;

/**
 * `workspaces/<workspace>/rawbox.lock` — generated, do not hand-edit.
 *
 * Absent lock means "resolve whatever is installed". A present entry is
 * enforced at load: a mismatch is a hard error naming the package and telling
 * the user to re-lock.
 */
export const RawboxLock = StrictObject({
  version: RawboxLockVersion,
  plugins: Type.Record(Type.String(), RawboxLockEntry),
});
export type RawboxLock = Static<typeof RawboxLock>;
