// ---------------------------------------------------------------------------
// Operation contract, cross-copy. Compiling is not enough: a constraint that
// degraded to `any` would compile too. So every property is probed from BOTH
// directions —
//
//   * a valid use that must compile   -> breaks if the type widened to `unknown`
//   * a `@ts-expect-error` that must be USED -> TS2578 if it narrowed to `any`
//
// Together those pin the inferred type exactly. Do not remove either half.
// ---------------------------------------------------------------------------
import { err, ok } from 'neverthrow';

import { createOperationDefinition } from './registry.js';

export default createOperationDefinition('./echo.definition.js', async (input) => {
  // --- number ---
  const a: number = input.a;
  // @ts-expect-error `a` is number, not string — proves the type is not `any`
  const aAsString: string = input.a;

  // --- string ---
  const b: string = input.b;
  // @ts-expect-error `b` is string, not number — proves the type is not `any`
  const bAsNumber: number = input.b;

  // --- optional: the shape `required` used to encode, and the one most at
  //     risk now that `ObjectSchemaLike` omits `required` entirely ---
  const maybe: string | undefined = input.maybe;
  // @ts-expect-error optional must not collapse to a bare `string`
  const maybeAsString: string = input.maybe;

  // --- nested object ---
  const deep: boolean = input.nested.deep;
  // @ts-expect-error nested property is boolean, not string
  const deepAsString: string = input.nested.deep;

  // --- array ---
  const list: string[] = input.list;
  // @ts-expect-error the array element type is string, not number
  const listAsNumbers: number[] = input.list;

  // --- union of literals ---
  const choice: 'x' | 'y' = input.choice;
  // @ts-expect-error the union does not admit 'z'
  const choiceAsZ: 'z' = input.choice;

  // --- absent property: the plainest possible proof the type is not `any` ---
  // @ts-expect-error `zzz` is not a property of the inferred input
  const absent = input.zzz;

  void [
    a,
    aAsString,
    b,
    bAsNumber,
    maybe,
    maybeAsString,
    deep,
    deepAsString,
    list,
    listAsNumbers,
    choice,
    choiceAsZ,
    absent,
  ];

  // The error and output types are inferred from the other copy's
  // `errorSchema` / `outputSchema` too.
  if (a < 0) return err({ message: b });

  return ok({ out: a });
});
