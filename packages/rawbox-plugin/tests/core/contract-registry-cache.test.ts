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

  // -------------------------------------------------------------------------
  // `timeoutMs` and the registry hash
  //
  // The hash is the address of every step in every workflow, so what does and
  // does not move it is the whole question a new `Contract` field raises. These
  // pin the answer for `timeoutMs`:
  //
  //   - a contract that does not declare one hashes exactly as before, which is
  //     what makes shipping the field a silent, non-breaking release: no lock
  //     file is invalidated by the SDK alone;
  //   - `JSON.stringify` drops an explicitly-`undefined` property, so a plugin
  //     that computes the field and lands on `undefined` is indistinguishable
  //     from one that omitted it. That is deliberate — a later "improvement" to
  //     `computeHash` (canonicalising, deep-sorting, encoding `undefined`) would
  //     break it, and would move every hash in existence for an unrelated
  //     reason;
  //   - a *real* bound is part of the contract and must move the hash: a locked
  //     workspace whose plugin has since gained a timeout is a workspace whose
  //     steps now behave differently.
  //
  // The last case documents the pre-existing property-order sensitivity rather
  // than endorsing it: `computeHash` sorts the definition-path keys, and only
  // those, so reordering fields *inside* a contract literal re-addresses it.
  // Hence the convention that `timeoutMs` goes last, after `version`.
  // -------------------------------------------------------------------------
  describe('computeHash and timeoutMs', () => {
    /** A registry holding one contract, so only the contract varies. */
    const registryOf = (contract: Contract): ContractRegistry<Contract> => ({
      contractRecord: { './def1.js': contract },
      contractRegistryPath: '/path/to/registry1.js',
      rawboxPluginVersion: '1.0.0',
    });

    const baseline = {
      type: 'operation',
      version: '1.0.0',
    } as unknown as Contract;

    const baselineHash = ContractRegistryCache.computeHash(registryOf(baseline));

    it('leaves the hash unchanged when no contract declares a bound', () => {
      // The whole of the compatibility claim: adding the field to the type
      // moves nothing until a plugin uses it.
      expect(ContractRegistryCache.computeHash(registryOf(baseline))).toBe(
        baselineHash,
      );
    });

    it('leaves the hash unchanged when timeoutMs is explicitly undefined', () => {
      const contract = {
        type: 'operation',
        version: '1.0.0',
        timeoutMs: undefined,
      } as unknown as Contract;

      expect(ContractRegistryCache.computeHash(registryOf(contract))).toBe(
        baselineHash,
      );
    });

    it('changes the hash when a plugin declares a real bound', () => {
      const contract = {
        type: 'operation',
        version: '1.0.0',
        timeoutMs: 30_000,
      } as unknown as Contract;

      expect(ContractRegistryCache.computeHash(registryOf(contract))).not.toBe(
        baselineHash,
      );
    });

    it('changes the hash when timeoutMs moves within the contract literal', () => {
      // Not a property of `timeoutMs` — `computeHash` sorts definition-path
      // keys and serialises each contract in its own insertion order, so this
      // holds for every field. Pinned here because it is the reason the field
      // has a documented position rather than a free one.
      const last = {
        type: 'operation',
        version: '1.0.0',
        timeoutMs: 30_000,
      } as unknown as Contract;
      const first = {
        timeoutMs: 30_000,
        type: 'operation',
        version: '1.0.0',
      } as unknown as Contract;

      expect(ContractRegistryCache.computeHash(registryOf(first))).not.toBe(
        ContractRegistryCache.computeHash(registryOf(last)),
      );
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
