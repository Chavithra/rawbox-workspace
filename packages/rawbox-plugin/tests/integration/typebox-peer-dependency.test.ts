import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Regression test for the real incident this fix addresses: a plugin whose
// own `typebox` resolved to a *different version* than the one `@rawbox/plugin`
// was built against failed to typecheck with a message that never mentions
// typebox — "Type 'undefined' is not assignable to type '[string]'" for a
// zero-property schema, "'[\"a\",\"b\"]' is not assignable to '[string]'" for a
// two-property one. See packages/rawbox-plugin/README.md, "Why typebox is a
// peer dependency of @rawbox/plugin", for the mechanism.
//
// This builds a real, standalone consumer of the *published shape* of
// `@rawbox/plugin` — `npm pack` the real tarball rather than a `file:` symlink
// to source, so module resolution behaves exactly as it would for an external
// plugin, not as a monorepo-internal shortcut — pins its own `typebox` to a
// version genuinely different from the one this repo otherwise uses (1.3.11
// vs. the framework's 1.3.9), and asserts `tsc --noEmit` succeeds against the
// BUILT `.d.ts` for both a zero-required-property schema and a
// multi-required-property one.
//
// WHAT THIS TEST DEFENDS *NOW*, which is not what its name suggests.
//
// The file name is historical. `typebox` is no longer a peer dependency of
// `@rawbox/plugin` at all — it is a regular dependency, because the SDK
// re-exports it at `@rawbox/plugin/typebox` and a library cannot be re-exported
// from a package that does not depend on it. So the published tarball DOES now
// carry its own `typebox`, and the fixture below installs a second one at a
// different version (1.3.11 vs. the framework's 1.3.9).
//
// That this still compiles is the point. Two copies coexisting is fine because
// the SDK's generics constrain on its own `ObjectSchemaLike` rather than
// typebox's `TObject` — and this test proves it holds across a real `npm pack`
// install, where the second copy is genuinely a separate installed package
// rather than a path alias. `typebox-cross-copy.test.ts` proves the same
// property at the type level, against declaration files in one compile.
//
// So what is uniquely covered here is the *packaging* half: the published
// `.d.ts` must be consumable by an external plugin that brings its own typebox
// at a version we never tested against — which remains legal, and remains the
// shape of any plugin that predates the passthrough subpath or prefers its own
// copy. It is an `npm pack` / module-resolution test wearing a typebox costume.
// Keep both; they fail for different reasons.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');
const distDir = path.join(packageRoot, 'dist');

/** Deliberately not the framework's own typebox version (1.3.9). */
const FIXTURE_TYPEBOX_VERSION = '1.3.11';

let fixtureDir: string;
let tarballPath: string;

function run(
  command: string,
  args: string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { cwd, encoding: 'utf-8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

beforeAll(async () => {
  // The whole point is to typecheck against the BUILT declaration files, not
  // the source — a mismatch that only exists once `TObject`'s generic default
  // has gone through a real `tsc` build is exactly what this guards against.
  const builtEntry = path.join(distDir, 'index.d.ts');
  try {
    await fs.access(builtEntry);
  } catch {
    throw new Error(
      `${builtEntry} does not exist — run "npm run build:all" before the test suite ` +
        `(this fixture typechecks against the BUILT declaration files, not src/).`,
    );
  }

  fixtureDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'rawbox-plugin-typebox-peer-dep-'),
  );

  // A real tarball, not a `file:` link to source: an external plugin installs
  // the *published* package, and only a packed install resolves dependencies
  // and peers the way npm actually would (a `file:` link to a directory is
  // just symlinked, per packages/rawbox-runner/src/tool/setup-workspace.ts's
  // own note on `--install-links`, and would sidestep the very resolution
  // this test means to exercise).
  const packResult = run(
    'npm',
    ['pack', '--json', '--pack-destination', fixtureDir],
    packageRoot,
  );
  expect(packResult.status, packResult.stderr).toBe(0);
  const [packed] = JSON.parse(packResult.stdout) as Array<{ filename: string }>;
  if (!packed) throw new Error(`"npm pack" produced no output: ${packResult.stdout}`);
  tarballPath = path.join(fixtureDir, packed.filename);

  await fs.writeFile(
    path.join(fixtureDir, 'package.json'),
    JSON.stringify(
      {
        name: 'typebox-peer-dependency-fixture',
        private: true,
        type: 'module',
        dependencies: {
          '@rawbox/plugin': `file:${tarballPath}`,
          neverthrow: '^8.2.0',
          // Genuinely different from the framework's own 1.3.9 — the fixture
          // is free to pick any typebox it wants, which is the whole point.
          typebox: FIXTURE_TYPEBOX_VERSION,
        },
        devDependencies: {
          typescript: '^6.0.3',
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  await fs.writeFile(
    path.join(fixtureDir, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          module: 'nodenext',
          moduleResolution: 'nodenext',
          target: 'esnext',
          strict: true,
          noEmit: true,
          skipLibCheck: true,
        },
        include: ['fixture.ts'],
      },
      null,
      2,
    ),
    'utf-8',
  );

  // The two shapes named in the incident: a schema with no required
  // properties at all, and one with more than one. Both must be assignable
  // to `@rawbox/plugin`'s `OperationContract<TObject, TObject, TObject>`.
  await fs.writeFile(
    path.join(fixtureDir, 'fixture.ts'),
    `
import { Type } from 'typebox';
import { setupPluginRegistry } from '@rawbox/plugin';

const operationsRecord = {
  './zero-required.definition.js': {
    type: 'operation',
    description: 'A schema with zero required properties',
    inputSchema: Type.Object({}),
    outputSchema: Type.Object({}),
    errorSchema: Type.Object({ message: Type.String() }),
    version: '1.0.0',
  },
  './multi-required.definition.js': {
    type: 'operation',
    description: 'A schema with more than one required property',
    inputSchema: Type.Object({
      a: Type.String(),
      b: Type.String(),
    }),
    outputSchema: Type.Object({
      c: Type.String(),
      d: Type.String(),
    }),
    errorSchema: Type.Object({ message: Type.String() }),
    version: '1.0.0',
  },
} as const;

export const { contractRegistry } = setupPluginRegistry({ operationsRecord });
export default contractRegistry;
`.trimStart(),
    'utf-8',
  );

  const installResult = run('npm', ['install', '--no-audit', '--no-fund'], fixtureDir);
  expect(
    installResult.status,
    `npm install failed in fixture:\n${installResult.stdout}\n${installResult.stderr}`,
  ).toBe(0);
}, 180_000);

afterAll(async () => {
  if (fixtureDir) {
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('typebox peer dependency — external plugin with its own typebox version', () => {
  it(
    'typechecks a zero-required-property schema and a multi-required-property schema ' +
      'against the BUILT @rawbox/plugin declaration files',
    () => {
      const tscBin = path.join(
        fixtureDir,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
      );
      const result = run(tscBin, ['--noEmit'], fixtureDir);

      expect(result.status, `tsc --noEmit failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    },
    60_000,
  );

  it('confirms the fixture really installed its own, different typebox version', async () => {
    const installedPjson = JSON.parse(
      await fs.readFile(
        path.join(fixtureDir, 'node_modules', 'typebox', 'package.json'),
        'utf-8',
      ),
    ) as { version: string };

    // Guards the test itself: if this ever matched the framework's own
    // version the assertion above would prove nothing about version skew.
    expect(installedPjson.version).toBe(FIXTURE_TYPEBOX_VERSION);
  });
});
