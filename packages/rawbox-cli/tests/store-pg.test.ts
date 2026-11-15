import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { Mutex } from 'async-mutex';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import type { BoxStrategy } from '@rawbox/store';
import {
  BoxStorePg,
  PgPoolCache,
  type PgPool,
  type PgPoolClient,
  type PgQueryResult,
} from '@rawbox/store/box-store-pg';

import { storeListCommand } from '../src/commands/store/list.js';
import { storeGetCommand } from '../src/commands/store/get.js';
import { storeWatchCommand } from '../src/commands/store/watch.js';
import { workspaceStatusCommand } from '../src/commands/workspace/status.js';
import { buildWorkspaceStatusSnapshot } from '../src/workspace/status.js';
import { resolveStoreTarget } from '../src/store/target.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-store-pg-cli-test');

interface PgHarness {
  readonly connection: string;
  readonly envVarName: string;
  cleanupWorkspace(prefix: string): Promise<void>;
  dispose(): Promise<void>;
}

async function createPgHarness(): Promise<PgHarness> {
  const externalUrl = process.env['PG_URL'];
  const envVarName = 'RAWBOX_CLI_PG_TEST_URL';

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
          // Schema may not exist yet.
        }
      },
      async dispose(): Promise<void> {
        await pgPool.end();
      },
    };
  }

  const connection = `postgresql://pglite:pglite@127.0.0.1:5432/rawbox_cli_${Date.now()}`;
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
      // Disposed by cleanup helper.
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

const PG_KV: BoxStrategy = { name: 'pg-kv', backend: 'primary_pg', valueSizeMax: 4096 };
const PG_FIFO: BoxStrategy = {
  name: 'pg-fifo',
  backend: 'primary_pg',
  queueSizeMax: 6,
  valueSizeMax: 4096,
};

let logSpy: ReturnType<typeof vi.spyOn>;

