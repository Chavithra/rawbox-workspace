import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { copyTemplateFile } from '../../utils/template.js';

export async function createPlugin(options: { name?: string | undefined; install?: boolean | undefined } = {}) {
  p.intro(pc.cyan('Create a new Rawbox Plugin'));

  const answers = await p.group(
    {
      pluginName: async () =>
        options.name !== undefined
          ? options.name
          : p.text({
              message: 'What is the name of your plugin?',
              placeholder: 'rawbox-plugin-custom',
              validate: (val) => {
                if (!val.trim()) return 'Plugin name is required';
              },
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
    // Scaffold plugin root files
    await copyTemplateFile('plugin/package.json.ejs', path.join(targetDir, 'package.json'), { pluginName });
    await copyTemplateFile('plugin/tsconfig.json.ejs', path.join(targetDir, 'tsconfig.json'));
    
    // Scaffold plugin src files
    await copyTemplateFile('plugin/src/contract-registry.ts.ejs', path.join(targetDir, 'src', 'contract-registry.ts'));
    await copyTemplateFile('plugin/src/operations/hello-world.definition.ts.ejs', path.join(targetDir, 'src', 'operations', 'hello-world.definition.ts'));
    
    // Scaffold test files
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
      } catch {}
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
  } catch (error: any) {
    s.stop('Generation failed.');
    p.log.error(pc.red(`Error generating plugin: ${error.message}`));
    process.exit(1);
  }
}
