import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';

import { OperationDynamicCaller } from '../../../src/operation/definition/operation-definition-cache.js';
import { setupContractRegistry } from '../../../src/core/contracts/contract-registry-utils.js';

describe('OperationDynamicCaller.callDefinition', () => {
  it('reports a definition that cannot be loaded as an Err, never a throw', async () => {
    // A registry whose path points nowhere: `loadOperationDefinition` answers
    // with an `Err`, and the caller's `ValidatedResult` signature promises that
    // `Err` reaches the caller as a value rather than as an exception.
    const contractRegistry = setupContractRegistry({
      contractRecord: {
        './ops/missing.definition.js': {
          type: 'operation' as const,
          description: 'Never on disk',
          inputSchema: Type.Object({}),
          outputSchema: Type.Object({}),
          errorSchema: Type.Object({}),
          version: '1.0.0',
        },
      },
      contractRegistryPath: '/nonexistent/registry.js',
    });

    const caller = new OperationDynamicCaller(contractRegistry);
    const result = await caller.callDefinition('./ops/missing.definition.js', {});

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Failed to load operation definition');
    expect(error.message).toContain('./ops/missing.definition.js');
  });
});
