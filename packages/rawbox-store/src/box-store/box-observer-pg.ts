import { ok, err, type Result } from 'neverthrow';

import { type BoxLocation } from '../box.js';
import { descriptorFor, seedCapacityOf } from '../strategy/descriptor.js';
import { type BoxObserverAsync } from './box-observer.js';
import { type BoxInspection, type BoxQueueDepth } from './box-peek.js';
import {
  decodePgValue,
  type PgPool,
  type PgPoolCache,
  wrongPgStrategyMessage,
} from './box-store-pg.js';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function unsupportedStrategyError(strategyName: string): string {
  return (
    `Unsupported strategy: '${strategyName}' — BoxObserverPg observes 'pg-kv' and ` +
    `'pg-fifo' only. Open an observer for that backend instead, or declare a PostgreSQL ` +
    `strategy for this key.`
  );
}

interface WorkflowRow extends Record<string, unknown> {
  readonly workflow: string;
}

interface BoxSummaryRow extends Record<string, unknown> {
  readonly key: string;
  readonly strategy: string;
  readonly kv_payload: Uint8Array | null;
  readonly fifo_depth: number | string;
}

interface FifoStatsRow extends Record<string, unknown> {
  readonly key: string;
  readonly entry_count: number | string;
  readonly total_bytes: number | string;
  readonly max_bytes: number | string;
}

interface BoxStrategyAndKvRow extends Record<string, unknown> {
  readonly strategy: string;
  readonly kv_payload: Uint8Array | null;
}

interface BoxStrategyAndDepthRow extends Record<string, unknown> {
  readonly strategy: string;
  readonly fifo_depth: number | string;
}

interface FifoPayloadRow extends Record<string, unknown> {
  readonly payload: Uint8Array;
}

/**
 * PostgreSQL implementation of {@link BoxObserverAsync} for observing
 * `pg-kv` and `pg-fifo` boxes across multihost runs without mutating state.
 */
export class BoxObserverPg implements BoxObserverAsync {
  private closed = false;

  private constructor(
    public readonly workspace: string,
    private readonly pool: PgPool,
  ) {}

  public static async create(
    workspace: string,
    connection: string,
    poolCache: PgPoolCache,
  ): Promise<Result<BoxObserverPg, string>> {
    const poolResult = await poolCache.getOrCreatePool(connection);
    if (poolResult.isErr()) {
      return err(poolResult.error);
    }
    return ok(new BoxObserverPg(workspace, poolResult.value));
  }

  public async listWorkflows(): Promise<Result<string[], string>> {
    if (this.closed) {
      return err(`Observer for workspace '${this.workspace}' is closed`);
    }

    try {
      const result = await this.pool.query<WorkflowRow>(
        `SELECT DISTINCT workflow
         FROM rawbox_boxes
         WHERE workspace = $1
         ORDER BY workflow ASC`,
        [this.workspace],
      );
      return ok(result.rows.map((row) => row.workflow));
    } catch (e: unknown) {
      return err(`PostgreSQL listWorkflows failed: ${errorMessage(e)}`);
    }
  }

