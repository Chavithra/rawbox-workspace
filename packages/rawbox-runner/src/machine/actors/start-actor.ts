import { fromPromise } from 'xstate';
import { ok, err, type Result } from 'neverthrow';

import { loadDefinition } from 'rawbox-plugin/core';
import { Workflow } from '../../workflow/workflow-types.js';
import type { ContractRegistryCache } from 'rawbox-plugin/core';
import { validateWorkflowType, validateStorageBoundaries, validateSeedData } from '../../workflow/validation.js';

export interface StartActorInput {
  contractRegistryCache: ContractRegistryCache;
  workflow: Workflow;
  workspace: string;
}





export async function preloadStepDefinitions(
  workflow: Workflow,
  contractRegistryCache: ContractRegistryCache,
): Promise<Result<void, Error>> {
  for (const step of workflow.stepList) {
    const loadResult = await loadDefinition(step.definitionLocation, contractRegistryCache);
    if (loadResult.isErr()) {
      return err(new Error(
        `Preflight Check: Failed to load step definition for step "${step.label ?? 'unlabeled'}" at "${step.definitionLocation.definitionPath}": ${loadResult.error}`
      ));
    }
  }
  return ok(undefined);
}

export const startFunc = async ({
  input: { contractRegistryCache, workflow, workspace },
}: {
  input: StartActorInput;
}): Promise<Result<void, Error>> => {
  const typeResult = validateWorkflowType(workflow);
  if (typeResult.isErr()) return typeResult;

  const boundaryResult = validateStorageBoundaries(workflow, workspace);
  if (boundaryResult.isErr()) return boundaryResult;

  const preloadResult = await preloadStepDefinitions(workflow, contractRegistryCache);
  if (preloadResult.isErr()) return preloadResult;

  return validateSeedData(workflow, contractRegistryCache);
};


export const startActor = fromPromise(startFunc);
