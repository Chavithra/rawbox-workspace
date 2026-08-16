import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ContractRegistryCache, type Contract, type ContractRegistry } from '@rawbox/plugin/core';
import { getErrorMessage } from '../../utils/error.js';

/**
 * The `--import tsx` argument for the child process, or `undefined` when the
 * target needs no TypeScript loader.
 *
 * `tsx` is **this package's** dependency, not the user's. Passing the bare
 * specifier `tsx` makes the child resolve it from its own working directory —
 * the user's project — where it is normally absent: a global `rawbox-cli`
 * install puts `tsx` in the global `node_modules`, and a `file:`-linked one puts
 * it beside the link target. Either way the child fails with
 * `Cannot find package 'tsx'`, and the command only ever worked from inside a
 * tree that happened to hoist it.
 *
 * Resolving it here, against this module, yields an absolute path that is
 * correct wherever the CLI itself lives.
 *
 * It is also skipped entirely for a `.js` target, which is the common case —
 * the registry a workflow loads is built output. That keeps the command working
 * even if `tsx` cannot be resolved at all.
 */
function tsxImportArgs(target: string): string[] {
  if (!/\.[cm]?ts$/.test(target)) return [];

  try {
    const require = createRequire(import.meta.url);
    return ['--import', pathToFileURL(require.resolve('tsx')).href];
  } catch {
    // Let the child fail on the TypeScript syntax instead, which at least names
    // the file rather than a package the user never asked for.
    return [];
  }
}

export async function registryHash(registryPath: string, options: { json?: boolean } = {}) {
  const absolutePath = path.resolve(process.cwd(), registryPath);

  try {
    const normalizedPath = absolutePath.replace(/\\/g, '/');

    const evalCode = `
      import('${normalizedPath}')
        .then(m => {
          const reg = m.default || m.contractRegistry;
          if (!reg || !reg.contractRecord) {
            console.error('Invalid registry: missing contractRecord');
            process.exit(1);
          }
          console.log(JSON.stringify(reg.contractRecord));
        })
        .catch(err => {
          console.error(err.stack || err);
          process.exit(1);
        });
    `;

    const importArgs = tsxImportArgs(absolutePath).join(' ');

    const stdout = execSync(
      `node ${importArgs} --eval "${evalCode.replace(/"/g, '\\"')}"`,
      {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );

    const contractRecord = JSON.parse(stdout.trim());
    
    // computeHash only reads `contractRecord`; the remaining registry fields do
    // not affect the hash, so a partial registry is sufficient here.
    const mockRegistry = { contractRecord } as ContractRegistry<Contract>;
    const hash = ContractRegistryCache.computeHash(mockRegistry);

    if (options.json) {
      console.log(JSON.stringify({ registry: registryPath, hash }));
    } else {
      console.log(hash);
    }
  } catch (error) {
    p.log.error(pc.red(`Failed to calculate registry hash: ${getErrorMessage(error)}`));
    process.exit(1);
  }
}