  public async listKeys(workflow: string): Promise<Result<BoxInspection[], string>> {
    if (this.closed) {
      return err(`Observer for workspace '${this.workspace}' is closed`);
    }

    try {
      const boxRes = await this.pool.query<BoxSummaryRow>(
        `SELECT key, strategy, kv_payload, fifo_depth
         FROM rawbox_boxes
         WHERE workspace = $1 AND workflow = $2
         ORDER BY key ASC`,
        [this.workspace, workflow],
      );

      const hasFifo = boxRes.rows.some((row) => row.strategy === 'pg-fifo');
      const fifoStatsMap = new Map<string, FifoStatsRow>();

      if (hasFifo) {
        const statsRes = await this.pool.query<FifoStatsRow>(
          `SELECT
             key,
             COUNT(*) AS entry_count,
             COALESCE(SUM(OCTET_LENGTH(payload)), 0) AS total_bytes,
             COALESCE(MAX(OCTET_LENGTH(payload)), 0) AS max_bytes
           FROM rawbox_fifo_items
           WHERE workspace = $1 AND workflow = $2
           GROUP BY key`,
          [this.workspace, workflow],
        );

        for (const row of statsRes.rows) {
          fifoStatsMap.set(row.key, row);
        }
      }

      const inspectionList: BoxInspection[] = [];

      for (const row of boxRes.rows) {
        if (row.strategy === 'pg-kv') {
          const byteLength = row.kv_payload !== null ? row.kv_payload.byteLength : 0;
          inspectionList.push({
            key: row.key,
            strategy: 'pg-kv',
            entryCount: row.kv_payload !== null ? 1 : 0,
            valueSizeBytes: byteLength,
            valueSizeMaxBytes: byteLength,
          });
          continue;
        }

        if (row.strategy === 'pg-fifo') {
          const stats = fifoStatsMap.get(row.key);
          const entryCount = stats !== undefined ? Number(stats.entry_count) : Number(row.fifo_depth);
          const valueSizeBytes = stats !== undefined ? Number(stats.total_bytes) : 0;
          const valueSizeMaxBytes = stats !== undefined ? Number(stats.max_bytes) : 0;

          inspectionList.push({
            key: row.key,
            strategy: 'pg-fifo',
            entryCount,
            valueSizeBytes,
            valueSizeMaxBytes,
            queueDepth: entryCount,
          });
        }
      }

      return ok(inspectionList);
    } catch (e: unknown) {
      return err(`PostgreSQL listKeys failed: ${errorMessage(e)}`);
    }
  }

  private checkLocation(
    boxLocation: BoxLocation,
    allowedNameList: readonly string[],
  ): Result<void, string> {
    if (this.closed) {
      return err(`Observer for workspace '${this.workspace}' is closed`);
    }

    if (boxLocation.workspace !== this.workspace) {
      return err(
        `Location addresses workspace '${boxLocation.workspace}' but this observer is open on '${this.workspace}'`,
      );
    }

    if (!allowedNameList.includes(boxLocation.strategy.name)) {
      return err(unsupportedStrategyError(boxLocation.strategy.name));
    }

    return ok();
  }

  public async peek(boxLocation: BoxLocation): Promise<Result<unknown, string>> {
    const checkResult = this.checkLocation(boxLocation, ['pg-kv', 'pg-fifo']);
    if (checkResult.isErr()) {
      return err(checkResult.error);
    }

    const { workflow, key, strategy } = boxLocation;

    try {
      if (strategy.name === 'pg-kv') {
        const res = await this.pool.query<BoxStrategyAndKvRow>(
          `SELECT strategy, kv_payload
           FROM rawbox_boxes
           WHERE workspace = $1 AND workflow = $2 AND key = $3`,
          [this.workspace, workflow, key],
        );
        const row = res.rows[0];
        if (row === undefined) {
          return err(descriptorFor(strategy).emptyReadMessage);
        }
        if (row.strategy !== 'pg-kv') {
          return err(wrongPgStrategyMessage(key, 'pg-kv', row.strategy));
        }
        if (row.kv_payload === null) {
          return err(descriptorFor(strategy).emptyReadMessage);
        }
        return decodePgValue(row.kv_payload);
      }

      const metaRes = await this.pool.query<BoxStrategyAndDepthRow>(
        `SELECT strategy, fifo_depth
         FROM rawbox_boxes
         WHERE workspace = $1 AND workflow = $2 AND key = $3`,
        [this.workspace, workflow, key],
      );
      const meta = metaRes.rows[0];
      if (meta === undefined) {
        return err(descriptorFor(strategy).emptyReadMessage);
      }
      if (meta.strategy !== 'pg-fifo') {
        return err(wrongPgStrategyMessage(key, 'pg-fifo', meta.strategy));
      }
      if (Number(meta.fifo_depth) <= 0) {
        return err(descriptorFor(strategy).emptyReadMessage);
      }

      const itemRes = await this.pool.query<FifoPayloadRow>(
        `SELECT payload
         FROM rawbox_fifo_items
         WHERE workspace = $1 AND workflow = $2 AND key = $3
         ORDER BY id ASC
         LIMIT 1`,
        [this.workspace, workflow, key],
      );
      const head = itemRes.rows[0];
      if (head === undefined) {
        return err(descriptorFor(strategy).emptyReadMessage);
      }
      return decodePgValue(head.payload);
    } catch (e: unknown) {
      return err(`PostgreSQL peek failed for key '${key}': ${errorMessage(e)}`);
    }
  }

