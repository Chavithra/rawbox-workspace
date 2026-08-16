import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateWorkspaceIdentifier } from '../src/store/name-validate.js';
import { resolveStoreTarget } from '../src/store/target.js';

// ---------------------------------------------------------------------------
// The traversal hazard rawbox-store/README.md, "Observation — `peek` is not `get`" flags and defers to its
// callers: `resolveEnvFolderUrl(rootDirectoryUrl, envIdentifier)` builds
// `new URL('./' + envIdentifier + '/', rootDirectoryUrl)`, which resolves
// `..` and `/` exactly like a filesystem path. `rawbox-cli` is the boundary
// that must reject an unsafe identifier before it ever reaches that call —
// both as a raw CLI argument and as a `workspace.name` read out of a
// document.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, 'temp-store-target-test');

beforeEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  await fs.mkdir(rootDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('validateWorkspaceIdentifier', () => {
  it('accepts an ordinary name', () => {
    expect(validateWorkspaceIdentifier('live-trading')).toBeUndefined();
  });

  it('rejects a name containing a path separator', () => {
    expect(validateWorkspaceIdentifier('a/b')).toContain('path separator');
    expect(validateWorkspaceIdentifier('a\\b')).toContain('path separator');
  });

  it('rejects a name containing ..', () => {
    expect(validateWorkspaceIdentifier('..')).toContain('..');
    expect(validateWorkspaceIdentifier('foo..bar')).toContain('..');
  });

  it('rejects an empty name', () => {
    expect(validateWorkspaceIdentifier('   ')).toBeDefined();
  });
});

describe('resolveStoreTarget: traversal rejection from argv', () => {
  it('rejects "../x" — neither an existing path here nor a safe raw name', async () => {
    const result = await resolveStoreTarget('../x', rootDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatch(/path separator/);
  });

  it('rejects "a/b"', async () => {
    const result = await resolveStoreTarget('a/b', rootDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatch(/path separator/);
  });

  it('rejects a bare ".." as a name', async () => {
    const result = await resolveStoreTarget('..', rootDir);
    expect(result.isErr()).toBe(true);
  });

  it('rejects a workspace document that itself declares an unsafe name', async () => {
    const wsPath = path.join(rootDir, 'workspace.yaml');
    await fs.writeFile(
      wsPath,
      'kind: Workspace\nname: "../escaped"\nworkflowPathList: []\n',
      'utf-8',
    );

    const result = await resolveStoreTarget(wsPath, rootDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('unsafe name');
  });
});

describe('resolveStoreTarget: path vs raw-name routing', () => {
  it('resolves a workspace document path to its target folder and declared name', async () => {
    const wsDir = path.join(rootDir, 'ws1');
    await fs.mkdir(wsDir, { recursive: true });
    const wsPath = path.join(wsDir, 'workspace.yaml');
    await fs.writeFile(wsPath, 'kind: Workspace\nname: doc-ws\nworkflowPathList: []\n', 'utf-8');

    const result = await resolveStoreTarget(wsPath, rootDir);
    expect(result.isOk()).toBe(true);
    const target = result._unsafeUnwrap();
    expect(target.workspaceName).toBe('doc-ws');
    expect(target.targetFolder).toBe(path.join(wsDir, '.rawbox'));
    expect(target.workspaceDoc?.name).toBe('doc-ws');
  });

  it('resolves a directory containing exactly one workspace document', async () => {
    const wsDir = path.join(rootDir, 'ws2');
    await fs.mkdir(wsDir, { recursive: true });
    await fs.writeFile(
      path.join(wsDir, 'workspace.yaml'),
      'kind: Workspace\nname: dir-ws\nworkflowPathList: []\n',
      'utf-8',
    );

    const result = await resolveStoreTarget(wsDir, rootDir);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().workspaceName).toBe('dir-ws');
  });

  it('errors on a directory with no workspace document', async () => {
    const emptyDir = path.join(rootDir, 'empty');
    await fs.mkdir(emptyDir, { recursive: true });

    const result = await resolveStoreTarget(emptyDir, rootDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('No workspace document');
  });

  it('errors on a directory with more than one workspace document', async () => {
    const dir = path.join(rootDir, 'ambiguous');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.yaml'), 'kind: Workspace\nname: one\nworkflowPathList: []\n', 'utf-8');
    await fs.writeFile(path.join(dir, 'b.yaml'), 'kind: Workspace\nname: two\nworkflowPathList: []\n', 'utf-8');

    const result = await resolveStoreTarget(dir, rootDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('Several workspace documents');
  });

  it('resolves a raw name found under a single discovered .rawbox/data root', async () => {
    const wsDir = path.join(rootDir, 'ws3');
    await fs.mkdir(path.join(wsDir, '.rawbox', 'data', 'raw-name-ws'), { recursive: true });

    const result = await resolveStoreTarget('raw-name-ws', wsDir);
    expect(result.isOk()).toBe(true);
    const target = result._unsafeUnwrap();
    expect(target.workspaceName).toBe('raw-name-ws');
    expect(target.workspaceDoc).toBeUndefined();
    expect(fileURLToPath(target.dataRootUrl)).toBe(
      `${path.join(wsDir, '.rawbox', 'data')}${path.sep}`,
    );
  });

  it('errors when a raw name is found under more than one discovered root', async () => {
    await fs.mkdir(path.join(rootDir, 'a', '.rawbox', 'data', 'shared-name'), { recursive: true });
    await fs.mkdir(path.join(rootDir, 'b', '.rawbox', 'data', 'shared-name'), { recursive: true });

    const result = await resolveStoreTarget('shared-name', rootDir);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('different data roots');
  });

  it('falls back to <cwd>/.rawbox/data for a raw name when nothing is discovered', async () => {
    const result = await resolveStoreTarget('never-seen', rootDir);
    expect(result.isOk()).toBe(true);
    const target = result._unsafeUnwrap();
    expect(fileURLToPath(target.dataRootUrl)).toBe(
      `${path.join(rootDir, '.rawbox', 'data')}${path.sep}`,
    );
  });
});
