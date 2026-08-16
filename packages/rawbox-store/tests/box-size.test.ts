import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Database } from 'lmdb';

import { BoxStoreLmdb } from '../src/box-store/box-store-lmdb.js';
import {
  LMDB_INDEX_POINTER,
  LMDB_KEY_SIZE_MAX_DEFAULT,
  LMDB_NODE_HEADER,
  LMDB_INPAGE_KEY_PLUS_VALUE_MAX,
  LMDB_PAGE_SIZE_DEFAULT,
  RAWBOX_KEY_DERIVATION_OVERHEAD_MAX,
  RAWBOX_KEY_SIZE_MAX,
  entryOverhead,
  readMaxKeySize,
  recommendedVolumeBytesFor,
  measureKeySize,
  measureValueSize,
  type BoxStorage,
  type KeyBudget,
  type KeyBudgetSource,
} from '../src/box-size.js';
// `budgetForKey` and `budgetForStorage` live with the strategy registry, not
// with the page model: they read `StrategyDescriptor.budget`, which is optional,
// and `box-size.ts` may not import `strategy/`. See `strategy/budget.ts`.
import {
  budgetForKey,
  budgetForStorage,
  partitionKeyBudgetOutcomeList,
  type KeyBudgetOutcome,
  type UnbudgetableKey,
} from '../src/strategy/budget.js';
import { type BoxStrategy } from '../src/box.js';

/**
 * `budgetForKey`'s budgeted answer, or a failed test.
 *
 * `budgetForKey` returns a `KeyBudgetOutcome` — a `KeyBudget` *or* an
 * `UnbudgetableKey` for a strategy with no byte model — so a test reading
 * `.dataBytesMax` has to say which it expected. Both strategies shipping today
 * are budgetable, so every use below asserts that and unwraps; a strategy that
 * stopped being budgetable would fail here by name rather than by a confusing
 * type error somewhere downstream.
 */
function budgetOf(
  key: string,
  strategy: BoxStrategy,
  source?: KeyBudgetSource,
): KeyBudget {
  const outcome = budgetForKey(key, strategy, source);

  if (!outcome.budgetable) {
    throw new Error(
      `Expected a budget for key '${key}' under strategy '${strategy.name}', ` +
        `but the strategy declares none`,
    );
  }

  return outcome;
}

const workspace = 'size-workspace';
const workflow = 'size-workflow';

/**
 * A `Database` with `encoder` hidden, to exercise `measureValueSize`'s fallback
 * path without opening a second environment. Only `.encoder` is
 * ever read through this handle.
 */
function withoutEncoder(db: Database<unknown, string>): Database<unknown, string> {
  return new Proxy(db, {
    get(target, property, receiver): unknown {
      return property === 'encoder'
        ? undefined
        : Reflect.get(target, property, receiver);
    },
  });
}

