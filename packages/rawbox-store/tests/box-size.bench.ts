/**
 * Prices the double pack `putStatic` pays: `checkValueSize` msgpack-packs the
 * value once to measure it, then lmdb-js packs it again inside `dbi.putSync`
 * when the write goes through. "Roughly double the encode cost for small
 * values" is the prediction; this file is the measurement.
 *
 * Not swept by `npm test`: vitest's default `include` glob matches
 * `*.test.ts` / `*.spec.ts`, not `*.bench.ts`, so this file is invisible to
 * `vitest run tests` and does not affect the test count. Run it explicitly:
 *
 *   npx vitest run tests/box-size.bench.ts
 *
 * ## Methodology
 *
 * - **Interleaved trials.** Each arm runs in alternating batches (guarded,
 *   unguarded, guarded, unguarded, …) rather than as two back-to-back blocks,
 *   so JIT warm-up and CPU frequency drift land on both arms equally. An
 *   unmeasured interleaved warm-up phase precedes the recorded trials for the
 *   same reason.
 * - **Multiple trials, spread reported.** 20 measured trials per arm per
 *   scenario, 50 ops per trial. Median, mean, standard deviation, and
 *   min–max range are all reported — a single number with no variance is not
 *   a measurement.
 * - **Same work, only the guard toggled.** The "unguarded" arm is not a
 *   different code path in spirit — it is the same sequence of operations
 *   `putStatic` performs, minus the one call to `checkValueSize`
 *   (`measureValueSize` under the hood). `BoxStoreLmdbKv` / `BoxStoreLmdbFifo`
 *   are not exported, so the unguarded arm calls the same public/exported
 *   primitives `putStatic` calls internally (`dbi.putSync`,
 *   `dbiCache.env.transactionSync`, `budgetForKey`) rather than reimplementing
 *   them differently. Both arms perform the key-length check
 *   (`readMaxKeySize(db)`, a property read, plus `budgetForKey(...).keySizeMax`
 *   — cheap: no LMDB call, no pack) and the dbi lookup (a cache hit after the
 *   first call) — only the value-size pack is toggled, so the measured delta is
 *   attributable to the pack specifically, not to bookkeeping `putStatic` would
 *   do regardless.
 * - **Two value sizes bracketing lmdb-js's compression threshold**
 *   (`node_modules/lmdb/open.js:148`, 1000 bytes): a small value well under
 *   it, and a value at 2022 bytes — **kept at 2022 on purpose** so previously
 *   recorded figures stay comparable across runs. It is not a meaningful
 *   boundary (the real one is `keyBytes + valueSizeMax ≤ 2013`); for this
 *   benchmark all that matters is that it sits well above the compression
 *   threshold. Content is random bytes (incompressible) — the worst case
 *   rather than something LZ4 flatters.
 * - **A standalone pack-cost microbenchmark** in addition to the end-to-end
 *   put comparison, isolating exactly what the extra pack costs with no LMDB
 *   transaction, cache lookup, or key-length check anywhere near it.
 */
