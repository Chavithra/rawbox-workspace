// ---------------------------------------------------------------------------
// The counterfactual. This file MUST NOT compile.
//
// Without it the positive fixture could pass vacuously: if npm ever deduped
// `typebox` and `typebox-xcopy` onto one physical copy, or a future typebox
// stopped computing `required`, the "cross-copy" test would silently become a
// single-copy test and keep reporting green. `strict()` below reproduces the
// pre-fix SDK signature — a constraint on the FRAMEWORK copy's `TObject` — so
// as long as the two copies really are distinct, it fails, and the harness
// asserts on the exact error.
//
// `loose()` is the shipped constraint on the same schema and must stay clean;
// the harness asserts the file produces exactly one error, which is what makes
// that assertion meaningful.
// ---------------------------------------------------------------------------
import { Type } from 'typebox-xcopy'; // the plugin author's copy
import type { TObject } from 'typebox'; // the framework's copy
import type { ObjectSchemaLike } from '@rawbox/plugin';

const schema = Type.Object({ a: Type.Number(), b: Type.String() });

/** The pre-T1 constraint. Expected: TS2345, the required-tuple mismatch. */
declare function strict<T extends TObject>(value: T): T;
void strict(schema);

/** The post-T1 constraint. Expected: no error. */
declare function loose<T extends ObjectSchemaLike>(value: T): T;
void loose(schema);
