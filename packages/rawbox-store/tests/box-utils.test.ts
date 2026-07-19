import { describe, it, expect } from 'vitest';

import { buildBoxRecord } from '../src/box-utils.js';
import type { WriteBoxLocation, BoxStrategy } from '../src/box.js';

describe('box-utils', () => {
  const strategy: BoxStrategy = { name: 'lmdb-kv', valueSizeMax: 1024 };
  const simpleLocations: Record<string, WriteBoxLocation> = {
    input: { key: 'key1', strategy },
    output: { key: 'key2', strategy },
  };

  describe('buildBoxRecord', () => {
    it('should turn a BoxLocationRecord into a BoxRecord when all keys match', () => {
      const values = {
        input: 'value-for-1',
        output: 'value-for-2',
      };

      const result = buildBoxRecord(simpleLocations, values, 'flow1', 'space1');

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const boxes = result.value;
        expect(Object.keys(boxes)).toHaveLength(2);
        expect(boxes.input).toEqual({
          content: 'value-for-1',
          location: {
            key: 'key1',
            workflow: 'flow1',
            workspace: 'space1',
            strategy,
          },
        });
        expect(boxes.output).toEqual({
          content: 'value-for-2',
          location: {
            key: 'key2',
            workflow: 'flow1',
            workspace: 'space1',
            strategy,
          },
        });
      }
    });

    it('should return an error Result when a key is not found in the values record', () => {
      const values = {
        input: 'value-for-1',
      };

      const result = buildBoxRecord(simpleLocations, values, 'flow1', 'space1');

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toContain('Field output not found in the values record');
      }
    });
  });
});
