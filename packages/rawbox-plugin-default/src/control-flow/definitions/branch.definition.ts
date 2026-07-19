import { ok } from 'neverthrow';
import { createControlFlowDefinition } from '../../contract-registry.js';

const branchDefinition = createControlFlowDefinition(
  './control-flow/definitions/branch.definition.js',
  async (input) => {
    const { condition, thenLabel, elseLabel } = input;

    return ok({ label: condition ? thenLabel : elseLabel });
  },
);

export default branchDefinition;
