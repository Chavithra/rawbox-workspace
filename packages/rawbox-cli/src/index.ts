#!/usr/bin/env node

import process from 'node:process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { createProject } from './commands/project/create.js';
import { createPlugin } from './commands/plugin/create.js';
import { createOperation } from './commands/operation/create.js';
import { createWorkspace } from './commands/workspace/create.js';
import { registryHash } from './commands/registry/hash.js';
import { verifyWorkspace } from './commands/workspace/verify.js';
import { verifyWorkflow } from './commands/workflow/verify.js';
import { runWorkflowCommand } from './commands/workflow/run.js';
import { setupWorkspaceCommand } from './commands/workspace/setup.js';

const cli = yargs(hideBin(process.argv))
  .scriptName('rawbox-cli')
  .usage('$0 <resource> <action> [options]')
  .command(
    'project',
    'Manage Rawbox projects.',
    (yargs) => {
      return yargs
        .command(
          'create',
          'Scaffolds a standard Rawbox project structure (packages, monorepo configurations, and baseline configs).',
          (yargs) => {
            return yargs
              .option('name', {
                alias: 'n',
                description: 'Name of the project directory',
                type: 'string',
              })
              .option('package-manager', {
                alias: 'p',
                description: 'Package manager to initialize the workspace with',
                type: 'string',
                choices: ['npm'],
                default: 'npm',
              })
              .option('install', {
                description: 'Automatically install npm package dependencies after scaffolding',
                type: 'boolean',
                default: true,
              });
          },
          async (argv) => {
            await createProject({
              name: argv.name,
              packageManager: argv['package-manager'] as 'npm' | undefined,
              install: argv.install,
            });
          }
        )
        .demandCommand(1, 'You need to specify a project action.');
    }
  )
  .command(
    'plugin',
    'Manage Rawbox plugins.',
    (yargs) => {
      return yargs
        .command(
          'create',
          'Scaffolds a new custom Rawbox plugin package with contract registry boilerplate.',
          (yargs) => {
            return yargs
              .option('name', {
                alias: 'n',
                description: 'Name of the plugin package',
                type: 'string',
              })
              .option('install', {
                description: 'Automatically install npm package dependencies after scaffolding',
                type: 'boolean',
              });
          },
          async (argv) => {
            await createPlugin({
              name: argv.name,
              install: argv.install,
            });
          }
        )
        .demandCommand(1, 'You need to specify a plugin action.');
    }
  )
  .command(
    'operation',
    'Manage plugin operations.',
    (yargs) => {
      return yargs
        .command(
          'create',
          'Scaffolds a new operation (schemas, definition, handler, and template files) inside an existing plugin.',
          (yargs) => {
            return yargs
              .option('name', {
                alias: 'n',
                description: 'Name of the operation to create',
                type: 'string',
              });
          },
          async (argv) => {
            await createOperation({
              name: argv.name,
            });
          }
        )
        .demandCommand(1, 'You need to specify an operation action.');
    }
  )
  .command(
    'workspace',
    'Manage Rawbox workspaces.',
    (yargs) => {
      return yargs
        .command(
          'create',
          'Scaffolds a new Rawbox workspace JSON configuration to group workflows and plugins.',
          (yargs) => {
            return yargs
              .option('name', {
                alias: 'n',
                description: 'Name of the workspace',
                type: 'string',
              })
              .option('workflows', {
                alias: 'w',
                description: 'Relative paths to the workspace workflows',
                type: 'array',
              });
          },
          async (argv) => {
            await createWorkspace({
              name: argv.name,
              workflows: argv.workflows as string[] | undefined,
            });
          }
        )
        .command(
          'setup <workspace-path> <target-folder>',
          'Prepares a workspace runner target folder, generating files and downloading/linking plugin dependencies.',
          (yargs) => {
            return yargs
              .positional('workspace-path', {
                description: 'Path to the workspace configuration JSON file',
                type: 'string',
              })
              .positional('target-folder', {
                description: 'Path to the target runner environment directory where plugins are linked and package.json is initialized',
                type: 'string',
              });
          },
          async (argv) => {
            await setupWorkspaceCommand(
              argv['workspace-path'] as string,
              argv['target-folder'] as string,
            );
          }
        )
        .command(
          'verify <file>',
          'Verifies workspace JSON structures, configurations, and path references.',
          (yargs) => {
            return yargs.positional('file', {
              description: 'Path to the workspace JSON file to verify',
              type: 'string',
            });
          },
          async (argv) => {
            await verifyWorkspace(argv.file as string);
          }
        )
        .demandCommand(1, 'You need to specify a workspace action.');
    }
  )
  .command(
    'workflow',
    'Manage Rawbox workflows.',
    (yargs) => {
      return yargs
        .command(
          'verify <file>',
          'Verifies a workflow file (schema checks, strict storage boundary checks, and cross-plugin registry hash verification).',
          (yargs) => {
            return yargs
              .positional('file', {
                description: 'Path to the workflow JSON file to verify',
                type: 'string',
              })
              .option('workspace', {
                description: 'Path to the workspace context config file (required to validate storage boundaries and cross-plugin references)',
                type: 'string',
              });
          },
          async (argv) => {
            await verifyWorkflow(argv.file as string, argv.workspace ? { workspace: argv.workspace } : {});
          }
        )
        .command(
          'run <workspace-path> <workflow-path> <log-file-path>',
          'Runs a workflow instance using XState transition orchestration, outputting step state changes to a log file.',
          (yargs) => {
            return yargs
              .positional('workspace-path', {
                description: 'Path to the workspace configuration JSON file',
                type: 'string',
              })
              .positional('workflow-path', {
                description: 'Path to the workflow configuration JSON file',
                type: 'string',
              })
              .positional('log-file-path', {
                description: 'Path to save the generated execution and state transition logs',
                type: 'string',
              });
          },
          async (argv) => {
            await runWorkflowCommand(
              argv['workspace-path'] as string,
              argv['workflow-path'] as string,
              argv['log-file-path'] as string,
            );
          }
        )
        .demandCommand(1, 'You need to specify a workflow action.');
    }
  )
  .command(
    'registry',
    'Manage plugin registries.',
    (yargs) => {
      return yargs
        .command(
          'hash <registry-path>',
          'Calculates and outputs the unique SHA-256 hash signature of a plugin\'s contract registry.',
          (yargs) => {
            return yargs
              .positional('registry-path', {
                description: 'Path to the contract registry file (.ts or .js)',
                type: 'string',
              })
              .option('json', {
                description: 'Format the output signature as JSON',
                type: 'boolean',
                default: false,
              });
          },
          async (argv) => {
            await registryHash(argv['registry-path'] as string, { json: argv.json });
          }
        )
        .demandCommand(1, 'You need to specify a registry action.');
    }
  )
  .demandCommand(1, 'You need to specify a resource.')
  .help()
  .alias('h', 'help')
  .recommendCommands()
  .strict();

await cli.parse();
