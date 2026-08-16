import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// The packaging half of the passthrough-subpath contract.
//
// `@rawbox/plugin` re-exports `typebox` and `neverthrow` at `./typebox` and
// `./neverthrow` so a plugin package can declare neither and still write
// contracts and return `Result`s. That arrangement has a manifest precondition
// which is invisible to every other test in this suite: a library can only be
// re-exported from a package that actually *depends* on it. Under
// `peerDependencies` the re-export would resolve in this monorepo (where the
// library is hoisted) and fail for anyone installing the published tarball,
// which is the worst possible split between where it works and where it matters.
//
// This test therefore pins the inverse of what it used to. It previously
// asserted `typebox` was a peer and never a dependency; that rule existed to
// stop the SDK shipping a second copy into a plugin's tree, and it was made
// obsolete by `ObjectSchemaLike` — two copies are now provably fine, which is
// what `tests/integration/typebox-cross-copy.test.ts` demonstrates by compiling
// against a genuinely different copy.
//
// Cheap and synchronous on purpose: it reads a manifest and asserts nothing
// about npm's dedup behaviour, so it cannot pass by accident the way a
// version-oblivious resolution test can.
// ---------------------------------------------------------------------------

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(
    await fs.readFile(path.join(packageRoot, 'package.json'), 'utf-8'),
  ) as Manifest;
}

describe('rawbox-plugin package.json — the passthrough subpaths are installable', () => {
  it('depends on the libraries it re-exports, rather than peer-depending on them', async () => {
    const pjson = await readManifest();

    // The precondition for `export * from 'typebox'` to resolve in a consumer's
    // install. A peer here would make the subpath a monorepo-only illusion.
    expect(pjson.dependencies ?? {}).toHaveProperty('typebox');
    expect(pjson.dependencies ?? {}).toHaveProperty('neverthrow');

    // Nothing is left peer-depending on typebox: a plugin no longer supplies it,
    // so requiring one to would break every scaffold the CLI now emits.
    expect(pjson.peerDependencies ?? {}).not.toHaveProperty('typebox');

    // Redundant once it is a real dependency, and actively misleading — it would
    // suggest the package builds against a copy it does not ship.
    expect(pjson.devDependencies ?? {}).not.toHaveProperty('typebox');
  });

  it('exposes both passthrough subpaths under exports', async () => {
    const pjson = await readManifest();
    const pkgExports = pjson.exports ?? {};

    // Without these entries Node's exports encapsulation blocks the import
    // outright, and a plugin written against the documented specifier fails at
    // its first line with ERR_PACKAGE_PATH_NOT_EXPORTED.
    expect(pkgExports).toHaveProperty('./typebox');
    expect(pkgExports).toHaveProperty('./neverthrow');
  });

  it('keeps the typebox second-copy fixture, which is not the same dependency', async () => {
    const pjson = await readManifest();

    // `typebox-xcopy` is an alias for a *different* typebox version, and it is
    // what makes `typebox-cross-copy.test.ts` prove anything at all. Losing it
    // while tidying dependencies would leave that test silently compiling one
    // copy against itself.
    expect(pjson.devDependencies ?? {}).toHaveProperty('typebox-xcopy');
  });
});
