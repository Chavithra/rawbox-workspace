import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { copyTemplateFile } from '../../utils/template.js';
import YAML from 'yaml';

export async function createProject(options: {
  name?: string | undefined;
  packageManager?: 'npm' | undefined;
  install?: boolean | undefined;
} = {}) {
  p.intro(pc.cyan('Create a new Rawbox Project'));

  const answers = await p.group(
    {
      projectName: async () =>
        options.name !== undefined
          ? options.name
          : p.text({
              message: 'What is the name of your project?',
              placeholder: 'my-rawbox-project',
              validate: (val) => {
                if (!val.trim()) return 'Project name is required';
              },
            }),
    },
    {
      onCancel: () => {
        p.cancel('Operation cancelled.');
        process.exit(0);
      },
    }
  );

  const { projectName } = answers;
  const packageManager = 'npm';
  const projectDir = path.resolve(process.cwd(), projectName);
  const shouldInstall = options.install !== false; // default true unless --no-install

  const s = p.spinner();
  s.start(`Generating files in ${pc.green(projectDir)}...`);

  try {
    // 1. Scaffold Root Files
    // package.json (master workspace config)
    const rootPkg = {
      name: projectName,
      version: '1.0.0',
      private: true,
      workspaces: [
        'packages/*'
      ],
      scripts: {
        'build:all': 'npm run build --workspaces',
        'test:all': 'npm run test --workspaces'
      },
      devDependencies: {
        'typescript': '^6.0.3'
      }
    };
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, 'package.json'), JSON.stringify(rootPkg, null, 2), 'utf-8');

    // tsconfig.base.json
    const tsconfigBase = {
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        strict: true,
        declaration: true,
        outDir: './dist',
        rootDir: './src'
      }
    };
    await fs.writeFile(path.join(projectDir, 'tsconfig.base.json'), JSON.stringify(tsconfigBase, null, 2), 'utf-8');

    // 2. Scaffold Packages
    // Create packages/rawbox-plugin-example/
    const pluginDir = path.join(projectDir, 'packages', 'rawbox-plugin-example');
    await fs.mkdir(pluginDir, { recursive: true });
    await copyTemplateFile('plugin/package.json.ejs', path.join(pluginDir, 'package.json'), { pluginName: 'rawbox-plugin-example' });
    await copyTemplateFile('plugin/tsconfig.json.ejs', path.join(pluginDir, 'tsconfig.json'));
    
    // Scaffold plugin src files
    await copyTemplateFile('plugin/src/contract-registry.ts.ejs', path.join(pluginDir, 'src', 'contract-registry.ts'));
    await copyTemplateFile('plugin/src/operations/hello-world.definition.ts.ejs', path.join(pluginDir, 'src', 'operations', 'hello-world.definition.ts'));
    
    // Scaffold test files
    await copyTemplateFile('plugin/tests/hello-world.test.ts.ejs', path.join(pluginDir, 'tests', 'hello-world.test.ts'));

    // Create packages/rawbox-shared-utils/
    const utilsDir = path.join(projectDir, 'packages', 'rawbox-shared-utils');
    await fs.mkdir(utilsDir, { recursive: true });
    
    const utilsPkg = {
      name: 'rawbox-shared-utils',
      version: '1.0.0',
      type: 'module',
      main: 'dist/index.js',
      scripts: {
        build: 'tsc'
      },
      devDependencies: {
        typescript: '^6.0.3'
      }
    };
    await fs.writeFile(path.join(utilsDir, 'package.json'), JSON.stringify(utilsPkg, null, 2), 'utf-8');

    const utilsTsconfig = {
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        outDir: './dist',
        rootDir: './src'
      },
      include: ['src/**/*']
    };
    await fs.writeFile(path.join(utilsDir, 'tsconfig.json'), JSON.stringify(utilsTsconfig, null, 2), 'utf-8');

    await fs.mkdir(path.join(utilsDir, 'src'), { recursive: true });
    const utilsSrcIndex = `export function formatValue(val: number): string {\n  return \`$\${val.toFixed(2)}\`;\n}\n`;
    await fs.writeFile(path.join(utilsDir, 'src', 'index.ts'), utilsSrcIndex, 'utf-8');

    // 3. Scaffold Workspaces
    const liveTradingDir = path.join(projectDir, 'workspaces', 'workspace-example');
    await fs.mkdir(liveTradingDir, { recursive: true });
    await fs.mkdir(path.join(liveTradingDir, 'workflows'), { recursive: true });
    await fs.mkdir(path.join(liveTradingDir, 'logs'), { recursive: true });
    await fs.mkdir(path.join(liveTradingDir, 'db'), { recursive: true });

    // workspace.yaml
    const workspaceJson = {
      name: 'workspace-example',
      workflowPathList: [
        './workflows/example.workflow.yaml',
        './workflows/monitor.workflow.yaml'
      ]
    };
    await fs.writeFile(
      path.join(liveTradingDir, 'workspace.yaml'),
      YAML.stringify(workspaceJson),
      'utf-8'
    );

    // workflows/example.workflow.yaml
    const exampleWorkflowJson = {
      name: 'example',
      pluginPathList: [
        '../../../packages/rawbox-plugin-example'
      ],
      stepList: [
        {
          label: 'fetch-price',
          definitionLocation: {
            contractRegistryHash: 'abc123hash...',
            definitionPath: './operations/fetch-price.definition.js'
          },
          storageLocation: {
            input: {
              symbol: {
                key: 'fetch_price_symbol',
                strategy: { name: 'lmdb-kv', valueSizeMax: 1024 }
              }
            },
            output: {
              price: {
                key: 'fetch_price_output',
                strategy: { name: 'lmdb-kv', valueSizeMax: 1024 }
              }
            },
            error: {
              message: {
                key: 'fetch_price_error',
                strategy: { name: 'lmdb-kv', valueSizeMax: 1024 }
              }
            }
          }
        }
      ]
    };
    await fs.writeFile(
      path.join(liveTradingDir, 'workflows', 'example.workflow.yaml'),
      YAML.stringify(exampleWorkflowJson),
      'utf-8'
    );

    // workflows/monitor.workflow.yaml
    const monitorJson = {
      name: 'monitor',
      pluginPathList: [
        '../../../packages/rawbox-plugin-example'
      ],
      stepList: []
    };
    await fs.writeFile(
      path.join(liveTradingDir, 'workflows', 'monitor.workflow.yaml'),
      YAML.stringify(monitorJson),
      'utf-8'
    );

    // logs/example.log and logs/monitor.log
    await fs.writeFile(path.join(liveTradingDir, 'logs', 'example.log'), '', 'utf-8');
    await fs.writeFile(path.join(liveTradingDir, 'logs', 'monitor.log'), '', 'utf-8');

    // 4. Scaffold Agent Skills
    const skillsToCopy = [
      'rawbox-operation-creation',
      'rawbox-plugin-creation',
      'rawbox-project-creation',
      'rawbox-workflow-creation'
    ];
    for (const skill of skillsToCopy) {
      await copyTemplateFile(
        `skills/${skill}/SKILL.md`,
        path.join(projectDir, '.agents', 'skills', skill, 'SKILL.md')
      );
    }

    s.stop('Files generated successfully.');

    if (shouldInstall) {
      p.note(
        `Installing dependencies with ${pc.yellow(packageManager)}...`,
        'Package Manager Installation'
      );

      const installResult = spawnSync(packageManager, ['install'], {
        cwd: projectDir,
        stdio: 'inherit',
      });

      if (installResult.status !== 0) {
        p.log.error(pc.red(`Failed to install dependencies using ${packageManager}.`));
        process.exit(1);
      }
    } else {
      p.log.info(`Skipping dependency installation (--no-install). Run ${pc.yellow(`cd ${projectName} && npm install`)} manually when ready.`);
    }

    p.outro(pc.green('✅ Project generation complete!'));
    console.log(`\nTo get started:\n  cd ${projectName}\n  npm run build:all\n`);
  } catch (error: any) {
    s.stop('Generation failed.');
    p.log.error(pc.red(`Error generating project: ${error.message}`));
    process.exit(1);
  }
}

