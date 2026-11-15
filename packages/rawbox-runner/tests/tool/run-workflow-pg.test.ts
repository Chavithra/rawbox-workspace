import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Mutex } from 'async-mutex';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { BoxObserverPg } from '@rawbox/store/box-observer-pg';
import {
  PgPoolCache,
  type PgPool,
  type PgPoolClient,
  type PgQueryResult,
} from '@rawbox/store/box-store-pg';

import { BOOTSTRAP_STAGE, OUTCOME, type RunEvent } from '../../src/events/index.js';
import { runWorkflowInstance } from '../../src/tool/run-workflow.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-run-pg-e2e');
const DEFAULT_PLUGIN = '@rawbox/rawbox-plugin-default';

interface PgHarness {
  readonly connection: string;
  readonly envVarName: string;
  cleanupWorkspace(workspacePrefix: string): Promise<void>;
  dispose(): Promise<void>;
}

async function createPgHarness(): Promise<PgHarness> {
  const externalUrl = process.env['PG_URL'];
  const envVarName = 'RAWBOX_RUNNER_PG_TEST_URL';

  if (externalUrl !== undefined && externalUrl.length > 0) {
    const pgPool = new Pool({ connectionString: externalUrl, max: 5 });
    const pool = pgPool as unknown as PgPool;
    return {
      connection: externalUrl,
      envVarName,
      async cleanupWorkspace(prefix: string): Promise<void> {
        try {
          await pool.query(`DELETE FROM rawbox_boxes WHERE workspace LIKE $1`, [
            `${prefix}%`,
          ]);
        } catch {
          // Schema may not exist yet before first run.
        }
      },
      async dispose(): Promise<void> {
        await pgPool.end();
      },
    };
  }

  const connection = `postgresql://pglite:pglite@127.0.0.1:5432/rawbox_runner_${Date.now()}`;
  const pglite = new PGlite();
  const mutex = new Mutex();

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

  const pool: PgPool = {
    query: runQuery,
    async connect(): Promise<PgPoolClient> {
      const release = await mutex.acquire();
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
      // Closed in dispose()
    },
  };

  PgPoolCache.registerTestPool(connection, pool);

  return {
    connection,
    envVarName,
    async cleanupWorkspace(prefix: string): Promise<void> {
      try {
        await pool.query(`DELETE FROM rawbox_boxes WHERE workspace LIKE $1`, [
          `${prefix}%`,
        ]);
      } catch {
        // Schema may not exist yet.
      }
    },
    async dispose(): Promise<void> {
      PgPoolCache.unregisterTestPool(connection);
      await pglite.close();
    },
  };
}

function readEvents(logContent: string): RunEvent[] {
  return logContent
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as RunEvent);
}

