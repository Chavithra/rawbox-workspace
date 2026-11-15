import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import contractRegistry from '../src/contract-registry.js';

// ---------------------------------------------------------------------------
// The registry is one object literal naming every definition in the package,
// keyed by the path the definition file will be loaded from. Nothing else ties
// the two together: a registry entry with no file behind it is a step that
// resolves and then fails to load at run time, and a definition file with no
// entry is code that can never be addressed. Both directions are checked here
// against the source tree, and each module's `contract` is checked to be the
// registry's own object rather than a copy that could drift.
// ---------------------------------------------------------------------------

const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));

/** Every `*.definition.ts` under `src/`, as the `./<dir>/<name>.definition.js` key the registry uses. */
function definitionKeyListOnDisk(): string[] {
  const keyList: string[] = [];

  for (const entry of readdirSync(SRC_DIR, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.definition.ts')) {
      continue;
    }

    const relativeDir = path.relative(SRC_DIR, entry.parentPath).split(path.sep).join('/');
    keyList.push(`./${relativeDir}/${entry.name.replace(/\.ts$/, '.js')}`);
  }

  return keyList.sort();
}

describe('contract-registry', () => {
  const registryKeyList = Object.keys(contractRegistry.contractRecord).sort();

  it('names exactly the definition modules that exist under src/', () => {
    expect(registryKeyList).toEqual(definitionKeyListOnDisk());
  });

  it('points every key at a source file that exists', () => {
    for (const key of registryKeyList) {
      const sourcePath = path.join(SRC_DIR, key.replace(/\.js$/, '.ts'));
      expect(existsSync(sourcePath), `${key} has no source file at ${sourcePath}`).toBe(true);
    }
  });

  it('is what every definition module binds its handler to, by identity', async () => {
    for (const key of registryKeyList) {
      const module = (await import(`../src/${key.slice(2)}`)) as {
        default: { contract: unknown };
      };

      // `toBe`, not `toEqual`: a structurally equal copy would still pass a
      // schema check while letting the two drift on the next edit.
      expect(module.default.contract, key).toBe(contractRegistry.contractRecord[key as keyof typeof contractRegistry.contractRecord]);
    }
  });

  it('declares a type, a description and a version on every contract', () => {
    for (const [key, contract] of Object.entries(contractRegistry.contractRecord)) {
      expect(['operation', 'control-flow'], key).toContain(contract.type);
      expect(contract.description.length, key).toBeGreaterThan(0);
      expect(contract.version, key).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('records its own module as the registry path', () => {
    expect(contractRegistry.contractRegistryPath).toMatch(/contract-registry\.(ts|js)$/);
  });
});
