import { describe, it, expect } from 'vitest';
import { setupPluginRegistry } from '../../src/plugin-registry-utils.js';
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
