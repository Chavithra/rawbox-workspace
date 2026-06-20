import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import { ContractRegistryCache } from '../../src/core/contracts/contract-registry-cache.js';
import { ContractRegistryLoader } from '../../src/core/contracts/contract-registry-loader.js';
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

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('build', () => {
    it('should load all valid registries and populate the cache', async () => {
      const loadListSpy = vi
        .spyOn(ContractRegistryLoader, 'loadValidContractRegistryList')
        .mockResolvedValue([mockRegistry1, mockRegistry2]);

      const cache = await ContractRegistryCache.build('/some/folder', 'custom.config.json');

      expect(loadListSpy).toHaveBeenCalledWith('/some/folder', 'custom.config.json');
      expect(cache.getContractRegistryPathList()).toEqual([
        '/path/to/registry1.js',
        '/path/to/registry2.js',
      ]);
      expect(cache.getContractRegistry('/path/to/registry1.js')).toBe(mockRegistry1);
      expect(cache.getContractRegistry('/path/to/registry2.js')).toBe(mockRegistry2);
    });

    it('should use default arguments if not provided', async () => {
      const loadListSpy = vi
        .spyOn(ContractRegistryLoader, 'loadValidContractRegistryList')
        .mockResolvedValue([]);

      await ContractRegistryCache.build();

      expect(loadListSpy).toHaveBeenCalledWith(expect.any(String), 'rawbox.config.json');
    });
  });

  describe('constructor and basic operations', () => {
    it('should initialize with an empty map by default', () => {
      const cache = new ContractRegistryCache();
      expect(cache.getContractRegistryPathList()).toEqual([]);
    });

    it('should initialize with the provided map', () => {
      const map = new Map<string, ContractRegistry<Contract>>([
        [mockRegistry1.contractRegistryPath, mockRegistry1],
      ]);
      const cache = new ContractRegistryCache(map);
      expect(cache.getContractRegistryPathList()).toEqual([mockRegistry1.contractRegistryPath]);
      expect(cache.getContractRegistry(mockRegistry1.contractRegistryPath)).toBe(mockRegistry1);
    });

    it('should add registry to map', () => {
      const cache = new ContractRegistryCache();
      cache.addContractRegistry(mockRegistry1);
      expect(cache.getContractRegistry(mockRegistry1.contractRegistryPath)).toBe(mockRegistry1);
    });

    it('should return undefined if registry not found', () => {
      const cache = new ContractRegistryCache();
      expect(cache.getContractRegistry('non-existent')).toBeUndefined();
    });

    it('should return a cloned map with getContractRegistryMap', () => {
      const cache = new ContractRegistryCache();
      cache.addContractRegistry(mockRegistry1);

      const map = cache.getContractRegistryMap();
      expect(map).toBeInstanceOf(Map);
      expect(map.get(mockRegistry1.contractRegistryPath)).toEqual(mockRegistry1);
      // Ensure it's a clone (though structuredClone copies content, the Map instance itself is different)
      expect(map).not.toBe(cache['registryMap']);
    });
  });

  describe('loadContractRegistry', () => {
    it('should return ok and not call loader if already cached and forceReload is false', async () => {
      const cache = new ContractRegistryCache();
      cache.addContractRegistry(mockRegistry1);

      const loadSpy = vi.spyOn(ContractRegistryLoader, 'loadContractRegistry');

      const result = await cache.loadContractRegistry(mockRegistry1.contractRegistryPath, false);

      expect(result.isOk()).toBe(true);
      expect(loadSpy).not.toHaveBeenCalled();
    });

    it('should call loader and update cache when not cached', async () => {
      const cache = new ContractRegistryCache();
      const loadSpy = vi
        .spyOn(ContractRegistryLoader, 'loadContractRegistry')
        .mockResolvedValue(ok(mockRegistry1));

      const result = await cache.loadContractRegistry(mockRegistry1.contractRegistryPath);

      expect(result.isOk()).toBe(true);
      expect(loadSpy).toHaveBeenCalledWith(mockRegistry1.contractRegistryPath);
      expect(cache.getContractRegistry(mockRegistry1.contractRegistryPath)).toBe(mockRegistry1);
    });

    it('should call loader when forceReload is true even if already cached', async () => {
      const cache = new ContractRegistryCache();
      cache.addContractRegistry(mockRegistry1);

      const updatedRegistry = { ...mockRegistry1, rawboxPluginVersion: '2.0.0' };
      const loadSpy = vi
        .spyOn(ContractRegistryLoader, 'loadContractRegistry')
        .mockResolvedValue(ok(updatedRegistry));

      const result = await cache.loadContractRegistry(mockRegistry1.contractRegistryPath, true);

      expect(result.isOk()).toBe(true);
      expect(loadSpy).toHaveBeenCalledWith(mockRegistry1.contractRegistryPath);
      expect(cache.getContractRegistry(mockRegistry1.contractRegistryPath)).toBe(updatedRegistry);
    });

    it('should return err if loader fails to load registry', async () => {
      const cache = new ContractRegistryCache();
      const loadSpy = vi
        .spyOn(ContractRegistryLoader, 'loadContractRegistry')
        .mockResolvedValue(err('Failed to load file'));

      const result = await cache.loadContractRegistry('/invalid/path');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe('Failed to load file');
      expect(cache.getContractRegistry('/invalid/path')).toBeUndefined();
      expect(loadSpy).toHaveBeenCalledWith('/invalid/path');
    });
  });

  describe('getOrLoadContractRegistry', () => {
    it('should retrieve cached registry without calling loader', async () => {
      const cache = new ContractRegistryCache();
      cache.addContractRegistry(mockRegistry1);

      const loadSpy = vi.spyOn(ContractRegistryLoader, 'loadContractRegistry');

      const result = await cache.getOrLoadContractRegistry(mockRegistry1.contractRegistryPath);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(mockRegistry1);
      expect(loadSpy).not.toHaveBeenCalled();
    });

    it('should load registry using loader if not cached', async () => {
      const cache = new ContractRegistryCache();
      const loadSpy = vi
        .spyOn(ContractRegistryLoader, 'loadContractRegistry')
        .mockResolvedValue(ok(mockRegistry1));

      const result = await cache.getOrLoadContractRegistry(mockRegistry1.contractRegistryPath);

      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBe(mockRegistry1);
      expect(loadSpy).toHaveBeenCalledWith(mockRegistry1.contractRegistryPath);
    });

    it('should return error if registry loading fails', async () => {
      const cache = new ContractRegistryCache();
      const loadSpy = vi
        .spyOn(ContractRegistryLoader, 'loadContractRegistry')
        .mockResolvedValue(err('Load error'));

      const result = await cache.getOrLoadContractRegistry('/invalid/path');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe('Load error');
      expect(loadSpy).toHaveBeenCalledWith('/invalid/path');
    });

    it('should return error if registry loaded but not found in map (e.g. registry value resolved to undefined)', async () => {
      const cache = new ContractRegistryCache();
      // Mocking loader to return ok(undefined)
      const loadSpy = vi
        .spyOn(ContractRegistryLoader, 'loadContractRegistry')
        .mockResolvedValue(ok(undefined as unknown as ContractRegistry<Contract>));

      const result = await cache.getOrLoadContractRegistry('/some/path');

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBe("SignatureRegistry at '/some/path' not found.");
      expect(loadSpy).toHaveBeenCalledWith('/some/path');
    });
  });

  describe('getDefinitionLocationList', () => {
    it('should return a flat list of definition paths with registry paths', () => {
      const cache = new ContractRegistryCache();
      cache.addContractRegistry(mockRegistry1);
      cache.addContractRegistry(mockRegistry2);

      const locations = cache.getDefinitionLocationList();

      expect(locations).toEqual([
        {
          contractRegistryPath: '/path/to/registry1.js',
          definitionPath: './def1.js',
        },
        {
          contractRegistryPath: '/path/to/registry1.js',
          definitionPath: './def2.js',
        },
        {
          contractRegistryPath: '/path/to/registry2.js',
          definitionPath: './def3.js',
        },
      ]);
    });

    it('should return empty list if cache has no registries', () => {
      const cache = new ContractRegistryCache();
      expect(cache.getDefinitionLocationList()).toEqual([]);
    });
  });
});
