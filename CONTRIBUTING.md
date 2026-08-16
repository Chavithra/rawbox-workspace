# Contributing

This guide covers working *on* Rawbox from a clone of this monorepo — building it,
iterating against it, testing what a consumer will get, and the conventions changes are
held to. For *using* Rawbox, start from the [README](README.md).

## 1. Build the clone

```bash
git clone https://github.com/chavithra/rawbox-workspace.git
cd rawbox-workspace
npm install
npm run build:all   # tsc --build across every package, then the CLI's own build
                    # (which also copies its scaffolding templates into dist/)
```

`npm install` at the root wires the five packages together: npm workspaces hoists each
into the root `node_modules/` as a **symlink to its source directory**. That one fact
powers the whole development loop — a package you rebuild is picked up by the next run
with no reinstall, because nothing was ever copied.

The `rawbox-cli` binary is available anywhere inside the repo via `npx rawbox-cli`.

## 2. The in-clone loop

Scaffold and run entirely inside the clone:

```bash
npx rawbox-cli workspace create --name my-workspace
npx rawbox-cli run workspaces/my-workspace/workflows/example.workflow.yaml
```

The generated workflow declares the published range (`"@rawbox/rawbox-plugin-default":
"^0.1.0"`), yet no registry is ever contacted here: plugin resolution walks up from the
workspace directory into the repo root's hoisted symlinks, finds the sibling packages,
and auto-setup installs nothing. The edit loop is therefore:

```bash
# edit packages/rawbox-plugin-default/src/…
npm run build:all
npx rawbox-cli run workspaces/my-workspace/workflows/example.workflow.yaml
```

