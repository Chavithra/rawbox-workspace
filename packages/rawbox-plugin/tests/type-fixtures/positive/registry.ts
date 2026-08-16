// ---------------------------------------------------------------------------
// The cross-copy positive fixture: every schema below is built by
// `typebox-xcopy` — a SECOND, deliberately different installed copy of typebox
// (an npm alias for a version other than the one `@rawbox/plugin` resolves).
// `setupPluginRegistry` is the real, BUILT SDK, whose own typebox is the
// framework copy. Nothing here may import `typebox` directly: that would
// quietly turn this back into a single-copy test.
//
// See tests/integration/typebox-cross-copy.test.ts for the harness that
// typechecks this directory, and for the rule the two copies rest on: the
// SDK's generic constraints may name a schema field but must never compute
// one, which is what lets a plugin's typebox version differ from the
// framework's.
// ---------------------------------------------------------------------------
import { Type } from 'typebox-xcopy';
import { setupPluginRegistry } from '@rawbox/plugin';

export const {
  contractRegistry,
  createOperationDefinition,
  createControlFlowDefinition,
} = setupPluginRegistry({
  operationsRecord: {
    // Every shape the cross-copy failure mode can surface through, because `required`
    // — the field `ObjectSchemaLike` deliberately omits — is what encodes
    // optionality. Optional properties are therefore the case most likely to
    // degrade silently.
    './echo.definition.js': {
      type: 'operation',
      description: 'Exercises every inference shape across the copy boundary',
      inputSchema: Type.Object({
        a: Type.Number(),
        b: Type.String(),
        maybe: Type.Optional(Type.String()),
        nested: Type.Object({ deep: Type.Boolean() }),
        list: Type.Array(Type.String()),
        choice: Type.Union([Type.Literal('x'), Type.Literal('y')]),
      }),
      outputSchema: Type.Object({ out: Type.Number() }),
      errorSchema: Type.Object({ message: Type.String() }),
      version: '1.0.0',
      // The bounded state of `Contract.timeoutMs`, exercised across the copy
      // boundary alongside the unbounded one below. `as const` narrows this to
      // the literal `30000`, so the fixture also pins that a literal-typed
      // bound still satisfies `timeoutMs?: number` — the field must not become
      // one of the *computed* members the cross-copy rule forbids.
      timeoutMs: 30_000,
    },
    // The zero-required-property shape from the original incident report: the
    // strict constraint reported "Type 'undefined' is not assignable to type
    // '[string]'" for exactly this.
    './empty.definition.js': {
      type: 'operation',
      description: 'A schema with no required properties at all',
      inputSchema: Type.Object({}),
      outputSchema: Type.Object({}),
      errorSchema: Type.Object({ message: Type.String() }),
      version: '1.0.0',
      // No `timeoutMs`: the *other* state of the same field, and the one that
      // must keep compiling unchanged — omitting the key is how a contract
      // declares itself deliberately unbounded, so a plugin written before the
      // field existed is still a valid plugin.
    },
  },
  controlFlowRecord: {
    // Control-flow contracts have no `outputSchema` — the SDK supplies a fixed
    // `{ label }` one from its OWN typebox copy, so this path mixes both copies
    // inside a single definition. It was never exercised cross-copy before.
    './halt.definition.js': {
      type: 'control-flow',
      description: 'Exercises the control-flow chain across the copy boundary',
      inputSchema: Type.Object({
        when: Type.Boolean(),
        reason: Type.Optional(Type.String()),
        tags: Type.Array(Type.String()),
        mode: Type.Union([Type.Literal('soft'), Type.Literal('hard')]),
        meta: Type.Object({ attempt: Type.Number() }),
      }),
      errorSchema: Type.Object({ message: Type.String() }),
      version: '1.0.0',
    },
  },
} as const);

// The merged registry must stay usable too — `setupPluginRegistry`'s two-record
// merge and `SpecificContractRegistry` re-narrowing are part of the chain.
export const registryPath: string = contractRegistry.contractRegistryPath;
