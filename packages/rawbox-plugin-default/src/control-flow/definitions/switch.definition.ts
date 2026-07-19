import { ok } from 'neverthrow';
import { createControlFlowDefinition } from '../../contract-registry.js';

const switchDefinition = createControlFlowDefinition(
  './control-flow/definitions/switch.definition.js',
  async (input) => {
    const { value, caseMap, defaultLabel } = input;

    if (Object.hasOwn(caseMap, value)) {
      return ok({ label: caseMap[value]! });
    }

    return ok({ label: defaultLabel });
  },
);

export default switchDefinition;
