import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Type-level regression test for the duplicate-typebox failure mode, and the
// tripwire for the rule the fix rests on:
//
//   The SDK's generic constraints may **name** a schema field but must never
//   **compute** one.
//
// A conditional or mapped type over a type parameter — even one that looks
// unrelated to `required` — reintroduces the same cross-copy mismatch, so any
// tightening of `ObjectSchemaLike` must be re-run through this test.
//
// The mechanism, briefly: typebox's `TObject` declares
// `required: TRequiredArray<Properties>` — a COMPUTED tuple. Within one copy
// TypeScript relates two `TObject`s as instantiations of a single generic;
// across two installed copies it falls back to a structural comparison,
// evaluates the tuple on both sides, and rejects `["a", "b"]` against
// `[string]`. The SDK therefore constrains its schema generics on a local
// `ObjectSchemaLike` that NAMES fields but never COMPUTES them.
//
// The whole value of this test is that the two copies are genuinely distinct,
// so it refuses to run unless it can prove that:
//
//   * the SDK (packages/rawbox-plugin/dist) resolves plain `typebox`;
//   * the fixtures (tests/type-fixtures/) resolve `typebox-xcopy`, an npm
//     alias for a DIFFERENT typebox version, declared in this package's
//     devDependencies;
//   * a single `tsc` invocation loads both declaration trees at once.
//
// A previous attempt at this check silently degraded to a single-copy compile
// and proved nothing; hence the paranoia below. The four things asserted are
// numbered in the `describe` blocks.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');
const fixtureRoot = path.join(packageRoot, 'tests', 'type-fixtures');
const require = createRequire(import.meta.url);

/**
 * The devDependency alias that supplies the second copy. Must stay in sync
 * with packages/rawbox-plugin/package.json.
 */
const FIXTURE_TYPEBOX_ALIAS = 'typebox-xcopy';

interface TscRun {
  status: number | null;
  output: string;
  /** Diagnostic lines only — `tsc` writes them to stdout, one per error. */
  errors: string[];
}

/**
 * Walks the node_modules chain the way Node does, and returns the package
 * directory's real path plus its declared version. Deliberately hand-rolled
 * rather than `require.resolve`: typebox's `exports` map does not expose
 * `./package.json`, and what this test needs is the package ROOT, not an
 * entry point.
 */
function resolvePackage(
  name: string,
  fromDir: string,
): { dir: string; version: string } {
  let dir = path.resolve(fromDir);
  for (;;) {
    const manifest = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(manifest)) {
      const { version } = JSON.parse(fs.readFileSync(manifest, 'utf-8')) as {
        version: string;
      };
      return { dir: fs.realpathSync(path.dirname(manifest)), version };
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not resolve "${name}" from ${fromDir}. ` +
          `Run "npm install" at the workspace root — this test needs the ` +
          `"${FIXTURE_TYPEBOX_ALIAS}" devDependency of @rawbox/plugin.`,
      );
    }
    dir = parent;
  }
}

function runTsc(project: string, extraArgs: string[] = []): TscRun {
  const result = spawnSync(
    process.execPath,
    [require.resolve('typescript/bin/tsc'), '-p', project, ...extraArgs],
    { cwd: fixtureRoot, encoding: 'utf-8' },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    status: result.status,
    output,
    errors: output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /error TS\d+:/.test(line)),
  };
}

beforeAll(() => {
  // The fixtures import `@rawbox/plugin` by package name, which resolves to
  // the BUILT declaration files — the surface a real plugin author sees. The
  // sibling test tests/integration/typebox-peer-dependency.test.ts has the
  // same prerequisite.
  const builtEntry = path.join(packageRoot, 'dist', 'index.d.ts');
  if (!fs.existsSync(builtEntry)) {
    throw new Error(
      `${builtEntry} does not exist — run "npm run build:all" before the test ` +
        `suite (these fixtures typecheck against the BUILT declaration files).`,
    );
  }
});

describe('typebox cross-copy (1) — the two copies are genuinely distinct', () => {
  // Assertion 4 of the acceptance list, run first: everything below is
  // meaningless if the fixtures and the SDK share one copy of typebox.
  it('resolves a different typebox from the SDK anchor than from the fixture anchor', () => {
    const sdkCopy = resolvePackage('typebox', path.join(packageRoot, 'dist'));
    const fixtureCopy = resolvePackage(FIXTURE_TYPEBOX_ALIAS, fixtureRoot);

    expect(
      fixtureCopy.version,
      `The fixture's "${FIXTURE_TYPEBOX_ALIAS}" resolved to the same typebox ` +
        `version as the SDK (${sdkCopy.version}). This test would degrade to a ` +
        `single-copy compile and prove nothing. Repoint the alias in ` +
        `packages/rawbox-plugin/package.json at a different version.`,
    ).not.toBe(sdkCopy.version);

    // Distinct versions are not by themselves distinct declaration files —
    // distinct directories are what makes TypeScript treat the two `TObject`s
    // as unrelated types.
    expect(fixtureCopy.dir).not.toBe(sdkCopy.dir);
  });

  it('loads both typebox declaration trees into one compilation', () => {
    const listed = runTsc('tsconfig.positive.json', ['--listFilesOnly']);
    expect(listed.status, listed.output).toBe(0);

    const files = listed.output.split('\n').map((line) => line.trim());
    const sdkTypebox = files.filter((f) => /[/\\]node_modules[/\\]typebox[/\\]/.test(f));
    const fixtureTypebox = files.filter((f) =>
      new RegExp(`[/\\\\]node_modules[/\\\\]${FIXTURE_TYPEBOX_ALIAS}[/\\\\]`).test(f),
    );

    // Both present in the SAME `tsc` run: the compiler really is being asked
    // to reconcile a schema from one copy with generics from the other.
    expect(sdkTypebox.length).toBeGreaterThan(0);
    expect(fixtureTypebox.length).toBeGreaterThan(0);

    // ...and it is the built SDK doing the reconciling, not the fixtures
    // reaching into src/.
    expect(
      files.some((f) => f.endsWith(path.join('rawbox-plugin', 'dist', 'index.d.ts'))),
    ).toBe(true);
  });
});

