import util from 'node:util';
import { createActor } from 'xstate';
import { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import { ok } from 'neverthrow';
import { ContractRegistryCache } from 'rawbox-plugin/core';
import { contractRegistry } from '../../../rawbox-plugin-default/dist/contract-registry.js';
import { createWorkflowMachine } from '../machine/machine-instance.js';
import type { Step } from '../workflow/step-types.js';
import type { Workflow } from '../workflow/workflow-types.js';
import type { Workspace } from '../workspace/workspace-types.js';
import type { BoxLocation } from 'rawbox-store';

// ---------------------------------------------------------------------------
// 1. Register the plugin's contract registry into the cache
// ---------------------------------------------------------------------------
const contractRegistryCache = new ContractRegistryCache();
const registryHash =
  contractRegistryCache.addContractRegistry(contractRegistry);

// ---------------------------------------------------------------------------
// 2. Define the workspace
// ---------------------------------------------------------------------------
const workspace: Workspace = {
  name: 'counting',
  workflowPathList: ['./workflows/simple.json'],
};

// ---------------------------------------------------------------------------
// 3. Build the step list
// ---------------------------------------------------------------------------
const workflowName = 'simple';
const strategy = {
  name: 'lmdb-kv' as const,
  valueSizeMax: 2022,
};

const stepList: Step[] = [
  {
    definitionLocation: {
      contractRegistryHash: registryHash,
      definitionPath: './time/workflow-throttle.definition.js',
    },
    storageLocation: {
      input: {
        ms: {
          key: '1000',
          strategy,
        },
      },
      output: {
        throttledMs: {
          key: '1100',
          strategy,
        },
        timestamp: {
          key: '1101',
          strategy,
        },
      },
      error: {
        message: {
          key: '1200',
          strategy,
        },
      },
    },
    label: 'throttle-step-1',
  },
  {
    definitionLocation: {
      contractRegistryHash: registryHash,
      definitionPath: './time/workflow-throttle.definition.js',
    },
    storageLocation: {
      input: {
        ms: {
          key: '2000',
          strategy,
        },
      },
      output: {
        throttledMs: {
          key: '2100',
          strategy,
        },
        timestamp: {
          key: '2101',
          strategy,
        },
      },
      error: {
        message: {
          key: '2200',
          strategy,
        },
      },
    },
    label: 'throttle-step-2',
  },
];

// ---------------------------------------------------------------------------
// 4. Assemble the workflow
// ---------------------------------------------------------------------------
const workflow: Workflow = {
  name: workflowName,
  pluginPathList: ['rawbox-default-plugins'],
  stepList,
  seedData: [
    { key: stepList[0]!.storageLocation.input['ms']!.key, strategy: stepList[0]!.storageLocation.input['ms']!.strategy, value: 50 },
    { key: stepList[1]!.storageLocation.input['ms']!.key, strategy: stepList[1]!.storageLocation.input['ms']!.strategy, value: 30 },
  ],
};

// ---------------------------------------------------------------------------
// 5. Initialize BoxStoreLmdb and seed the database
// ---------------------------------------------------------------------------
const rootDirectoryUrl = new URL('../../tests/sandbox/', import.meta.url);
const boxStoreLmdb = BoxStoreLmdb.create(workspace.name, rootDirectoryUrl);

boxStoreLmdb.transaction((boxStore) => {
  for (const seed of workflow.seedData!) {
    boxStore.putSync({
      content: seed.value,
      location: {
        key: seed.key,
        workflow: workflowName,
        workspace: workspace.name,
        strategy: seed.strategy,
      },
    });
  }
  return ok(undefined);
});


// ---------------------------------------------------------------------------
// 6. Create and run the xstate workflow machine
// ---------------------------------------------------------------------------
const input = {
  params: {
    runId: 'run1',
    workflow,
    workspace: workspace.name,
  },
  execution: {
    todoStep: { index: 0 },
    doneStep: null,
  },
  rootDirectoryUrl: rootDirectoryUrl.href,
  boxStoreLmdb: boxStoreLmdb,
};

const machine = createWorkflowMachine(boxStoreLmdb, contractRegistryCache);
const actor = createActor(machine, { input });

actor.subscribe((state) => {
  console.log('========================================');
  console.log('Current state:', util.inspect(state.value, { colors: true }));
  console.log(
    'Current context.execution.doneStep:',
    util.inspect(state.context.execution.doneStep, { depth: null, colors: true }),
  );
  console.log(
    'Current context.execution.todoStep:',
    util.inspect(state.context.execution.todoStep, { depth: null, colors: true }),
  );
  if (state.status === 'done') {
    console.log('\n🎉 Machine reached final state successfully!');
  }
});

actor.start();
