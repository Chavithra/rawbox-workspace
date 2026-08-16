// ---------------------------------------------------------------------------
// `@rawbox/plugin/typebox` — typebox, passed through unchanged.
//
// This module adds nothing and wraps nothing. It exists so a plugin package can
// build its contract schemas without declaring `typebox` itself:
//
//   import { Type } from '@rawbox/plugin/typebox';
//
// ## Why a passthrough rather than a root export
//
// The SDK's root export is about Rawbox — `setupPluginRegistry`,
// `ObjectSchemaLike`, `TIMEOUT_MS_MAX`, `emitRunEvent`. Folding a foreign
// library's whole surface into it would blur what a reader is looking at, and
// the import site would stop saying where the API came from. Named after the
// package it passes through, the specifier tells the author two things at a
// glance: this is the upstream API, and upstream documentation applies to it.
//
// ## Why `export *` and not a curated subset
//
// A partial re-export is worse than none. A plugin that takes `Type` from here
// and `Static` from its own `typebox` has two copies again, with extra steps and
// a more confusing failure. Everything typebox exports at its root is available
// here so that never has to happen.
//
// Subpaths are deliberately NOT mirrored yet: `typebox/compile` and
// `typebox/error` are used inside this package and by the runner, but no plugin
// has needed them. When one does, add `./typebox/compile` beside this file
// rather than telling the author to install typebox — the moment a plugin has
// its own copy, the reason this module exists is gone.
//
// ## What this does not make true
//
// It encourages one copy of typebox; it cannot enforce one. A plugin may still
// install its own, and a contract may be written as plain JSON Schema with no
// typebox at all. `ObjectSchemaLike` and the cross-copy integration test
// therefore remain load-bearing — see `core/contracts/contract-registry-types.ts`
// for what goes wrong when a schema generic is constrained on `TObject` instead.
// ---------------------------------------------------------------------------

export * from 'typebox';
