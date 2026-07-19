import { ok } from 'neverthrow';
import { createOperationDefinition } from '../contract-registry.js';

const logDefinition = createOperationDefinition(
  './observability/log.definition.js',
  async (input) => {
    const { level, message, data } = input;
    const timestamp = Date.now();

    const hasData = data !== undefined;
    const line = hasData
      ? { timestamp, level, message, data }
      : { timestamp, level, message };

    let serialized: string;
    try {
      serialized = JSON.stringify(line);
    } catch {
      serialized = JSON.stringify({
        timestamp,
        level,
        message,
        data: '[unserializable]',
      });
    }

    switch (level) {
      case 'debug':
        console.debug(serialized);
        break;
      case 'info':
        console.info(serialized);
        break;
      case 'warn':
        console.warn(serialized);
        break;
      case 'error':
        console.error(serialized);
        break;
    }

    return ok({ timestamp });
  },
);

export default logDefinition;