import { describe, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { type Database, type RootDatabase } from 'lmdb';

import { BoxStoreLmdb } from '../src/box-store/box-store-lmdb.js';
import { type Box, type BoxStrategy } from '../src/box.js';
import { measureValueSize, readMaxKeySize } from '../src/box-size.js';
import { budgetForKey } from '../src/strategy/budget.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SMALL_TARGET_BYTES = 128; // well under the 1000-byte compression threshold
// Well above the 1000-byte compression threshold. Held at 2022 so previously
// recorded numbers stay comparable; it is not any kind of page boundary.
const LARGE_TARGET_BYTES = 2022;

const WARMUP_TRIALS = 3;
const TRIALS = 20;
const OPS_PER_TRIAL = 50;

// FIFO queues only ever grow (nothing drains them here), so size the ring to
// comfortably outlast every op an arm will perform across warm-up + trials.
const FIFO_QUEUE_SIZE_MAX = 4 * (WARMUP_TRIALS + TRIALS) * OPS_PER_TRIAL;

const workspace = 'bench-workspace';
const workflow = 'bench-workflow';

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function median(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

interface Summary {
  readonly n: number;
  readonly meanUs: number;
  readonly medianUs: number;
  readonly stdevUs: number;
  readonly minUs: number;
  readonly maxUs: number;
}

function summarize(samplesUs: readonly number[]): Summary {
  return {
    n: samplesUs.length,
    meanUs: mean(samplesUs),
    medianUs: median(samplesUs),
    stdevUs: stdev(samplesUs),
    minUs: Math.min(...samplesUs),
    maxUs: Math.max(...samplesUs),
  };
}

function fmt(s: Summary): string {
  return (
    `median ${s.medianUs.toFixed(2)} µs/op ` +
    `(mean ${s.meanUs.toFixed(2)}, stdev ${s.stdevUs.toFixed(2)}, ` +
    `range ${s.minUs.toFixed(2)}–${s.maxUs.toFixed(2)}, n=${s.n})`
  );
}

/**
 * Runs every named arm's op interleaved, trial by trial: (arm1, arm2, arm1,
 * arm2, …) rather than all of arm1 then all of arm2, so warm-up and frequency
 * drift hit every arm equally. `warmupTrials` runs the same interleaved
 * pattern first, unmeasured.
 */
function runInterleavedTrials(
  arms: Readonly<Record<string, () => void>>,
  config: {
    readonly trials: number;
    readonly opsPerTrial: number;
    readonly warmupTrials: number;
  },
): Record<string, number[]> {
  const names = Object.keys(arms);
  const samples: Record<string, number[]> = Object.fromEntries(
    names.map((name) => [name, []]),
  );

  const runBatch = (fn: () => void, count: number): number => {
    const start = performance.now();
    for (let i = 0; i < count; i++) fn();
    return performance.now() - start;
  };

  for (let t = 0; t < config.warmupTrials; t++) {
    for (const name of names) runBatch(arms[name]!, config.opsPerTrial);
  }

  for (let t = 0; t < config.trials; t++) {
    for (const name of names) {
      const elapsedMs = runBatch(arms[name]!, config.opsPerTrial);
      samples[name]!.push((elapsedMs * 1000) / config.opsPerTrial);
    }
  }

  return samples;
}

function printComparison(
  label: string,
  guardedUs: readonly number[],
  unguardedUs: readonly number[],
): void {
  const g = summarize(guardedUs);
  const u = summarize(unguardedUs);
  const overheadUs = g.medianUs - u.medianUs;
  const overheadPct = (overheadUs / u.medianUs) * 100;

  console.log(`\n=== ${label} ===`);
  console.log(`  unguarded: ${fmt(u)}`);
  console.log(`  guarded:   ${fmt(g)}`);
  console.log(
    `  overhead:  +${overheadUs.toFixed(2)} µs/op (+${overheadPct.toFixed(1)}%)`,
  );
}

// ---------------------------------------------------------------------------
// Content calibration — random (incompressible) content packed to exactly
// (or, at a header-width crossing, the nearest byte at or just above) the
// target size, verified with the same `measureValueSize` the guard uses.
// ---------------------------------------------------------------------------

function makeContent(padLen: number): unknown {
  return { id: 0, payload: randomBytes(Math.max(0, padLen)).toString('base64').slice(0, padLen) };
}

function calibrateContent(
  db: Database<unknown, string>,
  targetBytes: number,
): { readonly content: unknown; readonly actualBytes: number } {
  let padLen = 0;
  let content = makeContent(padLen);
  let size = measureValueSize(content, db)._unsafeUnwrap();

  while (size < targetBytes) {
    padLen++;
    content = makeContent(padLen);
    size = measureValueSize(content, db)._unsafeUnwrap();
  }

  return { content, actualBytes: size };
}

// ---------------------------------------------------------------------------
// FIFO's raw (unguarded) write path — duplicated here, not imported, because
// `BoxStoreLmdbFifo` is not exported. This is the same sequence
// `BoxStoreLmdbFifo.putStatic` performs after its two guards: read head/tail,
// advance head, write the data key and the new head, inside one
// `transactionSync`. Matches `box-store-lmdb.ts` at the time of writing.
// ---------------------------------------------------------------------------

function fifoPutRaw(
  env: RootDatabase,
  dbi: Database<unknown, string>,
  key: string,
  content: unknown,
  queueSizeMax: number,
): void {
  const headDbiKey = `fifo:${key}:head`;
  const tailDbiKey = `fifo:${key}:tail`;

  env.transactionSync(() => {
    const head = (dbi.get(headDbiKey) as number) || 0;
    const tail = (dbi.get(tailDbiKey) as number) || 0;
    const nextHead = (head + 1) % queueSizeMax;

    if (nextHead !== tail) {
      const headDataDbiKey = `fifo:${key}:data:${head}`;
      dbi.putSync(headDataDbiKey, content);
      dbi.putSync(headDbiKey, nextHead);
    } else {
      throw new Error('Queue is full');
    }
  });
}

/**
 * Same work `checkKeySize` does — a property read off the open database plus
 * the `budgetForKey` arithmetic. Still no LMDB call and no pack: `db.maxKeySize`
 * is a plain number set once at open time (`lmdb/open.js:200`), not a query.
 *
 * The `budgetable` check mirrors the store's own: `budgetForKey` answers with a
 * `KeyBudget` *or* an `UnbudgetableKey`, and the guard fails closed on the
 * latter rather than guessing a width (`box-store-lmdb.ts`, `checkKeySize`).
 * Both strategies benched here are budgetable, so this costs one property read.
 */
function checkKeySizeReplica(
  db: Database<unknown, string>,
  strategy: BoxStrategy,
  key: string,
): void {
  const maxKeySize = readMaxKeySize(db)._unsafeUnwrap();
  const budget = budgetForKey(key, strategy);

  if (!budget.budgetable) {
    throw new Error(
      `Key '${key}' could not be checked: strategy '${strategy.name}' declares no ` +
        `key or byte model, so the widest key it stores is unknown`,
    );
  }

  const keySizeMax = budget.keySizeMax;

  if (keySizeMax > maxKeySize) {
    throw new Error(
      `Key '${key}' exceeds LMDB's maximum key size: ${keySizeMax} bytes, limit ${maxKeySize}`,
    );
  }
}

// ---------------------------------------------------------------------------

describe('box-size bench — the double pack', () => {
  it(
    'put throughput: guarded (checkValueSize runs) vs unguarded, small and 2022-byte values',
    { timeout: 120_000 },
    async () => {
      const rand = Math.floor(Math.random() * 1_000_000);
      const dbDirUrl = new URL(
        `../data/bench-db-${Date.now()}-${rand}/`,
        import.meta.url,
      );
      await fs.mkdir(fileURLToPath(dbDirUrl), { recursive: true });

      const store = BoxStoreLmdb.create(workspace, dbDirUrl);
      const dbi = store.dbiCache.getOrCreateDbi(workflow)._unsafeUnwrap();

      try {
        const small = calibrateContent(dbi, SMALL_TARGET_BYTES);
        const large = calibrateContent(dbi, LARGE_TARGET_BYTES);

        console.log(
          `\nTarget sizes: small=${SMALL_TARGET_BYTES}B (actual ${small.actualBytes}B), ` +
            `large=${LARGE_TARGET_BYTES}B (actual ${large.actualBytes}B)`,
        );

        // -------------------------------------------------------------
        // 1. Standalone pack cost — measureValueSize alone, no LMDB.
        //    Isolates exactly what the *extra* pack costs.
        // -------------------------------------------------------------
        {
          const packArms = {
            small: () => {
              measureValueSize(small.content, dbi);
            },
            large: () => {
              measureValueSize(large.content, dbi);
            },
          };
          const samples = runInterleavedTrials(packArms, {
            trials: TRIALS,
            opsPerTrial: OPS_PER_TRIAL * 10, // cheap call, larger batch for precision
            warmupTrials: WARMUP_TRIALS,
          });

          console.log(`\n=== Standalone measureValueSize cost (one pack) ===`);
          console.log(`  small (${small.actualBytes}B):  ${fmt(summarize(samples.small!))}`);
          console.log(`  large (${large.actualBytes}B):  ${fmt(summarize(samples.large!))}`);
        }

        // -------------------------------------------------------------
        // 2. lmdb-kv put — guarded (store.putSync) vs unguarded
        //    (dbi.putSync directly, skipping only checkValueSize; the
        //    key-length check runs in both arms).
        // -------------------------------------------------------------
        for (const { label, content, actualBytes } of [
          { label: 'lmdb-kv, small', content: small.content, actualBytes: small.actualBytes },
          { label: 'lmdb-kv, 2022B', content: large.content, actualBytes: large.actualBytes },
        ]) {
          const strategy: BoxStrategy = {
            name: 'lmdb-kv',
            valueSizeMax: actualBytes,
          };
          const guardedKey = `${label}-guarded`;
          const unguardedKey = `${label}-unguarded`;

          const guardedBox: Box<unknown> = {
            content,
            location: { workspace, workflow, key: guardedKey, strategy },
          };

          const arms = {
            unguarded: () => {
              checkKeySizeReplica(dbi, strategy, unguardedKey);
              dbi.putSync(unguardedKey, content);
            },
            guarded: () => {
              const result = store.putSync(guardedBox);
              if (result.isErr()) throw new Error(result.error);
            },
          };

          const samples = runInterleavedTrials(arms, {
            trials: TRIALS,
            opsPerTrial: OPS_PER_TRIAL,
            warmupTrials: WARMUP_TRIALS,
          });

          printComparison(
            `put: ${label} (${actualBytes}B packed)`,
            samples.guarded!,
            samples.unguarded!,
          );
        }

        // -------------------------------------------------------------
        // 3. lmdb-fifo put — guarded (store.putSync) vs unguarded
        //    (fifoPutRaw, skipping only checkValueSize; the derived-key
        //    length check runs in both arms).
        // -------------------------------------------------------------
        for (const { label, content, actualBytes } of [
          { label: 'lmdb-fifo, small', content: small.content, actualBytes: small.actualBytes },
          { label: 'lmdb-fifo, 2022B', content: large.content, actualBytes: large.actualBytes },
        ]) {
          const strategy: BoxStrategy = {
            name: 'lmdb-fifo',
            queueSizeMax: FIFO_QUEUE_SIZE_MAX,
            valueSizeMax: actualBytes,
          };
          const guardedKey = `${label}-guarded`;
          const unguardedKey = `${label}-unguarded`;

          const guardedBox: Box<unknown> = {
            content,
            location: { workspace, workflow, key: guardedKey, strategy },
          };

          const arms = {
            unguarded: () => {
              checkKeySizeReplica(dbi, strategy, unguardedKey);
              fifoPutRaw(
                store.dbiCache.env,
                dbi,
                unguardedKey,
                content,
                FIFO_QUEUE_SIZE_MAX,
              );
            },
            guarded: () => {
              const result = store.putSync(guardedBox);
              if (result.isErr()) throw new Error(result.error);
            },
          };

          const samples = runInterleavedTrials(arms, {
            trials: TRIALS,
            opsPerTrial: OPS_PER_TRIAL,
            warmupTrials: WARMUP_TRIALS,
          });

          printComparison(
            `put: ${label} (${actualBytes}B packed)`,
            samples.guarded!,
            samples.unguarded!,
          );
        }
      } finally {
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
      }
    },
  );
});