describe('typebox cross-copy (2) — the real SDK chain compiles across copies', () => {
  // Assertions 1 and 2: the full `setupPluginRegistry` →
  // `createOperationDefinition` / `createControlFlowDefinition` chain, with
  // every schema built by the other copy, and with the inferred handler input
  // pinned exactly from both directions inside the fixtures themselves.
  it('typechecks tests/type-fixtures/positive with zero errors', () => {
    const result = runTsc('tsconfig.positive.json');

    expect(
      result.status,
      `tsc --noEmit failed on the cross-copy fixtures.\n\n` +
        `A TS2345 about 'required' means a schema generic is constrained on ` +
        `typebox's TObject again instead of ObjectSchemaLike.\n` +
        `A TS2578 ("Unused '@ts-expect-error' directive") means inference ` +
        `degraded to 'any'.\n` +
        `A TS2322/TS2339 on a valid use means it degraded to 'unknown'.\n\n` +
        result.output,
    ).toBe(0);
  });

  it('still probes the inferred input type from both directions', () => {
    // Guards the guard: the positive fixtures only prove inference is exact
    // for as long as they keep both halves of each probe. Deleting the
    // `@ts-expect-error` lines would leave a green suite that no longer
    // distinguishes an exact type from `any`.
    const probeCounts = ['echo.definition.ts', 'halt.definition.ts'].map((name) => {
      const source = fs.readFileSync(
        path.join(fixtureRoot, 'positive', name),
        'utf-8',
      );
      return {
        name,
        expectErrors: source.match(/@ts-expect-error/g)?.length ?? 0,
      };
    });

    for (const { name, expectErrors } of probeCounts) {
      // Optional / nested / array / union / absent, at minimum.
      expect(expectErrors, `${name} lost its negative probes`).toBeGreaterThanOrEqual(5);
    }
  });
});

describe('typebox cross-copy (3) — the counterfactual still fails', () => {
  // Assertion 3: without this, the suite above would pass vacuously the day
  // the two copies deduped or typebox stopped computing `required`.
  it('rejects a TObject-constrained mimic with the required-tuple error', () => {
    const result = runTsc('tsconfig.counterfactual.json');

    expect(
      result.status,
      `The strict TObject mimic COMPILED. Either the two typebox copies have ` +
        `deduped, or typebox no longer computes 'required' — in both cases the ` +
        `positive fixtures are no longer testing anything cross-copy.\n${result.output}`,
    ).not.toBe(0);

    // The specific diagnostic, not merely a non-zero exit: this is the exact
    // error a plugin author used to get — a message naming neither typebox nor
    // versions, which is what made the failure so hard to place.
    expect(result.output).toContain('error TS2345');
    expect(result.output).toContain("Types of property 'required' are incompatible");
    expect(result.output).toContain(`Type '["a", "b"]' is not assignable to type '[string]'`);

    // Exactly one error, on the `strict()` call. The `loose()` call in the
    // same file uses the SHIPPED `ObjectSchemaLike` constraint on the SAME
    // schema and must stay clean — that contrast is what attributes the
    // failure to the constraint rather than to the fixture.
    expect(result.errors, result.output).toHaveLength(1);
    expect(result.errors[0]).toMatch(/counterfactual[/\\]strict-tobject\.ts/);
  });
});
