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
import { runCommandDefinition } from './commands/workflow/run.js';
import { setupWorkspaceCommand } from './commands/workspace/setup.js';
import { pluginInfo } from './commands/plugin/info.js';
import { lockWorkflow } from './commands/workflow/lock.js';
import { runsListCommand } from './commands/runs/list.js';
import { runsShowCommand } from './commands/runs/show.js';
import { runsTailCommand } from './commands/runs/tail.js';
import { runsPruneCommand } from './commands/runs/prune.js';
import { storeListCommand } from './commands/store/list.js';
import { storeGetCommand } from './commands/store/get.js';
import { storeWatchCommand } from './commands/store/watch.js';
import { workspaceStatusCommand } from './commands/workspace/status.js';
import { workspaceLogsCommand } from './commands/workspace/logs.js';

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
              })
              .option('registry', {
                description:
                  'Write an .npmrc at the project root routing the @rawbox scope to this ' +
                  'registry URL (http/https), e.g. a local Verdaccio. Third-party packages ' +
                  'keep resolving from the ambient registry.',
                type: 'string',
                requiresArg: true,
              });
          },
          async (argv) => {
            await createProject({
              name: argv.name,
              packageManager: argv['package-manager'] as 'npm' | undefined,
              install: argv.install,
              registry: argv.registry as string | undefined,
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
        .command(
          'info <file>',
          'Reports the plugins a workflow requires: specifier, resolved version, install status, registry hash and rawbox.lock agreement.',
          (yargs) => {
            return yargs
              .positional('file', {
                description: 'Path to the workflow file to inspect',
                type: 'string',
              })
              .option('workspace', {
                description: 'Path to the workspace context config file (used to locate rawbox.lock)',
                type: 'string',
              });
          },
          async (argv) => {
            await pluginInfo(
              argv.file as string,
              argv.workspace ? { workspace: argv.workspace } : {},
            );
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
    'run <workflow-path>',
    'Runs a workflow instance using XState transition orchestration, outputting step state changes to a log file. Alias for `workflow run`.',
    runCommandDefinition.builder,
    runCommandDefinition.handler,
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
              })
              .option('registry', {
                description:
                  'Write an .npmrc beside the generated workspace.yaml routing the @rawbox ' +
                  'scope to this registry URL (http/https), e.g. a local Verdaccio. ' +
                  '`workspace setup` copies it into the target folder so its installs honour it.',
                type: 'string',
                requiresArg: true,
              });
          },
          async (argv) => {
            await createWorkspace({
              name: argv.name,
              workflows: argv.workflows as string[] | undefined,
              registry: argv.registry as string | undefined,
            });
          }
        )
        .command(
          'setup <workspace-path> [target-folder]',
          'Prepares a workspace runner target folder, generating files and downloading/linking plugin dependencies.',
          (yargs) => {
            return yargs
              .positional('workspace-path', {
                description: 'Path to the workspace configuration JSON file',
                type: 'string',
              })
              .positional('target-folder', {
                description:
                  'Path to the target runner environment directory where plugins are linked and package.json is initialized. ' +
                  'Defaults to `targetFolder:` in the workspace file, and failing that to the workspace directory itself.',
                type: 'string',
              })
              .option('install-links', {
                description:
                  'Copy `file:` plugins and install their own dependencies instead of symlinking them, making the target folder portable. ' +
                  'The default symlink keeps a locally developed plugin live: rebuild it and the next run picks it up with no second setup.',
                type: 'boolean',
                default: false,
              });
          },
          async (argv) => {
            await setupWorkspaceCommand(
              argv['workspace-path'] as string,
              argv['target-folder'] as string | undefined,
              { installLinks: argv['install-links'] as boolean },
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
        .command(
          'status [path]',
          'One snapshot of the whole system: every workflow the workspace lists, its latest ' +
            "run's liveness/age/last event/step counts/last error, and a compact storage panel " +
            '(OBSERVABILITY.md, "CLI surfaces").',
          (yargs) => {
            return yargs
              .positional('path', {
                description:
                  'Path to the workspace document, or a directory containing exactly one. Omit ' +
                  'to look for one directly inside the current directory. A bare workspace name ' +
                  'is not accepted here — this command needs the document itself to know its ' +
                  'workflowPathList.',
                type: 'string',
              })
              .option('watch', {
                description:
                  'Re-render on an interval instead of printing once. Takes an optional ' +
                  'millisecond period (--watch 5000); with none, polls every 2000ms. Clears and ' +
                  'redraws the terminal each render — no TUI library.',
                type: 'string',
              })
              .option('output', {
                description: 'Output shape.',
                type: 'string',
                choices: ['text', 'json'],
                default: 'text',
              });
          },
          async (argv) => {
            const watchArg = argv.watch as string | undefined;
            await workspaceStatusCommand(argv.path as string | undefined, {
              output: argv.output as 'text' | 'json',
              ...(watchArg !== undefined
                ? {
                    watch: true,
                    ...(watchArg.trim() !== '' ? { watchIntervalMs: Number(watchArg) } : {}),
                  }
                : {}),
            });
          },
        )
        .command(
          'logs [path]',
          'Merges the NDJSON event streams of this workspace\'s runs by timestamp, one coloured ' +
            'line per event — live runs by default, finished ones via --run/--since (the ' +
            'post-mortem path, which merges identically to live). Cross-process clock skew ' +
            'between the runs being merged is NOT corrected (OBSERVABILITY.md, "CLI surfaces").',
          (yargs) => {
            return yargs
              .positional('path', {
                description:
                  'Path to the workspace document, or a directory containing exactly one, or a ' +
                  'bare workspace name looked up under a discovered data root. Omit to look for ' +
                  'a document directly inside the current directory.',
                type: 'string',
              })
              .option('follow', {
                alias: 'f',
                description:
                  'Keep polling every selected run\'s log for appended lines and re-merging them ' +
                  'in timestamp order until stopped. In the default/--since selection modes, a ' +
                  'run that newly matches after --follow started joins the merge; --run is a ' +
                  'fixed list and never grows.',
                type: 'boolean',
                default: false,
              })
              .option('workflow', {
                description: 'Limit the merge to these workflow(s) (registry `workflow` field). Repeatable.',
                type: 'string',
                array: true,
              })
              .option('since', {
                description:
                  'Select every run whose lifetime overlaps [t, now], finished or not — the ' +
                  'post-mortem selector. ISO-8601 (e.g. "2026-08-09T10:00:00Z") or a relative ' +
                  'shorthand ("15m", "2h", "90s", "1d"). Mutually exclusive with --run.',
                type: 'string',
              })
              .option('run', {
                description:
                  'Select exactly these run id(s), including already-finished ones, via the ' +
                  'registry. Repeatable. Mutually exclusive with --since.',
                type: 'string',
                array: true,
              })
              .conflicts('since', 'run')
              .option('output', {
                description:
                  'Output shape: text prints "HH:MM:SS.mmm [workflow] event summary", coloured ' +
                  'per workflow (picocolors; respects NO_COLOR); json prints the merged raw event ' +
                  'objects, one per line, for jq.',
                type: 'string',
                choices: ['text', 'json'],
                default: 'text',
              });
          },
          async (argv) => {
            await workspaceLogsCommand(argv.path as string | undefined, {
              follow: argv.follow as boolean,
              output: argv.output as 'text' | 'json',
              ...(argv.workflow ? { workflowList: argv.workflow as string[] } : {}),
              ...(argv.since ? { since: argv.since as string } : {}),
              ...(argv.run ? { runIdList: argv.run as string[] } : {}),
            });
          },
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
              })
              .option('workspace-name', {
                description:
                  'Verify against a synthesized, workspace-less context named <name> — the same ' +
                  'implicit workspace `workflow run --workspace-name` would build, scoped to just ' +
                  'this workflow, with no document read from or written to disk. Requires a value. ' +
                  'Mutually exclusive with --workspace.',
                type: 'string',
                requiresArg: true,
              })
              .conflicts('workspace', 'workspace-name')
              .option('seed', {
                description:
                  'Check a --seed key=<json> override before running it: same flag, same rules, ' +
                  'same precedence (CLI > workspace > workflow) as `workflow run --seed`. ' +
                  'Repeatable. NOT a channel for secrets — the value lands in this shell\'s ' +
                  'history like any other argument; backends: entries interpolate ${ENV_VAR} ' +
                  'references for connection credentials instead.',
                type: 'array',
                string: true,
              });
          },
          async (argv) => {
            await verifyWorkflow(argv.file as string, {
              ...(argv.workspace ? { workspace: argv.workspace as string } : {}),
              ...(argv['workspace-name'] ? { workspaceName: argv['workspace-name'] as string } : {}),
              ...(argv.seed ? { seed: argv.seed as string[] } : {}),
            });
          }
        )
        .command(
          'run <workflow-path>',
          'Runs a workflow instance using XState transition orchestration, outputting step state changes to a log file.',
          runCommandDefinition.builder,
          runCommandDefinition.handler,
        )
        .command(
          'lock <file>',
          'Resolves every plugin declared by the workflow and writes the workspace rawbox.lock. The workflow file is never modified.',
          (yargs) => {
            return yargs
              .positional('file', {
                description: 'Path to the workflow file whose plugins are locked',
                type: 'string',
              })
              .option('workspace', {
                description: 'Path to the workspace context config file (determines where rawbox.lock is written)',
                type: 'string',
              });
          },
          async (argv) => {
            await lockWorkflow(
              argv.file as string,
              argv.workspace ? { workspace: argv.workspace } : {},
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
  .command(
    'runs',
    'Inspect the run registry: history, liveness, logs and retention (OBSERVABILITY.md, "The run registry").',
    (yargs) => {
      return yargs
        .command(
          'list [workspace]',
          'Lists recorded runs — id, workflow, status (with crash detection), age, duration, step counts. ' +
            'Given a workspace, lists only its runs; omitted, scans project-wide from the current directory.',
          (yargs) => {
            return yargs
              .positional('workspace', {
                description:
                  'Path to a workspace document, a directory holding exactly one, or a bare workspace name ' +
                  'under a discovered data root. Omit to scan project-wide from the current directory.',
                type: 'string',
              })
              .option('output', {
                description: 'Output shape.',
                type: 'string',
                choices: ['text', 'json'],
                default: 'text',
              });
          },
          async (argv) => {
            await runsListCommand({
              ...(argv.workspace ? { workspace: argv.workspace as string } : {}),
              output: argv.output as 'text' | 'json',
            });
          },
        )
        .command(
          'show <run-id>',
          "Prints one run's registry entry plus a summary of its NDJSON log (event counts, last event, last error).",
          (yargs) => {
            return yargs
              .positional('run-id', {
                description: 'The run id to inspect (as printed by `runs list` or a run\'s own output).',
                type: 'string',
              })
              .option('output', {
                description: 'Output shape.',
                type: 'string',
                choices: ['text', 'json'],
                default: 'text',
              });
          },
          async (argv) => {
            await runsShowCommand(argv['run-id'] as string, {
              output: argv.output as 'text' | 'json',
            });
          },
        )
        .command(
          'tail <run-id>',
          "Prints (and, with -f, follows) one run's NDJSON log without needing to know its path.",
          (yargs) => {
            return yargs
              .positional('run-id', {
                description: 'The run id whose log to print.',
                type: 'string',
              })
              .option('follow', {
                alias: 'f',
                description: 'Keep printing appended lines until stopped, like `tail -f`.',
                type: 'boolean',
                default: false,
              });
          },
          async (argv) => {
            await runsTailCommand(argv['run-id'] as string, {
              follow: argv.follow as boolean,
            });
          },
        )
        .command(
          'prune [workspace]',
          'Deletes registry entries and their log files down to a bound. Defaults come from ' +
            'the workspace document\'s `logs.prune:` section when present, and --max-bytes is ' +
            'the primary bound.',
          (yargs) => {
            return yargs
              .positional('workspace', {
                description: 'Path to a workspace document. Omit to prune every workspace found under the current directory.',
                type: 'string',
              })
              .option('keep', {
                description: 'Keep only the N most recently started runs.',
                type: 'number',
              })
              .option('older-than', {
                description: 'Delete anything started more than this many days ago.',
                type: 'number',
              })
              .option('max-bytes', {
                description: 'Delete oldest-first until the surviving set is at or under this many bytes (the primary bound).',
                type: 'number',
              })
              .option('output', {
                description: 'Output shape.',
                type: 'string',
                choices: ['text', 'json'],
                default: 'text',
              });
          },
          async (argv) => {
            await runsPruneCommand({
              ...(argv.workspace ? { workspace: argv.workspace as string } : {}),
              ...(argv.keep !== undefined ? { keep: argv.keep as number } : {}),
              ...(argv['older-than'] !== undefined ? { olderThanDays: argv['older-than'] as number } : {}),
              ...(argv['max-bytes'] !== undefined ? { maxBytes: argv['max-bytes'] as number } : {}),
              output: argv.output as 'text' | 'json',
            });
          },
        )
        .demandCommand(1, 'You need to specify a runs action.');
    },
  )
  .command(
    'store',
    'Inspect the LMDB-backed state a workspace has written — key/value cells and FIFO queues ' +
      '(OBSERVABILITY.md, "Store observation"). Read-only: no action in this group ever accepts a ' +
      'write or delete flag; mutating state by hand is out of scope by design.',
    (yargs) => {
      return yargs
        .command(
          'list <workspace>',
          'Lists every storage key a workspace has written: key, workflow, strategy, byte size, ' +
            'and FIFO depth/capacity. Sizes are the UNCOMPRESSED bytes valueSizeMax is checked ' +
            'against, never on-disk bytes. When the workspace document is resolvable, joins the ' +
            "declared valueSizeMax/queueSizeMax per key and reports declared-vs-actual; a key " +
            "bound only by a step and declared nowhere falls back to storage.defaultStrategy, " +
            'exactly as the runner resolves it, and is labelled "bound" rather than "declared".',
          (yargs) => {
            return yargs
              .positional('workspace', {
                description:
                  'A bare workspace name (looked up under a discovered .rawbox/data root), or ' +
                  'a path to a workspace document or its directory.',
                type: 'string',
              })
              .option('workflow', {
                description: 'Limit the listing to one workflow (database) in the environment.',
                type: 'string',
              })
              .option('output', {
                description: 'Output shape.',
                type: 'string',
                choices: ['text', 'json'],
                default: 'text',
              });
          },
          async (argv) => {
            await storeListCommand(argv.workspace as string, {
              ...(argv.workflow ? { workflow: argv.workflow as string } : {}),
              output: argv.output as 'text' | 'json',
            });
          },
        )
        .command(
          'get <workspace> <workflow> <key>',
          "Prints one storage key's value, non-destructively on both strategies — a FIFO key is " +
            'peeked, never dequeued, and its depth is unchanged by running this command. There is ' +
            'NO write or delete flag on this command: mutating state by hand is out of scope for ' +
            '`store` by design; use the workflow that owns the key to change it.',
          (yargs) => {
            return yargs
              .positional('workspace', {
                description:
                  'A bare workspace name (looked up under a discovered .rawbox/data root), or ' +
                  'a path to a workspace document or its directory.',
                type: 'string',
              })
              .positional('workflow', {
                description: 'The workflow (database) the key belongs to.',
                type: 'string',
              })
              .positional('key', {
                description: 'The storage key to read.',
                type: 'string',
              })
              .option('full', {
                description:
                  'Print the value with no truncation. By default a large value is truncated ' +
                  'in text output.',
                type: 'boolean',
                default: false,
              })
              .option('output', {
                description: 'Output shape.',
                type: 'string',
                choices: ['text', 'json'],
                default: 'text',
              });
          },
          async (argv) => {
            await storeGetCommand(
              argv.workspace as string,
              argv.workflow as string,
              argv.key as string,
              { full: argv.full as boolean, output: argv.output as 'text' | 'json' },
            );
          },
        )
        .command(
          'watch <workspace> [key..]',
          "Polls a workspace's storage on an interval and prints keys whose value changed since " +
            'the previous poll, with timestamps. Each poll is a fresh, independently-released ' +
            "read snapshot — nothing is held open across polls. A `key` selector is " +
            '"<workflow>:<key>"; give none to watch every key currently in the workspace.',
          (yargs) => {
            return yargs
              .positional('workspace', {
                description:
                  'A bare workspace name (looked up under a discovered .rawbox/data root), or ' +
                  'a path to a workspace document or its directory.',
                type: 'string',
              })
              .positional('key', {
                description: '"<workflow>:<key>" selectors to watch. Omit to watch every key.',
                type: 'string',
                array: true,
              })
              .option('interval', {
                description: 'Poll period, in milliseconds.',
                type: 'number',
                default: 1000,
              })
              .option('output', {
                description:
                  'Output shape: text prints one line per change; json streams one change record per line.',
                type: 'string',
                choices: ['text', 'json'],
                default: 'text',
              });
          },
          async (argv) => {
            await storeWatchCommand(
              argv.workspace as string,
              (argv.key as string[] | undefined) ?? [],
              { interval: argv.interval as number, output: argv.output as 'text' | 'json' },
            );
          },
        )
        .demandCommand(1, 'You need to specify a store action.');
    },
  )
  .demandCommand(1, 'You need to specify a resource.')
  .help()
  .alias('h', 'help')
  .recommendCommands()
  .strict();

await cli.parse();