describe('runWorkflowInstance with PostgreSQL (pg-kv & pg-fifo)', () => {
  const WS_PREFIX = 'pg_runner_e2e_';
  let pg: PgHarness;
  let previousEnvVal: string | undefined;

  beforeAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(rootDir, { recursive: true });
    pg = await createPgHarness();
    previousEnvVal = process.env[pg.envVarName];
    process.env[pg.envVarName] = pg.connection;
  });

  beforeEach(async () => {
    await pg.cleanupWorkspace(WS_PREFIX);
  });

  afterAll(async () => {
    if (previousEnvVal === undefined) {
      delete process.env[pg.envVarName];
    } else {
      process.env[pg.envVarName] = previousEnvVal;
    }
    await pg.cleanupWorkspace(WS_PREFIX);
    await pg.dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('executes a pure PostgreSQL workflow (pg-kv + pg-fifo) without creating a local LMDB data dir', async () => {
    const wsName = `${WS_PREFIX}pure_${Date.now()}`;
    const wsDir = path.join(rootDir, wsName);
    await fs.mkdir(path.join(wsDir, 'workflows'), { recursive: true });

    const workspacePath = path.join(wsDir, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      [
        'kind: Workspace',
        `name: ${wsName}`,
        'backends:',
        '  main_pg:',
        `    connection: "\${${pg.envVarName}}"`,
        'workflowPathList:',
        '  - workflows/pg.workflow.yaml',
        '',
      ].join('\n'),
    );

    const workflowPath = path.join(wsDir, 'workflows', 'pg.workflow.yaml');
    await fs.writeFile(
      workflowPath,
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: pg_main_wf',
        'plugins:',
        `  "${DEFAULT_PLUGIN}": "*"`,
        'storage:',
        '  defaultStrategy:',
        '    name: pg-kv',
        '    backend: main_pg',
        '    valueSizeMax: 4096',
        '  keys:',
        '    input_queue:',
        '      strategy:',
        '        name: pg-fifo',
        '        backend: main_pg',
        '        queueSizeMax: 4',
        '        valueSizeMax: 4096',
        '      seed:',
        '        - item-from-pg-fifo',
        '        - second-queued-item',
        '    halt_reason:',
        '      seed: finished pg workflow',
        'steps:',
        '  - label: echo-from-fifo',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: value-ops/echo',
        '    inputs:',
        '      value: input_queue',
        '    outputs:',
        '      value: echoed_out',
        '    errors:',
        '      message: echo_err',
        '  - label: halt-step',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: control-flow/halt',
        '    inputs:',
        '      reason: halt_reason',
        '    errors:',
        '      message: halt_err',
        '',
      ].join('\n'),
    );

    const logPath = path.join(wsDir, 'run.log');
    const errorLogPath = path.join(wsDir, 'run.error.log');
    const result = await runWorkflowInstance(workspacePath, workflowPath, logPath, errorLogPath);

    expect(result.isOk(), result.isErr() ? result.error : '').toBe(true);
    expect(result._unsafeUnwrap().outcome).toBe(OUTCOME.OK);

    // Verify no local LMDB directory was materialized for a pure-PG workflow
    const dataDirExists = await fs
      .access(path.join(wsDir, '.rawbox', 'data'))
      .then(() => true)
      .catch(() => false);
    expect(dataDirExists).toBe(false);

    // Observe PostgreSQL directly to verify output persisted and first item was dequeued
    const poolCache = new PgPoolCache();
    try {
      const obs = (
        await BoxObserverPg.create(wsName, pg.connection, poolCache)
      )._unsafeUnwrap();
      try {
        expect(
          (
            await obs.peek({
              workspace: wsName,
              workflow: 'pg_main_wf',
              key: 'echoed_out',
              strategy: { name: 'pg-kv', backend: 'main_pg', valueSizeMax: 4096 },
            })
          )._unsafeUnwrap(),
        ).toBe('item-from-pg-fifo');

        expect(
          (
            await obs.peekAll({
              workspace: wsName,
              workflow: 'pg_main_wf',
              key: 'input_queue',
              strategy: {
                name: 'pg-fifo',
                backend: 'main_pg',
                queueSizeMax: 4,
                valueSizeMax: 4096,
              },
            })
          )._unsafeUnwrap(),
        ).toEqual(['second-queued-item']);
      } finally {
        await obs.close();
      }
    } finally {
      await poolCache.closeAll();
    }
  });

  it('routes cross-workflow reads from an LMDB workflow to a PostgreSQL workflow', async () => {
    const wsName = `${WS_PREFIX}xwf_${Date.now()}`;
    const wsDir = path.join(rootDir, wsName);
    await fs.mkdir(path.join(wsDir, 'workflows'), { recursive: true });

    const producerPath = path.join(wsDir, 'workflows', 'producer.workflow.yaml');
    await fs.writeFile(
      producerPath,
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: pg_producer',
        'plugins:',
        `  "${DEFAULT_PLUGIN}": "*"`,
        'storage:',
        '  defaultStrategy:',
        '    name: pg-kv',
        '    backend: main_pg',
        '    valueSizeMax: 4096',
        '  keys:',
        '    msg:',
        '      seed: cross-backend-hello',
        '    halt_reason:',
        '      seed: producer done',
        'steps:',
        '  - label: produce',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: value-ops/echo',
        '    inputs:',
        '      value: msg',
        '    outputs:',
        '      value: published_val',
        '    errors:',
        '      message: prod_err',
        '  - label: stop',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: control-flow/halt',
        '    inputs:',
        '      reason: halt_reason',
        '    errors:',
        '      message: halt_err',
        '',
      ].join('\n'),
    );

    const consumerPath = path.join(wsDir, 'workflows', 'consumer.workflow.yaml');
    await fs.writeFile(
      consumerPath,
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: lmdb_consumer',
        'plugins:',
        `  "${DEFAULT_PLUGIN}": "*"`,
        'storage:',
        '  defaultStrategy:',
        '    name: lmdb-kv',
        '    valueSizeMax: 4096',
        '  keys:',
        '    published_val:',
        '      workflow: pg_producer',
        '      strategy:',
        '        name: pg-kv',
        '        backend: main_pg',
        '        valueSizeMax: 4096',
        '    halt_reason:',
        '      seed: consumer done',
        'steps:',
        '  - label: consume',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: value-ops/echo',
        '    inputs:',
        '      value: published_val',
        '    outputs:',
        '      value: local_copy',
        '    errors:',
        '      message: cons_err',
        '  - label: stop',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: control-flow/halt',
        '    inputs:',
        '      reason: halt_reason',
        '    errors:',
        '      message: halt_err',
        '',
      ].join('\n'),
    );

    const workspacePath = path.join(wsDir, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      [
        'kind: Workspace',
        `name: ${wsName}`,
        'backends:',
        '  main_pg:',
        `    connection: "\${${pg.envVarName}}"`,
        'workflowPathList:',
        '  - workflows/producer.workflow.yaml',
        '  - workflows/consumer.workflow.yaml',
        '',
      ].join('\n'),
    );

    const prodRes = await runWorkflowInstance(
      workspacePath,
      producerPath,
      path.join(wsDir, 'prod.log'),
      path.join(wsDir, 'prod.err.log'),
    );
    expect(prodRes.isOk(), prodRes.isErr() ? prodRes.error : '').toBe(true);

    const consRes = await runWorkflowInstance(
      workspacePath,
      consumerPath,
      path.join(wsDir, 'cons.log'),
      path.join(wsDir, 'cons.err.log'),
    );
    expect(consRes.isOk(), consRes.isErr() ? consRes.error : '').toBe(true);

    const consLog = await fs.readFile(path.join(wsDir, 'cons.log'), 'utf-8');
    const stepEnds = readEvents(consLog).filter((e) => e.event === 'step.end');
    expect(stepEnds.length).toBeGreaterThanOrEqual(1);
    expect(stepEnds[0]).toMatchObject({ outcome: 'ok' });
  });

  it('fails at BOOTSTRAP_STAGE.STORE when a referenced backend env var is unset', async () => {
    const wsName = `${WS_PREFIX}unset_${Date.now()}`;
    const wsDir = path.join(rootDir, wsName);
    await fs.mkdir(path.join(wsDir, 'workflows'), { recursive: true });

    const missingEnv = 'RAWBOX_MISSING_PG_ENV_FOR_TEST';
    delete process.env[missingEnv];

    const workspacePath = path.join(wsDir, 'workspace.yaml');
    await fs.writeFile(
      workspacePath,
      [
        'kind: Workspace',
        `name: ${wsName}`,
        'backends:',
        '  main_pg:',
        `    connection: "\${${missingEnv}}"`,
        'workflowPathList:',
        '  - workflows/pg.workflow.yaml',
        '',
      ].join('\n'),
    );

    const workflowPath = path.join(wsDir, 'workflows', 'pg.workflow.yaml');
    await fs.writeFile(
      workflowPath,
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: pg_unset_wf',
        'plugins:',
        `  "${DEFAULT_PLUGIN}": "*"`,
        'storage:',
        '  defaultStrategy:',
        '    name: pg-kv',
        '    backend: main_pg',
        '    valueSizeMax: 4096',
        '  keys:',
        '    reason:',
        '      seed: bye',
        'steps:',
        '  - label: halt-step',
        `    plugin: "${DEFAULT_PLUGIN}"`,
        '    operation: control-flow/halt',
        '    inputs:',
        '      reason: reason',
        '    errors:',
        '      message: err',
        '',
      ].join('\n'),
    );

    const errLog = path.join(wsDir, 'err.log');
    const res = await runWorkflowInstance(
      workspacePath,
      workflowPath,
      path.join(wsDir, 'run.log'),
      errLog,
    );
    expect(res.isErr()).toBe(true);
    expect(res._unsafeUnwrapErr()).toContain(missingEnv);

    const errEvents = readEvents(await fs.readFile(errLog, 'utf-8'));
    expect(errEvents[0]).toMatchObject({
      event: 'bootstrap.error',
      stage: BOOTSTRAP_STAGE.STORE,
    });
  });
});
