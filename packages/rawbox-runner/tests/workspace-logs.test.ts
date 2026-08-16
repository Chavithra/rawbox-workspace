import { describe, it, expect } from 'vitest';
import { Compile } from 'typebox/compile';

import {
  DEFAULT_PRUNE_KEEP,
  LOG_ROTATE_DEFAULT_MAX_BYTES,
  LOG_ROTATE_DEFAULT_MAX_FILES,
  LOG_ROTATE_MAX_BYTES_MIN,
  collectLogRotationProblems,
  resolveLogsConfig,
  type WorkspaceLogs,
} from '../src/workspace/logs.js';
import { Workspace } from '../src/workspace/workspace-types.js';
import { formatValidationErrors } from '../src/workflow/validation.js';

// ---------------------------------------------------------------------------
// `logs:` — the workspace document's run-event log configuration
//
// Two halves, and the second is the reason the first exists. The schema half
// checks that a well-formed block validates and that a malformed one is
// REFUSED rather than ignored: these bounds used to come from an untyped
// `rawbox.config.json` whose reader silently dropped anything of the wrong
// type, so "a misspelt field is an error" is the behaviour being bought here, not a
// side effect of tidiness. The second half is the one rule a schema cannot
// state — `rotate.maxBytes` and `rotate.maxFiles` are one setting written as
// two fields, and half of it is worse than none.
//
// Nothing here writes a log line or deletes a file; the sink and `runs prune`
// consume these fields elsewhere.
// ---------------------------------------------------------------------------

const workspaceValidator = Compile(Workspace);

const WORKSPACE_SOURCE = 'workspace.yaml';

/** A minimal valid workspace, plus whatever the case under test adds. */
function workspace(block: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'Workspace',
    name: 'demo',
    workflowPathList: ['./workflows/main.workflow.yaml'],
    ...block,
  };
}

describe('logs — schema', () => {
  it('accepts the full block, every field populated', () => {
    expect(
      workspaceValidator.Check(
        workspace({
          logs: {
            async: false,
            steps: 'summary',
            rotate: { maxBytes: 134217728, maxFiles: 8 },
            prune: { keep: 200, olderThanDays: 14, maxBytes: 52428800 },
          },
        }),
      ),
    ).toBe(true);
  });

  it('accepts each of `steps:`s three values, and `steps:` alone', () => {
    for (const steps of ['full', 'summary', 'off']) {
      expect(workspaceValidator.Check(workspace({ logs: { steps } }))).toBe(true);
    }
  });

  it('accepts a workspace that declares no `logs:` at all', () => {
    expect(workspaceValidator.Check(workspace({}))).toBe(true);
  });

  it('accepts an empty `logs: {}` as "all defaults"', () => {
    // Spelled out rather than refused: an author who has written the key and
    // is about to fill it in should not be told the empty form is an error.
    expect(workspaceValidator.Check(workspace({ logs: {} }))).toBe(true);
  });

  it('accepts `async:` alone, with neither sub-block', () => {
    expect(workspaceValidator.Check(workspace({ logs: { async: true } }))).toBe(true);
  });

  it('accepts `rotate:` alone, with no `prune:`', () => {
    expect(
      workspaceValidator.Check(
        workspace({ logs: { rotate: { maxBytes: 134217728, maxFiles: 8 } } }),
      ),
    ).toBe(true);
  });

  it('accepts `prune:` alone, with no `rotate:`', () => {
    expect(
      workspaceValidator.Check(workspace({ logs: { prune: { keep: 200 } } })),
    ).toBe(true);
  });

  it('accepts an empty `rotate: {}` and an empty `prune: {}`', () => {
    expect(
      workspaceValidator.Check(workspace({ logs: { rotate: {}, prune: {} } })),
    ).toBe(true);
  });

  it('accepts each `prune:` bound independently of the other two', () => {
    // Absent means "no bound of this kind", never zero — so any subset is a
    // policy, not a half-written one.
    for (const prune of [
      { keep: 200 },
      { olderThanDays: 14 },
      { maxBytes: 52428800 },
      { keep: 200, maxBytes: 52428800 },
    ]) {
      expect(workspaceValidator.Check(workspace({ logs: { prune } }))).toBe(true);
    }
  });
});

