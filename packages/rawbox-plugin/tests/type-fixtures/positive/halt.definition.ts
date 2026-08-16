// ---------------------------------------------------------------------------
// Control-flow contract, cross-copy. Distinct from the operation case in the
// one way that matters here: a control-flow contract has NO `outputSchema`, so
// the SDK substitutes its own fixed `{ label }` schema built by the FRAMEWORK's
// typebox. A single handler signature therefore mixes both copies — the input
// side from `typebox-xcopy`, the output side from `typebox`.
//
// Same two-directional probes as echo.definition.ts; see its header for why
// both halves are required.
// ---------------------------------------------------------------------------
import { ok } from 'neverthrow';

import { createControlFlowDefinition } from './registry.js';

export default createControlFlowDefinition('./halt.definition.js', async (input) => {
  // --- boolean ---
  const when: boolean = input.when;
  // @ts-expect-error `when` is boolean, not string — proves the type is not `any`
  const whenAsString: string = input.when;

  // --- optional ---
  const reason: string | undefined = input.reason;
  // @ts-expect-error optional must not collapse to a bare `string`
  const reasonAsString: string = input.reason;

  // --- array ---
  const tags: string[] = input.tags;
  // @ts-expect-error the array element type is string, not number
  const tagsAsNumbers: number[] = input.tags;

  // --- union of literals ---
  const mode: 'soft' | 'hard' = input.mode;
  // @ts-expect-error the union does not admit 'medium'
  const modeAsMedium: 'medium' = input.mode;

  // --- nested object ---
  const attempt: number = input.meta.attempt;
  // @ts-expect-error nested property is number, not string
  const attemptAsString: string = input.meta.attempt;

  // --- absent property ---
  // @ts-expect-error `zzz` is not a property of the inferred input
  const absent = input.zzz;

  void [
    when,
    whenAsString,
    reason,
    reasonAsString,
    tags,
    tagsAsNumbers,
    mode,
    modeAsMedium,
    attempt,
    attemptAsString,
    absent,
  ];

  // The output side comes from the SDK's OWN typebox copy, not the fixture's.
  return ok({ label: '__END__' });
});
