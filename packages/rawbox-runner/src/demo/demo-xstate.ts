import util from 'node:util';
import { createActor } from 'xstate';
import { BoxStoreLmdb } from 'rawbox-store/box-store-lmdb';
import { ok } from 'neverthrow';
import { ContractRegistryCache } from 'rawbox-plugin/core';
import { createWorkflowMachine } from '../machine-instance.js';
import { stepList } from './demo-step-list.js';

const workspace = 'counting';
const rootDirectoryUrl = new URL('../../tests/sandbox/', import.meta.url);

// Initialize BoxStoreLmdb and seed the database with inputs for step 0 & 1
const boxStore = BoxStoreLmdb.create(workspace, rootDirectoryUrl);
boxStore.transaction(() => {
  // Seed inputs for Step 0 (sum)
  const step0 = stepList[0]!;
  boxStore.putSync({
    content: 15,
    location: step0.inputBoxLocationRecord['a']!,
  });
  boxStore.putSync({
    content: 27,
    location: step0.inputBoxLocationRecord['b']!,
  });

  // Seed inputs for Step 1 (mul)
  const step1 = stepList[1]!;
  boxStore.putSync({
    content: 10,
    location: step1.inputBoxLocationRecord['a']!,
  });
  boxStore.putSync({
    content: 20,
    location: step1.inputBoxLocationRecord['b']!,
  });
  boxStore.putSync({
    content: 30,
    location: step1.inputBoxLocationRecord['c']!,
  });

  return ok(undefined);
});

const input = {
  instanceId: 'instance1',
  todoStep: { index: 0 },
  stepList,
  workspace,
  rootDirectoryUrl: rootDirectoryUrl.href,
  boxStoreLmdb: boxStore,
};

const contractRegistryCache = new ContractRegistryCache();
const machine = createWorkflowMachine(boxStore, contractRegistryCache);
const actor = createActor(machine, { input });

actor.subscribe((state) => {
  console.log('========================================');
  console.log('Current state:', util.inspect(state.value, { colors: true }));
  console.log(
    'Current context.doneStep:',
    util.inspect(state.context.doneStep, { depth: null, colors: true }),
  );
  console.log(
    'Current context.todoStep:',
    util.inspect(state.context.todoStep, { depth: null, colors: true }),
  );
  if (state.status === 'done') {
    console.log('\n🎉 Machine reached final state successfully!');
  }
});

actor.start();

// // Automatically stop the machine after a short time
// setTimeout(() => {
//   console.log('Sending STOP event...');
//   actor.send({ type: 'STOP' });
// }, 30000);
