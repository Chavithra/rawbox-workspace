import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import yargs from 'yargs';

import * as runner from '@rawbox/runner';
import { resolveDependencyEnvDir } from '@rawbox/runner';

import { setupCommandDefinition } from '../src/commands/workspace/setup.js';
import { setupLockPathFor } from '../src/commands/workflow/setup-lock.js';
import { getProcessStartedAtMs } from '../src/runs/pid-probe.js';

vi.mock('@rawbox/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@rawbox/runner')>();
  return { ...actual, setupWorkspace: vi.fn(actual.setupWorkspace) };
});

// ---------------------------------------------------------------------------
// `workspace setup <workspace-path> [target-folder]` — the CLI layer over
// `@rawbox/runner`'s `setupWorkspace`: its flags, how they map onto
// `SetupOptions`, and the per-env lock it passes as `withEnvLock`.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-workspace-setup-test');

/** A plain npm package — setup installs any specifier, rawbox plugin or not. */
const LOCAL_PACKAGE = 'rawbox-setup-test-package';
const localPackageDir = path.join(rootDir, '_local-package');

let exitSpy: ReturnType<typeof vi.spyOn>;
let messageList: string[];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureLog(): any {
  return vi.fn((...args: unknown[]) => {
    messageList.push(args.map(String).join(' '));
  });
}

