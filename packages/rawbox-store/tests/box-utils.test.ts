import { describe, it, expect } from 'vitest';

import { buildBoxRecord } from '../src/box-utils.js';
import type { BoxLocation, BoxStrategy, BoxLocationRecord } from '../src/box.js';

describe('box-utils', () => {
  const strategy: BoxStrategy = { name: 'lmdb-kv', valueSizeMax: 1024 };
  const simpleLocations = {
    input: { key: 1, workflow: 'flow1', workspace: 'space1' },
    output: { key: 2, workflow: 'flow2', workspace: 'space2' },
  };

  function buildBoxLocationRecord(
    simpleLocs: Record<string, Omit<BoxLocation, 'strategy'>>,
    strat: BoxStrategy,
  ): BoxLocationRecord {
    const record: BoxLocationRecord = {};
    for (const [name, loc] of Object.entries(simpleLocs)) {
      record[name] = {
        ...loc,
        strategy: strat,
      };
    }
    return record;
  }

  describe('buildBoxLocationRecord (local helper)', () => {
    it('should turn a record of simple locations into a BoxLocationRecord with the same strategy', () => {
      const record = buildBoxLocationRecord(simpleLocations, strategy);

      expect(Object.keys(record)).toHaveLength(2);
      expect(record.input).toEqual({
        key: 1,
        workflow: 'flow1',
        workspace: 'space1',
        strategy,
      });
      expect(record.output).toEqual({
        key: 2,
        workflow: 'flow2',
        workspace: 'space2',
        strategy,
      });
    });
  });

  describe('buildBoxRecord', () => {
    it('should turn a BoxLocationRecord into a BoxRecord when all keys match', () => {
      const boxLocationRecord = buildBoxLocationRecord(simpleLocations, strategy);
      const values = {
        input: 'value-for-1',
        output: 'value-for-2',
      };

      const result = buildBoxRecord(boxLocationRecord, values);

      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        const boxes = result.value;
        expect(Object.keys(boxes)).toHaveLength(2);
        expect(boxes.input).toEqual({
          content: 'value-for-1',
          location: {
            key: 1,
            workflow: 'flow1',
            workspace: 'space1',
            strategy,
          },
        });
        expect(boxes.output).toEqual({
          content: 'value-for-2',
          location: {
            key: 2,
            workflow: 'flow2',
            workspace: 'space2',
            strategy,
          },
        });
      }
    });

    it('should return an error Result when a key is not found in the values record', () => {
      const boxLocationRecord = buildBoxLocationRecord(simpleLocations, strategy);
      const values = {
        input: 'value-for-1',
      };

      const result = buildBoxRecord(boxLocationRecord, values);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toContain('Field output not found in the values record');
      }
    });
  });
});
