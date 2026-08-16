import { describe, it, expect } from 'vitest';
import { setupPluginRegistry } from '../../src/plugin-registry-utils.js';
import { setupContractRegistry } from '../../src/core/contracts/contract-registry-utils.js';
import { TIMEOUT_MS_MAX } from '../../src/core/contracts/contract-registry-types.js';
import type { Contract } from '../../src/core/contracts/contract-registry-types.js';
import { Type } from 'typebox';

describe('setupPluginRegistry', () => {
  it('should work with both operationsRecord and controlFlowRecord', () => {
    const operationsRecord = {
      './ops/hello.js': {
        type: 'operation' as const,
        description: 'Hello',
        inputSchema: Type.Object({}),
        outputSchema: Type.Object({}),
        errorSchema: Type.Object({}),
        version: '1.0.0',
      },
    };
    const controlFlowRecord = {
      './cf/jump.js': {
        type: 'control-flow' as const,
        description: 'Jump',
        inputSchema: Type.Object({}),
        errorSchema: Type.Object({}),
        version: '1.0.0',
      },
    };

    const { contractRegistry, createOperationDefinition, createControlFlowDefinition } = setupPluginRegistry({
      operationsRecord,
      controlFlowRecord,
    });

    expect(contractRegistry.contractRecord).toEqual({
      ...operationsRecord,
      ...controlFlowRecord,
    });
    expect(createOperationDefinition).toBeTypeOf('function');
    expect(createControlFlowDefinition).toBeTypeOf('function');
  });

  it('should work when only operationsRecord is provided', () => {
    const operationsRecord = {
      './ops/hello.js': {
        type: 'operation' as const,
        description: 'Hello',
        inputSchema: Type.Object({}),
        outputSchema: Type.Object({}),
        errorSchema: Type.Object({}),
        version: '1.0.0',
      },
    };

    const { contractRegistry, createOperationDefinition } = setupPluginRegistry({
      operationsRecord,
    });

    expect(contractRegistry.contractRecord).toEqual(operationsRecord);
    expect(createOperationDefinition).toBeTypeOf('function');
  });

  it('should work when only controlFlowRecord is provided', () => {
    const controlFlowRecord = {
      './cf/jump.js': {
        type: 'control-flow' as const,
        description: 'Jump',
        inputSchema: Type.Object({}),
        errorSchema: Type.Object({}),
        version: '1.0.0',
      },
    };

    const { contractRegistry, createControlFlowDefinition } = setupPluginRegistry({
      controlFlowRecord,
    });

    expect(contractRegistry.contractRecord).toEqual(controlFlowRecord);
    expect(createControlFlowDefinition).toBeTypeOf('function');
  });

  it('should work with no parameters', () => {
    const { contractRegistry } = setupPluginRegistry({});
    expect(contractRegistry.contractRecord).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// `timeoutMs` — the bound a contract may declare
//
// `setupContractRegistry` is the one place every registry is built, so it is
// the one place the bound can be checked before anything can address a step
// through it. A registry is built at module evaluation, so these throws land
// on `import`.
// ---------------------------------------------------------------------------

describe('setupContractRegistry — timeoutMs', () => {
  const contractOf = (timeoutMs: unknown): Record<string, Contract> =>
    ({
      './ops/fetch.definition.js': {
        type: 'operation',
        description: 'Fetches something over a network',
        inputSchema: Type.Object({}),
        outputSchema: Type.Object({}),
        errorSchema: Type.Object({}),
        version: '1.0.0',
        timeoutMs,
      },
    }) as unknown as Record<string, Contract>;

  const build = (timeoutMs: unknown) =>
    setupContractRegistry({ contractRecord: contractOf(timeoutMs) });

  it('accepts a whole number of milliseconds inside the range', () => {
    expect(() => build(30_000)).not.toThrow();
    expect(() => build(1)).not.toThrow();
    expect(() => build(TIMEOUT_MS_MAX)).not.toThrow();
  });

  it('accepts a contract that declares no bound at all', () => {
    const contractRecord = {
      './ops/fetch.definition.js': {
        type: 'operation',
        description: 'Fetches something over a network',
        version: '1.0.0',
      },
    } as unknown as Record<string, Contract>;

    expect(() =>
      setupContractRegistry({ contractRecord }),
    ).not.toThrow();
  });

  it('rejects 0, which reads as "no bound" but fires immediately', () => {
    expect(() => build(0)).toThrow(/at least 1ms/);
  });

  it('rejects a value above the setTimeout ceiling, which would invert it', () => {
    expect(() => build(TIMEOUT_MS_MAX + 1)).toThrow(/TimeoutOverflowWarning/);
  });

  it('rejects a non-integer, a non-number and a non-finite value', () => {
    expect(() => build(1.5)).toThrow(/not a whole number/);
    expect(() => build('5000')).toThrow(/of type string/);
    expect(() => build(null)).toThrow(/is null/);
    expect(() => build(Number.POSITIVE_INFINITY)).toThrow(/Infinity/);
    expect(() => build(Number.NaN)).toThrow(/NaN/);
  });

  it('names the offending definition path and how to declare unbounded', () => {
    // A registry is one literal holding every contract in the package, so the
    // path is the only thing that says *which* contract, and "omit the key" is
    // the answer to the question the author is about to ask.
    expect(() => build(-1)).toThrow(/"\.\/ops\/fetch\.definition\.js"/);
    expect(() => build(-1)).toThrow(/omit the key/);
  });

  it('checks contracts reached through setupPluginRegistry too', () => {
    // The merged path: both older single-type registries and the modern
    // two-record one funnel through the same choke point.
    expect(() =>
      setupPluginRegistry({
        controlFlowRecord: {
          './cf/jump.js': {
            type: 'control-flow' as const,
            description: 'Jump',
            inputSchema: Type.Object({}),
            errorSchema: Type.Object({}),
            version: '1.0.0',
            timeoutMs: 0,
          },
        },
      }),
    ).toThrow(/timeoutMs/);
  });
});