No `workspace setup`, no reinstall — the links are live. (If you changed the CLI's
scaffolding *templates*, run `npm run build --workspace @rawbox/cli`; only that
package's own build copies them into `dist/`.)

## 3. Verification

A change is done when, from the repo root:

```bash
npm run build:all && npm run lint && npm run test:all
```

passes clean. `build:all` typechecks every package's `src` **and** its `tests` — all five
test projects are in the `tsc --build` graph, so a type error in a test file fails the
build. Tests land with the code, never in a trailing task.

> [!NOTE]
> **The CLI suite is not idempotent.** It leaves `packages/rawbox-cli/tests/temp-store-watch-test/`
> behind, and a second run trips on the leftover directory with ~8 failures that have
> nothing to do with your change. Remove it between runs:
>
> ```bash
> rm -rf packages/rawbox-cli/tests/temp-store-watch-test
> ```
>
> Worth fixing at the source (the test should clean up in an `afterAll`), but until then
> a red second run is not evidence of a regression — re-run from clean before believing it.

## 4. Testing what a consumer gets

The in-clone loop never exercises real installs, so before a release rehearse the
published flow against a local registry such as [Verdaccio](https://verdaccio.org/):

```bash
npx verdaccio &                          # default: http://localhost:4873

# publish the five packages to it (bump or unpublish first on a re-run)
for p in rawbox-plugin rawbox-store rawbox-runner rawbox-cli rawbox-plugin-default; do
  npm publish ./packages/$p --registry http://localhost:4873
done

# consume them the way a user would, in a scratch directory
echo "@rawbox:registry=http://localhost:4873" > .npmrc
npm install @rawbox/cli
npx rawbox-cli project create --name consumer-check --registry http://localhost:4873
```

`project create` / `workspace create` `--registry <url>` writes that scoped `.npmrc`
into the scaffold, and `workspace setup` propagates it into the workspace's target
folder, so every install rawbox performs honours it. Scoped config keeps third-party
packages coming from npmjs.

**Registry hygiene:** the packages, the internal ranges, and the scaffold templates'
ranges all move in lockstep — publishing a new version means bumping all three in one
change, and `scripts/check-release-version.mjs` fails the release if they disagree.

From `0.1.0` a caret range means what it appears to mean (`^0.1.0` is `>=0.1.0 <0.2.0`),
so a patch release is picked up by existing documents without editing them. That was
**not** true on `0.0.x`, where a caret admits exactly one version (`^0.0.1` is
`>=0.0.1 <0.0.2`) and every release stranded every workflow written against the previous
one — which is why the set moved off `0.0.x` before any third-party plugin was published
against it.

When republishing over a dev registry, check `npm view <pkg> versions` first: unpublishing
one version can leave stale older versions behind, and a consumer install will happily
resolve an ancient artifact that satisfies the range.

> [!WARNING]
> **Clean `dist/` before publishing after a rename.** `tsc` does not prune `dist/`; it
> writes current outputs and leaves whatever is already there. With `"files": ["dist"]`,
> a package ever built under a different file layout ships **both**. Renaming
> `control-flow/definitions/branch.definition.ts` to `control-flow/branch.definition.ts`
> and publishing produced a tarball carrying both paths. The stale file is inert — the
> contract registry names only the new key — but it ships, and anything resolving the old
> path finds a real module and fails later at contract lookup rather than at import,
> which reads as a far stranger bug. Nothing warns about it:
>
> ```bash
> rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo && npm run build:all
> # then prove it, don't assume:
> curl -s <registry>/@rawbox/rawbox-plugin-default/-/rawbox-plugin-default-0.1.0.tgz \
>   | tar tzf - | grep definitions      # must print nothing
> ```

> [!WARNING]
> **Republishing a version in place invalidates consumers' locks.** Unpublish + publish at
> the same version changes the tarball's integrity hash, and any project whose
> `package-lock.json` pins the old one fails with `EINTEGRITY` — the lock's `resolved` URL
> still matches, so npm never re-resolves; it downloads, checksums, and rejects. Bumping
> the version avoids this. If you republish in place anyway, each consumer needs its stale
> entries dropped:
>
> ```bash
> node -e 'const fs=require("fs");const l=JSON.parse(fs.readFileSync("package-lock.json","utf8"));
> for (const k of Object.keys(l.packages||{})) if (k.includes("node_modules/@rawbox/")) delete l.packages[k];
> fs.writeFileSync("package-lock.json", JSON.stringify(l,null,2)+"\n")'
> npm install --prefer-online
> ```
>
> A workspace's `.rawbox/` target folder holds its own install; re-run
> `rawbox-cli workspace setup <workspace file>` afterwards.

## 5. Consuming the clone from an external project

To build a rawbox-project against *unpublished* framework changes, prefer `file:`
dependencies pointing at the clone — npm installs a `file:` directory as a link, and
unlike `npm link` the entry lives in `package.json`, so it survives every future
`npm install`:

```jsonc
"dependencies": {
  "@rawbox/plugin": "file:../rawbox-workspace/packages/rawbox-plugin"
}
```

Workflow `plugins:` specifiers compose the same way (relative `file:` resolves against
the workspace directory). `npm link` also works for quick experiments — but any later
`npm install` re-resolves from the registry and silently replaces the links, so the
discipline is: install first, link second, re-link after every install.

Two sharp edges to know:

- **`workspace setup --install-links` cannot work for the clone's plugins** — it copies
  instead of linking, forcing npm to resolve the plugin's `@rawbox/plugin` peer from a
  registry that may not have it. Link (the default), or use the "Testing what a consumer gets" rehearsal.
- **"Works in the clone" does not prove "works anywhere else."** Plugin resolution's
  bare-specifier fallback resolves a plugin as a sibling of `@rawbox/runner` itself, so
  inside this repo a plugin the workspace never installed still resolves. The "Testing what a consumer gets"
  rehearsal is the check that catches this class of mistake.

## 6. Locks and contract hashes during development

`rawbox.lock` pins each plugin's contract-registry hash, enforced on the execution
path, and every rebuild that changes a contract changes the hash. So: don't lock while
iterating on contracts (an absent lock means "resolve whatever is installed" — the
development posture); lock at stopping points — before sharing a workspace, in CI, at
release. When resolution surprises you, `plugin info <workflow>` is the first
diagnostic: it reports each package's specifier, resolved version, install status, and
hash-vs-lock agreement.

## 7. Error messages

Error messages are a feature here, not polish. These files are authored by people and
agents iterating against `workflow verify`, so a diagnostic should name the field that is
wrong, list the values that would be right, and state the next action. Existing tests
assert on message content; when you change wording, assert on the *facts* a message must
carry rather than its exact sentence.

## 8. The skill files

`.agents/skills/<name>/SKILL.md` and `packages/rawbox-cli/src/templates/skills/<name>/SKILL.md`
are separate files that must stay byte-identical — the first is what this repo's agents
load, the second is what gets scaffolded into a generated project. `skill-examples.test.ts`
enforces that for the workflow-creation skill, and also extracts its fenced YAML and runs
the real `workflow verify` over it, so any example you add there has to actually validate.

## 9. Running work across parallel agents

Most of the workflow-format work was executed by agents working concurrently in separate
git worktrees. It worked, but the same three failures recurred often enough to be worth
writing down.

**Commit on your branch before you finish.** This went wrong three times: Wave 1 agents
left everything uncommitted so the integration merges brought in nothing; a first attempt
at Wave 2 abandoned ~760 lines in worktrees, recovered only because someone diffed them
before pruning; Wave 3 repeated it with ~1,470 lines. An uncommitted worktree is
indistinguishable from an agent that did nothing. Treat committing as part of the task.

**Check what your worktree is cut from.** Worktrees are created from the default branch,
which is usually behind. Run `git log --oneline -1` first, merge the integration branch if
you are not a descendant of it, then re-run `npm install`. Every agent in two separate
waves came up on the same stale commit — assume it rather than hoping.

**Give each task exclusive file ownership.** Non-overlapping paths are what make concurrent
work safe. If a task appears to need a file another task owns, that is a decomposition bug
worth reporting, not something to work around. Barrel files (`src/index.ts`) are the usual
conflict hotspot; wire them up front against stubs so no other task has to touch them.

**Verify an agent's claims, do not merge them.** Reports have been wrong in both
directions — a stated benefit that did not materialise, and a caveat that turned out not to
apply. The cheap checks that repeatedly paid off:

- **Mutation-test the acceptance case.** Remove the fix, confirm the new test fails, put it
  back. Several tests that looked like proof passed for the wrong reason — usually because
  a fixture resolved through this monorepo's hoisted `node_modules` regardless of the code
  under test.
- **Read the real output.** Run the failing command and look at what a user would see.
  Inconsistent hint text and a swallowed npm error both survived greps and were only found
  this way.
- **Check what a sweep changed, not just that it passes.** One correct fix arrived bundled
  with a rename that made every affected message less useful.
