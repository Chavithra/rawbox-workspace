// The zero-required-property shape. Under the old strict `TObject` constraint
// this produced the incident's other error text — "Type 'undefined' is not
// assignable to type '[string]'" — because `Type.Object({})` computes
// `required: undefined` while `TObject<TProperties>` computes `[string]`.
import { ok } from 'neverthrow';

import { createOperationDefinition } from './registry.js';

export default createOperationDefinition('./empty.definition.js', async (input) => {
  // @ts-expect-error the input schema has no properties at all
  const absent = input.anything;
  void absent;

  return ok({});
});