describe('logs — closed at every level', () => {
  // The whole reason this block lives in the validated document rather than in
  // `rawbox.config.json`: that reader used to accept a misspelt or mistyped
  // field and silently use the default, so an author discovered a retention
  // typo as a full disk weeks later.

  it('rejects an unknown field directly inside `logs:`', () => {
    expect(
      workspaceValidator.Check(workspace({ logs: { rotation: { maxBytes: 1 } } })),
    ).toBe(false);
  });

  it('rejects an unknown field inside `logs.rotate:`', () => {
    expect(
      workspaceValidator.Check(
        workspace({
          logs: { rotate: { maxBytes: 134217728, maxfiles: 8 } },
        }),
      ),
    ).toBe(false);
  });

  it('rejects an unknown field inside `logs.prune:`', () => {
    expect(
      workspaceValidator.Check(
        workspace({ logs: { prune: { keep: 200, olderThan: 14 } } }),
      ),
    ).toBe(false);
  });

  it('keeps the Workspace document itself closed', () => {
    // Adding `logs:` must not have opened the document — `metadata:` is still
    // reserved and still refused.
    expect(workspaceValidator.Check(workspace({ metadata: { note: 'x' } }))).toBe(
      false,
    );
  });
});

describe('logs — integer and minimum constraints', () => {
  it('rejects a non-integer `rotate.maxBytes`', () => {
    // A byte count is a count; `134217728.5` is a typo, not a policy.
    expect(
      workspaceValidator.Check(
        workspace({ logs: { rotate: { maxBytes: 134217728.5, maxFiles: 8 } } }),
      ),
    ).toBe(false);
  });

  it('rejects a `rotate.maxBytes` below the one-block floor', () => {
    // Below one filesystem block buys no disk back, and a tiny bound would
    // roll on nearly every event — filling `maxFiles` in seconds and deleting
    // the run's whole history on the next line.
    expect(
      workspaceValidator.Check(
        workspace({
          logs: { rotate: { maxBytes: LOG_ROTATE_MAX_BYTES_MIN - 1, maxFiles: 8 } },
        }),
      ),
    ).toBe(false);

    expect(
      workspaceValidator.Check(
        workspace({
          logs: { rotate: { maxBytes: LOG_ROTATE_MAX_BYTES_MIN, maxFiles: 8 } },
        }),
      ),
    ).toBe(true);
  });

  it('rejects `rotate.maxFiles: 0`, which would delete the live segment', () => {
    // Segment 0 is the file the sink is writing. `1` — keep the live segment
    // only — is the aggressive end of legal.
    expect(
      workspaceValidator.Check(
        workspace({ logs: { rotate: { maxBytes: 134217728, maxFiles: 0 } } }),
      ),
    ).toBe(false);

    expect(
      workspaceValidator.Check(
        workspace({ logs: { rotate: { maxBytes: 134217728, maxFiles: 1 } } }),
      ),
    ).toBe(true);
  });

  it('rejects a negative `prune.keep`, and accepts `0`', () => {
    // `0` asks for no retained history, which `pruneRuns` honours as far as it
    // can. A negative count names nothing.
    expect(workspaceValidator.Check(workspace({ logs: { prune: { keep: -1 } } }))).toBe(
      false,
    );
    expect(workspaceValidator.Check(workspace({ logs: { prune: { keep: 0 } } }))).toBe(
      true,
    );
  });

  it('rejects a fractional `prune.olderThanDays`', () => {
    // `0.5` is indistinguishable from a units mistake; sub-day precision is
    // really a request for `maxBytes`.
    expect(
      workspaceValidator.Check(workspace({ logs: { prune: { olderThanDays: 0.5 } } })),
    ).toBe(false);
  });

  it('rejects a negative `prune.maxBytes`, and accepts `0`', () => {
    expect(
      workspaceValidator.Check(workspace({ logs: { prune: { maxBytes: -1 } } })),
    ).toBe(false);
    expect(
      workspaceValidator.Check(workspace({ logs: { prune: { maxBytes: 0 } } })),
    ).toBe(true);
  });

  it('rejects a string where a number belongs, rather than defaulting', () => {
    // The exact `rawbox.config.json` behaviour that block ended: `"50mb"`
    // there was not an error, it was the default and no diagnostic anywhere.
    expect(
      workspaceValidator.Check(workspace({ logs: { prune: { maxBytes: '50mb' } } })),
    ).toBe(false);
  });

  it('rejects a non-boolean `async:`', () => {
    expect(workspaceValidator.Check(workspace({ logs: { async: 'false' } }))).toBe(
      false,
    );
  });

  it('rejects a `steps:` value outside the three, rather than falling back to `full`', () => {
    // A closed set is the point: `sumary` must be a diagnostic, not a silent
    // `full`. Getting this wrong is the `rawbox.config.json` failure mode
    // exactly — an author sets a retention policy, the reader ignores it, and
    // nobody finds out until the disk is full.
    for (const steps of ['sumary', 'none', 'summary ', 'FULL', true, 0, null, ['off']]) {
      expect(workspaceValidator.Check(workspace({ logs: { steps } }))).toBe(false);
    }
  });
});

