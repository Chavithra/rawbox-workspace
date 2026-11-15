import { Pool } from 'pg';
import { Packr } from 'msgpackr';
import { ok, err, type Result } from 'neverthrow';

import { type Box, type BoxLocation } from '../box.js';
import { measureValueSize } from '../box-size.js';
import { descriptorFor } from '../strategy/descriptor.js';
import { type BoxStore, type BoxTransactionBatch } from './box-store.js';

export interface PgQueryResult<
  TRow extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: TRow[];
  readonly rowCount: number | null;
}

export interface PgPoolClient {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<TRow>>;
  release(err?: Error | boolean): void;
}

export interface PgPool {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<TRow>>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

const PG_SCHEMA_LOCK_ID = 729269;
const PG_HASH_PARTITION_COUNT = 16;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const pgPackr = new Packr({ copyBuffers: true });

export function encodePgValue(content: unknown): Result<Buffer, string> {
  try {
    const packed = pgPackr.pack(content);
    return ok(Buffer.from(packed));
  } catch (e: unknown) {
    return err(`Failed to encode value: ${errorMessage(e)}`);
  }
}

export function decodePgValue(raw: Uint8Array): Result<unknown, string> {
  try {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    return ok(pgPackr.unpack(buffer));
  } catch (e: unknown) {
    return err(`Failed to decode value: ${errorMessage(e)}`);
  }
}

export function wrongPgStrategyMessage(
  key: string,
  expectedStrategy: 'pg-kv' | 'pg-fifo',
  foundStrategy: string,
): string {
  return (
    `Key '${key}' declares strategy '${expectedStrategy}', which requires PostgreSQL box ` +
    `strategy '${expectedStrategy}' — but PostgreSQL reports it currently holds ` +
    `'${foundStrategy}'. Either restore this key's strategy to '${foundStrategy}', or delete ` +
    `the row from 'rawbox_boxes' to discard the old data and let this run start fresh.`
  );
}

function unsupportedStrategyError(strategyName: string): string {
  return (
    `Unsupported strategy: '${strategyName}' — BoxStorePg routes 'pg-kv' and 'pg-fifo' only. ` +
    `Open a store for that backend, or declare a PostgreSQL strategy for this key.`
  );
}

function checkValueSize(
  content: unknown,
  valueSizeMax: number,
  key: string,
): Result<void, string> {
  const sizeResult = measureValueSize(content);
  if (sizeResult.isErr()) {
    return err(sizeResult.error);
  }
  const size = sizeResult.value;
  if (size > valueSizeMax) {
    return err(
      `Value for key '${key}' exceeds valueSizeMax: ${size} bytes encoded, limit ${valueSizeMax}`,
    );
  }
  return ok();
}

/**
 * Validates that a connection string is a PostgreSQL URI (`postgres://` or
 * `postgresql://`).
 */
export function validatePgConnectionString(connection: string): Result<string, string> {
  if (
    !connection.startsWith('postgres://') &&
    !connection.startsWith('postgresql://')
  ) {
    return err(
      `Invalid PostgreSQL connection string: expected a "postgres://" or "postgresql://" URL, ` +
        `got ${JSON.stringify(connection)}.`,
    );
  }
  return ok(connection);
}

/**
 * Bootstraps the partitioned `rawbox_boxes` and `rawbox_fifo_items` schema
 * idempotently using an advisory transaction lock so concurrent runners on a
 * fresh database do not race on DDL.
 */
export async function ensurePgSchema(pool: PgPool): Promise<Result<void, string>> {
  let client: PgPoolClient;
  try {
    client = await pool.connect();
  } catch (e: unknown) {
    return err(`PostgreSQL connection failed: ${errorMessage(e)}`);
  }

  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(${PG_SCHEMA_LOCK_ID})`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rawbox_boxes (
        workspace   TEXT        NOT NULL,
        workflow    TEXT        NOT NULL,
        key         TEXT        NOT NULL,
        strategy    TEXT        NOT NULL CHECK (strategy IN ('pg-kv', 'pg-fifo')),
        kv_payload  BYTEA,
        fifo_depth  INTEGER     NOT NULL DEFAULT 0 CHECK (fifo_depth >= 0),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace, workflow, key)
      ) PARTITION BY HASH (workspace, workflow)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rawbox_fifo_items (
        id          BIGSERIAL   NOT NULL,
        workspace   TEXT        NOT NULL,
        workflow    TEXT        NOT NULL,
        key         TEXT        NOT NULL,
        payload     BYTEA       NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace, workflow, id),
        FOREIGN KEY (workspace, workflow, key)
          REFERENCES rawbox_boxes (workspace, workflow, key)
          ON DELETE CASCADE
      ) PARTITION BY HASH (workspace, workflow)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rawbox_fifo_head
      ON rawbox_fifo_items (workspace, workflow, key, id ASC)
    `);

