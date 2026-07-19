import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { ContractRegistryCache } from '../../src/core/contracts/contract-registry-cache.js';
import type { Contract, ContractRegistry } from '../../src/core/contracts/contract-registry-types.js';

describe('ContractRegistryCache', () => {
  const mockRegistry1: ContractRegistry<Contract> = {
    contractRecord: {
      './def1.js': { type: 'operation' },
      './def2.js': { type: 'operation' },
    },
    contractRegistryPath: '/path/to/registry1.js',
    rawboxPluginVersion: '1.0.0',
  };

  const mockRegistry2: ContractRegistry<Contract> = {
    contractRecord: {
      './def3.js': { type: 'operation' },
    },
    contractRegistryPath: '/path/to/registry2.js',
    rawboxPluginVersion: '1.0.0',
  };

  const getHash = (reg: ContractRegistry<Contract>) =>
    crypto.createHash('sha256').update(JSON.stringify(reg.contractRecord)).digest('hex');

  describe('constructor and basic operations', () => {
    it('should initialize with an empty map by default', () => {
      const cache = new ContractRegistryCache();
      expect(cache.getContractRegistryMap().size).toBe(0);
    });

    it('should initialize with the provided map', () => {
      const hash1 = getHash(mockRegistry1);
      const initMap = new Map<string, ContractRegistry<Contract>>([
        [hash1, mockRegistry1],
      ]);
      const cache = new ContractRegistryCache(initMap);
      expect(cache.getContractRegistryMap().size).toBe(1);
      expect(cache.getContractRegistry(hash1)).toBe(mockRegistry1);
    });

    it('should add registry to map', () => {
      const cache = new ContractRegistryCache();
      const hash = cache.addContractRegistry(mockRegistry1);
      expect(cache.getContractRegistry(hash)).toBe(mockRegistry1);
    });

    it('should return undefined if registry not found', () => {
      const cache = new ContractRegistryCache();
      expect(cache.getContractRegistry('non-existent')).toBeUndefined();
    });

    it('should return a cloned map with getContractRegistryMap', () => {
      const cache = new ContractRegistryCache();
      const hash = cache.addContractRegistry(mockRegistry1);

      const registryMap = cache.getContractRegistryMap();
      expect(registryMap).toBeInstanceOf(Map);
      expect(registryMap.get(hash)).toEqual(mockRegistry1);
      expect(registryMap).not.toBe(cache['registryMap']);
    });
  });

  describe('getDefinitionLocationList', () => {
    it('should return a flat list of definition paths with registry paths (hashes)', () => {
      const cache = new ContractRegistryCache();
      const hash1 = cache.addContractRegistry(mockRegistry1);
      const hash2 = cache.addContractRegistry(mockRegistry2);

      const locations = cache.getDefinitionLocationList();

      expect(locations).toEqual([
        {
          contractRegistryHash: hash1,
          definitionPath: './def1.js',
        },
        {
          contractRegistryHash: hash1,
          definitionPath: './def2.js',
        },
        {
          contractRegistryHash: hash2,
          definitionPath: './def3.js',
        },
      ]);
    });

    it('should return empty list if map has no registries', () => {
      const cache = new ContractRegistryCache();
      expect(cache.getDefinitionLocationList()).toEqual([]);
    });
  });
});
