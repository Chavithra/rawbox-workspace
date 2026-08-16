import { describe, it, expect } from 'vitest';
import { Compile } from 'typebox/compile';

import {
  collectBackendEnvProblems,
  collectBackendReferenceList,
  collectEnvReferenceList,
  collectUnknownBackendProblems,
  interpolateEnvReferences,
  resolveBackendConnection,
} from '../src/workspace/backends.js';
import { Workspace } from '../src/workspace/workspace-types.js';

// ---------------------------------------------------------------------------
// `backends:` — the workspace's map of backend id → connection descriptor
//
// The unit half of what `packages/rawbox-cli/tests/verify.test.ts` exercises
// through the two `verify` commands. Nothing here opens a socket; the whole
// module is a function of two documents and a `Record<string, string>` standing
// in for `process.env`, which is why the environment is a *parameter* rather
// than a read of the real one.
// ---------------------------------------------------------------------------

const WORKSPACE_SOURCE = 'workspace.yaml';

describe('env-var interpolation', () => {
  it('finds every `${VAR}` reference, deduplicated and in first-seen order', () => {
    expect(
      collectEnvReferenceList('redis://${USER}:${PASS}@${HOST}:6379/${USER}'),
    ).toEqual(['USER', 'PASS', 'HOST']);
  });

  it('does NOT treat a bare `$NAME` as a reference', () => {
    // The braces are load-bearing. A URL password may legitimately contain a
    // `$`, and a bare-word form would resolve the ambiguity in the dangerous
    // direction: silently, into an empty password.
    expect(collectEnvReferenceList('redis://u:pa$$w0rd@host:6379')).toEqual([]);
  });

  it('substitutes every reference when the environment supplies them', () => {
    const result = interpolateEnvReferences(
      'redis://user:${PASS}@${HOST}:6379',
      { PASS: 's3cret', HOST: 'cache.internal' },
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe('redis://user:s3cret@cache.internal:6379');
  });

  it('refuses an unset variable rather than substituting nothing', () => {
    const result = interpolateEnvReferences('${REDIS_URL}', {});

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual([
      { variable: 'REDIS_URL', reason: 'unset' },
    ]);
  });

  it('refuses an EMPTY variable, and distinguishes it from an unset one', () => {
    // The precise failure being designed out: `redis://:@localhost:6379` is
    // still a valid URL, and a client would open it against the wrong server.
    const result = interpolateEnvReferences('redis://:${PASS}@${HOST}:6379', {
      PASS: '',
      HOST: 'localhost',
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toEqual([
      { variable: 'PASS', reason: 'empty' },
    ]);
  });

  it('collects every unresolved reference rather than the first', () => {
    // One pass should give the author the whole fix list, rather than one
    // problem per run.
    const result = interpolateEnvReferences('${A}/${B}/${C}', { B: 'set' });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().map((entry) => entry.variable)).toEqual([
      'A',
      'C',
    ]);
  });

  it('leaves a connection string with no references exactly as written', () => {
    const literal = 'redis://cache.internal:6379/0';
    expect(interpolateEnvReferences(literal, {})._unsafeUnwrap()).toBe(literal);
  });
});

describe('collectBackendEnvProblems', () => {
  const backends = {
    main: { connection: '${MAIN_URL}' },
    prod: { connection: '${PROD_URL}' },
  };

  it('names the variable, the backend id and the document path', () => {
    const problemList = collectBackendEnvProblems({
      backends,
      source: WORKSPACE_SOURCE,
      env: { PROD_URL: 'redis://prod:6379' },
    });

    expect(problemList).toHaveLength(1);
    const [problem] = problemList;
    expect(problem).toContain('MAIN_URL');
    expect(problem).toContain('Backend "main" cannot be resolved');
    expect(problem).toContain('backends.main.connection');
    expect(problem).toContain(WORKSPACE_SOURCE);
    // Say what to do, and contradict the reading a terse message would invite.
    expect(problem).toContain('export MAIN_URL=');
    expect(problem).toContain('NO default and no fallback');
  });

  it('checks every declared backend when no id list is given', () => {
    // `workspace verify`'s scope: the workspace document is what it verifies,
    // so a declared-but-unresolvable entry is broken whether or not a workflow
    // reaches for it today.
    expect(
      collectBackendEnvProblems({ backends, source: WORKSPACE_SOURCE, env: {} }),
    ).toHaveLength(2);
  });

  it('checks only the listed ids when one is given', () => {
    // `workflow verify`'s scope: a workflow touching no Redis must not fail
    // because the workspace also declares a `prod` backend whose password this
    // developer does not hold.
    const problemList = collectBackendEnvProblems({
      backends,
      source: WORKSPACE_SOURCE,
      env: {},
      backendIdList: ['main'],
    });

    expect(problemList).toHaveLength(1);
    expect(problemList[0]).toContain('main');
  });

  it('reports nothing for a workspace with no backends at all', () => {
    expect(
      collectBackendEnvProblems({
        backends: undefined,
        source: WORKSPACE_SOURCE,
        env: {},
      }),
    ).toEqual([]);
  });
});

describe('collectBackendReferenceList', () => {
  it('sweeps `storage.defaultStrategy` and every `storage.keys` entry', () => {
    // Completeness is over declaration SITES, and that half was missed once:
    // this function read the then-existing `storage.strategies` alone, so a
    // `redis-*` declared under `keys:` had its `backend:` id checked by
    // nothing. The shorthand is gone; the entry sites must stay swept.
    expect(
      collectBackendReferenceList({
        storage: {
          defaultStrategy: { name: 'redis-kv', valueSizeMax: 1900, backend: 'a' },
          keys: {
            cache: {
              strategy: { name: 'redis-kv', valueSizeMax: 1900, backend: 'b' },
            },
            local: { strategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
            seeded_only: { seed: 1 },
          },
        },
      }),
    ).toEqual([
      { backendId: 'a', path: 'storage.defaultStrategy' },
      { backendId: 'b', path: 'storage.keys.cache.strategy' },
    ]);
  });

  it('no longer sweeps the removed `storage.strategies` block', () => {
    // A document still writing it is refused by `validateWorkflowType` before
    // any backend check runs (`collectRemovedStorageBlockProblems`), so a
    // reference hidden there must not be reported as a live one here.
    expect(
      collectBackendReferenceList({
        storage: {
          defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
          strategies: {
            cache: { name: 'redis-kv', valueSizeMax: 1900, backend: 'b' },
          },
        },
      }),
    ).toEqual([]);
  });

  it('reads the field by name, not by strategy name', () => {
    // `backend:` means one thing wherever it appears (FORMAT.md,
    // "Strategies"), so a second
    // strategy that also references a backend is swept the day it is added.
    expect(
      collectBackendReferenceList({
        storage: {
          defaultStrategy: {
            name: 'some-future-strategy',
            backend: 'shared',
          },
        },
      }),
    ).toEqual([{ backendId: 'shared', path: 'storage.defaultStrategy' }]);
  });

  it('returns nothing for a document with no storage block, without throwing', () => {
    // Runs on whatever `parseConfig` returned, so every shape has to be safe.
    expect(collectBackendReferenceList(undefined)).toEqual([]);
    expect(collectBackendReferenceList({ storage: 'not-an-object' })).toEqual([]);
  });
});

describe('collectUnknownBackendProblems', () => {
  const document = {
    storage: {
      defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 },
      keys: {
        cache_entry: {
          strategy: { name: 'redis-kv', valueSizeMax: 1900, backend: 'main' },
        },
      },
    },
  };

  it('names the id, where it was named, and the ids that do exist', () => {
    const problemList = collectUnknownBackendProblems({
      document,
      backends: { cache: { connection: 'redis://cache:6379' } },
      workflowLabel: '"main.yaml"',
      workspaceSource: WORKSPACE_SOURCE,
    });

    expect(problemList).toHaveLength(1);
    const [problem] = problemList;
    expect(problem).toContain('Backend "main" is not declared by this workspace');
    expect(problem).toContain('storage.keys.cache_entry.strategy');
    expect(problem).toContain('"main.yaml"');
    expect(problem).toContain('Declared backend ids: "cache".');
  });

  it('shows the block to add when there is no `backends:` map at all', () => {
    // A missing block and a missing entry are different mistakes: one gets the
    // block to write, the other gets the list of ids that would be right.
    const [problem] = collectUnknownBackendProblems({
      document,
      backends: undefined,
      workflowLabel: '"main.yaml"',
      workspaceSource: WORKSPACE_SOURCE,
    });

    expect(problem).toContain('has no "backends:" block at all');
    expect(problem).toContain('connection: ${REDIS_URL}');
    expect(problem).toContain('never a connection string');
  });

  it('reports nothing when every referenced id is declared', () => {
    expect(
      collectUnknownBackendProblems({
        document,
        backends: { main: { connection: 'redis://cache:6379' } },
        workflowLabel: '"main.yaml"',
        workspaceSource: WORKSPACE_SOURCE,
      }),
    ).toEqual([]);
  });

  it('reports nothing for a workflow that references no backend', () => {
    expect(
      collectUnknownBackendProblems({
        document: {
          storage: { defaultStrategy: { name: 'lmdb-kv', valueSizeMax: 1900 } },
        },
        backends: undefined,
        workflowLabel: '"main.yaml"',
        workspaceSource: WORKSPACE_SOURCE,
      }),
    ).toEqual([]);
  });
});

describe('resolveBackendConnection', () => {
  it('returns the substituted connection string', () => {
    const result = resolveBackendConnection({
      backends: { main: { connection: 'redis://user:${PASS}@cache:6379' } },
      backendId: 'main',
      source: WORKSPACE_SOURCE,
      env: { PASS: 's3cret' },
    });

    expect(result._unsafeUnwrap()).toBe('redis://user:s3cret@cache:6379');
  });

  it('is an Err, never a throw, for an id that names nothing', () => {
    const result = resolveBackendConnection({
      backends: { cache: { connection: 'redis://cache:6379' } },
      backendId: 'main',
      source: WORKSPACE_SOURCE,
      env: {},
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('Declared backend ids: "cache"');
  });

  it('is an Err for an unset variable, in the same words verify prints', () => {
    // One wording, two moments. A reader who hits this at run time should see
    // the message they would have seen at verify time, not a terser second one.
    const result = resolveBackendConnection({
      backends: { main: { connection: '${REDIS_URL}' } },
      backendId: 'main',
      source: WORKSPACE_SOURCE,
      env: {},
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('Backend "main" cannot be resolved');
    expect(result._unsafeUnwrapErr()).toContain('REDIS_URL');
  });
});

describe('the Workspace schema with backends', () => {
  const validator = Compile(Workspace);

  const base = {
    kind: 'Workspace',
    name: 'ws',
    workflowPathList: ['./workflows/main.yaml'],
  };

  it('accepts a workspace with no `backends:` at all', () => {
    // Optional, and absent for every LMDB-only workspace. The LMDB environment
    // is not a backend entry: its location comes from `targetFolder`, there is
    // nothing to connect to and no credential to hold.
    expect(validator.Check(base)).toBe(true);
  });

  it('accepts a map of ids whose values carry a connection', () => {
    expect(
      validator.Check({
        ...base,
        backends: { main: { connection: '${REDIS_URL}' } },
      }),
    ).toBe(true);
  });

  it('rejects a stray field inside a backend entry', () => {
    // The map's KEYS are the author's own ids and so are open; its VALUES are
    // closed, so a misspelt setting is an error rather than a dropped one.
    expect(
      validator.Check({
        ...base,
        backends: {
          main: { connection: 'redis://cache:6379', connexion: 'typo' },
        },
      }),
    ).toBe(false);
  });

  it('rejects an empty connection string', () => {
    // An empty connection names no server and would reach a client library as
    // the string it treats as "use the default".
    expect(
      validator.Check({ ...base, backends: { main: { connection: '' } } }),
    ).toBe(false);
  });

  it('rejects a bare string in place of a descriptor', () => {
    expect(
      validator.Check({ ...base, backends: { main: 'redis://cache:6379' } }),
    ).toBe(false);
  });

  it('keeps the Workspace document itself closed', () => {
    // Adding `backends:` must not have made the document open — `metadata:` is
    // still reserved and still rejected.
    expect(validator.Check({ ...base, metadata: { note: 'x' } })).toBe(false);
  });
});