    for (let i = 0; i < PG_HASH_PARTITION_COUNT; i += 1) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS rawbox_boxes_p${i}
        PARTITION OF rawbox_boxes
        FOR VALUES WITH (MODULUS ${PG_HASH_PARTITION_COUNT}, REMAINDER ${i})
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS rawbox_fifo_items_p${i}
        PARTITION OF rawbox_fifo_items
        FOR VALUES WITH (MODULUS ${PG_HASH_PARTITION_COUNT}, REMAINDER ${i})
      `);
    }

    await client.query('COMMIT');
    return ok();
  } catch (e: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failures after connection error.
    }
    return err(`PostgreSQL schema initialization failed: ${errorMessage(e)}`);
  } finally {
    client.release();
  }
}

/**
 * Pools PostgreSQL connections per connection URL for one workflow run or CLI
 * inspection command. Owns connection lifecycle via {@link closeAll}.
 */
export class PgPoolCache {
  private static readonly testPools = new Map<string, PgPool>();

  /** Registers an external/in-memory pool (e.g. PGlite) for a connection string during tests. */
  public static registerTestPool(connection: string, pool: PgPool): void {
    PgPoolCache.testPools.set(connection, pool);
  }

  /** Unregisters a previously registered test pool. */
  public static unregisterTestPool(connection: string): void {
    PgPoolCache.testPools.delete(connection);
  }

  private readonly poolMap = new Map<string, { pool: PgPool; isOwned: boolean }>();

  public async getOrCreatePool(connection: string): Promise<Result<PgPool, string>> {
    const validResult = validatePgConnectionString(connection);
    if (validResult.isErr()) {
      return err(validResult.error);
    }

    const cached = this.poolMap.get(connection);
    if (cached !== undefined) {
      return ok(cached.pool);
    }

    const testPool = PgPoolCache.testPools.get(connection);
    if (testPool !== undefined) {
      const schemaResult = await ensurePgSchema(testPool);
      if (schemaResult.isErr()) {
        return err(schemaResult.error);
      }
      this.poolMap.set(connection, { pool: testPool, isOwned: false });
      return ok(testPool);
    }

    const pgPool = new Pool({
      connectionString: connection,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
    });
    pgPool.on('error', () => {
      // Prevent idle client errors from becoming uncaught EventEmitter crashes.
    });

    const wrappedPool = pgPool as unknown as PgPool;
    const schemaResult = await ensurePgSchema(wrappedPool);
    if (schemaResult.isErr()) {
      try {
        await pgPool.end();
      } catch {
        // Ignore cleanup errors after connection/schema failure.
      }
      return err(schemaResult.error);
    }

    this.poolMap.set(connection, { pool: wrappedPool, isOwned: true });
    return ok(wrappedPool);
  }

  public async closeAll(): Promise<void> {
    const entries = [...this.poolMap.values()];
    this.poolMap.clear();
    for (const entry of entries) {
      if (!entry.isOwned) {
        continue;
      }
      try {
        await entry.pool.end();
      } catch {
        // Closing is cleanup; never throw.
      }
    }
  }
}

interface PreparedPut {
  readonly box: Box<unknown>;
  readonly encoded: Buffer;
}

interface BoxMetaRow extends Record<string, unknown> {
  readonly strategy: string;
  readonly fifo_depth: number | string;
}

interface BoxKvRow extends Record<string, unknown> {
  readonly strategy: string;
  readonly kv_payload: Uint8Array | null;
}

interface FifoPayloadRow extends Record<string, unknown> {
  readonly payload: Uint8Array;
}

export class BoxStorePg implements BoxStore {
  private constructor(
    public readonly workspace: string,
    private readonly pool: PgPool,
  ) {}

  public static async create(
    workspace: string,
    connection: string,
    poolCache: PgPoolCache,
  ): Promise<Result<BoxStorePg, string>> {
    const poolResult = await poolCache.getOrCreatePool(connection);
    if (poolResult.isErr()) {
      return err(poolResult.error);
    }
    return ok(new BoxStorePg(workspace, poolResult.value));
  }

  public async get(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    const res = await this.transact({ gets: { value: boxLocation } });
    if (res.isErr()) {
      return err(res.error);
    }
    return ok(res.value['value']);
  }

  public async put(box: Box<unknown>): Promise<Result<void, string>> {
    const res = await this.transact({ puts: [box] });
    if (res.isErr()) {
      return err(res.error);
    }
    return ok();
  }

  public async transact(
    batch: BoxTransactionBatch,
  ): Promise<Result<Record<string, unknown>, string>> {
    const puts = batch.puts ?? [];
    const getEntries = Object.entries(batch.gets ?? {});

    if (puts.length === 0 && getEntries.length === 0) {
      return ok({});
    }

    // Stage 1: Client preflight (zero DB round trips on malformed inputs)
    const preparedPuts: PreparedPut[] = [];
    for (const box of puts) {
      if (box.location.workspace !== this.workspace) {
        return err(
          `Workspace mismatch: store is for '${this.workspace}', box location specifies '${box.location.workspace}'`,
        );
      }

      const { strategy, key } = box.location;
      if (strategy.name !== 'pg-kv' && strategy.name !== 'pg-fifo') {
        return err(unsupportedStrategyError(strategy.name));
      }

      const sizeResult = checkValueSize(box.content, strategy.valueSizeMax, key);
      if (sizeResult.isErr()) {
        return err(sizeResult.error);
      }

      const encodedResult = encodePgValue(box.content);
      if (encodedResult.isErr()) {
        return err(encodedResult.error);
      }

      preparedPuts.push({ box, encoded: encodedResult.value });
    }

    for (const [, loc] of getEntries) {
      if (loc.workspace !== this.workspace) {
        return err(
          `Workspace mismatch: store is for '${this.workspace}', box location specifies '${loc.workspace}'`,
        );
      }
      if (loc.strategy.name !== 'pg-kv' && loc.strategy.name !== 'pg-fifo') {
        return err(unsupportedStrategyError(loc.strategy.name));
      }
    }

    // Collect distinct target keys in deterministic order for deadlock-free row locking
    const lockTargetMap = new Map<string, { workflow: string; key: string }>();
    for (const { box } of preparedPuts) {
      const id = `${box.location.workflow}\u0000${box.location.key}`;
      lockTargetMap.set(id, {
        workflow: box.location.workflow,
        key: box.location.key,
      });
    }
    for (const [, loc] of getEntries) {
      const id = `${loc.workflow}\u0000${loc.key}`;
      lockTargetMap.set(id, { workflow: loc.workflow, key: loc.key });
    }
    const sortedTargets = [...lockTargetMap.values()].sort((a, b) => {
      const wfCmp = a.workflow.localeCompare(b.workflow);
      return wfCmp !== 0 ? wfCmp : a.key.localeCompare(b.key);
    });

    // Stage 2: Native ACID PostgreSQL transaction
    let client: PgPoolClient;
    try {
      client = await this.pool.connect();
    } catch (e: unknown) {
      return err(`PostgreSQL connection failed: ${errorMessage(e)}`);
    }

    const abortTx = async (reason: string): Promise<Result<Record<string, unknown>, string>> => {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure when already aborting.
      }
      return err(reason);
    };

    try {
      await client.query('BEGIN');

      if (sortedTargets.length > 0) {
        await client.query(
          `SELECT b.workflow, b.key
           FROM rawbox_boxes AS b
           JOIN UNNEST($2::text[], $3::text[]) AS t(workflow, key)
             ON b.workspace = $1 AND b.workflow = t.workflow AND b.key = t.key
           ORDER BY b.workflow ASC, b.key ASC
           FOR UPDATE`,
          [
            this.workspace,
            sortedTargets.map((t) => t.workflow),
            sortedTargets.map((t) => t.key),
          ],
        );
      }

      let hasMutations = false;

      for (const { box, encoded } of preparedPuts) {
        const { workflow, key, strategy } = box.location;

        if (strategy.name === 'pg-kv') {
          const existingRes = await client.query<BoxMetaRow>(
            `SELECT strategy, fifo_depth
             FROM rawbox_boxes
             WHERE workspace = $1 AND workflow = $2 AND key = $3
             FOR UPDATE`,
            [this.workspace, workflow, key],
          );

          const existing = existingRes.rows[0];
          if (existing !== undefined && existing.strategy !== 'pg-kv') {
            return await abortTx(wrongPgStrategyMessage(key, 'pg-kv', existing.strategy));
          }

          await client.query(
            `INSERT INTO rawbox_boxes (workspace, workflow, key, strategy, kv_payload, fifo_depth, updated_at)
             VALUES ($1, $2, $3, 'pg-kv', $4, 0, now())
             ON CONFLICT (workspace, workflow, key)
             DO UPDATE SET
               kv_payload = EXCLUDED.kv_payload,
               updated_at = now()`,
            [this.workspace, workflow, key, encoded],
          );
          hasMutations = true;
          continue;
        }

        if (strategy.name === 'pg-fifo') {
          const existingRes = await client.query<BoxMetaRow>(
            `SELECT strategy, fifo_depth
             FROM rawbox_boxes
             WHERE workspace = $1 AND workflow = $2 AND key = $3
             FOR UPDATE`,
            [this.workspace, workflow, key],
          );

          const existing = existingRes.rows[0];
          if (existing !== undefined && existing.strategy !== 'pg-fifo') {
            return await abortTx(wrongPgStrategyMessage(key, 'pg-fifo', existing.strategy));
          }

          const currentDepth = existing !== undefined ? Number(existing.fifo_depth) : 0;
          if (currentDepth >= strategy.queueSizeMax) {
            return await abortTx(`Queue is full '${strategy.name}'`);
          }

          const nextDepth = currentDepth + 1;
          await client.query(
            `INSERT INTO rawbox_boxes (workspace, workflow, key, strategy, kv_payload, fifo_depth, updated_at)
             VALUES ($1, $2, $3, 'pg-fifo', NULL, $4, now())
             ON CONFLICT (workspace, workflow, key)
             DO UPDATE SET
               fifo_depth = EXCLUDED.fifo_depth,
               updated_at = now()`,
            [this.workspace, workflow, key, nextDepth],
          );

          await client.query(
            `INSERT INTO rawbox_fifo_items (workspace, workflow, key, payload)
             VALUES ($1, $2, $3, $4)`,
            [this.workspace, workflow, key, encoded],
          );
          hasMutations = true;
        }
      }

      const outputRecord: Record<string, unknown> = {};

      for (const [inputKey, loc] of getEntries) {
        const { workflow, key, strategy } = loc;

        if (strategy.name === 'pg-kv') {
          const readRes = await client.query<BoxKvRow>(
            `SELECT strategy, kv_payload
             FROM rawbox_boxes
             WHERE workspace = $1 AND workflow = $2 AND key = $3
             FOR UPDATE`,
            [this.workspace, workflow, key],
          );

          const row = readRes.rows[0];
          if (row === undefined) {
            return await abortTx(descriptorFor(strategy).emptyReadMessage);
          }

          if (row.strategy !== 'pg-kv') {
            return await abortTx(wrongPgStrategyMessage(key, 'pg-kv', row.strategy));
          }

          if (row.kv_payload === null) {
            return await abortTx(descriptorFor(strategy).emptyReadMessage);
          }

          const decoded = decodePgValue(row.kv_payload);
          if (decoded.isErr()) {
            return await abortTx(decoded.error);
          }

          outputRecord[inputKey] = decoded.value;
          continue;
        }

        if (strategy.name === 'pg-fifo') {
          const metaRes = await client.query<BoxMetaRow>(
            `SELECT strategy, fifo_depth
             FROM rawbox_boxes
             WHERE workspace = $1 AND workflow = $2 AND key = $3
             FOR UPDATE`,
            [this.workspace, workflow, key],
          );

          const meta = metaRes.rows[0];
          if (meta !== undefined && meta.strategy !== 'pg-fifo') {
            return await abortTx(wrongPgStrategyMessage(key, 'pg-fifo', meta.strategy));
          }

          const currentDepth = meta !== undefined ? Number(meta.fifo_depth) : 0;
          if (currentDepth <= 0) {
            return await abortTx(descriptorFor(strategy).emptyReadMessage);
          }

          const popRes = await client.query<FifoPayloadRow>(
            `DELETE FROM rawbox_fifo_items
             WHERE workspace = $1 AND workflow = $2
               AND id = (
                 SELECT id
                 FROM rawbox_fifo_items
                 WHERE workspace = $1 AND workflow = $2 AND key = $3
                 ORDER BY id ASC
                 LIMIT 1
               )
             RETURNING payload`,
            [this.workspace, workflow, key],
          );

          const popped = popRes.rows[0];
          if (popped === undefined) {
            return await abortTx(descriptorFor(strategy).emptyReadMessage);
          }

          await client.query(
            `UPDATE rawbox_boxes
             SET fifo_depth = fifo_depth - 1,
                 updated_at = now()
             WHERE workspace = $1 AND workflow = $2 AND key = $3`,
            [this.workspace, workflow, key],
          );

          const decoded = decodePgValue(popped.payload);
          if (decoded.isErr()) {
            return await abortTx(decoded.error);
          }

          outputRecord[inputKey] = decoded.value;
          hasMutations = true;
        }
      }

      if (hasMutations) {
        await client.query(
          `SELECT pg_notify('rawbox_store', $1)`,
          [JSON.stringify({ workspace: this.workspace })],
        );
      }

      await client.query('COMMIT');
      return ok(outputRecord);
    } catch (e: unknown) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure.
      }
      return err(`PostgreSQL transaction failed: ${errorMessage(e)}`);
    } finally {
      client.release();
    }
  }
}
