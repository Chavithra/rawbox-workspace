import type { Step } from './step.js';
import { Type } from '@sinclair/typebox';

import { BoxLocation, Box } from 'rawbox-store';

const stepList: Step[] = [
  {
    definitionLocation: {
      contractsRegistryPath:
        '/home/dtp2/code/javascript/real/rawbox-workspace/packages/rawbox-extension-maths/dist/contracts-registry.js',
      definitionPath: './sum.definition.js',
    },
    inputLocationRecord: {
      a: {
        key: 0,
        workflow: 'simple',
        workspace: 'counting',
      },
      b: {
        key: 1,
        workflow: 'simple',
        workspace: 'counting',
      },
    },
    outputLocationRecord: {
      value: {
        key: 2,
        workflow: 'simple',
        workspace: 'counting',
      },
    },
    errorLocationRecord: {
      message: {
        key: 4,
        workflow: 'simple',
        workspace: 'counting',
      },
    },
  },
  {
    definitionLocation: {
      contractsRegistryPath:
        '/home/dtp2/code/javascript/real/rawbox-workspace/packages/rawbox-extension-maths/dist/contracts-registry.js',
      definitionPath: './mul.definition.js',
    },
    inputLocationRecord: {
      a: {
        key: 5,
        workflow: 'simple',
        workspace: 'counting',
      },
      b: {
        key: 6,
        workflow: 'simple',
        workspace: 'counting',
      },
      c: {
        key: 7,
        workflow: 'simple',
        workspace: 'counting',
      },
    },
    outputLocationRecord: {
      value: {
        key: 8,
        workflow: 'simple',
        workspace: 'counting',
      },
    },
    errorLocationRecord: {
      message: {
        key: 9,
        workflow: 'simple',
        workspace: 'counting',
      },
    },
  },
];

export const inputBoxItemA: Box<number> = {
  content: 10,
  location: {
    key: 0,
    workflow: 'simple',
    workspace: 'counting',
  },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};

export const inputBoxItemB: Box<number> = {
  content: 20,
  location: {
    key: 0,
    workflow: 'simple',
    workspace: 'counting',
  },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};

export const inputBoxItemC: Box<number> = {
  content: 30,
  location: {
    key: 0,
    workflow: 'simple',
    workspace: 'counting',
  },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};
