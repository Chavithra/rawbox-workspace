import { Type } from '@rawbox/plugin/typebox';
import type { TOptional, TUnknown } from '@rawbox/plugin/typebox';
import { setupPluginRegistry } from '@rawbox/plugin';
import { SNAPSHOT_VALUE_FIELD_LIST } from './observability/snapshot-fields.js';

/**
 * `{ value1: Type.Optional(Type.Unknown()), ..., value8: ... }`, built from
 * {@link SNAPSHOT_VALUE_FIELD_LIST} rather than typed out by hand, so the
 * contract's field names cannot drift from the list `snapshot.definition.ts`
 * iterates at run time — see that file for why these are fixed fields rather
 * than one `Type.Record`.
 */
const snapshotValueProperties: Record<
  (typeof SNAPSHOT_VALUE_FIELD_LIST)[number],
  TOptional<TUnknown>
> = Object.fromEntries(
  SNAPSHOT_VALUE_FIELD_LIST.map((field) => [field, Type.Optional(Type.Unknown())]),
) as Record<(typeof SNAPSHOT_VALUE_FIELD_LIST)[number], TOptional<TUnknown>>;

const operationsRecord = {
  "./time/workflow-throttle.definition.js": {
    type: "operation",
    description: "Throttles the workflow execution for a specified duration in milliseconds",
    inputSchema: Type.Object({
      ms: Type.Number({ minimum: 0 }),
      lastTimestamp: Type.Optional(Type.Number()),
    }),
    outputSchema: Type.Object({
      throttledMs: Type.Number(),
      timestamp: Type.Number(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: "1.0.0"
  },
  './time/sleep.definition.js': {
    type: 'operation',
    description: 'Pauses workflow execution for the given number of milliseconds',
    inputSchema: Type.Object({
      ms: Type.Number({ minimum: 0 }),
    }),
    outputSchema: Type.Object({
      timestamp: Type.Number(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './value-ops/compare.definition.js': {
    type: 'operation',
    description: 'Compares two values and returns a boolean result for branch to consume',
    inputSchema: Type.Object({
      a: Type.Any(),
      b: Type.Any(),
      operator: Type.Union([
        Type.Literal('eq'),
        Type.Literal('ne'),
        Type.Literal('gt'),
        Type.Literal('gte'),
        Type.Literal('lt'),
        Type.Literal('lte'),
      ]),
    }),
    outputSchema: Type.Object({
      result: Type.Boolean(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './value-ops/echo.definition.js': {
    type: 'operation',
    description: 'Returns its input value unchanged; used to copy/rename storage keys or seed constants',
    inputSchema: Type.Object({
      value: Type.Any(),
    }),
    outputSchema: Type.Object({
      value: Type.Any(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './observability/log.definition.js': {
    type: 'operation',
    description: 'Writes a structured JSON line to the local workflow log',
    inputSchema: Type.Object({
      level: Type.Union([
        Type.Literal('debug'),
        Type.Literal('info'),
        Type.Literal('warn'),
        Type.Literal('error'),
      ]),
      message: Type.String(),
      data: Type.Optional(Type.Any()),
    }),
    outputSchema: Type.Object({
      timestamp: Type.Number(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './observability/snapshot.definition.js': {
    type: 'operation',
    // See snapshot.definition.ts for why this is fixed `valueN` fields rather
    // than a `Type.Record` — `OperationContract`'s `inputSchema` is bounded by
    // `TObject`, which a `Type.Record` schema is not, and `validateSeedData`
    // (@rawbox/runner) pairs a seed to its field via `inputSchema.properties`,
    // which only an object schema has. Field names MUST stay in sync with
    // `SNAPSHOT_VALUE_FIELD_LIST` in ./observability/snapshot-fields.js.
    description: 'Emits its bound inputs as one structured log event; the whole of a read-only monitor workflow',
    inputSchema: Type.Object({
      label: Type.Optional(Type.String()),
      ...snapshotValueProperties,
    }),
    outputSchema: Type.Object({
      label: Type.Optional(Type.String()),
      snapshot: Type.Record(Type.String(), Type.Unknown()),
      count: Type.Number(),
      timestamp: Type.Number(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './value-ops/assert.definition.js': {
    type: 'operation',
    description: 'Succeeds when condition is true, otherwise fails the step with the given message',
    inputSchema: Type.Object({
      condition: Type.Boolean(),
      message: Type.Optional(Type.String()),
    }),
    outputSchema: Type.Object({
      passed: Type.Boolean(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './value-ops/increment.definition.js': {
    type: 'operation',
    description: 'Adds step (default 1) to value; the loop-counter companion to loop-gate',
    inputSchema: Type.Object({
      value: Type.Number(),
      step: Type.Optional(Type.Number()),
    }),
    outputSchema: Type.Object({
      value: Type.Number(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './value-ops/logic.definition.js': {
    type: 'operation',
    description: 'Combines boolean values with and/or/not for branch to consume',
    inputSchema: Type.Object({
      operator: Type.Union([
        Type.Literal('and'),
        Type.Literal('or'),
        Type.Literal('not'),
      ]),
      values: Type.Array(Type.Boolean()),
    }),
    outputSchema: Type.Object({
      result: Type.Boolean(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
} as const;

const controlFlowRecord = {
  './control-flow/jump.definition.js': {
    type: 'control-flow',
    description: 'Jumps to the given step label',
    inputSchema: Type.Object({
      condition: Type.Boolean(),
      label: Type.String(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './control-flow/branch.definition.js': {
    type: 'control-flow',
    description: 'Jumps to thenLabel when condition is true, otherwise to elseLabel',
    inputSchema: Type.Object({
      condition: Type.Boolean(),
      thenLabel: Type.String(),
      elseLabel: Type.String(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './control-flow/switch.definition.js': {
    type: 'control-flow',
    description: 'Jumps to the label mapped to value in caseMap, or to defaultLabel when no case matches',
    inputSchema: Type.Object({
      value: Type.String(),
      caseMap: Type.Record(Type.String(), Type.String()),
      defaultLabel: Type.String(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './control-flow/loop-gate.definition.js': {
    type: 'control-flow',
    description: 'Jumps back to loopLabel while counter < max, otherwise to exitLabel',
    inputSchema: Type.Object({
      counter: Type.Number(),
      max: Type.Number(),
      loopLabel: Type.String(),
      exitLabel: Type.String(),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
  './control-flow/halt.definition.js': {
    type: 'control-flow',
    description:
      'Terminates the workflow early, optionally logging a reason; ends the run as a failure when fail is true',
    // `fail` is a Boolean rather than an `outcome: ok | error` word for one
    // reason: bindings read storage and nothing else (a binding names a storage key and no binding
    // form carries a value), so a Boolean is the only shape another step can *compute* —
    // `value-ops/compare` and `value-ops/logic` write exactly this type, which
    // lets one halt step end the run either way on a condition rather than
    // forcing two steps behind a `branch`. It also matches how every other
    // decision in this plugin is spelled (`branch`/`jump`'s `condition`,
    // `assert`'s `condition`).
    //
    // Optional, and absent means `false`: halting **successfully** is the
    // legitimate default use of this operation, so every document written
    // before this field existed keeps its exact behaviour.
    inputSchema: Type.Object({
      reason: Type.Optional(Type.String()),
      fail: Type.Optional(Type.Boolean()),
    }),
    errorSchema: Type.Object({
      message: Type.String(),
    }),
    version: '1.0.0',
  },
} as const;

export const {
  contractRegistry,
  createOperationDefinition,
  createControlFlowDefinition,
} = setupPluginRegistry({
  operationsRecord,
  controlFlowRecord,
});

export default contractRegistry;