describe('logs — the diagnostic a bad block produces', () => {
  /** What the two workspace entry points print for a document that fails. */
  function diagnose(logs: unknown): string {
    const document = workspace({ logs });
    return formatValidationErrors(workspaceValidator.Errors(document), document);
  }

  it('names the path, the value written, and what was expected', () => {
    // All three facts on one line, which is the whole difference from
    // `rawbox.config.json`: there, `"50mb"` was never reported at all.
    expect(diagnose({ prune: { maxBytes: '50mb' } })).toBe(
      '  - Path: "/logs/prune/maxBytes" : must be integer (received "50mb")',
    );
  });

  it('names the offending value on a below-minimum bound', () => {
    expect(diagnose({ rotate: { maxBytes: 1024, maxFiles: 8 } })).toBe(
      `  - Path: "/logs/rotate/maxBytes" : must be >= ${LOG_ROTATE_MAX_BYTES_MIN} (received 1024)`,
    );
  });

  it('names the misspelt property itself for a closed-object error', () => {
    // TypeBox reports "must not have additional properties" at the OBJECT's
    // path, naming no field; the property list is what makes it actionable.
    expect(diagnose({ rotate: { maxBytes: 134217728, maxfiles: 8 } })).toBe(
      '  - Path: "/logs/rotate" : must not have additional properties: "maxfiles"',
    );
  });

  it('names the path and the value written for a bad `steps:`', () => {
    // The same three facts as every other bound: which key, what was written,
    // and what was expected instead — here, the three values themselves, so
    // the diagnostic doubles as the documentation.
    const message = diagnose({ steps: 'sumary' });
    expect(message).toContain('"/logs/steps"');
    expect(message).toContain('"sumary"');
  });

  it('names a wrong-shaped sub-block by kind rather than dumping it', () => {
    expect(diagnose({ rotate: [] })).toContain('(received an array)');
  });
});

