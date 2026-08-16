import { ok } from '@rawbox/plugin/neverthrow';
import { createControlFlowDefinition } from '../contract-registry.js';

const controlFlowDefinition = createControlFlowDefinition(
  './control-flow/jump.definition.js',
  async (input) => {
    const { label } = input;

    return ok({ label });
  },
);

export default controlFlowDefinition;
