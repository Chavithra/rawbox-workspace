import { execSync } from 'node:child_process';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { ContractRegistryCache } from 'rawbox-plugin/core';

export async function registryHash(registryPath: string, options: { json?: boolean } = {}) {
  const absolutePath = path.resolve(process.cwd(), registryPath);

  try {
    // Escape path for windows backslashes in double-quoted template literal
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    
    // Evaluate the typescript file dynamically via a node subprocess using tsx loader
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

    // We replace double quotes inside evalCode to pass it as string
    const stdout = execSync(`node --import tsx --eval "${evalCode.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const contractRecord = JSON.parse(stdout.trim());
    
    // Construct mock registry to run computeHash
    const mockRegistry = { contractRecord };
    const hash = ContractRegistryCache.computeHash(mockRegistry as any);

    if (options.json) {
      console.log(JSON.stringify({ registry: registryPath, hash }));
    } else {
      console.log(hash);
    }
  } catch (error: any) {
    p.log.error(pc.red(`Failed to calculate registry hash: ${error.message}`));
    process.exit(1);
  }
}
