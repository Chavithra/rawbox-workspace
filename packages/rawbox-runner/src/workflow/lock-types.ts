import { Type, type Static } from 'typebox';

import { StrictObject } from '@rawbox/store';

// ---------------------------------------------------------------------------
// rawbox.lock
//
// The workflow is the manifest; this generated sibling file is the lock. It is
// keyed at the workspace level by **package name and canonical specifier**
// (`canonicalLockSpecifier`), so workflows sharing a specifier share one entry
// and workflows pinning different versions of one package get one entry each.
// `workflow lock` writes it; the workflow file is never rewritten.
// ---------------------------------------------------------------------------

/** File name of the lock, written next to `workspace.yaml`. */
export const RAWBOX_LOCK_FILENAME = 'rawbox.lock';

/** Value of `version:` for this lock revision. */
export const RAWBOX_LOCK_VERSION = '2';

export const RawboxLockVersion = Type.Literal(RAWBOX_LOCK_VERSION);
export type RawboxLockVersion = Static<typeof RawboxLockVersion>;

/**
 * What a lock records for one package at one specifier: the version npm
 * actually resolved, and the contract-registry hash that version produced.
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
 * `dependencies[packageName][canonicalSpecifier]`. The specifier level exists
 * because one install no longer serves the whole workspace: each distinct
 * `dependencies:` map has its own env, so `^0.1.0` and `^0.2.0` of one package
 * can both be installed — and both be locked — at once.
 *
 * Absent lock means "resolve whatever is installed". A present entry is
 * enforced at load: a mismatch is a hard error naming the package and telling
 * the user to re-lock.
 */
export const RawboxLock = StrictObject({
  version: RawboxLockVersion,
  dependencies: Type.Record(Type.String(), Type.Record(Type.String(), RawboxLockEntry)),
});
export type RawboxLock = Static<typeof RawboxLock>;
