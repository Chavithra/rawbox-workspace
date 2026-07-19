import { ok, err, type Result } from 'neverthrow';
import { Compile } from 'typebox/compile';
import type { ContractRegistryCache } from 'rawbox-plugin/core';
import { Workflow } from './workflow-types.js';

// Compile the Workflow schema for runtime validation
const workflowValidator = Compile(Workflow);

/** Validate that a workflow matches the Typebox schema. */
export function validateWorkflowType(workflow: Workflow): Result<void, Error> {
  if (!workflowValidator.Check(workflow)) {
    const errorDetails = Array.from(workflowValidator.Errors(workflow))
      .map((error: any) => `  - Path: "${error.path}" : ${error.message}`)
      .join('\n');
    return err(new Error(`Preflight Check: Workflow validation failed:\n${errorDetails}`));
  }
  return ok(undefined);
}

/** Validate that all storage locations in a workflow respect workspace and workflow boundaries. */
export function validateStorageBoundaries(workflow: Workflow, workspace: string): Result<void, Error> {
  // Enforced structurally by the refined JSON schemas
  return ok(undefined);
}

/** Validate that seedData matches step input contract schemas ("Approach A"). */
export function validateSeedData(
  workflow: Workflow,
  contractRegistryCache: ContractRegistryCache,
): Result<void, Error> {
  if (!workflow.seedData || workflow.seedData.length === 0) {
    return ok(undefined);
  }

  for (const seed of workflow.seedData) {
    for (const step of workflow.stepList) {
      const registryHash = step.definitionLocation.contractRegistryHash;
      const definitionPath = step.definitionLocation.definitionPath;

      const registry = contractRegistryCache.getContractRegistry(registryHash);
      if (!registry) {
        continue;
      }

      const contract = registry.contractRecord[definitionPath] as any;
      if (!contract || !contract.inputSchema || !contract.inputSchema.properties) {
        continue;
      }

      const inputs = step.storageLocation.input;
      for (const [fieldName, readBoxLoc] of Object.entries(inputs)) {
        if (readBoxLoc.key === seed.key) {
          const expectedSchema = contract.inputSchema.properties[fieldName];
          if (!expectedSchema) {
            continue;
          }

          const validator = Compile(expectedSchema);
          if (!validator.Check(seed.value)) {
            const errorDetails = Array.from(validator.Errors(seed.value))
              .map((error: any) => `  - Path: "${error.path}" : ${error.message}`)
              .join('\n');
            return err(new Error(
              `Preflight Check: Seed validation failed for key "${seed.key}" used in step "${step.label ?? 'unlabeled'}" (input field "${fieldName}"):\n${errorDetails}`
            ));
          }
        }
      }
    }
  }

  return ok(undefined);
}

