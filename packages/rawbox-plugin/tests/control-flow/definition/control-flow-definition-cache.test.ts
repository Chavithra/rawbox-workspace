import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';

import { ControlFlowDynamicCaller } from '../../../src/control-flow/definition/control-flow-definition-cache.js';
import { setupContractRegistry } from '../../../src/core/contracts/contract-registry-utils.js';

describe('ControlFlowDynamicCaller.callDefinition', () => {
  it('reports a definition that cannot be loaded as an Err, never a throw', async () => {
    // A registry whose path points nowhere: `loadControlFlowDefinition` answers
    // with an `Err`, and the caller's `ValidatedResult` signature promises that
    // `Err` reaches the caller as a value rather than as an exception.
    const contractRegistry = setupContractRegistry({
      contractRecord: {
        './cf/missing.definition.js': {
          type: 'control-flow' as const,
          description: 'Never on disk',
          inputSchema: Type.Object({}),
          errorSchema: Type.Object({}),
          version: '1.0.0',
        },
      },
      contractRegistryPath: '/nonexistent/registry.js',
    });

    const caller = new ControlFlowDynamicCaller(contractRegistry);
    const result = await caller.callDefinition('./cf/missing.definition.js', {});

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Failed to load control-flow definition');
    expect(error.message).toContain('./cf/missing.definition.js');
  });
});
