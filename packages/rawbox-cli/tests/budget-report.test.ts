import { describe, it, expect } from 'vitest';
import type { KeyBudget, StorageBudget, UnbudgetableKey } from '@rawbox/store';

import {
  formatBoundKeyNoteLine,
  formatKeyBudgetLine,
  formatUnbudgetableKeyLine,
  formatUnbudgetableKeyNoteLine,
  formatWorkspaceUnbudgetableKeyLines,
} from '../src/utils/budget-report.js';

// ---------------------------------------------------------------------------
// Rendering a key with no budget
//
// `StrategyDescriptor.budget` is optional (`@rawbox/store`,
// `strategy/descriptor.ts`), so `budgetForStorage` can return keys it could not
// charge. **Both strategies shipping today have budgets**, so no real document
// can reach these lines yet — which is exactly why the renderer takes plain
// records rather than a whole command's output: the wording is pinned here,
// against hand-built values, instead of first being exercised by whichever
// backend lands next.
//
// What is asserted is one rule above all: a key with no budget must never
// render as `0`. Zero would sit in a column of byte counts and read as "this
// key costs nothing", which is the one thing about it that is certainly false.
// ---------------------------------------------------------------------------

/**
 * A budgeted key, hand-built rather than computed.
 *
 * The arithmetic is `@rawbox/store`'s and is tested there; what these tests
 * need is a record on the *budgeted* side of the union to mix with the other.
 */
function keyBudget(
  key: string,
  overrides: Partial<KeyBudget> = {},
): KeyBudget {
  return {
    budgetable: true,
    key,
    source: 'declared',
    strategyName: 'lmdb-kv',
    entryCount: 1,
    keySizeMax: key.length,
    dataBytesMax: 1_000,
    usesOverflowPages: false,
    leafPageShare: 0.5,
    overflowPageCount: 0,
    ...overrides,
  };
}

/**
 * A key whose strategy declares no budget.
 *
 * `strategyName` stays inside `BoxStrategy['name']` — the real, closed union of
 * the two LMDB strategies. Inventing a third name to make the fixture look like
 * a remote backend would be a claim this repository cannot yet make; the
 * renderer branches on `budgetable`, not on the name, so the fixture is honest
 * and still exercises the branch.
 */
function unbudgetableKey(
  key: string,
  source: UnbudgetableKey['source'] = 'declared',
): UnbudgetableKey {
  return { budgetable: false, key, source, strategyName: 'lmdb-kv' };
}

describe('budget-report — keys with no budget', () => {
  describe('formatUnbudgetableKeyLine', () => {
    it('states "not applicable" and never a byte figure', () => {
      const line = formatUnbudgetableKeyLine(unbudgetableKey('remote_cache'));

      expect(line).toContain('remote_cache');
      expect(line).toContain('not applicable');
      // The whole point: no `0`, and nothing that could be read as a count of
      // bytes this key costs.
      expect(line).not.toMatch(/\b0 bytes\b/);
      expect(line).toContain('NOT zero bytes');
      expect(line).toContain('bounded by the backend');
    });

    it('names the strategy, which is the reason there is no figure', () => {
      expect(formatUnbudgetableKeyLine(unbudgetableKey('k'))).toContain(
        'lmdb-kv',
      );
    });

    it('labels a step-bound key as bound, like a budgeted one', () => {
      expect(
        formatUnbudgetableKeyLine(unbudgetableKey('k', 'bound')),
      ).toContain('bound by a step');
      // The same wording `formatKeyBudgetLine` uses, so the two kinds of line
      // read as one report rather than two vocabularies.
      expect(formatKeyBudgetLine(keyBudget('j', { source: 'bound' }))).toContain(
        'bound by a step',
      );
    });
  });

  describe('formatUnbudgetableKeyNoteLine', () => {
    it('is absent when every key could be charged', () => {
      expect(
        formatUnbudgetableKeyNoteLine({
          keyBudgetList: [keyBudget('ticker')],
          unbudgetableKeyList: [],
        }),
      ).toBeUndefined();
    });

    it('names every excluded key and says how many of how many the total covers', () => {
      const note = formatUnbudgetableKeyNoteLine({
        keyBudgetList: [keyBudget('ticker'), keyBudget('notes')],
        unbudgetableKeyList: [
          unbudgetableKey('remote_a'),
          unbudgetableKey('remote_b', 'bound'),
        ],
      });

      expect(note).toBeDefined();
      // Named, not counted: a reader can SEE which keys are outside the figure
      // rather than inferring that two of them are.
      expect(note).toContain('"remote_a"');
      expect(note).toContain('"remote_b"');
      expect(note).toContain('NOT included');
      expect(note).toContain('cover 2 of 4 keys');
    });

    it('reads correctly for a single excluded key', () => {
      const note = formatUnbudgetableKeyNoteLine({
        keyBudgetList: [keyBudget('ticker')],
        unbudgetableKeyList: [unbudgetableKey('remote_a')],
      });

      expect(note).toContain('1 key is NOT included');
      expect(note).toContain('cover 1 of 2 keys');
    });
  });

  describe('formatBoundKeyNoteLine counts both sides of the partition', () => {
    // "Bound by a step" and "has a budget" are independent questions. A bound
    // key with no budget is still a key the document never declared, so leaving
    // it out of these counts would make the sentence disagree with the lines
    // printed directly above it.
    const budget: Pick<StorageBudget, 'keyBudgetList' | 'unbudgetableKeyList'> =
      {
        keyBudgetList: [keyBudget('ticker')],
        unbudgetableKeyList: [unbudgetableKey('remote_a', 'bound')],
      };

    it('includes an unbudgetable bound key in the note', () => {
      const note = formatBoundKeyNoteLine(budget);

      expect(note).toContain('1 of these 2 keys');
      expect(note).toContain('"remote_a"');
      expect(note).toContain('1 declared key');
    });

    it('stays absent when nothing at all is bound', () => {
      expect(
        formatBoundKeyNoteLine({
          keyBudgetList: [keyBudget('ticker')],
          unbudgetableKeyList: [unbudgetableKey('remote_a')],
        }),
      ).toBeUndefined();
    });
  });

  describe('formatWorkspaceUnbudgetableKeyLines', () => {
    it('adds no section when nothing was excluded', () => {
      expect(formatWorkspaceUnbudgetableKeyLines([])).toEqual([]);
    });

    it('names the workflow each excluded key belongs to', () => {
      // The workspace decision: report the modelled total as the provisioning
      // figure and list what it leaves out, by workflow and key, so the
      // exclusion is visible rather than inferred — the posture the budget
      // already fixed for cross-workflow reads.
      const lines = formatWorkspaceUnbudgetableKeyLines([
        {
          workflowName: 'ingest',
          unbudgetableKey: unbudgetableKey('remote_a'),
        },
        {
          workflowName: 'report',
          unbudgetableKey: unbudgetableKey('remote_b', 'bound'),
        },
      ]);

      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('NOT part of the workspace total');
      expect(lines[1]).toContain('ingest');
      expect(lines[1]).toContain('remote_a');
      expect(lines[2]).toContain('report');
      expect(lines[2]).toContain('remote_b');
      expect(lines.join('\n')).not.toMatch(/\b0 bytes\b/);
    });
  });
});
