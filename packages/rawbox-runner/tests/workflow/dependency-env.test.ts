import { describe, it, expect } from 'vitest';
import path from 'node:path';

import {
  DEPENDENCY_ENVS_DIRNAME,
  DEPENDENCY_ENV_HASH_PATTERN,
  canonicalLockSpecifier,
  dependencyEnvHash,
  groupDependencyEnvs,
  normalizeDependencyRecord,
  normalizeDependencySpecifier,
  resolveDependencyEnvDir,
} from '../../src/workflow/dependency-env.js';

const WORKSPACE_DIR = path.resolve('/ws/project');
const TARGET_FOLDER = path.join(WORKSPACE_DIR, '.rawbox');

describe('normalizeDependencySpecifier', () => {
  it('resolves a relative `file:` specifier against the base directory', () => {
    expect(normalizeDependencySpecifier('file:../plugins/a', WORKSPACE_DIR)).toBe(
      `file:${path.resolve(WORKSPACE_DIR, '../plugins/a')}`,
    );
  });

  it('trims, and passes every non-`file:` form through', () => {
    expect(normalizeDependencySpecifier('  ^1.2.0 ', WORKSPACE_DIR)).toBe('^1.2.0');
    expect(normalizeDependencySpecifier('git+https://example.com/a.git', WORKSPACE_DIR)).toBe(
      'git+https://example.com/a.git',
    );
  });

  it('never re-resolves an absolute `file:` specifier', () => {
    const absolute = path.resolve('/elsewhere/plugin');
    expect(normalizeDependencySpecifier(`file:${absolute}`, WORKSPACE_DIR)).toBe(
      `file:${absolute}`,
    );
  });
});

describe('canonicalLockSpecifier', () => {
  it('keeps relative `file:` paths relative, slash-normalized', () => {
    expect(canonicalLockSpecifier('file:./plugins/a/')).toBe('file:plugins/a');
    expect(canonicalLockSpecifier('file:plugins/a')).toBe('file:plugins/a');
    expect(canonicalLockSpecifier('file:plugins\\a')).toBe('file:plugins/a');
    expect(canonicalLockSpecifier('file:../x/')).toBe('file:../x');
    expect(canonicalLockSpecifier(' ^1.0.0 ')).toBe('^1.0.0');
  });

  it('is the same key whatever directory the workspace is checked out in', () => {
    // The lock is committed, so its keys cannot depend on the machine. Only
    // the env hash — which is machine-local anyway — sees the base directory.
    const specifier = 'file:./plugins/a';
    const lockKey = canonicalLockSpecifier(specifier);
    expect(canonicalLockSpecifier(specifier)).toBe(lockKey);
    expect(lockKey).not.toContain(WORKSPACE_DIR);
    expect(normalizeDependencySpecifier(specifier, '/checkout/one')).not.toBe(
      normalizeDependencySpecifier(specifier, '/checkout/two'),
    );
  });
});

describe('normalizeDependencyRecord', () => {
  it('sorts keys and normalizes every specifier', () => {
    const normalized = normalizeDependencyRecord(
      { 'zeta-plugin': '^1.0.0', 'alpha-plugin': 'file:./a' },
      WORKSPACE_DIR,
    );
    expect(Object.keys(normalized)).toEqual(['alpha-plugin', 'zeta-plugin']);
    expect(normalized['alpha-plugin']).toBe(`file:${path.join(WORKSPACE_DIR, 'a')}`);
  });
});

describe('dependencyEnvHash', () => {
  it('is 16 lower-case hex characters', () => {
    expect(dependencyEnvHash({ a: '^1.0.0' })).toMatch(DEPENDENCY_ENV_HASH_PATTERN);
  });

  it('does not depend on key order', () => {
    expect(dependencyEnvHash({ a: '^1.0.0', b: '^2.0.0' })).toBe(
      dependencyEnvHash({ b: '^2.0.0', a: '^1.0.0' }),
    );
  });

  it('gives equivalent `file:` specifiers one hash', () => {
    const forms = ['file:./a/', 'file:a', `file:${path.join(WORKSPACE_DIR, 'a')}`];
    const hashes = new Set(forms.map((form) => dependencyEnvHash({ p: form }, WORKSPACE_DIR)));
    expect(hashes.size).toBe(1);
  });

  it('changes when any specifier or package changes', () => {
    const base = dependencyEnvHash({ a: '^1.0.0' });
    expect(dependencyEnvHash({ a: '^2.0.0' })).not.toBe(base);
    expect(dependencyEnvHash({ b: '^1.0.0' })).not.toBe(base);
    expect(dependencyEnvHash({ a: '^1.0.0', b: '^1.0.0' })).not.toBe(base);
  });
});

describe('resolveDependencyEnvDir', () => {
  it('is `undefined` for an empty dependency set', () => {
    expect(resolveDependencyEnvDir(TARGET_FOLDER, {})).toBeUndefined();
  });

  it('is `<targetFolder>/envs/<16 hex>` otherwise', () => {
    const envDir = resolveDependencyEnvDir(TARGET_FOLDER, { a: '^1.0.0' }) as string;
    expect(path.dirname(envDir)).toBe(path.join(TARGET_FOLDER, DEPENDENCY_ENVS_DIRNAME));
    expect(path.basename(envDir)).toMatch(DEPENDENCY_ENV_HASH_PATTERN);
    expect(path.basename(envDir)).toBe(dependencyEnvHash({ a: '^1.0.0' }));
  });
});

describe('groupDependencyEnvs', () => {
  it('merges identical maps, collecting every workflow path, and splits different ones', () => {
    const groups = groupDependencyEnvs(
      TARGET_FOLDER,
      [
        { path: './a.yaml', dependencies: { x: '^0.1.0' } },
        { path: './b.yaml', dependencies: { x: ' ^0.1.0' } },
        { path: './c.yaml', dependencies: { x: '^0.2.0' } },
      ],
      WORKSPACE_DIR,
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]?.workflowPathList).toEqual(['./a.yaml', './b.yaml']);
    expect(groups[0]?.dependencies).toEqual({ x: '^0.1.0' });
    expect(groups[1]?.workflowPathList).toEqual(['./c.yaml']);
    expect(groups[0]?.hash).not.toBe(groups[1]?.hash);
    expect(groups[1]?.envDir).toBe(
      resolveDependencyEnvDir(TARGET_FOLDER, { x: '^0.2.0' }, WORKSPACE_DIR),
    );
  });

  it('skips workflows with no dependencies', () => {
    expect(
      groupDependencyEnvs(TARGET_FOLDER, [{ path: './empty.yaml', dependencies: {} }]),
    ).toEqual([]);
  });
});
