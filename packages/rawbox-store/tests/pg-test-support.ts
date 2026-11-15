import { Pool } from 'pg';
import { Mutex } from 'async-mutex';
import { PGlite } from '@electric-sql/pglite';
import {
  PgPoolCache,
  type PgPool,
  type PgPoolClient,
  type PgQueryResult,
} from '../src/box-store/box-store-pg.js';

export interface PgTestHandle {
  readonly connection: string;
  readonly pool: PgPool;
  cleanupWorkspace(workspacePrefix: string): Promise<void>;
  dispose(): Promise<void>;
}

function toPgPoolFromPglite(pglite: PGlite): PgPool {
  const txMutex = new Mutex();

  const runQuery = async <TRow extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<TRow>> => {
    const res = await pglite.query<TRow>(
      text,
      values === undefined ? undefined : [...values],
    );
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length,
    };
  };

  return {
    query: runQuery,
    async connect(): Promise<PgPoolClient> {
      const release = await txMutex.acquire();
      let released = false;

      return {
        query: runQuery,
        release(): void {
          if (!released) {
            released = true;
            release();
          }
        },
      };
    },
    async end(): Promise<void> {
      // Lifecycle is owned by PgTestHandle.dispose().
    },
  };
}

let testCounter = 0;

/**
 * Creates a clean PostgreSQL test environment for `@rawbox/store`, `@rawbox/runner`,
 * or `@rawbox/cli` tests:
 * - Uses `process.env.PG_URL` directly when a live PostgreSQL server is provided.
 * - Otherwise starts an isolated in-memory `@electric-sql/pglite` engine and
 *   registers it with `PgPoolCache.registerTestPool(...)` under a unique URI.
 */
export async function createPgTestEnvironment(): Promise<PgTestHandle> {
  const externalUrl = process.env['PG_URL'];
  if (externalUrl !== undefined && externalUrl.length > 0) {
    const pgPool = new Pool({ connectionString: externalUrl, max: 5 });
    const pool = pgPool as unknown as PgPool;
    return {
      connection: externalUrl,
      pool,
      async cleanupWorkspace(workspacePrefix: string): Promise<void> {
        try {
          await pool.query(
            `DELETE FROM rawbox_boxes WHERE workspace LIKE $1`,
            [`${workspacePrefix}%`],
          );
        } catch {
          // Ignore if schema wasn't created yet.
        }
      },
      async dispose(): Promise<void> {
        await pgPool.end();
      },
    };
  }

  testCounter += 1;
  const connection = `postgresql://pglite:pglite@127.0.0.1:5432/rawbox_test_${Date.now()}_${testCounter}`;
  const pglite = new PGlite();
  const pool = toPgPoolFromPglite(pglite);
  PgPoolCache.registerTestPool(connection, pool);

  return {
    connection,
    pool,
    async cleanupWorkspace(workspacePrefix: string): Promise<void> {
      try {
        await pool.query(
          `DELETE FROM rawbox_boxes WHERE workspace LIKE $1`,
          [`${workspacePrefix}%`],
        );
      } catch {
        // Ignore if schema wasn't created yet.
      }
    },
    async dispose(): Promise<void> {
      PgPoolCache.unregisterTestPool(connection);
      await pglite.close();
    },
  };
}
