import { ok } from 'neverthrow';
import { ReservedLabel } from 'rawbox-plugin/control-flow';
import { createControlFlowDefinition } from '../../contract-registry.js';

const haltDefinition = createControlFlowDefinition(
  './control-flow/definitions/halt.definition.js',
  async (input) => {
    const { reason } = input;

    if (reason !== undefined) {
      console.info(
        JSON.stringify({ timestamp: Date.now(), event: 'halt', reason }),
      );
    }

    return ok({ label: ReservedLabel.EXIT });
  },
);

export default haltDefinition;
