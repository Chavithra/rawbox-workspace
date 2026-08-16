import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverWorkspace } from '../src/workspace/discovery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'sandbox', 'discovery-test');

// ---------------------------------------------------------------------------
// Every scenario gets its own subtree so that one scenario's upward walk can
// never reach another's fixture files — the same isolation strategy
// `verify.test.ts` uses for the CLI-level coverage of this same behaviour.
//
// `discoverWorkspace` takes the *workflow document's* path (not merely its
// directory), because the ambiguity tie-break needs it to check
// `workflowPathList` membership. Most scenarios below never exercise the
// tie-break (their workspace documents declare an empty list, or there is
// only one candidate to begin with), so the workflow file itself need not
// exist on disk — only its path, for resolution purposes.
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
});

afterAll(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

function workspaceYaml(name: string): string {
  return `kind: Workspace\nname: ${name}\nworkflowPathList: []\n`;
}

/** A `kind: Workspace` document whose `workflowPathList` is given explicitly. */
function workspaceYamlListing(name: string, workflowPathList: string[]): string {
  return `kind: Workspace\nname: ${name}\nworkflowPathList: ${JSON.stringify(workflowPathList)}\n`;
}

describe('discoverWorkspace', () => {
  it('finds a `kind: Workspace` document one level above the workflow directory', async () => {
    const directory = path.join(rootDir, 'found');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(workspacePath, workspaceYaml('found-ws'), 'utf-8');
    const workflowFile = path.join(workflowDir, 'workflow.yaml');

    const result = await discoverWorkspace(workflowFile);

    expect(result.file).toBe(workspacePath);
    expect(result.ambiguousList).toBeUndefined();
    expect(result.searchedList).toContain(directory);
  });

  it('matches on `kind: Workspace` and nothing else — a sibling `kind: Workflow` document is not a candidate', async () => {
    const directory = path.join(rootDir, 'found-sibling');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    const workspacePath = path.join(directory, 'workspace.yaml');
    await fs.writeFile(workspacePath, workspaceYaml('found-sibling-ws'), 'utf-8');
    // Sits in the very directory being inspected, and shares the extension —
    // it must be skipped by `kind`, not merely by name.
    await fs.writeFile(
      path.join(workflowDir, 'other.yaml'),
      'kind: Workflow\nformatVersion: "1.0"\nname: other\nplugins: {}\nstorage: {}\nsteps: []\n',
      'utf-8',
    );
    const workflowFile = path.join(workflowDir, 'workflow.yaml');

    const result = await discoverWorkspace(workflowFile);

    expect(result.file).toBe(workspacePath);
  });

  it('reports every searched directory and no file when none exists', async () => {
    const directory = path.join(rootDir, 'none-found', 'a', 'b', 'workflows');
    await fs.mkdir(directory, { recursive: true });
    const workflowFile = path.join(directory, 'workflow.yaml');

    const result = await discoverWorkspace(workflowFile);

    expect(result.file).toBeUndefined();
    expect(result.ambiguousList).toBeUndefined();
    expect(result.searchedList).toContain(directory);
    expect(result.searchedList.length).toBeGreaterThan(1);
  });

  it('reports ambiguity — not a guess — when one directory holds two workspace documents and neither lists the workflow', async () => {
    const directory = path.join(rootDir, 'ambiguous');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    const first = path.join(directory, 'workspace.yaml');
    const second = path.join(directory, 'workspace-staging.yaml');
    await fs.writeFile(first, workspaceYaml('ambiguous-a'), 'utf-8');
    await fs.writeFile(second, workspaceYaml('ambiguous-b'), 'utf-8');
    const workflowFile = path.join(workflowDir, 'workflow.yaml');

    const result = await discoverWorkspace(workflowFile);

    expect(result.file).toBeUndefined();
    expect(result.ambiguousList).toEqual([first, second].sort());
  });

  it('prefers the one candidate whose `workflowPathList` lists the workflow being operated on', async () => {
    const directory = path.join(rootDir, 'tie-break-single-listing');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    const workflowFile = path.join(workflowDir, 'workflow.yaml');
    await fs.writeFile(
      workflowFile,
      'kind: Workflow\nformatVersion: "1.0"\nname: w\nplugins: {}\nstorage: {}\nsteps: []\n',
      'utf-8',
    );

    const relativeWorkflowPath = path.relative(directory, workflowFile);
    const listing = path.join(directory, 'workspace-listing.yaml');
    const notListing = path.join(directory, 'workspace-other.yaml');
    await fs.writeFile(
      listing,
      workspaceYamlListing('listing-ws', [relativeWorkflowPath]),
      'utf-8',
    );
    await fs.writeFile(notListing, workspaceYaml('other-ws'), 'utf-8');

    const result = await discoverWorkspace(workflowFile);

    expect(result.file).toBe(listing);
    expect(result.ambiguousList).toBeUndefined();
  });

  it('stays ambiguous when several candidates all list the workflow being operated on', async () => {
    const directory = path.join(rootDir, 'tie-break-multiple-listing');
    const workflowDir = path.join(directory, 'workflows');
    await fs.mkdir(workflowDir, { recursive: true });
    const workflowFile = path.join(workflowDir, 'workflow.yaml');
    await fs.writeFile(
      workflowFile,
      'kind: Workflow\nformatVersion: "1.0"\nname: w\nplugins: {}\nstorage: {}\nsteps: []\n',
      'utf-8',
    );

    const relativeWorkflowPath = path.relative(directory, workflowFile);
    const first = path.join(directory, 'workspace-a.yaml');
    const second = path.join(directory, 'workspace-b.yaml');
    await fs.writeFile(
      first,
      workspaceYamlListing('multi-listing-a', [relativeWorkflowPath]),
      'utf-8',
    );
    await fs.writeFile(
      second,
      workspaceYamlListing('multi-listing-b', [relativeWorkflowPath]),
      'utf-8',
    );

    const result = await discoverWorkspace(workflowFile);

    expect(result.file).toBeUndefined();
    expect(result.ambiguousList).toEqual([first, second].sort());
  });

  it('bounds the upward walk — a workspace document past the depth limit is never found', async () => {
    // The walk climbs at most 8 ancestor directories before falling back to
    // `process.cwd()`. Ten nested `far/` segments puts the workspace document
    // two levels beyond that bound, and `process.cwd()` (the repo checkout)
    // holds no `kind: Workspace` document either, so discovery must come back
    // empty rather than eventually climbing far enough to find it.
    const directory = path.join(rootDir, 'depth-bound');
    const segments = Array.from({ length: 10 }, (_, index) => `far${index}`);
    const deepDir = path.join(directory, ...segments);
    await fs.mkdir(deepDir, { recursive: true });
    // Placed at the root of this scenario's subtree — outside the bounded
    // walk's reach from `deepDir`.
    await fs.writeFile(
      path.join(directory, 'workspace.yaml'),
      workspaceYaml('too-far'),
      'utf-8',
    );
    const workflowFile = path.join(deepDir, 'workflow.yaml');

    const result = await discoverWorkspace(workflowFile);

    expect(result.file).toBeUndefined();
    expect(result.ambiguousList).toBeUndefined();
    // Exactly 8 bounded directories, plus the final `process.cwd()` fallback
    // inspection (deduped only if cwd happens to already be in the list).
    expect(result.searchedList.length).toBeGreaterThanOrEqual(8);
    expect(result.searchedList).not.toContain(directory);
  });

  it('falls back to `process.cwd()` when the bounded walk finds nothing', async () => {
    // A fresh, unrelated directory stands in for the process's cwd, via
    // `chdir` — never the real repo checkout — so the assertion cannot be
    // confused by, or corrupt, an actual file in this package's directory.
    const cwdStandIn = path.join(rootDir, 'cwd-fallback', 'cwd');
    const workflowDir = path.join(rootDir, 'cwd-fallback', 'unrelated', 'workflows');
    await fs.mkdir(cwdStandIn, { recursive: true });
    await fs.mkdir(workflowDir, { recursive: true });
    const cwdWorkspace = path.join(cwdStandIn, 'workspace.yaml');
    await fs.writeFile(cwdWorkspace, workspaceYaml('cwd-ws'), 'utf-8');
    const workflowFile = path.join(workflowDir, 'workflow.yaml');

    const originalCwd = process.cwd();
    process.chdir(cwdStandIn);
    try {
      const result = await discoverWorkspace(workflowFile);
      expect(result.file).toBe(cwdWorkspace);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
