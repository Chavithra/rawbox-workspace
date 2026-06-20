import { Box } from 'rawbox-store';
import { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import { stepList } from './demo-step-list.js';

const stepIndex = 0;
const step = stepList[stepIndex]!;

console.log('Step Definition Location:', step.definitionLocation);
console.log('Step Input Box Location Record:', step.inputBoxLocationRecord);
console.log('Step Output Box Location Record:', step.outputBoxLocationRecord);

// Define a directory for our Lmdb store
const rootDirectoryUrl = new URL('../../../../data', import.meta.url);
const workspace = 'counting';

console.log(`\nInitializing BoxStoreLmdb for workspace "${workspace}"...`);
const boxStore = BoxStoreLmdb.create(workspace, rootDirectoryUrl);

const env = boxStore.dbiCache.env;

env.transaction(async () => {
  // --- Setup: Seed the database with inputs (pre-requisite) ---
  const seedInputs = { a: 15, b: 27 };
  for (const [name, content] of Object.entries(seedInputs)) {
    const location = step.inputBoxLocationRecord[name]!;
    await boxStore.put({ content, location });
  }

  // --- Simulation Main Flow ---
  console.log('\n--- 1. Retrieving Inputs from DB ---');
  const inputsForExecution: Record<string, number> = {};
  for (const name of Object.keys(step.inputBoxLocationRecord)) {
    const location = step.inputBoxLocationRecord[name]!;
    const getResult = await boxStore.get(location);
    if (getResult.isErr()) {
      console.error(`Failed to retrieve input "${name}":`, getResult.error);
      return;
    }
    inputsForExecution[name] = getResult.value as number;
    console.log(`Retrieved Input "${name}" value:`, inputsForExecution[name]);
  }

  console.log('\n--- 2. Simulating Operation Execution ---');
  // Simulate executing the 'sum' operation
  const a = inputsForExecution.a ?? 0;
  const b = inputsForExecution.b ?? 0;
  const operationOutput = {
    value: a + b,
  };
  console.log('Operation output object:', operationOutput);

  console.log('\n--- 3. Storing the Operation Output Object in DB ---');
  // Map and store each property of the operation output object to the corresponding output box location
  for (const [name, content] of Object.entries(operationOutput)) {
    const location = step.outputBoxLocationRecord[name];
    if (!location) {
      console.error(`Warning: No box location configured for output "${name}".`);
      continue;
    }

    const box: Box<unknown> = {
      content,
      location,
    };

    console.log(`Storing Output Box "${name}" at key ${location.key} with content:`, content);
    const putResult = await boxStore.put(box);
    if (putResult.isErr()) {
      console.error(`Failed to store output "${name}":`, putResult.error);
    }
  }
});
