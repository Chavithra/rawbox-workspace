// ---------------------------------------------------------------------------
// Release preflight: does this tag describe what is actually in the tree?
//
// Run from the repo root with the tag being released:
//
//   node scripts/check-release-version.mjs v0.0.2
//
// Exits 0 when every publishable package carries that exact version, and
// non-zero — with a message naming each offender — otherwise.
//
// ## Why a tag can disagree with the tree at all
//
// The tag is a label a human types; the versions are committed files. Nothing
// in git relates them, so `git tag v0.0.2` on a tree whose manifests still say
// `0.0.1` is an ordinary mistake with an expensive outcome: the release
// pipeline publishes `0.0.1` again (or fails halfway through, having already
// published some packages), and the tag now points at something that was never
// released under that name.
//
// This check makes that state unrepresentable rather than merely unlikely, and
// it runs BEFORE the build so a mismatch costs seconds instead of a partial
// publish.
//
// ## Why lockstep versions
//
// The five packages are one product with one changelog, and they depend on
// each other by caret range (`@rawbox/cli` depends on `@rawbox/runner`, which
// depends on `@rawbox/store`). Independent versions are legal in npm and would
// be defensible for libraries released on their own schedules; these are not.
// Requiring them equal means the tag names a coherent set, and a consumer who
// installs one package at version X can reason about the others.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';

const PACKAGES_DIR = 'packages';

/** The scope whose dependencies are this monorepo's own packages. */
const INTERNAL_SCOPE = '@rawbox/';

/**
 * Every internal dependency range that the version being released does not
 * satisfy.
 *
 * **This is the check that catches a broken release rather than a mislabelled
 * one.** The ranges are `^0.0.1` today, and under semver a caret on a `0.0.x`
 * version matches that version and nothing else — `^0.0.1` does not admit
 * `0.0.2`. So releasing `v0.0.2` while the ranges still say `^0.0.1` publishes
 * a new `@rawbox/cli` that depends on the *previous* `@rawbox/runner`. Every
 * package installs, every version number looks right, and the consumer gets a
 * combination that was never built or tested together.
 *
 * Nothing else would notice: the monorepo resolves siblings through workspace
 * symlinks, so the in-repo build and the whole test suite exercise the new
 * code regardless of what the ranges say. Only an install from a registry
 * would show it, and by then the version is published and immutable.
 */
function collectInternalRangeProblems(manifestList, version) {
  const problemList = [];

  for (const { manifestPath, manifest } of manifestList) {
    for (const field of ['dependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!name.startsWith(INTERNAL_SCOPE)) {
          continue;
        }
        if (!semver.satisfies(version, range)) {
          problemList.push(
            `  ${manifest.name} depends on ${name}@${range}, which does not ` +
              `admit ${version} (${manifestPath}, ${field})`,
          );
        }
      }
    }
  }

  return problemList;
}

/** `v0.0.2` and `0.0.2` are both accepted; git tags conventionally carry the `v`. */
function versionFromTag(tag) {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}

/**
 * Every publishable package's manifest.
 *
 * Read off the directory rather than a hand-kept list: a sixth package added
 * later is included the day it exists, and a list that has to be remembered is
 * a list that will be forgotten at exactly the wrong moment. `private: true`
 * packages are skipped — npm will not publish them, so requiring their version
 * to match would fail a release for a package no consumer can see.
 */
function readPublishableManifests() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PACKAGES_DIR, entry.name, 'package.json'))
    .map((manifestPath) => ({
      manifestPath,
      manifest: JSON.parse(readFileSync(manifestPath, 'utf-8')),
    }))
    .filter(({ manifest }) => manifest.private !== true);
}

const tag = process.argv[2];

if (tag === undefined || tag.length === 0) {
  console.error(
    'usage: node scripts/check-release-version.mjs <tag>\n' +
      '  e.g. node scripts/check-release-version.mjs v0.0.2',
  );
  process.exit(2);
}

const expected = versionFromTag(tag);
const manifestList = readPublishableManifests();

if (manifestList.length === 0) {
  console.error(`No publishable package found under ${PACKAGES_DIR}/.`);
  process.exit(2);
}

const mismatchList = manifestList.filter(
  ({ manifest }) => manifest.version !== expected,
);

if (mismatchList.length > 0) {
  console.error(
    `Tag ${tag} does not match the versions in the tree.\n` +
      `  Expected every package to be at ${expected}, from the tag.\n`,
  );
  for (const { manifestPath, manifest } of mismatchList) {
    console.error(`  ${manifest.name} is ${manifest.version} (${manifestPath})`);
  }
  console.error(
    `\n  Nothing has been published. Either retag to match the tree, or set\n` +
      `  every package to ${expected}, commit, and move the tag onto that commit.`,
  );
  process.exit(1);
}

const rangeProblemList = collectInternalRangeProblems(manifestList, expected);

if (rangeProblemList.length > 0) {
  console.error(
    `Tag ${tag} would publish packages that depend on a different release.\n` +
      `  Each package is at ${expected}, but these ranges do not admit it:\n`,
  );
  for (const problem of rangeProblemList) {
    console.error(problem);
  }
  console.error(
    `\n  Nothing has been published. Bump the internal ranges to ^${expected}\n` +
      `  alongside the versions — a caret on a 0.0.x version matches that exact\n` +
      `  version only, so these must move together on every 0.0.x release.`,
  );
  process.exit(1);
}

console.log(
  `Tag ${tag}: all ${manifestList.length} publishable packages are at ${expected}, ` +
    `and every internal dependency range admits it.`,
);
for (const { manifest } of manifestList) {
  console.log(`  ${manifest.name}@${manifest.version}`);
}