beforeEach(() => {
  messageList = [];
  exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation(captureLog());
  vi.spyOn(p.log, 'warn').mockImplementation(captureLog());
  vi.spyOn(p.log, 'info').mockImplementation(captureLog());
  vi.spyOn(p.log, 'step').mockImplementation(captureLog());
  vi.mocked(runner.setupWorkspace).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function reported(): string {
  // eslint-disable-next-line no-control-regex
  return messageList.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

function expectPassed(): void {
  expect(exitSpy, reported()).not.toHaveBeenCalled();
}

beforeAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(localPackageDir, { recursive: true });
  await fs.writeFile(
    path.join(localPackageDir, 'package.json'),
    JSON.stringify({ name: LOCAL_PACKAGE, version: '1.0.0', type: 'module' }, null, 2),
    'utf-8',
  );
});

afterAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

interface Scenario {
  directory: string;
  workspacePath: string;
  envDir: string;
}

/** One workspace, one workflow declaring {@link LOCAL_PACKAGE} by an absolute `file:` specifier. */
async function makeScenario(name: string): Promise<Scenario> {
  const directory = path.join(rootDir, name);
  await fs.mkdir(path.join(directory, 'workflows'), { recursive: true });

  const workspacePath = path.join(directory, 'workspace.yaml');
  await fs.writeFile(
    workspacePath,
    `kind: Workspace\nname: ${name}\nworkflowPathList:\n  - ./workflows/a.workflow.yaml\n`,
    'utf-8',
  );
  await fs.writeFile(
    path.join(directory, 'workflows', 'a.workflow.yaml'),
    `
kind: Workflow
formatVersion: "1.0"
name: a
dependencies:
  ${LOCAL_PACKAGE}: "file:${localPackageDir}"
storage:
  defaultStrategy:
    name: lmdb-kv
    valueSizeMax: 1900
steps: []
`.trim(),
    'utf-8',
  );

  const envDir = resolveDependencyEnvDir(
    path.join(directory, '.rawbox'),
    { [LOCAL_PACKAGE]: `file:${localPackageDir}` },
    directory,
  ) as string;
  return { directory, workspacePath, envDir };
}

/** A directory shaped like an env no workflow references. */
async function plantStaleEnv(directory: string): Promise<string> {
  const staleEnvDir = path.join(directory, '.rawbox', 'envs', 'deadbeefdeadbeef');
  await fs.mkdir(staleEnvDir, { recursive: true });
  await fs.writeFile(path.join(staleEnvDir, 'package.json'), '{}\n', 'utf-8');
  return staleEnvDir;
}

describe('workspace setup — yargs wiring', () => {
  async function parse(
    args: string[],
  ): Promise<{ failMessage: string | undefined; argv: Record<string, unknown> | undefined }> {
    let failMessage: string | undefined;
    let argv: Record<string, unknown> | undefined;
    const parser = yargs(args)
      .exitProcess(false)
      .fail((msg, error) => {
        failMessage = msg ?? error?.message ?? '(no message)';
        throw new Error(failMessage);
      })
      .command(
        'setup <workspace-path> [target-folder]',
        'setup',
        setupCommandDefinition.builder,
        async (parsed) => {
          argv = parsed as Record<string, unknown>;
        },
      );
    try {
      await parser.parseAsync();
    } catch {
      // The re-thrown `.fail()` error — already captured in `failMessage`.
    }
    return { failMessage, argv };
  }

  it('defaults to --concurrency 2 and pruning on', async () => {
    const { failMessage, argv } = await parse(['setup', 'workspace.yaml']);

    expect(failMessage).toBeUndefined();
    expect(argv?.concurrency).toBe(2);
    expect(argv?.prune).toBe(true);
  });

  it('parses --concurrency <n> and --no-prune', async () => {
    const { failMessage, argv } = await parse([
      'setup',
      'workspace.yaml',
      '--concurrency',
      '4',
      '--no-prune',
    ]);

    expect(failMessage).toBeUndefined();
    expect(argv?.concurrency).toBe(4);
    expect(argv?.prune).toBe(false);
  });

  it.each([['0'], ['-1'], ['1.5'], ['many']])('rejects --concurrency %s', async (value) => {
    const { failMessage, argv } = await parse(['setup', 'workspace.yaml', '--concurrency', value]);

    expect(failMessage).toContain('--concurrency expects a positive integer');
    expect(argv).toBeUndefined();
  });
});

describe('workspace setup — options and output', () => {
  it('maps the flags onto SetupOptions, with a per-env lock as withEnvLock', async () => {
    const scenario = await makeScenario('maps-options');

    await setupCommandDefinition.handler({
      'workspace-path': scenario.workspacePath,
      'install-links': false,
      concurrency: 3,
      prune: false,
    });

    expectPassed();
    expect(runner.setupWorkspace).toHaveBeenCalledTimes(1);
    const [workspacePath, targetFolder, options] = vi.mocked(runner.setupWorkspace).mock.calls[0]!;
    expect(workspacePath).toBe(scenario.workspacePath);
    expect(targetFolder).toBeUndefined();
    expect(options).toMatchObject({ installLinks: false, concurrency: 3, pruneStaleEnvs: false });
    expect(typeof options?.withEnvLock).toBe('function');
  }, 120_000);

  it('prints one line per env and the envs it pruned', async () => {
    const scenario = await makeScenario('prunes-by-default');
    const staleEnvDir = await plantStaleEnv(scenario.directory);

    await setupCommandDefinition.handler({
      'workspace-path': scenario.workspacePath,
      'install-links': false,
      concurrency: 2,
      prune: true,
    });

    expectPassed();
    const output = reported();
    expect(output).toContain(
      `${path.join('envs', path.basename(scenario.envDir))}  ./workflows/a.workflow.yaml`,
    );
    expect(output).toContain(`pruned ${path.join('envs', 'deadbeefdeadbeef')}`);
    await expect(fs.stat(staleEnvDir)).rejects.toThrow();
    await expect(
      fs.stat(path.join(scenario.envDir, 'node_modules', LOCAL_PACKAGE, 'package.json')),
    ).resolves.toBeDefined();
  }, 120_000);

  it('--no-prune keeps envs no workflow references', async () => {
    const scenario = await makeScenario('no-prune');
    const staleEnvDir = await plantStaleEnv(scenario.directory);

    await setupCommandDefinition.handler({
      'workspace-path': scenario.workspacePath,
      'install-links': false,
      concurrency: 2,
      prune: false,
    });

    expectPassed();
    expect(reported()).not.toContain('pruned');
    await expect(fs.stat(staleEnvDir)).resolves.toBeDefined();
  }, 120_000);

  it("waits for a concurrent holder of an env's setup lock before installing into it", async () => {
    const scenario = await makeScenario('waits-for-lock');
    const lockPath = setupLockPathFor(scenario.envDir);
    await fs.mkdir(scenario.envDir, { recursive: true });
    // Held by a live, correctly identified process — this one — so it is
    // waited on rather than recovered as stale.
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        pid_started_at: getProcessStartedAtMs(process.pid) ?? Date.now(),
        created_at: new Date().toISOString(),
      }),
    );

    let releasedAt = 0;
    const release = new Promise<void>((resolve) => {
      setTimeout(() => {
        releasedAt = Date.now();
        void fs.rm(lockPath, { force: true }).then(() => resolve());
      }, 500);
    });

    await setupCommandDefinition.handler({
      'workspace-path': scenario.workspacePath,
      'install-links': false,
      concurrency: 2,
      prune: true,
    });
    await release;

    expectPassed();
    expect(releasedAt).toBeGreaterThan(0);
    const packageJsonMtime = (await fs.stat(path.join(scenario.envDir, 'package.json'))).mtimeMs;
    expect(packageJsonMtime).toBeGreaterThanOrEqual(releasedAt);
    await expect(fs.stat(lockPath)).rejects.toThrow();
  }, 120_000);
});