describe('box-size', () => {
  let dbDirUrl: URL;
  let dataFilePath: string;
  let store: BoxStoreLmdb;
  let dbi: Database<unknown, string>;

  beforeAll(async () => {
    const rand = Math.floor(Math.random() * 1000000);
    dbDirUrl = new URL(
      `../data/test-size-${Date.now()}-${rand}/`,
      import.meta.url,
    );
    await fs.mkdir(fileURLToPath(dbDirUrl), { recursive: true });
    store = BoxStoreLmdb.create(workspace, dbDirUrl);
    dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();
    dataFilePath = fileURLToPath(new URL(`./${workspace}/data.mdb`, dbDirUrl));
  });

  afterAll(async () => {
    try {
      store.dbiCache.env.close();
    } catch {
      void 0;
    }
    try {
      await fs.rm(fileURLToPath(dbDirUrl), { recursive: true, force: true });
    } catch {
      void 0;
    }
  });

  // -------------------------------------------------------------------------
  // T3 — boundary behaviour of the measured quantity
  // -------------------------------------------------------------------------

  describe('T3 — a value at exactly valueSizeMax is accepted, one byte over is not', () => {
    // The shipped default. Nothing here depends on it being *that* number —
    // this is about `measureValueSize`'s boundary, not about page behaviour —
    // but using the default keeps the case realistic.
    const valueSizeMax = 1900;

    // A msgpack `str32`-class header for 256..65535 bytes costs 3 bytes, so a
    // 1897-character ASCII string packs to exactly 1900.
    const atLimit = 'x'.repeat(valueSizeMax - 3);
    const overLimit = 'x'.repeat(valueSizeMax - 2);

    it('measures the boundary value at exactly valueSizeMax', () => {
      const measured = measureValueSize(atLimit, dbi);

      expect(measured.isOk()).toBe(true);
      expect(measured._unsafeUnwrap()).toBe(valueSizeMax);
      expect(measured._unsafeUnwrap() <= valueSizeMax).toBe(true);
    });

    it('measures one character more at valueSizeMax + 1', () => {
      const measured = measureValueSize(overLimit, dbi);

      expect(measured.isOk()).toBe(true);
      expect(measured._unsafeUnwrap()).toBe(valueSizeMax + 1);
      expect(measured._unsafeUnwrap() <= valueSizeMax).toBe(false);
    });

    it('agrees with the bytes lmdb-js actually stores at the boundary', () => {
      dbi.putSync('t3:at-limit', atLimit);
      dbi.putSync('t3:over-limit', overLimit);

      expect(dbi.getBinary('t3:at-limit')?.length).toBe(
        measureValueSize(atLimit, dbi)._unsafeUnwrap(),
      );
      expect(dbi.getBinary('t3:over-limit')?.length).toBe(
        measureValueSize(overLimit, dbi)._unsafeUnwrap(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // T6 — encoding failures surface as Err
  // -------------------------------------------------------------------------

  describe('T6 — unencodable content returns Err rather than throwing', () => {
    it('returns Err for a cyclic object', () => {
      const cyclic: Record<string, unknown> = { name: 'loop' };
      cyclic['self'] = cyclic;

      let measured = measureValueSize(0, dbi);
      expect(() => {
        measured = measureValueSize(cyclic, dbi);
      }).not.toThrow();

      expect(measured.isErr()).toBe(true);
      expect(measured._unsafeUnwrapErr()).toContain(
        'Failed to measure value size',
      );
    });

    it('returns Err for a cyclic array', () => {
      const cyclic: unknown[] = [];
      cyclic.push(cyclic);

      const measured = measureValueSize(cyclic, dbi);

      expect(measured.isErr()).toBe(true);
    });

    it('returns Err for a BigInt too large for a msgpack 64-bit integer', () => {
      let measured = measureValueSize(0, dbi);
      expect(() => {
        measured = measureValueSize({ counter: 2n ** 64n }, dbi);
      }).not.toThrow();

      expect(measured.isErr()).toBe(true);
      expect(measured._unsafeUnwrapErr()).toContain(
        'Failed to measure value size',
      );
    });

    it('returns Ok for a BigInt that does fit — msgpackr encodes those natively', () => {
      const measured = measureValueSize({ counter: 2n ** 63n - 1n }, dbi);

      expect(measured.isOk()).toBe(true);
    });

    it('returns Err for a Symbol', () => {
      const measured = measureValueSize({ tag: Symbol('nope') }, dbi);

      expect(measured.isErr()).toBe(true);
      expect(measured._unsafeUnwrapErr()).toContain('Unknown type: symbol');
    });

    it('returns Err on the fallback path too', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;

      expect(measureValueSize(cyclic).isErr()).toBe(true);
      expect(measureValueSize(cyclic, withoutEncoder(dbi)).isErr()).toBe(true);
    });

    it('leaves the encoder usable after a failure', () => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;

      const before = measureValueSize(
        { price: 105.4, ticker: 'BTC/USDT' },
        dbi,
      )._unsafeUnwrap();
      measureValueSize(cyclic, dbi);
      const after = measureValueSize(
        { price: 105.4, ticker: 'BTC/USDT' },
        dbi,
      )._unsafeUnwrap();

      expect(after).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // T7 — anti-drift on the fallback path
  // -------------------------------------------------------------------------

  describe('T7 — fallback measurement matches the bytes lmdb-js packs', () => {
    // Packed vs packed on both sides: `getBinary` decompresses transparently,
    // so it reports packed bytes and can never observe on-disk size.
    const corpus: readonly { readonly name: string; readonly value: unknown }[] =
      [
        { name: 'null', value: null },
        { name: 'boolean', value: true },
        { name: 'small int', value: 7 },
        { name: 'negative int', value: -4242 },
        { name: 'float', value: 105.4 },
        { name: 'large int', value: Number.MAX_SAFE_INTEGER },
        { name: 'empty string', value: '' },
        { name: 'short string', value: 'BTC/USDT' },
        { name: 'unicode string', value: 'héllo — 日本語 🎉' },
        { name: 'empty object', value: {} },
        { name: 'flat object', value: { price: 105.4, ticker: 'BTC/USDT' } },
        {
          name: 'ticker record',
          value: { price: 105.4, ticker: 'BTC/USDT', timestamp: 1, volume: 2 },
        },
        {
          name: 'nested object',
          value: { a: { b: { c: { d: [1, 2, 3, { e: 'f' }] } } } },
        },
        { name: 'empty array', value: [] },
        { name: 'array of scalars', value: [1, 'two', 3.5, false, null] },
        {
          name: 'array of records',
          value: Array.from({ length: 20 }, (_v, i) => ({
            ticker: `SYM${i}`,
            price: i * 1.5,
          })),
        },
        { name: 'date', value: new Date('2026-08-08T00:00:00.000Z') },
        { name: 'binary', value: new Uint8Array([1, 2, 3, 4, 5]) },
        { name: 'string under compression threshold', value: 'a'.repeat(900) },
        { name: 'string at 2022 packed', value: 'b'.repeat(2019) },
        { name: 'string over compression threshold', value: 'c'.repeat(5000) },
        {
          name: 'highly compressible record',
          value: { blob: 'z'.repeat(4000), tag: 'repeat' },
        },
        {
          name: 'incompressible record',
          value: {
            blob: Array.from({ length: 2000 }, (_v, i) =>
              String.fromCharCode(33 + ((i * 7919) % 90)),
            ).join(''),
          },
        },
      ];

    it('matches db.getBinary().length for every shape in the corpus', () => {
      const fallbackDb = withoutEncoder(dbi);

      expect(
        (fallbackDb as unknown as { encoder?: unknown }).encoder,
      ).toBeUndefined();

      for (const { name, value } of corpus) {
        const key = `t7:${name}`;
        dbi.putSync(key, value);

        const stored = dbi.getBinary(key)?.length;
        const measured = measureValueSize(value, fallbackDb);

        expect(measured.isOk(), `${name}: ${String(measured)}`).toBe(true);
        expect(measured._unsafeUnwrap(), name).toBe(stored);
      }
    });

    it('measures the same with no db at all as with the live encoder', () => {
      for (const { name, value } of corpus) {
        expect(measureValueSize(value)._unsafeUnwrap(), name).toBe(
          measureValueSize(value, dbi)._unsafeUnwrap(),
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // T7b — the primary path is still there
  // -------------------------------------------------------------------------

  describe('T7b — db.encoder.pack is present on the pinned lmdb-js', () => {
    it('exposes a pack function on the opened database', () => {
      const encoder = (dbi as unknown as { encoder?: { pack?: unknown } })
        .encoder;

      expect(encoder).toBeDefined();
      expect(typeof encoder?.pack).toBe('function');
    });

    it('returns a view into a shared arena, which must never be retained', () => {
      const encoder = (
        dbi as unknown as {
          encoder: { pack: (v: unknown) => Uint8Array };
        }
      ).encoder;

      const first = encoder.pack({ price: 105.4, ticker: 'BTC/USDT' });
      const second = encoder.pack({ price: 105.4, ticker: 'BTC/USDT' });

      expect(first.buffer).toBe(second.buffer);
    });
  });

  // -------------------------------------------------------------------------
  // T7c — purity tripwire
  // -------------------------------------------------------------------------

  describe('T7c — packing is pure and has no write side effect', () => {
    // Every assertion here holds today and every one of them breaks the moment
    // `sharedStructuresKey` enters `LmdbDbiCache.dbiOptions`, which must not
    // happen without re-measuring the design.

    it('gives the same length for the same value packed twice', () => {
      const value = { price: 105.4, ticker: 'BTC/USDT', timestamp: 1, volume: 2 };

      const lengthList = Array.from(
        { length: 6 },
        () => measureValueSize(value, dbi)._unsafeUnwrap(),
      );

      expect(new Set(lengthList).size).toBe(1);
    });

    it('does not change data.mdb or the key count when packing novel shapes', async () => {
      // Settle any pending write before taking the baseline.
      dbi.putSync('t7c:settle', { settled: true });

      const sizeBefore = (await fs.stat(dataFilePath)).size;
      const countBefore = dbi.getCount({});

      for (let index = 0; index < 500; index += 1) {
        const novel: Record<string, unknown> = {};
        novel[`field_a_${index}`] = index;
        novel[`field_b_${index}`] = `value-${index}`;
        novel[`field_c_${index}`] = [index, index + 1];

        expect(measureValueSize(novel, dbi).isOk()).toBe(true);
      }

      const sizeAfter = (await fs.stat(dataFilePath)).size;
      const countAfter = dbi.getCount({});

      expect(sizeAfter).toBe(sizeBefore);
      expect(countAfter).toBe(countBefore);
    });

    it('does not make packed size depend on what the dbi packed first', () => {
      const reference = {
        price: 105.4,
        ticker: 'BTC/USDT',
        timestamp: 1,
        volume: 2,
      };

      // A dbi that has never seen any shape, versus this one, which has now
      // been shown hundreds. Under shared structures the second would fall off
      // the 32-slot cliff and measure larger — 26 bytes against 59, measured.
      const freshDbi = store.dbiCache
        .getOrCreateDbi(`${workflow}-fresh`)
        ._unsafeUnwrap();

      expect(measureValueSize(reference, dbi)._unsafeUnwrap()).toBe(
        measureValueSize(reference, freshDbi)._unsafeUnwrap(),
      );
      expect(measureValueSize(reference, dbi)._unsafeUnwrap()).toBe(
        measureValueSize(reference)._unsafeUnwrap(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Primitives the budget formula is built from
  // -------------------------------------------------------------------------

  describe('measureKeySize / entryOverhead', () => {
    it('counts UTF-8 bytes, not code units', () => {
      expect(measureKeySize('ticker')).toBe(6);
      expect(measureKeySize('')).toBe(0);
      expect(measureKeySize('é')).toBe(2);
      expect(measureKeySize('日')).toBe(3);
      expect(measureKeySize('🎉')).toBe(4);
    });

    it('charges the index pointer and node header on top of the key', () => {
      expect(entryOverhead(0)).toBe(LMDB_INDEX_POINTER + LMDB_NODE_HEADER);
      expect(entryOverhead(6)).toBe(16);
    });
  });

  describe('recommendedVolumeBytesFor', () => {
    // The argument is a PAGE COUNT, not `dataBytesMax`.
    //
    //   max((8192 + 6144 × workflowCount + 4096 × pages) × 1.15, 262144)
    //     rounded up to a whole page
    //
    // Every figure below is derived from that expression, never read back from
    // the implementation.
    it('prices the pages, the environment and one dbi per workflow', () => {
      // 53 pages is the first count at which the model clears the 256 KiB
      // floor: (8192 + 6144 + 53 × 4096) × 1.15 = 231424 × 1.15 = 266137.6,
      // -> ceil(266137.6 / 4096) = ceil(64.97...) = 65 pages.
      expect(recommendedVolumeBytesFor(53)).toBe(65 * LMDB_PAGE_SIZE_DEFAULT);
      // (8192 + 6144 + 100 × 4096) × 1.15 = 423936 × 1.15 = 487526.4
      //   -> ceil(119.02...) = 120 pages.
      expect(recommendedVolumeBytesFor(100)).toBe(120 * LMDB_PAGE_SIZE_DEFAULT);
    });

    it('floors the recommendation at the measured environment overhead', () => {
      // The model prices an almost-empty environment below what one really
      // occupies once MVCC has settled (LMDB_ENV_OVERHEAD_BYTES): a single page
      // gives (8192 + 6144 + 4096) × 1.15 = 21196.8, and the measured
      // high-water mark for one dbi with one rewritten key is 45056. The floor
      // is what makes that safe, so every small count lands on 64 pages.
      expect(recommendedVolumeBytesFor(0)).toBe(64 * LMDB_PAGE_SIZE_DEFAULT);
      expect(recommendedVolumeBytesFor(1)).toBe(64 * LMDB_PAGE_SIZE_DEFAULT);
      // 52 pages is still under it: 227328 × 1.15 = 261427.2 < 262144.
      expect(recommendedVolumeBytesFor(52)).toBe(64 * LMDB_PAGE_SIZE_DEFAULT);
    });

    it('charges one dbi per workflow sharing the environment', () => {
      // 12 is lmdb-js's default `maxDbs`, so 12 workflows is the most a single
      // environment can hold: (8192 + 12 × 6144 + 100 × 4096) × 1.15
      //   = 491520 × 1.15 = 565248 -> exactly 138 pages, no rounding.
      expect(recommendedVolumeBytesFor(100, { workflowCount: 12 })).toBe(
        138 * LMDB_PAGE_SIZE_DEFAULT,
      );
      // The dbi term is real but small next to the pages: 12 workflows adds
      // 18 pages to the same 100-page workload's 120.
      expect(recommendedVolumeBytesFor(100, { workflowCount: 1 })).toBe(
        120 * LMDB_PAGE_SIZE_DEFAULT,
      );
    });

    it('accepts an explicit residual factor', () => {
      // (8192 + 6144 + 100 × 4096) × 1 = 423936 -> ceil(103.5) = 104 pages.
      expect(recommendedVolumeBytesFor(100, { residualFactor: 1 })).toBe(
        104 * LMDB_PAGE_SIZE_DEFAULT,
      );
      // × 2 = 847872 -> ceil(207.0) = 207 pages.
      expect(recommendedVolumeBytesFor(100, { residualFactor: 2 })).toBe(
        207 * LMDB_PAGE_SIZE_DEFAULT,
      );
    });
  });

  describe('budgetForKey', () => {
    it('charges an lmdb-kv key its own bytes plus the value bound', () => {
      const budget = budgetOf('ticker', {
        name: 'lmdb-kv',
        valueSizeMax: 512,
      });

      // overhead(len('ticker')) + 512 = (2 + 8 + 6) + 512
      expect(budget.dataBytesMax).toBe(528);
      expect(budget.entryCount).toBe(1);
      expect(budget.keySizeMax).toBe(6);
      expect(budget.usesOverflowPages).toBe(false);
    });

    it('charges an lmdb-fifo key its slots plus head and tail', () => {
      const budget = budgetOf('tick_queue', {
        name: 'lmdb-fifo',
        queueSizeMax: 100,
        valueSizeMax: 1024,
      });

      // dataKeyLen = len('fifo:tick_queue:data:') + digits(99) = 21 + 2 = 23
      // 99 * ((2 + 8 + 23) + 1024) = 99 * 1057            = 104643
      // head: (2 + 8 + 20) + 9 = 39, tail: 39             =     78
      expect(budget.dataBytesMax).toBe(104_721);
      expect(budget.entryCount).toBe(101);
      expect(budget.keySizeMax).toBe(23);
    });

    it('widens the data key as the slot index gains digits', () => {
      const narrow = budgetOf('q', {
        name: 'lmdb-fifo',
        queueSizeMax: 10,
        valueSizeMax: 100,
      });
      const wide = budgetOf('q', {
        name: 'lmdb-fifo',
        queueSizeMax: 11,
        valueSizeMax: 100,
      });

      // 'fifo:q:data:' is 12 bytes; digits(9) = 1, digits(10) = 2.
      expect(narrow.keySizeMax).toBe(13);
      expect(wide.keySizeMax).toBe(14);
    });

    it('page-rounds instead of reporting logical bytes past the in-page cutoff', () => {
      const single = budgetOf('blob', {
        name: 'lmdb-kv',
        valueSizeMax: 3000,
      });
      const double = budgetOf('blob', {
        name: 'lmdb-kv',
        valueSizeMax: 5000,
      });

      // 'blob' is 4 bytes, so both sums (3004, 5004) are far past 2013.
      // ceil((16 + 3000) / 4096) = 1 page; node keeps a 64-bit page id.
      expect(single.dataBytesMax).toBe(14 + 8 + 4096);
      expect(single.usesOverflowPages).toBe(true);
      // ceil((16 + 5000) / 4096) = 2 pages.
      expect(double.dataBytesMax).toBe(14 + 8 + 8192);
      expect(double.usesOverflowPages).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // The in-page threshold is a property of key + value, not of the value
  // -------------------------------------------------------------------------

  describe('budgetForKey — the in-page cutoff is keyBytes + valueSizeMax ≤ 2013', () => {
    // Measured, not derived (see LMDB_INPAGE_KEY_PLUS_VALUE_MAX): incompressible
    // values calibrated to an exact packed length and swept one byte at a time
    // against `getStats().overflowPages` stay on a shared leaf page up to
    // 2011/2010/2005/1988/1973 bytes at key lengths 2/3/8/25/40 — the same
    // sum, 2013, at every one of them, overflowing at 2014.
    //
    // This is the assertion the value-only constant it replaced could not make:
    // `LMDB_VALUE_INPAGE_MAX = 2022` gave the same verdict for a 2-byte key and
    // a 40-byte one, and the wrong verdict for both.
    const KEY_PLUS_VALUE_MAX = 2013;

    it.each([2, 8, 25, 40])(
      'lmdb-kv, %i-byte key: in-page at sum 2013, overflow at 2014',
      (keyBytes) => {
        const key = 'k'.repeat(keyBytes);
        const inPageValue = KEY_PLUS_VALUE_MAX - keyBytes;

        const inPage = budgetOf(key, {
          name: 'lmdb-kv',
          valueSizeMax: inPageValue,
        });
        const overflow = budgetOf(key, {
          name: 'lmdb-kv',
          valueSizeMax: inPageValue + 1,
        });

        expect(inPage.usesOverflowPages).toBe(false);
        expect(overflow.usesOverflowPages).toBe(true);

        // At the threshold the charge is overhead(k) + (2013 - k), so it is
        // 10 + 2013 = 2023 whatever the key length — the cost of an entry
        // sitting exactly on the cliff does not depend on where the bytes are.
        expect(inPage.dataBytesMax).toBe(2023);
        // One byte more and it is a whole page: overhead(k) + 8 + 4096.
        expect(overflow.dataBytesMax).toBe(keyBytes + 10 + 8 + LMDB_PAGE_SIZE_DEFAULT);
      },
    );

    it('measures an lmdb-fifo key by its derived data key, not the declared one', () => {
      // 'fifo:q:data:' is 12 bytes and digits(9) = 1, so the widest derived key
      // is 13 — while the author's key is 1 byte. A value-sized-only test, or
      // one using the declared key, would call 2001 in-page (1 + 2001 = 2002);
      // the derived key is what LMDB actually weighs, and 13 + 2001 = 2014.
      const strategy = { name: 'lmdb-fifo', queueSizeMax: 10 } as const;

      const inPage = budgetOf('q', { ...strategy, valueSizeMax: 2000 });
      const overflow = budgetOf('q', { ...strategy, valueSizeMax: 2001 });

      expect(inPage.keySizeMax).toBe(13);
      expect(inPage.usesOverflowPages).toBe(false);
      expect(overflow.usesOverflowPages).toBe(true);

      // 9 slots * (overhead(13) + 2000) + head + tail
      //   = 9 * (23 + 2000) + ((2 + 8 + 11) + 9) * 2
      //   = 9 * 2023 + 30 * 2 = 18 207 + 60
      expect(inPage.dataBytesMax).toBe(18_267);
      // 9 * (overhead(13) + 8 + 4096) + 60 = 9 * 4127 + 60 = 37 143 + 60
      expect(overflow.dataBytesMax).toBe(37_203);
    });

    it('exports the threshold it enforces', () => {
      expect(LMDB_INPAGE_KEY_PLUS_VALUE_MAX).toBe(KEY_PLUS_VALUE_MAX);
    });
  });

  // -------------------------------------------------------------------------
  // T13 — the whole formula, against a hand-computed figure
  // -------------------------------------------------------------------------

  describe('T13 — budgetForStorage matches a hand-computed mixed kv/fifo block', () => {
    // Hand derivation. overhead(k) = 2 + 8 + k = k + 10.
    //
    //  ticker      lmdb-kv,  valueSizeMax 512
    //              overhead(6) + 512  = 16 + 512                    =      528
    //
    //  notes       not in `strategies`, so defaultStrategy:
    //              lmdb-kv, valueSizeMax 1900 (the shipped default)
    //              5 + 1900 = 1905 ≤ 2013, so in-page:
    //              overhead(5) + 1900 = 15 + 1900                   =    1 915
    //
    //  tick_queue  lmdb-fifo, queueSizeMax 100, valueSizeMax 1024
    //              dataKeyLen = len('fifo:tick_queue:data:') + digits(99)
    //                         = (5 + 10 + 6) + 2                    =       23
    //              slot       = overhead(23) + 1024 = 33 + 1024     =    1 057
    //              slots      = (100 - 1) * 1057                    =  104 643
    //              head       = overhead(len('fifo:tick_queue:head')) + 9
    //                         = overhead(20) + 9 = 30 + 9           =       39
    //              tail       = same                                =       39
    //                                                                 --------
    //                                                                 104 721
    //                                                                 ========
    //  Every entry here is in-page — 6+512, 5+1900 and 23+1024 are all well
    //  under 2013 — so none of the three takes the page-rounded branch.
    //
    //  dataBytesMax = 528 + 1915 + 104721                           =  107 164
    //
    //  ---- recommendedVolumeBytes: the page model ------------------------
    //
    //  A SECOND accounting of the same three keys, in pages rather than bytes.
    //  It is not `dataBytesMax` scaled, and it is derived here from the model
    //  alone. Notation: even(x) rounds up to a multiple of 2, a leaf node costs
    //  2 + 8 + even(k) + even(v + 18), a page holds floor(4080 / node) of them,
    //  and a settled page is 0.55 full.
    //
    //  ticker      k = 6, v = 512, in-page (518 <= 2013)
    //              node        = 2 + 8 + 6 + even(530) = 546
    //              nodes/page  = floor(4080 / 546) = 7
    //              leaf share  = 1 / (7 * 0.55) = 1 / 3.85     = 0.259740...
    //
    //  tick_queue  99 slots at k = 23, v = 1024, in-page (1047 <= 2013)
    //              node        = 2 + 8 + 24 + even(1042) = 1076
    //              nodes/page  = floor(4080 / 1076) = 3
    //              leaf share  = 99 / (3 * 0.55) = 99 / 1.65   = 60.0
    //              head+tail: 2 entries at k = 20, v = 9
    //              node        = 2 + 8 + 20 + even(27) = 58
    //              nodes/page  = floor(4080 / 58) = 70
    //              leaf share  = 2 / (70 * 0.55) = 2 / 38.5    =  0.051948...
    //
    //  notes       k = 5, v = 1900, in-page (1905 <= 2013)
    //              node        = 2 + 8 + 6 + even(1918) = 1934
    //              nodes/page  = floor(4080 / 1934) = 2
    //              leaf share  = 1 / (2 * 0.55) = 1 / 1.1      =  0.909090...
    //                                                            ------------
    //              total leaf share                              61.220779...
    //
    //  No key here overflows, so there are no dedicated overflow pages. Leaf
    //  shares are FRACTIONAL and round ONCE, at the total — a leaf page belongs
    //  to the dbi, not to a key, so `ticker` does not get a page to itself.
    //
    //  pageCountMax = ceil(61.220779...)                       =        62
    //
    //  recommendedVolumeBytes
    //    = ceil(max((8192 + 6144 * 1 + 4096 * 62) * 1.15, 262144) / 4096) * 4096
    //    = ceil(max(268288 * 1.15, 262144) / 4096) * 4096
    //    = ceil(308531.2 / 4096) * 4096
    //    = ceil(75.32...) * 4096 = 76 * 4096                   =   311 296
    //
    //  **This figure MORE THAN HALVED, from 692,224.** The old
    //  `dataBytesMax x 4 + 256 KiB` had to clear the worst page-packing tooth
    //  with one multiplier, so it over-provisioned every declaration that was
    //  not on a tooth. These three keys are not: 7, 3 and 2 nodes to a page,
    //  all packing cleanly. `dataBytesMax` is unchanged at 107,164 — the two
    //  figures moved apart because they are now two computations, not one
    //  number and its multiple.
    const DATA_BYTES_MAX = 107_164;
    const PAGE_COUNT_MAX = 62;
    const RECOMMENDED_VOLUME_BYTES = 311_296;

    const storage: BoxStorage = {
      defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
      strategies: {
        ticker: { name: 'lmdb-kv', valueSizeMax: 512 },
        tick_queue: { name: 'lmdb-fifo', queueSizeMax: 100, valueSizeMax: 1024 },
      },
      seed: {
        ticker: { price: 105.4 },
        notes: 'a seed-only key, which takes defaultStrategy',
      },
    };

    it('sums declared keys to the hand-computed total', () => {
      const budget = budgetForStorage(storage);

      expect(budget.dataBytesMax).toBe(DATA_BYTES_MAX);
    });

    it('counts the pages those entries occupy', () => {
      const budget = budgetForStorage(storage);

      expect(budget.pageCountMax).toBe(PAGE_COUNT_MAX);

      // The leaf shares really are fractional and really do round once. If any
      // key were rounded to a whole page on its own the total would be 63 —
      // `ticker` alone would go from 0.26 pages to 1.
      const summedShare = budget.keyBudgetList.reduce(
        (total, keyBudget) => total + keyBudget.leafPageShare,
        0,
      );
      expect(summedShare).toBeGreaterThan(61);
      expect(summedShare).toBeLessThan(62);
      expect(
        budget.keyBudgetList.every((keyBudget) => keyBudget.overflowPageCount === 0),
      ).toBe(true);
    });

    it('reports recommendedVolumeBytes as a distinct, larger, page-aligned figure', () => {
      const budget = budgetForStorage(storage);

      expect(budget.recommendedVolumeBytes).toBe(RECOMMENDED_VOLUME_BYTES);
      expect(budget.recommendedVolumeBytes).not.toBe(budget.dataBytesMax);
      expect(budget.recommendedVolumeBytes).toBeGreaterThan(budget.dataBytesMax);
      expect(budget.recommendedVolumeBytes % LMDB_PAGE_SIZE_DEFAULT).toBe(0);
      expect(budget.residualFactor).toBe(1.15);
      // One `storage:` block is one workflow, hence one dbi. The store derives
      // this rather than being told it; only a workspace total passes its own.
      expect(budget.workflowCount).toBe(1);
    });

    it('counts a seed-only key under defaultStrategy, exactly once', () => {
      const budget = budgetForStorage(storage);

      expect(budget.keyBudgetList.map((keyBudget) => keyBudget.key)).toEqual([
        'ticker',
        'tick_queue',
        'notes',
      ]);
      expect(
        budget.keyBudgetList.find((keyBudget) => keyBudget.key === 'notes')
          ?.dataBytesMax,
      ).toBe(1915);
      expect(
        budget.keyBudgetList.find((keyBudget) => keyBudget.key === 'ticker')
          ?.dataBytesMax,
      ).toBe(528);
    });

    it('counts every entry: 1 kv + 1 kv + (99 slots + head + tail)', () => {
      const budget = budgetForStorage(storage);

      expect(budget.entryCount).toBe(1 + 1 + 101);
    });

    it('is zero for a storage block that declares no keys and binds none', () => {
      const budget = budgetForStorage({
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
      });

      expect(budget.dataBytesMax).toBe(0);
      expect(budget.entryCount).toBe(0);
      expect(budget.pageCountMax).toBe(0);
      expect(budget.keyBudgetList).toEqual([]);
      // Zero declared pages, but not zero bytes to provision: an environment
      // costs 8,192 bytes before a dbi exists and reaches 45,056 once one key
      // has been written and rewritten. The model prices that at
      // (8192 + 6144) * 1.15 = 16,486, so LMDB_ENV_OVERHEAD_BYTES floors it at
      // 256 KiB = 64 pages — the same figure this case produced before T16,
      // for the same measured reason.
      expect(budget.recommendedVolumeBytes).toBe(64 * LMDB_PAGE_SIZE_DEFAULT);
    });
  });

  // -------------------------------------------------------------------------
  // T16 — the page size is a documented default, pinned to the live figure
  // -------------------------------------------------------------------------

  describe('LMDB_PAGE_SIZE_DEFAULT is pinned to the page size LMDB reports', () => {
    it('matches getStats().pageSize on this host', () => {
      // The page model reasons in whole pages, and LMDB does not choose 4096 —
      // it takes the host's page size at environment creation. There is no live
      // source on the path that needs it (`workflow verify` and `workspace
      // verify` run on a parsed document, with no environment open, and must
      // not create one as a side effect of checking a file), so the model uses
      // a documented default.
      //
      // This is the same arrangement, and the same tripwire, as
      // LMDB_KEY_SIZE_MAX_DEFAULT above: if the shipped build or the host moves
      // the figure, a test fails rather than every printed budget silently
      // disagreeing with the machine it was computed for.
      const stats = (dbi as unknown as { getStats(): { pageSize: number } }).getStats();

      expect(stats.pageSize).toBe(LMDB_PAGE_SIZE_DEFAULT);
    });
  });

  // -------------------------------------------------------------------------
  // LMDB's maximum key size — read from the build, not assumed
  // -------------------------------------------------------------------------

  describe('the key-size limit is the linked build\'s, not upstream\'s default', () => {
    it('reads the live limit off the open database', () => {
      const maxKeySize = readMaxKeySize(dbi)._unsafeUnwrap();

      // `MDB_MAXKEYSIZE` is compile-time (`mdb.c:672`) and the C API offers
      // only `mdb_env_get_maxkeysize`, a getter — so the only honest source is
      // the build actually linked. This one is not upstream's 511 default,
      // which is the whole reason the figure is read rather than assumed. (511
      // is spelled here rather than imported: it stopped being a threshold
      // anything compares against, so `LMDB_KEY_SIZE_PORTABLE_MAX` was deleted
      // rather than left as an unused export.)
      expect(maxKeySize).toBeGreaterThan(511);
    });

    it('pins LMDB_KEY_SIZE_MAX_DEFAULT to what the shipped build reports', () => {
      // The static checker has no database and must not open one as a side
      // effect of reading a file, so it uses this documented default. It is a
      // *default*, so it can drift; this is the tripwire that makes a bump of
      // lmdb-js fail a test rather than silently make `verify` and the store
      // disagree about which keys are legal.
      expect(LMDB_KEY_SIZE_MAX_DEFAULT).toBe(readMaxKeySize(dbi)._unsafeUnwrap());
    });

    it('fails closed rather than guessing when the property is absent', () => {
      // `maxKeySize` is undocumented in lmdb-js's typings, like `encoder`, and
      // is set on the instance at `lmdb/open.js:200`. `measureValueSize` has a
      // faithful stand-in for the encoder and falls back; there is no stand-in
      // for a compile-time constant, so this returns an `Err`.
      const hidden = new Proxy(dbi, {
        get(target, property, receiver): unknown {
          return property === 'maxKeySize'
            ? undefined
            : Reflect.get(target, property, receiver);
        },
      });

      const result = readMaxKeySize(hidden);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toContain('db.maxKeySize');
    });
  });

  // -------------------------------------------------------------------------
  // Rawbox's key-size contract
  //
  // "Stricter than every backend" is the property the contract exists to have,
  // and a comment cannot hold it. These make it checked.
  //
  // The inequality has to add the derivation: `RAWBOX_KEY_SIZE_MAX` bounds the
  // *author's* key, while the backend is handed the *stored* one. Comparing the
  // constant alone against `LMDB_KEY_SIZE_MAX_DEFAULT` would pass while a FIFO
  // derivation quietly grew past the limit it was supposed to be inside.
  // -------------------------------------------------------------------------

  describe('the Rawbox key contract clears the backend actually linked', () => {
    it('K6: RAWBOX_KEY_SIZE_MAX + the worst derivation fits LMDB_KEY_SIZE_MAX_DEFAULT', () => {
      expect(
        RAWBOX_KEY_SIZE_MAX + RAWBOX_KEY_DERIVATION_OVERHEAD_MAX,
      ).toBeLessThanOrEqual(LMDB_KEY_SIZE_MAX_DEFAULT);
    });

    it('K6: and clears the *live* limit, not only the documented default', () => {
      expect(
        RAWBOX_KEY_SIZE_MAX + RAWBOX_KEY_DERIVATION_OVERHEAD_MAX,
      ).toBeLessThanOrEqual(readMaxKeySize(dbi)._unsafeUnwrap());
    });

    it('K6: no legal queueSizeMax derives more than RAWBOX_KEY_DERIVATION_OVERHEAD_MAX', () => {
      // The half of K6 that can actually break. `queueSizeMax` is
      // `Type.Integer({ minimum: 2 })` with no upper bound (`box.ts`), and
      // `budgetForKey` spells the index suffix `String(queueSizeMax - 1).length`
      // — so the overhead is `len("fifo:") + len(":data:") + digits`, and the
      // question is how long `digits` can get.
      //
      // JavaScript answers it: a number stringifies in full decimal only up to
      // an exponent of 21. `String(1e20)` is 21 characters; `String(1e21)` is
      // the five characters `1e+21`, and it only gets shorter above that. So 21
      // is the longest suffix any legal declaration can produce, and 11 + 21 =
      // 32 is the constant. The sweep below includes both sides of that cliff.
      const key = 'k'.repeat(RAWBOX_KEY_SIZE_MAX);

      const queueSizeMaxList = [
        2,
        1000,
        2 ** 30,
        Number.MAX_SAFE_INTEGER,
        1e20, // 21 digits — the worst case
        1e21, // "1e+21": 5 characters, past the cliff
        1e300,
      ];

      for (const queueSizeMax of queueSizeMaxList) {
        const budget = budgetOf(key, {
          name: 'lmdb-fifo',
          queueSizeMax,
          valueSizeMax: 1900,
        });

        expect(budget.keySizeMax - RAWBOX_KEY_SIZE_MAX).toBeLessThanOrEqual(
          RAWBOX_KEY_DERIVATION_OVERHEAD_MAX,
        );
        expect(budget.keySizeMax).toBeLessThanOrEqual(LMDB_KEY_SIZE_MAX_DEFAULT);
      }

      // And the bound is tight, not merely safe: the 21-digit case reaches it
      // exactly, so a derivation that grows by even one byte fails above.
      expect(
        budgetOf(key, {
          name: 'lmdb-fifo',
          queueSizeMax: 1e20,
          valueSizeMax: 1900,
        }).keySizeMax - RAWBOX_KEY_SIZE_MAX,
      ).toBe(RAWBOX_KEY_DERIVATION_OVERHEAD_MAX);

      // `lmdb-kv` stores the author's key verbatim: no derivation at all.
      expect(
        budgetOf(key, { name: 'lmdb-kv', valueSizeMax: 1900 }).keySizeMax,
      ).toBe(RAWBOX_KEY_SIZE_MAX);
    });
  });

  // -------------------------------------------------------------------------
  // The sweep of step-bound keys
  // -------------------------------------------------------------------------

  describe('budgetForStorage sweeps boundKeyList', () => {
    const defaultStrategy = { name: 'lmdb-kv' as const, valueSizeMax: 1900 };

    it('reports a non-zero budget for a workflow that declares nothing at all', () => {
      // The sharp case. Before the sweep this reported `dataBytesMax: 0` while
      // writing one key per output and error binding — not approximately
      // wrong, structurally blind. Nothing enforces the budget, so the
      // container limit sized from this number is the only backstop.
      //
      // Hand-derived, overhead(k) = 2 + 8 + k:
      //   sleep_done_at (13) : (10 + 13) + 1900 = 1923
      //   sleep_error   (11) : (10 + 11) + 1900 = 1921
      //                                          ------
      //                                            3844
      const budget = budgetForStorage({
        defaultStrategy,
        boundKeyList: ['sleep_done_at', 'sleep_error'],
      });

      expect(budget.dataBytesMax).toBe(3844);
      expect(budget.entryCount).toBe(2);
      expect(budget.keyBudgetList.map((keyBudget) => keyBudget.source)).toEqual([
        'bound',
        'bound',
      ]);
    });

    it('deduplicates against strategies and seed, and orders declared keys first', () => {
      const budget = budgetForStorage({
        defaultStrategy,
        strategies: { ticker: { name: 'lmdb-kv', valueSizeMax: 512 } },
        seed: { notes: 'seeded' },
        // `ticker` and `notes` are already declared; only `fresh` is new.
        boundKeyList: ['ticker', 'fresh', 'notes', 'fresh'],
      });

      expect(
        budget.keyBudgetList.map((keyBudget) => [keyBudget.key, keyBudget.source]),
      ).toEqual([
        ['ticker', 'declared'],
        ['notes', 'declared'],
        ['fresh', 'bound'],
      ]);

      //   ticker (6, valueSizeMax 512) : (10 + 6) + 512  =  528
      //   notes  (5, defaultStrategy)  : (10 + 5) + 1900 = 1915
      //   fresh  (5, defaultStrategy)  : (10 + 5) + 1900 = 1915
      //                                                   ------
      //                                                     4358
      expect(budget.dataBytesMax).toBe(4358);
    });

    it('resolves a bound key through strategies[key] ?? defaultStrategy, like any other', () => {
      // A key can be bound by a step *and* carry a strategy override without
      // ever appearing in `seed` — it is then a declared key, charged as a
      // FIFO, not a bound one charged as the default kv.
      const budget = budgetForStorage({
        defaultStrategy,
        strategies: { q: { name: 'lmdb-fifo', queueSizeMax: 10, valueSizeMax: 100 } },
        boundKeyList: ['q'],
      });

      expect(budget.keyBudgetList).toHaveLength(1);
      expect(budget.keyBudgetList[0]!.source).toBe('declared');
      expect(budget.keyBudgetList[0]!.strategyName).toBe('lmdb-fifo');
    });

    it('leaves the figure untouched when no bound keys are supplied', () => {
      const storage: BoxStorage = { defaultStrategy, seed: { notes: 'seeded' } };

      expect(budgetForStorage(storage).dataBytesMax).toBe(
        budgetForStorage({ ...storage, boundKeyList: [] }).dataBytesMax,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Keys with no budget
  //
  // `StrategyDescriptor.budget` is optional: a strategy whose bytes this
  // package cannot model from the document declares none, and its keys must be
  // *named* rather than charged a fabricated figure or a `0` that would be
  // summed into a provisioning number.
  //
  // **Both strategies shipping today have budgets**, so `budgetForKey` cannot
  // currently produce the `budgetable: false` half — that becomes reachable
  // when a backend without a page model joins `BoxStrategy`. Nothing here fakes
  // a strategy into that union to pretend otherwise. Instead the partition is
  // tested where it is decided: `partitionKeyBudgetOutcomeList` takes a plain
  // list, so a hand-built mixture exercises the real function that
  // `budgetForStorage` routes every key through.
  // -------------------------------------------------------------------------

  describe('the budgetable / unbudgetable partition', () => {
    /**
     * A hand-built `UnbudgetableKey`.
     *
     * `strategyName` is `BoxStrategy['name']`, a closed union of the two real
     * strategies, and it stays that way here: the record under test is the
     * *shape* the partition sorts on, and inventing a third union member to
     * make the fixture look exotic would be a lie about what this package
     * currently supports.
     */
    function unbudgetable(
      key: string,
      source: KeyBudgetSource = 'declared',
    ): UnbudgetableKey {
      return { budgetable: false, key, source, strategyName: 'lmdb-kv' };
    }

    const budgeted = budgetOf('ticker', { name: 'lmdb-kv', valueSizeMax: 512 });

    it('sends each outcome to exactly one side, preserving order', () => {
      const outcomeList: KeyBudgetOutcome[] = [
        budgeted,
        unbudgetable('remote_a'),
        budgetOf('notes', { name: 'lmdb-kv', valueSizeMax: 1900 }),
        unbudgetable('remote_b', 'bound'),
      ];

      const partition = partitionKeyBudgetOutcomeList(outcomeList);

      expect(partition.keyBudgetList.map((entry) => entry.key)).toEqual([
        'ticker',
        'notes',
      ]);
      expect(partition.unbudgetableKeyList.map((entry) => entry.key)).toEqual([
        'remote_a',
        'remote_b',
      ]);
      // Nothing is dropped and nothing is duplicated: the two sides account for
      // every key that went in. This is the property the discriminated union
      // exists to hold — a `KeyBudget | undefined` return would let a caller
      // `.filter(Boolean)` and report the sum of two keys as a total of four.
      expect(
        partition.keyBudgetList.length + partition.unbudgetableKeyList.length,
      ).toBe(outcomeList.length);
    });

    it('keeps the unbudgetable keys out of every figure, and nameable', () => {
      const partition = partitionKeyBudgetOutcomeList([
        budgeted,
        unbudgetable('remote_a'),
      ]);

      // The sum is over the budgeted side alone — the same reduction
      // `budgetForStorage` performs.
      expect(
        partition.keyBudgetList.reduce(
          (total, entry) => total + entry.dataBytesMax,
          0,
        ),
      ).toBe(budgeted.dataBytesMax);
      // And the excluded key still carries what a report needs to name it.
      expect(partition.unbudgetableKeyList[0]).toEqual({
        budgetable: false,
        key: 'remote_a',
        source: 'declared',
        strategyName: 'lmdb-kv',
      });
    });

    it('returns two empty sides for an empty list', () => {
      expect(partitionKeyBudgetOutcomeList([])).toEqual({
        keyBudgetList: [],
        unbudgetableKeyList: [],
      });
    });

    it('reports no unbudgetable keys for a document both LMDB strategies can model', () => {
      // The end-to-end half of the property, and all of it that is reachable
      // today: every strategy in the union has a `budget`, so a real document
      // partitions entirely onto the budgeted side and the totals cover it in
      // full.
      const budget = budgetForStorage({
        defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
        strategies: { q: { name: 'lmdb-fifo', queueSizeMax: 10, valueSizeMax: 100 } },
        seed: { notes: 'seeded' },
        boundKeyList: ['fresh'],
      });

      expect(budget.unbudgetableKeyList).toEqual([]);
      expect(budget.keyBudgetList).toHaveLength(3);
    });

    it('answers budgetable: true for every strategy in the union', () => {
      // The compile-time guarantee lives in `strategy/descriptor.ts` (the table
      // is keyed by `BoxStrategy['name']`); this is the runtime half — if a row
      // ever dropped its `budget`, the LMDB store's key guard would start
      // failing closed and this says so first.
      expect(
        budgetForKey('k', { name: 'lmdb-kv', valueSizeMax: 100 }).budgetable,
      ).toBe(true);
      expect(
        budgetForKey('k', {
          name: 'lmdb-fifo',
          queueSizeMax: 10,
          valueSizeMax: 100,
        }).budgetable,
      ).toBe(true);
    });
  });
});
