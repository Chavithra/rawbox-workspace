import { describe, it, expect } from 'vitest';
import { Type } from 'typebox';
import {
  setupOperationContractRegistry,
  operationContractGuard,
  setupOperationContract,
} from '../../src/operation/contract/operation-contract-utils.js';
import type { OperationContract } from '../../src/operation/contract/operation-contract-types.js';

describe('operation-contract-utils', () => {
  const validContract: OperationContract = {
    type: 'operation',
    description: 'Adds two numbers',
    inputSchema: Type.Object({ a: Type.Number(), b: Type.Number() }),
    outputSchema: Type.Object({ result: Type.Number() }),
    errorSchema: Type.Object({ message: Type.String() }),
    version: '1.1.0',
  };

  describe('operationContractGuard', () => {
    it('should return true for a valid operation contract', () => {
      expect(operationContractGuard(validContract)).toBe(true);
    });

    it('should return false if contract is null or undefined', () => {
      expect(operationContractGuard(null as unknown as object)).toBe(false);
      expect(operationContractGuard(undefined as unknown as object)).toBe(false);
    });

    it('should return false if type is not operation', () => {
      expect(
        operationContractGuard({ ...validContract, type: 'control-flow' }),
      ).toBe(false);
    });

    it('should return false if inputSchema is missing', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { inputSchema, ...invalidContract } = validContract;
      expect(operationContractGuard(invalidContract as unknown as object)).toBe(false);
    });

    it('should return false if outputSchema is missing', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { outputSchema, ...invalidContract } = validContract;
      expect(operationContractGuard(invalidContract as unknown as object)).toBe(false);
    });

    it('should return false if errorSchema is missing', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { errorSchema, ...invalidContract } = validContract;
      expect(operationContractGuard(invalidContract as unknown as object)).toBe(false);
    });

    it('should return false if version is missing', () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { version, ...invalidContract } = validContract;
      expect(operationContractGuard(invalidContract as unknown as object)).toBe(false);
    });
  });

  describe('setupOperationContract', () => {
    it('should return the provided contract unmodified', () => {
      const contract = setupOperationContract(validContract);
      expect(contract).toBe(validContract);
    });
  });

  describe('setupOperationContractRegistry', () => {
    it('should correctly initialize a registry with operation contracts', () => {
      const contractRecord = {
        './math/add.js': validContract,
      };

      const registry = setupOperationContractRegistry({
        contractRecord,
      });

      expect(registry.contractRecord).toEqual(contractRecord);
      expect(typeof registry.contractRegistryPath).toBe('string');
    });

    it('should store the optional contractRegistryPath', () => {
      const registryPath = '/absolute/path';
      const registry = setupOperationContractRegistry({
        contractRecord: {},
        contractRegistryPath: registryPath,
      });

      expect(registry.contractRegistryPath).toBe(registryPath);
    });
  });
});