function loggedText(): string {
  const joined = logSpy.mock.calls.map((call: unknown[]) => call.join(' ')).join('\n');
  // eslint-disable-next-line no-control-regex
  return joined.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('CLI store & status commands against PostgreSQL backends', () => {
  const WS_PREFIX = 'pg_cli_test_';
  let pg: PgHarness;
  let prevEnv: string | undefined;

  beforeAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.mkdir(rootDir, { recursive: true });
    pg = await createPgHarness();
    prevEnv = process.env[pg.envVarName];
    process.env[pg.envVarName] = pg.connection;
  });

  beforeEach(async () => {
    await pg.cleanupWorkspace(WS_PREFIX);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    vi.spyOn(p.log, 'error').mockImplementation((() => undefined) as never);
    vi.spyOn(p.log, 'info').mockImplementation((() => undefined) as never);
    vi.spyOn(p.log, 'warn').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (prevEnv === undefined) {
      delete process.env[pg.envVarName];
    } else {
      process.env[pg.envVarName] = prevEnv;
    }
    await pg.cleanupWorkspace(WS_PREFIX);
    await pg.dispose();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  async function createPgWorkspaceFixture(name: string, includeUnsetBackend = false) {
    const wsDir = path.join(rootDir, name);
    await fs.mkdir(path.join(wsDir, 'workflows'), { recursive: true });

    const wfPath = path.join(wsDir, 'workflows', 'pg_wf.workflow.yaml');
    await fs.writeFile(
      wfPath,
      [
        'kind: Workflow',
        'formatVersion: "1.0"',
        'name: pg_wf',
        'plugins: {}',
        'storage:',
        '  defaultStrategy:',
        '    name: pg-kv',
        '    backend: primary_pg',
        '    valueSizeMax: 4096',
        '  keys:',
        '    cell_box:',
        '      seed: initial',
        '    queue_box:',
        '      strategy:',
        '        name: pg-fifo',
        '        backend: primary_pg',
        '        queueSizeMax: 6',
        '        valueSizeMax: 4096',
        '      seed: []',
        'steps: []',
        '',
      ].join('\n'),
    );

    const workspacePath = path.join(wsDir, 'workspace.yaml');
    const backendLines = [
      'backends:',
      '  primary_pg:',
      `    connection: "\${${pg.envVarName}}"`,
      ...(includeUnsetBackend
        ? ['  broken_pg:', '    connection: "${RAWBOX_UNSET_CLI_PG_URL}"']
        : []),
    ];

    await fs.writeFile(
      workspacePath,
      [
        'kind: Workspace',
        `name: ${name}`,
        ...backendLines,
        'workflowPathList:',
        '  - workflows/pg_wf.workflow.yaml',
        '',
      ].join('\n'),
    );

    const poolCache = new PgPoolCache();
    const store = (await BoxStorePg.create(name, pg.connection, poolCache))._unsafeUnwrap();
    await store.transact({
      puts: [
        {
          location: { workspace: name, workflow: 'pg_wf', key: 'cell_box', strategy: PG_KV },
          content: { count: 42 },
        },
        {
          location: { workspace: name, workflow: 'pg_wf', key: 'queue_box', strategy: PG_FIFO },
          content: 'q-first',
        },
        {
          location: { workspace: name, workflow: 'pg_wf', key: 'queue_box', strategy: PG_FIFO },
          content: 'q-second',
        },
      ],
    });
    await poolCache.closeAll();

    return { wsDir, workspacePath };
  }

  it('lists and non-destructively inspects pg-kv and pg-fifo keys via store list and store get', async () => {
    const wsName = `${WS_PREFIX}list_get_${Date.now()}`;
    const { workspacePath } = await createPgWorkspaceFixture(wsName);

    await storeListCommand(workspacePath, { output: 'json' });
    const rows = JSON.parse(loggedText()) as Array<{
      workflow: string;
      key: string;
      strategy: string;
      fifo?: { depth: number; capacity?: number };
    }>;
    expect(rows).toEqual([
      expect.objectContaining({
        workflow: 'pg_wf',
        key: 'cell_box',
        strategy: 'pg-kv',
      }),
      expect.objectContaining({
        workflow: 'pg_wf',
        key: 'queue_box',
        strategy: 'pg-fifo',
        fifo: { depth: 2, capacity: 6 },
      }),
    ]);

    logSpy.mockClear();
    await storeGetCommand(workspacePath, 'pg_wf', 'queue_box', { output: 'json' });
    const peeked = JSON.parse(loggedText()) as Array<{
      strategy: string;
      depth: number;
      elements: unknown[];
    }>;
    expect(peeked).toEqual([
      expect.objectContaining({
        strategy: 'pg-fifo',
        depth: 2,
        elements: ['q-first', 'q-second'],
      }),
    ]);

    // Ensure `store get` did not pop anything from PostgreSQL
    logSpy.mockClear();
    await storeGetCommand(workspacePath, 'pg_wf', 'queue_box', { output: 'json' });
    const peekedAgain = JSON.parse(loggedText()) as Array<{ elements: unknown[] }>;
    expect(peekedAgain[0]?.elements).toEqual(['q-first', 'q-second']);
  });

  it('watches PostgreSQL mutations across polls via store watch', async () => {
    const wsName = `${WS_PREFIX}watch_${Date.now()}`;
    const { workspacePath } = await createPgWorkspaceFixture(wsName);

    const emittedLines: string[] = [];
    const poolCache = new PgPoolCache();
    const store = (await BoxStorePg.create(wsName, pg.connection, poolCache))._unsafeUnwrap();

    try {
      const updateTimer = setTimeout(() => {
        void store.put({
          location: { workspace: wsName, workflow: 'pg_wf', key: 'cell_box', strategy: PG_KV },
          content: { count: 99 },
        });
      }, 25);

      await storeWatchCommand(workspacePath, ['pg_wf:cell_box'], {
        interval: 40,
        maxPolls: 5,
        output: 'json',
        write: (text) => {
          emittedLines.push(text);
        },
      });
      clearTimeout(updateTimer);
    } finally {
      await poolCache.closeAll();
    }

    const parsedChanges = emittedLines
      .flatMap((line) => line.trim().split('\n'))
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as { workflow: string; key: string; strategy: string });

    expect(parsedChanges.length).toBeGreaterThanOrEqual(1);
    expect(parsedChanges[0]).toMatchObject({
      workflow: 'pg_wf',
      key: 'cell_box',
      strategy: 'pg-kv',
    });
  });

  it('includes PostgreSQL storage and renders backend warnings in workspace status', async () => {
    delete process.env['RAWBOX_UNSET_CLI_PG_URL'];
    const wsName = `${WS_PREFIX}status_${Date.now()}`;
    const { workspacePath } = await createPgWorkspaceFixture(wsName, true);

    const target = (await resolveStoreTarget(workspacePath, process.cwd()))._unsafeUnwrap();
    const resolvedTarget = target as typeof target & {
      workspaceDoc: NonNullable<typeof target.workspaceDoc>;
      workspaceDocPath: NonNullable<typeof target.workspaceDocPath>;
    };
    const snapshot = await buildWorkspaceStatusSnapshot(resolvedTarget);

    expect(snapshot.storage).toEqual([
      {
        workflow: 'pg_wf',
        keyList: [
          expect.objectContaining({ key: 'cell_box', strategy: 'pg-kv' }),
          expect.objectContaining({ key: 'queue_box', strategy: 'pg-fifo', fifo: { depth: 2 } }),
        ],
      },
    ]);
    expect(snapshot.storageWarningList).toBeDefined();
    expect(snapshot.storageWarningList?.join('\n')).toContain('RAWBOX_UNSET_CLI_PG_URL');

    logSpy.mockClear();
    await workspaceStatusCommand(workspacePath);
    const rendered = loggedText();
    expect(rendered).toContain('cell_box');
    expect(rendered).toContain('queue_box');
    expect(rendered).toContain('RAWBOX_UNSET_CLI_PG_URL');
  });
});
