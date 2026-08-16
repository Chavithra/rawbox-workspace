import { ok } from '@rawbox/plugin/neverthrow';
import { createControlFlowDefinition } from '../contract-registry.js';

const branchDefinition = createControlFlowDefinition(
  './control-flow/branch.definition.js',
  async (input) => {
    const { condition, thenLabel, elseLabel } = input;

    return ok({ label: condition ? thenLabel : elseLabel });
  },
);

export default branchDefinition;