describe('collectLogRotationProblems', () => {
  it('reports `maxBytes` without `maxFiles`, naming the missing field', () => {
    const [problem, ...rest] = collectLogRotationProblems({
      logs: { rotate: { maxBytes: 134217728 } },
      source: WORKSPACE_SOURCE,
    });

    expect(rest).toEqual([]);
    expect(problem).toBeDefined();
    // Names the thing, where it was declared, and what to add.
    expect(problem).toContain('logs.rotate.maxBytes');
    expect(problem).toContain('134217728');
    expect(problem).toContain('logs.rotate.maxFiles');
    expect(problem).toContain('is missing');
    expect(problem).toContain(WORKSPACE_SOURCE);
    expect(problem).toContain('Add logs.rotate.maxFiles');
  });

  it('reports `maxFiles` without `maxBytes`, the other way round', () => {
    const [problem, ...rest] = collectLogRotationProblems({
      logs: { rotate: { maxFiles: 8 } },
      source: WORKSPACE_SOURCE,
    });

    expect(rest).toEqual([]);
    expect(problem).toContain('logs.rotate.maxFiles');
    expect(problem).toContain('is missing');
    expect(problem).toContain('Add logs.rotate.maxBytes');
    // The floor is quoted, so the author does not have to guess a legal value.
    expect(problem).toContain(String(LOG_ROTATE_MAX_BYTES_MIN));
  });

  it('does not fire when both fields are present', () => {
    expect(
      collectLogRotationProblems({
        logs: { rotate: { maxBytes: 134217728, maxFiles: 8 } },
        source: WORKSPACE_SOURCE,
      }),
    ).toEqual([]);
  });

  it('does not fire when neither is present — rotation is simply off', () => {
    expect(
      collectLogRotationProblems({ logs: { rotate: {} }, source: WORKSPACE_SOURCE }),
    ).toEqual([]);
  });

  it('does not fire for a workspace with no `rotate:` or no `logs:` at all', () => {
    expect(
      collectLogRotationProblems({
        logs: { prune: { keep: 200 } },
        source: WORKSPACE_SOURCE,
      }),
    ).toEqual([]);
    expect(
      collectLogRotationProblems({ logs: undefined, source: WORKSPACE_SOURCE }),
    ).toEqual([]);
  });

  it('says nothing about a block that is not an object', () => {
    // Reads defensively: `workflow verify` holds a workspace document it has
    // deliberately not schema-validated, and the schema is what reports these
    // shapes — a second, differently worded complaint here would be noise.
    for (const logs of ['rotate', 42, null, [], { rotate: 'yes' }, { rotate: [] }]) {
      expect(collectLogRotationProblems({ logs, source: WORKSPACE_SOURCE })).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// `resolveLogsConfig` — CLI override > workspace.yaml > built-in default,
// decided independently per field (`logs.ts`'s "Resolving `logs:`" module
// note). Nothing here rotates, prunes or writes anything either — this is
// pure arithmetic over three optional sources, exercised without ever
// touching disk.
// ---------------------------------------------------------------------------

describe('resolveLogsConfig', () => {
  /** A minimal, schema-shaped `Workspace`, with or without a `logs:` block. */
  function ws(logs?: WorkspaceLogs): Workspace {
    return {
      kind: 'Workspace',
      name: 'demo',
      workflowPathList: [],
      ...(logs !== undefined ? { logs } : {}),
    };
  }

  const BUILTIN_DEFAULTS = {
    async: false,
    // `full` — the step payloads are written. Every other value drops data a
    // reader may be looking for, so nothing but an explicit setting may
    // produce one.
    steps: 'full',
    rotate: { maxBytes: LOG_ROTATE_DEFAULT_MAX_BYTES, maxFiles: LOG_ROTATE_DEFAULT_MAX_FILES },
    prune: { keep: DEFAULT_PRUNE_KEEP, olderThanDays: undefined, maxBytes: undefined },
  };

  it('resolves to pure built-in defaults for a workspace-less run (workspace: undefined)', () => {
    // The real path this covers: `workflow run --workspace-name`
    // (rawbox-runner README, "Implicit (workspace-less) workspaces") has no
    // document at all.
    expect(resolveLogsConfig({ workspace: undefined })).toEqual(BUILTIN_DEFAULTS);
  });

  it('resolves to pure built-in defaults with no `override` argument at all', () => {
    expect(resolveLogsConfig({ workspace: undefined, override: undefined })).toEqual(
      BUILTIN_DEFAULTS,
    );
  });

  it('resolves to pure built-in defaults for an empty `logs: {}`', () => {
    expect(resolveLogsConfig({ workspace: ws({}) })).toEqual(BUILTIN_DEFAULTS);
  });

  it('resolves to pure built-in defaults for a workspace declaring no `logs:` at all', () => {
    expect(resolveLogsConfig({ workspace: ws(undefined) })).toEqual(BUILTIN_DEFAULTS);
  });

  it('the workspace document wins over the built-in default, field by field', () => {
    const resolved = resolveLogsConfig({
      workspace: ws({
        async: true,
        steps: 'summary',
        rotate: { maxBytes: 999_999, maxFiles: 3 },
        prune: { keep: 10, olderThanDays: 5, maxBytes: 12_345 },
      }),
    });
    expect(resolved).toEqual({
      async: true,
      steps: 'summary',
      rotate: { maxBytes: 999_999, maxFiles: 3 },
      prune: { keep: 10, olderThanDays: 5, maxBytes: 12_345 },
    });
  });

  it('a CLI override wins over the workspace document, field by field', () => {
    const resolved = resolveLogsConfig({
      workspace: ws({
        async: true,
        steps: 'off',
        rotate: { maxBytes: 999_999, maxFiles: 3 },
        prune: { keep: 10, olderThanDays: 5, maxBytes: 12_345 },
      }),
      override: {
        async: false,
        steps: 'summary',
        rotate: { maxBytes: 8192, maxFiles: 2 },
        prune: { keep: 1, olderThanDays: 2, maxBytes: 3 },
      },
    });
    expect(resolved).toEqual({
      async: false,
      steps: 'summary',
      rotate: { maxBytes: 8192, maxFiles: 2 },
      prune: { keep: 1, olderThanDays: 2, maxBytes: 3 },
    });
  });

  it('resolves `steps` through all three layers, per field and in that order', () => {
    // The three-layer precedence stated once for the field this feature adds:
    // `--log-steps` beats `logs.steps:` beats the built-in `full`, and each
    // layer is consulted only when the one above it said nothing.
    // Deliberately `off` at the bottom and `summary` on top, so a resolver
    // that returned the wrong layer could not accidentally return the right
    // value.
    expect(
      resolveLogsConfig({
        workspace: ws({ steps: 'off' }),
        override: { steps: 'summary' },
      }).steps,
    ).toBe('summary');
    // No flag: the document decides.
    expect(resolveLogsConfig({ workspace: ws({ steps: 'off' }) }).steps).toBe('off');
    // No flag and no document field: the built-in default, which is the old
    // behaviour — every field of every step event on disk.
    expect(resolveLogsConfig({ workspace: ws({ async: true }) }).steps).toBe('full');
    // No document at all (`--workspace-name`, a scratch run).
    expect(resolveLogsConfig({ workspace: undefined, override: { steps: 'off' } }).steps).toBe(
      'off',
    );
    // An override that sets *another* field leaves `steps` to the document —
    // per field, not per block.
    expect(
      resolveLogsConfig({ workspace: ws({ steps: 'summary' }), override: { async: true } }).steps,
    ).toBe('summary');
  });

  it('composes CLI and workspace per field, rather than one replacing the other whole', () => {
    // Only `prune.keep` is overridden; `olderThanDays` and `maxBytes` still
    // come from the workspace document, and `async`/`rotate` — untouched by
    // either — fall to their built-in defaults. Unlike a seed override
    // (`seed-overrides.ts`), which replaces a whole value, `logs:` resolves
    // one field at a time.
    const resolved = resolveLogsConfig({
      workspace: ws({ prune: { keep: 10, olderThanDays: 5, maxBytes: 12_345 } }),
      override: { prune: { keep: 1 } },
    });
    expect(resolved.prune).toEqual({ keep: 1, olderThanDays: 5, maxBytes: 12_345 });
    expect(resolved.async).toBe(false);
    expect(resolved.rotate).toEqual({
      maxBytes: LOG_ROTATE_DEFAULT_MAX_BYTES,
      maxFiles: LOG_ROTATE_DEFAULT_MAX_FILES,
    });
  });

  it('`prune.olderThanDays` stays undefined — "no bound of this kind" — when nothing supplies it, while `keep` still defaults', () => {
    const resolved = resolveLogsConfig({ workspace: ws({ prune: { maxBytes: 999 } }) });
    expect(resolved.prune.keep).toBe(DEFAULT_PRUNE_KEEP);
    expect(resolved.prune.olderThanDays).toBeUndefined();
    expect(resolved.prune.maxBytes).toBe(999);
  });

  it('`prune.maxBytes` has no built-in default — it stays undefined when nothing configures it', () => {
    // The retired fallback: `maxBytes` used to fall back to a built-in byte
    // total; now `keep` (`DEFAULT_PRUNE_KEEP`) is the only bound that ever
    // applies unconfigured.
    const resolved = resolveLogsConfig({ workspace: undefined });
    expect(resolved.prune.maxBytes).toBeUndefined();
    expect(resolved.prune.keep).toBe(DEFAULT_PRUNE_KEEP);
  });

  it('`prune.maxBytes: 0` from the workspace is honoured, not treated as absent', () => {
    // `0` is a real, meaningful bound (`LogPrune.maxBytes`'s own doc) — `??`
    // rather than `||` is what keeps it from being treated as unset.
    expect(resolveLogsConfig({ workspace: ws({ prune: { maxBytes: 0 } }) }).prune.maxBytes).toBe(
      0,
    );
  });

  it('`prune.keep: 0` from the workspace is honoured, not overwritten by the built-in default', () => {
    // Same `??` reasoning as `maxBytes: 0` above, but for the field that now
    // carries an actual built-in default to be overwritten by mistake.
    expect(resolveLogsConfig({ workspace: ws({ prune: { keep: 0 } }) }).prune.keep).toBe(0);
  });
});
