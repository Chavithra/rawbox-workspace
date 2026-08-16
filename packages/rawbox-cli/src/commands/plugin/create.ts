import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { copyTemplateFile } from '../../utils/template.js';
import { getErrorMessage } from '../../utils/error.js';
import { resolvePluginSdkFloorVersion } from '../../utils/plugin-sdk-version.js';

/**
 * Rawbox plugins are discovered by name, so the convention is enforced up front:
 * a plugin scaffolded under any other name would never be found by the runner.
 * Matches `rawbox-plugin-*`, optionally inside any scope.
 */
function validatePluginName(value: string | undefined): string | undefined {
  if (!value?.trim()) return 'Plugin name is required';

  const name = value.trim();
  const matchesConvention =
    name.startsWith('rawbox-plugin-') || /^@[^/]+\/rawbox-plugin-/.test(name);

  if (!matchesConvention) {
    return `Plugin name must start with 'rawbox-plugin-' (e.g. rawbox-plugin-custom) or '@scope/rawbox-plugin-' (e.g. @acme/rawbox-plugin-custom); got '${name}'`;
  }
  return undefined;
}

export async function createPlugin(options: { name?: string | undefined; install?: boolean | undefined } = {}) {
  p.intro(pc.cyan('Create a new Rawbox Plugin'));

  // Fail fast on a bad --name rather than scaffolding an undiscoverable plugin.
  if (options.name !== undefined) {
    const invalid = validatePluginName(options.name);
    if (invalid) {
      p.cancel(invalid);
      process.exit(1);
    }
  }

  const answers = await p.group(
    {
      pluginName: async () =>
        options.name !== undefined
          ? options.name
          : p.text({
              message: 'What is the name of your plugin?',
              placeholder: 'rawbox-plugin-custom',
              validate: validatePluginName,
            }),
      installDeps: async () =>
        options.install !== undefined
          ? options.install
          : p.confirm({
              message: 'Would you like to automatically run dependency installation?',
              initialValue: true,
            }),
    },
    {
      onCancel: () => {
        p.cancel('Operation cancelled.');
        process.exit(0);
      },
    }
  );

  const { pluginName, installDeps } = answers;
  
  const targetDir = path.resolve(process.cwd(), pluginName);

  const s = p.spinner();
  s.start(`Generating plugin files in ${pc.green(targetDir)}...`);

  try {
    const pluginSdkVersion = await resolvePluginSdkFloorVersion();
    await copyTemplateFile('plugin/package.json.ejs', path.join(targetDir, 'package.json'), { pluginName, pluginSdkVersion });
    await copyTemplateFile('plugin/tsconfig.json.ejs', path.join(targetDir, 'tsconfig.json'));
    
    await copyTemplateFile('plugin/src/contract-registry.ts.ejs', path.join(targetDir, 'src', 'contract-registry.ts'));
    await copyTemplateFile('plugin/src/operations/hello-world.definition.ts.ejs', path.join(targetDir, 'src', 'operations', 'hello-world.definition.ts'));
    
    await copyTemplateFile('plugin/tests/hello-world.test.ts.ejs', path.join(targetDir, 'tests', 'hello-world.test.ts'));

    s.stop('Plugin files generated successfully.');

    if (installDeps) {
      p.note('Installing dependencies...', 'Install dependencies');
      let isMonorepo = false;
      try {
        const pkg = JSON.parse(await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
        if (pkg.workspaces && Array.isArray(pkg.workspaces)) {
          isMonorepo = true;
        }
      } catch {
        // No readable package.json here — treat as a standalone (non-monorepo) target.
      }
      const cwd = isMonorepo ? process.cwd() : targetDir;
      
      const installResult = spawnSync('npm', ['install'], {
        cwd,
        stdio: 'inherit',
      });

      if (installResult.status !== 0) {
        p.log.error(pc.red('Failed to install dependencies.'));
      }
    }

    p.outro(pc.green('✅ Plugin generation complete!'));
  } catch (error) {
    s.error('Generation failed.');
    p.log.error(pc.red(`Error generating plugin: ${getErrorMessage(error)}`));
    process.exit(1);
  }
}
