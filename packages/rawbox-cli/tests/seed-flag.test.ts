import { describe, it, expect } from 'vitest';

import { parseSeedFlagList, seedOverrideLayerFromFlags } from '../src/utils/seed-flag.js';

// ---------------------------------------------------------------------------
// `--seed key=<json>` parsing — pure, no workspace/workflow needed, so this
// is unit-tested directly rather than only through `run.test.ts`/
// `verify.test.ts`'s end-to-end scenarios.
// ---------------------------------------------------------------------------

describe('parseSeedFlagList', () => {
  it('returns an empty record for an empty list', () => {
    expect(parseSeedFlagList([]).isOk()).toBe(true);
    expect(parseSeedFlagList([])._unsafeUnwrap()).toEqual({});
  });

  it('parses a JSON value per key: number, string, bool, null, array, object', () => {
    const result = parseSeedFlagList([
      'count=500',
      'name="Ada"',
      'active=true',
      'ignored=null',
      'items=[1,2,3]',
      'config={"a":1}',
    ]);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({
      count: 500,
      name: 'Ada',
      active: true,
      ignored: null,
      items: [1, 2, 3],
      config: { a: 1 },
    });
  });

  it('splits on the FIRST "=" only, so a JSON value containing "=" is not truncated', () => {
    const result = parseSeedFlagList(['query="a=b"']);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ query: 'a=b' });
  });

  it('a later entry for the same key wins, like a duplicate object-literal key', () => {
    const result = parseSeedFlagList(['sleep_ms=1', 'sleep_ms=2']);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ sleep_ms: 2 });
  });

  it('is a named error for an entry with no "="', () => {
    const result = parseSeedFlagList(['sleep_ms']);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('--seed value "sleep_ms"');
    expect(result._unsafeUnwrapErr()).toContain('key=<json>');
  });

  // The hazard this whole module exists to name: an unquoted value must never
  // silently become the *string* form of itself. Named after --seed and the
  // specific key, so the diagnostic points straight back at its cause instead
  // of surfacing far away, the first time a step does arithmetic on it.
  it('is a named error for a value that is not valid JSON, naming --seed and the key', () => {
    const result = parseSeedFlagList(['sleep_ms=500x']);
    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();
    expect(message).toContain('--seed "sleep_ms"');
    expect(message).toContain('is not valid JSON');
    expect(message).toContain('must be JSON');
  });

  it('is a named error for a bare, unquoted string value', () => {
    const result = parseSeedFlagList(['name=Ada']);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('--seed "name"');
  });

  it('the first malformed entry is reported when several are given', () => {
    const result = parseSeedFlagList(['ok=1', 'bad=nope', 'also_bad=nope2']);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('--seed "bad"');
  });
});

describe('seedOverrideLayerFromFlags', () => {
  it('returns undefined for an empty value record — no --seed flags means no CLI layer', () => {
    expect(seedOverrideLayerFromFlags({})).toBeUndefined();
  });

  it('builds a layer naming the --seed flag as its source', () => {
    const layer = seedOverrideLayerFromFlags({ sleep_ms: 500 });
    expect(layer).toEqual({
      valueRecord: { sleep_ms: 500 },
      blockPath: '--seed',
      source: 'the --seed flag',
    });
  });
});
