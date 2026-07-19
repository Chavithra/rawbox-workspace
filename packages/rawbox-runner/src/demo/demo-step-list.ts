import type { Step } from '../workflow/step-types.js';
import type { Workflow } from '../workflow/workflow-types.js';
import type { Workspace } from '../workspace/workspace-types.js';
import { ContractRegistryCache } from 'rawbox-plugin/core';
import { contractRegistry } from '../../../rawbox-plugin-default/dist/contract-registry.js';

// ---------------------------------------------------------------------------
// 1. Register the plugin's contract registry into the cache
// ---------------------------------------------------------------------------
const contractRegistryCache = new ContractRegistryCache();
const registryHash = contractRegistryCache.addContractRegistry(contractRegistry);

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
        ms: { key: '1000', strategy },
      },
      output: {
        throttledMs: { key: '1100', strategy },
        timestamp: { key: '1101', strategy },
      },
      error: {
        message: { key: '1200', strategy },
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
        ms: { key: '2000', strategy },
      },
      output: {
        throttledMs: { key: '2100', strategy },
        timestamp: { key: '2101', strategy },
      },
      error: {
        message: { key: '2200', strategy },
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
// 5. Print the results
// ---------------------------------------------------------------------------
console.log('Workspace:', JSON.stringify(workspace, null, 2));
console.log('\nWorkflow:', JSON.stringify(workflow, null, 2));
console.log('\nStep count:', workflow.stepList.length);
console.log(
  '\nDefinition locations:',
  workflow.stepList.map((s) => s.definitionLocation),
);
