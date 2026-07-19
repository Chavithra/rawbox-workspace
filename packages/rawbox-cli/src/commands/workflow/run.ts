import * as p from '@clack/prompts';
import pc from 'picocolors';
import { runWorkflowInstance } from 'rawbox-runner';

/**
 * CLI command controller to run a workflow instance with step transition logging.
 */
export async function runWorkflowCommand(
  workspacePath: string,
  workflowPath: string,
  logFilePath: string,
): Promise<void> {
  const s = p.spinner();
  s.start(`Executing workflow machine instance...`);

  const result = await runWorkflowInstance(workspacePath, workflowPath, logFilePath);

  if (result.isErr()) {
    s.stop('Execution failed.');
    p.log.error(pc.red(`Error executing workflow: ${result.error}`));
    process.exit(1);
  } else {
    s.stop('Execution completed.');
    p.outro(pc.green(`✅ Workflow completed successfully! State transitions logged to ${pc.cyan(logFilePath)}`));
  }
}
