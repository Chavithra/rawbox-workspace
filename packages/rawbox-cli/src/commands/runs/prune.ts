/**
 * `runs prune [workspace] [--keep N | --older-than D | --max-bytes B]` — the
 * CLI-facing wrapper around `runs/prune.ts`'s `pruneRuns`
 * (OBSERVABILITY.md, "Retention"). Flags override a workspace's own
 * `logs.prune:`; `--keep` falls back to a built-in default
 * (`DEFAULT_PRUNE_KEEP`) when neither supplies one — `--max-bytes` does not,
 * and stays unset (no bound of that kind) unless a flag or the workspace
 * document supplies it. All three are resolved by `@rawbox/runner`'s
 * `resolveLogsConfig` (`workspace/logs.ts`) — CLI flag > `logs.prune:` >
 * built-in default, per bound.
 *
 * `workspace` is optional, exactly like `runs list`: given, only that
 * workspace's runs are pruned, against *that* workspace's own `logs.prune:`.
 * Omitted, every `.rawbox/runs` directory found under `cwd` is pruned
 * independently — and **each now answers for itself**: the workspace
 * document found directly alongside its target folder (the default
 * `<workspaceDir>/.rawbox` layout — see {@link findWorkspaceDocumentIn})
 * supplies that workspace's own bounds, rather than every workspace under
 * `cwd` sharing one project-wide file the way `rawbox.config.json` did. A
 * target folder whose workspace document cannot be found or loaded — a
 * customised `targetFolder:` pointing elsewhere, an invalid document — falls
 * back to the built-in default for that one target folder only; it does not
 * fail the scan.
 */

import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import {
  findWorkspaceDocumentIn,
  loadAndValidateWorkspace,
  resolveLogsConfig,
  resolveWorkspaceTargetFolder,
  type LogsOverride,
} from '@rawbox/runner';

import { getErrorMessage } from '../../utils/error.js';
import { findRunsDirectories } from '../../runs/scan.js';
import { pruneOptionsFromResolvedLogs, pruneRuns, type PruneOptions, type PruneResult } from '../../runs/prune.js';

export interface RunsPruneOptions {
  workspace?: string;
  keep?: number;
  olderThanDays?: number;
  maxBytes?: number;
  output?: 'text' | 'json';
  cwd?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function printResult(targetFolder: string, result: PruneResult): void {
  if (result.prunedList.length === 0) {
    p.log.info(`${targetFolder}: nothing to prune — ${result.survivorCount} run(s) already within bounds.`);
    return;
  }
  p.log.info(
    `${targetFolder}: pruned ${result.prunedList.length} run(s), freeing ` +
      `${formatBytes(result.bytesFreed)} — ${result.survivorCount} remaining.`,
  );
  for (const pruned of result.prunedList) {
    console.log(`  - ${pruned.runId} (${formatBytes(pruned.bytes)})`);
  }
}

/**
 * One target folder to prune, paired with the workspace document (if any)
 * that answers for its `logs.prune:` bounds.
 *
 * `workspaceFile` is `undefined` in exactly two cases, both resolved to the
 * built-in default the same way a workspace declaring no `logs:` block is: an
 * explicit `--workspace` naming a document that fails to load (silently, not
 * fatal to pruning — the same load, by the same function, is retried and
 * *does* fail the run at `runWorkflowInstance`'s own preflight, which is
 * where a broken workspace document belongs), or the no-argument scan finding
 * zero or several workspace documents directly beside a `.rawbox` target
 * folder (`findWorkspaceDocumentIn`).
 */
interface PruneTarget {
  targetFolder: string;
  workspaceFile: string | undefined;
}

/** Resolves `logs.prune:` for one target, folding in the CLI's own flags. */
async function resolvePruneOptions(
  target: PruneTarget,
  override: LogsOverride,
): Promise<PruneOptions> {
  if (target.workspaceFile === undefined) {
    return pruneOptionsFromResolvedLogs(resolveLogsConfig({ override }).prune);
  }
  const loaded = await loadAndValidateWorkspace(target.workspaceFile);
  return pruneOptionsFromResolvedLogs(
    resolveLogsConfig({
      workspace: loaded.isOk() ? loaded.value : undefined,
      override,
    }).prune,
  );
}

export async function runsPruneCommand(options: RunsPruneOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();

  // The CLI's own flags, highest precedence over every target's own
  // `logs.prune:` — built once, since it does not vary per target folder.
  const override: LogsOverride = {
    prune: {
      ...(options.keep !== undefined ? { keep: options.keep } : {}),
      ...(options.olderThanDays !== undefined ? { olderThanDays: options.olderThanDays } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    },
  };

  let targetList: PruneTarget[];
  try {
    if (options.workspace !== undefined) {
      const workspaceFile = path.resolve(cwd, options.workspace);
      targetList = [
        { targetFolder: await resolveWorkspaceTargetFolder(workspaceFile), workspaceFile },
      ];
    } else {
      const hitList = await findRunsDirectories(cwd);
      // Each hit answers for itself: the workspace document (if exactly one)
      // found directly beside *this* target folder, not one document shared
      // across every workspace under `cwd`.
      targetList = await Promise.all(
        hitList.map(async (hit) => ({
          targetFolder: hit.targetFolder,
          workspaceFile: await findWorkspaceDocumentIn(path.dirname(hit.targetFolder)),
        })),
      );
    }
  } catch (error) {
    p.log.error(pc.red(`Failed to resolve target folder(s): ${getErrorMessage(error)}`));
    process.exit(1);
    return;
  }

  if (targetList.length === 0) {
    if (options.output === 'json') {
      console.log(JSON.stringify([], null, 2));
    } else {
      p.log.info('No runs directories found.');
    }
    return;
  }

  const jsonResultList: Array<{ targetFolder: string; result: PruneResult }> = [];

  for (const target of targetList) {
    const effectiveOptions = await resolvePruneOptions(target, override);
    const result = await pruneRuns(target.targetFolder, effectiveOptions);

    if (options.output === 'json') {
      jsonResultList.push({ targetFolder: target.targetFolder, result });
    } else {
      printResult(target.targetFolder, result);
    }
  }

  if (options.output === 'json') {
    console.log(JSON.stringify(jsonResultList, null, 2));
  }
}
