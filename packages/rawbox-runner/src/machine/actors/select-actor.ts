import { fromPromise } from 'xstate';

import { err, ok, type Result } from 'neverthrow';
import { ContractRegistryLoader } from '@rawbox/plugin/core';
import type { ContractRegistryCache, DefinitionLocation } from '@rawbox/plugin/core';
import type { ControlFlowContract } from '@rawbox/plugin/control-flow';
import type { OperationContract } from '@rawbox/plugin/operation';
import { ReservedLabel } from '@rawbox/plugin/control-flow';

export async function loadContract(
  definitionLocation: DefinitionLocation,
  contractRegistryCache: ContractRegistryCache,
): Promise<Result<OperationContract | ControlFlowContract, string>> {
  let registry = contractRegistryCache.getContractRegistry(
    definitionLocation.contractRegistryHash,
  );
  if (!registry) {
    const loadResult = await ContractRegistryLoader.loadContractRegistry(
      definitionLocation.contractRegistryHash,
    );
    if (loadResult.isErr()) {
      return err(`Failed to load registry: ${loadResult.error}`);
    }
    registry = loadResult.value;
    contractRegistryCache.addContractRegistry(registry);
  }

  const contract = registry.contractRecord[definitionLocation.definitionPath];
  if (!contract) {
    return err(`Contract not found in registry: ${definitionLocation.definitionPath}`);
  }

  if (contract.type === 'operation' || contract.type === 'control-flow') {
    return ok(contract as OperationContract | ControlFlowContract);
  }

  return err(`Unknown contract type: ${contract.type}`);
}

import type { MachineExecution } from '../machine-types.js';
import type { ResolvedStep } from '../../workflow/step-types.js';
import type { ResolvedWorkflow } from '../../workflow/workflow-types.js';

export const getStepContract = async (
  stepList: ResolvedStep[],
  stepIndex: number,
  contractRegistryCache: ContractRegistryCache,
): Promise<Result<OperationContract | ControlFlowContract, string>> => {
  const step = stepList[stepIndex];

  if (!step) {
    return err(`Step at index ${stepIndex} not found in stepList`);
  }

  return await loadContract(
    step.definitionLocation,
    contractRegistryCache,
  );
};

/**
 * The message a `__FAIL__` step gets when it named no reason.
 *
 * Shaped like `run-actor.ts`'s timeout sentence — index, plus the authored
 * label when there is one — because it lands in exactly the same places
 * (`run.end.error.message`, the terminal's failure line) and an operator
 * reading either one needs to know *which* step ended the run before anything
 * else. Naming the label as well is what makes the message actionable when the
 * reason is missing.
 */
function describeFailWithoutReason(
  stepIndex: number,
  label: string | undefined,
): string {
  const named = label === undefined || label === '' ? '' : ` "${label}"`;
  return (
    `Step ${stepIndex}${named} ended the run as a failure ` +
    `(${ReservedLabel.FAIL} with no reason given).`
  );
}

export const selectFunc = async ({
  input: { contractRegistryCache, execution, workflow },
}: {
  input: {
    contractRegistryCache: ContractRegistryCache;
    execution: MachineExecution;
    workflow: ResolvedWorkflow;
  };
}): Promise<Result<{
  todoStep: MachineExecution['todoStep'];
}, Error>> => {
  const stepList = workflow.stepList;
  const doneStep = execution.doneStep;
  let output;

  if (doneStep) {
    const contractResult = await getStepContract(
      stepList,
      doneStep.index,
      contractRegistryCache,
    );

    if (contractResult.isErr()) {
      return err(new Error(contractResult.error));
    }

    const contract = contractResult.value;

    if (contract.type === 'operation') {
      const nextIndex = doneStep.index + 1;
      output = {
        todoStep: stepList[nextIndex] ? { index: nextIndex } : null,
      };
    } else if (contract.type === 'control-flow') {
      const label = doneStep.outputRecord!.label as string;

      if (label === ReservedLabel.EXIT) {
        output = { todoStep: null };
      } else if (label === ReservedLabel.FAIL) {
        // The one place a *document* can end the run as a failure. Returning
        // `err` here is not an error in selection: it is the deliberate reuse
        // of the path a failed step actor already takes — `resultErrorAssigner`
        // puts this message on `context.error`, `run-workflow.ts` turns that
        // into an error `run.end` and an `err` result, and the CLI exits 1.
        //
        // The step that returned the label has already reported its own
        // `step.end` with `outcome: "ok"` (it did what it was asked), and the
        // machine goes straight to `stopping`, so no further step starts and
        // none is fabricated. Nothing is lost by skipping `exiting`: a
        // control-flow step may not declare `outputs:`, and a step returning a
        // label produced no error record, so it has nothing to write.
        //
        // An empty `reason` counts as none: `resultErrorAssigner` falls back to
        // `String(error)` for an empty message, which would report the run's
        // failure as the bare word "Error".
        const reason = doneStep.outputRecord!['reason'];
        return err(
          new Error(
            typeof reason === 'string' && reason !== ''
              ? reason
              : describeFailWithoutReason(
                  doneStep.index,
                  stepList[doneStep.index]?.label,
                ),
          ),
        );
      } else if (label === ReservedLabel.START) {
        output = { todoStep: { index: 0 } };
      } else if (label === ReservedLabel.END) {
        output = { todoStep: { index: stepList.length - 1 } };
      } else {
        const index = stepList.findIndex((step) => step.label === label);
        if (index !== -1) {
          output = {
            todoStep: { index: index },
          };
        } else {
          return err(new Error(`No step found with label: "${label}"`));
        }
      }
    } else {
      // Defensive: `contract` is narrowed to `never` here, but a registry can
      // still carry an unrecognised type at runtime.
      return err(new Error(`Unknown contract type: ${(contract as { type: string }).type}`));
    }
  } else {
    if (stepList.length > 0) {
      output = {
        todoStep: stepList[0] ? { index: 0 } : null,
      };
    } else {
      return err(new Error(`Array stepList shouldn't be empty.`));
    }
  }

  return ok(output);
};

export const selectActor = fromPromise(selectFunc);