  public async peekAll(boxLocation: BoxLocation): Promise<Result<unknown[], string>> {
    const checkResult = this.checkLocation(boxLocation, ['pg-kv', 'pg-fifo']);
    if (checkResult.isErr()) {
      return err(checkResult.error);
    }

    const { workflow, key, strategy } = boxLocation;

    if (strategy.name === 'pg-kv') {
      const peekResult = await this.peek(boxLocation);
      return peekResult.isOk() ? ok([peekResult.value]) : err(peekResult.error);
    }

    try {
      const metaRes = await this.pool.query<BoxStrategyAndDepthRow>(
        `SELECT strategy, fifo_depth
         FROM rawbox_boxes
         WHERE workspace = $1 AND workflow = $2 AND key = $3`,
        [this.workspace, workflow, key],
      );
      const meta = metaRes.rows[0];
      if (meta === undefined) {
        return err(descriptorFor(strategy).emptyReadMessage);
      }
      if (meta.strategy !== 'pg-fifo') {
        return err(wrongPgStrategyMessage(key, 'pg-fifo', meta.strategy));
      }

      const itemRes = await this.pool.query<FifoPayloadRow>(
        `SELECT payload
         FROM rawbox_fifo_items
         WHERE workspace = $1 AND workflow = $2 AND key = $3
         ORDER BY id ASC`,
        [this.workspace, workflow, key],
      );

      if (itemRes.rows.length === 0) {
        return err(descriptorFor(strategy).emptyReadMessage);
      }

      const decodedList: unknown[] = [];
      for (const row of itemRes.rows) {
        const decoded = decodePgValue(row.payload);
        if (decoded.isErr()) {
          return err(decoded.error);
        }
        decodedList.push(decoded.value);
      }
      return ok(decodedList);
    } catch (e: unknown) {
      return err(`PostgreSQL peekAll failed for key '${key}': ${errorMessage(e)}`);
    }
  }

  public async depth(boxLocation: BoxLocation): Promise<Result<BoxQueueDepth, string>> {
    const checkResult = this.checkLocation(boxLocation, ['pg-kv', 'pg-fifo']);
    if (checkResult.isErr()) {
      return err(checkResult.error);
    }

    const { workflow, key, strategy } = boxLocation;
    if (strategy.name !== 'pg-fifo') {
      return err(
        `Depth is not a property of strategy '${strategy.name}'; key '${key}' has no depth to report`,
      );
    }

    try {
      const metaRes = await this.pool.query<BoxStrategyAndDepthRow>(
        `SELECT strategy, fifo_depth
         FROM rawbox_boxes
         WHERE workspace = $1 AND workflow = $2 AND key = $3`,
        [this.workspace, workflow, key],
      );
      const meta = metaRes.rows[0];
      if (meta !== undefined && meta.strategy !== 'pg-fifo') {
        return err(wrongPgStrategyMessage(key, 'pg-fifo', meta.strategy));
      }

      const used = meta !== undefined ? Number(meta.fifo_depth) : 0;
      const capacity = seedCapacityOf(strategy) ?? strategy.queueSizeMax;
      return ok({ used, capacity });
    } catch (e: unknown) {
      return err(`PostgreSQL depth failed for key '${key}': ${errorMessage(e)}`);
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}
