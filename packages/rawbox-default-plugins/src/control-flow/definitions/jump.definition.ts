import { ok } from 'neverthrow';
import { createControlFlowDefinition } from './contract-registry.js';

const controlFlowDefinition = createControlFlowDefinition(
  './goto.definition.js',
  async (input) => {
    const { label } = input;

    return ok({ label });
  },
);

export default controlFlowDefinition;
