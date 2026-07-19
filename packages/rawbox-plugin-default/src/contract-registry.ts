import { Type } from 'typebox';
import { setupPluginRegistry } from 'rawbox-plugin';

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
  './control-flow/definitions/jump.definition.js': {
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
  './control-flow/definitions/branch.definition.js': {
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
  './control-flow/definitions/switch.definition.js': {
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
  './control-flow/definitions/loop-gate.definition.js': {
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
  './control-flow/definitions/halt.definition.js': {
    type: 'control-flow',
    description: 'Terminates the workflow early, optionally logging a reason',
    inputSchema: Type.Object({
      reason: Type.Optional(Type.String()),
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
