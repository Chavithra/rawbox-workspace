import { ok } from 'neverthrow';
import { createControlFlowDefinition } from '../../contract-registry.js';

const loopGateDefinition = createControlFlowDefinition(
  './control-flow/definitions/loop-gate.definition.js',
  async (input) => {
    const { counter, max, loopLabel, exitLabel } = input;

    return ok({ label: counter < max ? loopLabel : exitLabel });
  },
);

export default loopGateDefinition;
