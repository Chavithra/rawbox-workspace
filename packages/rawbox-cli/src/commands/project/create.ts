import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { copyTemplateFile } from '../../utils/template.js';
import { resolvePluginSdkFloorVersion } from '../../utils/plugin-sdk-version.js';
import { DOCUMENT_KIND, FORMAT_VERSION } from '@rawbox/runner';
import {
  DEFAULT_STORAGE_STRATEGY,
  registryUrlError,
  renderAnnotatedYaml,
  renderRegistryNpmrc,
  renderWorkspaceDocument,
  WORKSPACE_GITIGNORE,
} from '../workspace/create.js';
import { getErrorMessage } from '../../utils/error.js';

/** Package name of the plugin this command scaffolds under `packages/`. */
const EXAMPLE_PLUGIN_PACKAGE = 'rawbox-plugin-example';

/**
 * Specifier for that plugin, relative to the generated workspace directory.
 *
 * `workspaces/workspace-example` -> `../../packages/rawbox-plugin-example`. A
 * relative `file:` specifier is resolved against the **workspace** directory,
 * not against the workflow file, which is why this is two levels up rather
 * than three.
 */
const EXAMPLE_PLUGIN_SPECIFIER = 'file:../../packages/rawbox-plugin-example';

export async function createProject(options: {
  name?: string | undefined;
  packageManager?: 'npm' | undefined;
  install?: boolean | undefined;
  registry?: string | undefined;
} = {}) {
  // `--registry` is optional and never prompted for: absent, the scaffold is
  // exactly what it always was. Validated before anything else so a typo fails
  // here, not as a broken `.npmrc` discovered at install time.
  const registryUrl = options.registry?.trim();
  if (registryUrl !== undefined) {
    const urlError = registryUrlError(registryUrl);
    if (urlError !== undefined) {
      p.log.error(pc.red(urlError));
      process.exit(1);
      return;
    }
  }

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
                if (!val?.trim()) return 'Project name is required';
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
  const shouldInstall = options.install !== false;

  const s = p.spinner();
  s.start(`Generating files in ${pc.green(projectDir)}...`);

  try {
    // 1. Scaffold Root Files
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

    // `.rawbox/` is unrooted, so this one entry also covers every nested
    // workspace's target folder (`workspaces/*/.rawbox/`) — see
    // rawbox-cli README, "Workspace Initialization (`workspace setup`)". `node_modules/` and `dist/` cover what
    // `npm install` and `tsc --build` produce for the scaffolded packages.
    await fs.writeFile(
      path.join(projectDir, '.gitignore'),
      `node_modules/\ndist/\n.rawbox/\n`,
      'utf-8',
    );

    // At the project root, beside the root package.json, so the top-level
    // `npm install` below — and every later one — resolves `@rawbox/*` from
    // the requested registry.
    if (registryUrl !== undefined) {
      await fs.writeFile(
        path.join(projectDir, '.npmrc'),
        renderRegistryNpmrc(registryUrl),
        'utf-8',
      );
    }

    // 2. Scaffold Packages
    const pluginDir = path.join(projectDir, 'packages', 'rawbox-plugin-example');
    await fs.mkdir(pluginDir, { recursive: true });
    // `pluginSdkVersion` is not optional to the template: it renders the peer
    // range. Resolved through the same helper `plugin create` uses, so a plugin
    // scaffolded inside a project and one scaffolded on its own are born
    // identical.
    const pluginSdkVersion = await resolvePluginSdkFloorVersion();
    await copyTemplateFile('plugin/package.json.ejs', path.join(pluginDir, 'package.json'), { pluginName: 'rawbox-plugin-example', pluginSdkVersion });
    await copyTemplateFile('plugin/tsconfig.json.ejs', path.join(pluginDir, 'tsconfig.json'));
    
    await copyTemplateFile('plugin/src/contract-registry.ts.ejs', path.join(pluginDir, 'src', 'contract-registry.ts'));
    await copyTemplateFile('plugin/src/operations/hello-world.definition.ts.ejs', path.join(pluginDir, 'src', 'operations', 'hello-world.definition.ts'));
    
    await copyTemplateFile('plugin/tests/hello-world.test.ts.ejs', path.join(pluginDir, 'tests', 'hello-world.test.ts'));

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

    await fs.writeFile(
      path.join(liveTradingDir, 'workspace.yaml'),
      renderWorkspaceDocument('workspace-example', [
        './workflows/example.workflow.yaml',
        './workflows/monitor.workflow.yaml',
      ]),
      'utf-8'
    );
    // Redundant with the root `.gitignore`'s unrooted `.rawbox/` entry, but
    // written per-workspace too so a workspace copied out of this project on
    // its own still ignores its target folder.
    await fs.writeFile(path.join(liveTradingDir, '.gitignore'), WORKSPACE_GITIGNORE, 'utf-8');

    // The step must call an operation the scaffolded plugin actually provides,
    // or the very first `workflow verify` fails on a fresh project.
    await fs.writeFile(
      path.join(liveTradingDir, 'workflows', 'example.workflow.yaml'),
      renderAnnotatedYaml(
        {
          kind: DOCUMENT_KIND.WORKFLOW,
          formatVersion: FORMAT_VERSION,
          name: 'example',
          description: 'Greets a name using the scaffolded example plugin.',
          plugins: { [EXAMPLE_PLUGIN_PACKAGE]: EXAMPLE_PLUGIN_SPECIFIER },
          storage: {
            defaultStrategy: { ...DEFAULT_STORAGE_STRATEGY },
            keys: { greeting_name: { seed: 'World' } },
          },
          steps: [
            {
              label: 'hello-world',
              plugin: EXAMPLE_PLUGIN_PACKAGE,
              operation: 'operations/hello-world',
              inputs: { name: 'greeting_name' },
              outputs: { greeting: 'hello_world_greeting' },
              errors: { message: 'hello_world_error' },
            },
          ],
        },
        `Rawbox workflow — format v${FORMAT_VERSION}.\n` +
          `\n` +
          `This workflow drives the plugin scaffolded alongside it, so it works as\n` +
          `soon as that plugin compiles:\n` +
          `  npm run build:all\n` +
          `  npx rawbox-cli workflow verify ./workflows/example.workflow.yaml`,
        [
          {
            path: ['plugins'],
            before:
              `Plugins: package name -> npm dependency specifier, the shape of\n` +
              `\`dependencies\` in a package.json. A \`file:\` specifier is resolved\n` +
              `against the workspace directory — the one holding workspace.yaml — not\n` +
              `against this file, so it points at packages/ two levels up.\n` +
              `\n` +
              `Resolved versions and contract-registry hashes live in the generated\n` +
              `\`rawbox.lock\` beside workspace.yaml, never here:\n` +
              `  npx rawbox-cli workflow lock ./workflows/example.workflow.yaml`,
          },
          { path: ['plugins', EXAMPLE_PLUGIN_PACKAGE], quote: true },
          {
            path: ['storage'],
            before:
              `Storage. A strategy describes a box, so it is declared once per key here\n` +
              `and never repeated on a step:\n` +
              `\`keys[key].strategy ?? defaultStrategy\`.`,
          },
          {
            path: ['storage', 'defaultStrategy'],
            before: 'Applies to every key the key table gives no strategy of its own.',
            spaceBefore: false,
          },
          {
            path: ['storage', 'defaultStrategy', 'valueSizeMax'],
            inline: 'largest value this box will hold, in bytes',
          },
          {
            path: ['storage', 'keys'],
            before:
              `The key table — one entry per key, holding everything this document\n` +
              `says about it. Uncomment to say more about a key than the default\n` +
              `covers:\n` +
              `\n` +
              `  keys:\n` +
              `    queue_items:\n` +
              `      strategy:\n` +
              `        name: lmdb-fifo\n` +
              `        queueSizeMax: 1024  # entries the ring holds (1023 usable — one slot is reserved)\n` +
              `        valueSizeMax: 1900  # largest value one item in this queue will hold, in bytes\n` +
              `      seed: []              # an lmdb-fifo seed is a list, so this starts it empty\n` +
              `    shared_state:\n` +
              `      workflow: monitor     # monitor's box: readable here, never written here\n` +
              `\n` +
              `--\n` +
              `\n` +
              `The key below carries a \`seed:\` — its initial value, written into\n` +
              `storage before the first step runs, with the strategy coming from\n` +
              `\`defaultStrategy\` above.\n` +
              `\n` +
              `\`keys:\` is the only way to declare a key. Two earlier top-level\n` +
              `blocks, \`strategies:\` and \`seed:\`, stated the same two facts one map\n` +
              `per fact; both were removed, and a document still writing either is\n` +
              `refused with the \`keys:\` entry that replaces it.\n` +
              `\n` +
              `A seed for an lmdb-fifo key must be a list, and each element becomes one\n` +
              `queue entry: [a, b, c] seeds three, [[a, b, c]] seeds one holding the\n` +
              `list, [] seeds an empty queue.\n` +
              `\n` +
              `A workspace can replace a value here without editing this file —\n` +
              `\`seedOverrides:\` in workspace.yaml, keyed by this file's PATH as\n` +
              `\`workflowPathList\` spells it, or \`--seed key=<json>\` for one run:\n` +
              `\n` +
              `  seedOverrides:\n` +
              `    ./workflows/example.workflow.yaml:\n` +
              `      greeting_name: Ada\n` +
              `\n` +
              `Only the value: never the strategy, the sizing or the owner. A path in\n` +
              `no \`workflowPathList\` entry is an error from every command that loads\n` +
              `the workspace, not a block that silently does nothing.`,
          },
          {
            path: ['steps'],
            before:
              `Steps run top to bottom. \`plugin:\` is a key of \`plugins:\` above, matched\n` +
              `exactly; \`operation:\` is the contract path inside that plugin, so\n` +
              `\`operations/hello-world\` addresses\n` +
              `"./operations/hello-world.definition.js" in its contract registry —\n` +
              `the very key packages/${EXAMPLE_PLUGIN_PACKAGE}/src/contract-registry.ts\n` +
              `declares.`,
          },
          {
            path: ['steps', 0],
            before:
              `\`inputs:\` read storage; \`outputs:\` and \`errors:\` write it. The short\n` +
              `form is the storage key itself. Long forms, for the cases it cannot\n` +
              `express:\n` +
              `\n` +
              `  name: { key: greeting_name }                  the same, spelled out\n` +
              `  name: { key: shared, workflow: monitor }      read another workflow\n` +
              `\n` +
              `\`workflow:\` is legal on inputs only — a step never writes outside its own\n` +
              `workflow, and no binding may name another workspace. A box another\n` +
              `workflow owns is usually better declared once on the key\n` +
              `(\`keys: { shared: { workflow: monitor } }\`), after which the plain short\n` +
              `form reads it; the two must agree wherever both are written. There is no\n` +
              `inline form: a constant is declared as a \`keys:\` entry with a \`seed:\`\n` +
              `and read by key, like this step's \`greeting_name\`.`,
            spaceBefore: false,
          },
        ],
      ),
      'utf-8'
    );

    await fs.writeFile(
      path.join(liveTradingDir, 'workflows', 'monitor.workflow.yaml'),
      renderAnnotatedYaml(
        {
          kind: DOCUMENT_KIND.WORKFLOW,
          formatVersion: FORMAT_VERSION,
          name: 'monitor',
          description: 'Empty starting point for a second workflow.',
          plugins: {},
          storage: { defaultStrategy: { ...DEFAULT_STORAGE_STRATEGY } },
          steps: [],
        },
        `Rawbox workflow — format v${FORMAT_VERSION}.\n` +
          `\n` +
          `A second workflow in the same workspace, empty on purpose: it verifies as\n` +
          `it stands, and grows from here.\n` +
          `  npx rawbox-cli workflow verify ./workflows/monitor.workflow.yaml\n` +
          `\n` +
          `Workflows in one workspace share a \`rawbox.lock\` — it is keyed by package,\n` +
          `so declaring "${EXAMPLE_PLUGIN_PACKAGE}" here too costs one line, not a\n` +
          `second resolved version.`,
        [
          {
            path: ['plugins'],
            before:
              `Plugins: package name -> npm dependency specifier. To reuse the plugin\n` +
              `example.workflow.yaml declares:\n` +
              `\n` +
              `  plugins:\n` +
              `    "${EXAMPLE_PLUGIN_PACKAGE}": "${EXAMPLE_PLUGIN_SPECIFIER}"\n` +
              `\n` +
              `Both workflows must spell the specifier identically; \`workspace verify\`\n` +
              `reports a disagreement as an error.`,
          },
          {
            path: ['storage'],
            before:
              `Storage. The strategy is a property of the key, declared once here:\n` +
              `\`keys[key].strategy ?? defaultStrategy\`. Everything about one key goes\n` +
              `in one \`keys:\` entry — its strategy, its seed, and \`workflow:\` when\n` +
              `another workflow owns the box.`,
          },
          {
            path: ['steps'],
            before:
              `Steps run top to bottom. Add one shaped like this:\n` +
              `\n` +
              `  steps:\n` +
              `    - label: hello-world\n` +
              `      plugin: "${EXAMPLE_PLUGIN_PACKAGE}"\n` +
              `      operation: operations/hello-world\n` +
              `      inputs:\n` +
              `        name: greeting_name\n` +
              `      outputs:\n` +
              `        greeting: hello_world_greeting\n` +
              `      errors:\n` +
              `        message: hello_world_error`,
          },
        ],
      ),
      'utf-8'
    );

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
  } catch (error) {
    s.error('Generation failed.');
    p.log.error(pc.red(`Error generating project: ${getErrorMessage(error)}`));
    process.exit(1);
  }
}

