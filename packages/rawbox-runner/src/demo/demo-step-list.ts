import type { Step } from '../step.js';

import { Box } from 'rawbox-store';

const workflow = 'simple';
const workspace = 'counting';
const stepList: Step[] = [
  {
    definitionLocation: {
      contractsRegistryPath:
        '/home/dtp2/code/javascript/real/rawbox-workspace/packages/rawbox-extension-maths/dist/contracts-registry.js',
      definitionPath: './sum.definition.js',
    },
    inputLocationRecord: {
      a: {
        key: 1000,
        workflow,
        workspace,
      },
      b: {
        key: 1001,
        workflow,
        workspace,
      },
    },
    outputLocationRecord: {
      value: {
        key: 1100,
        workflow,
        workspace,
      },
    },
    errorLocationRecord: {
      message: {
        key: 1200,
        workflow,
        workspace,
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
        key: 2000,
        workflow,
        workspace,
      },
      b: {
        key: 2001,
        workflow,
        workspace,
      },
      c: {
        key: 2002,
        workflow,
        workspace,
      },
    },
    outputLocationRecord: {
      value: {
        key: 2100,
        workflow,
        workspace,
      },
    },
    errorLocationRecord: {
      message: {
        key: 2200,
        workflow,
        workspace,
      },
    },
  },
];

export const box1000: Box<number> = {
  content: 1,
  location: {
    key: 2000,
    workflow,
    workspace,
  },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};

export const box1001: Box<number> = {
  content: 2,
  location: {
    key: 2000,
    workflow,
    workspace,
  },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};

export const box2000: Box<number> = {
  content: 10,
  location: {
    key: 2000,
    workflow,
    workspace,
  },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};

export const box2001: Box<number> = {
  content: 20,
  location: {
    key: 2001,
    workflow,
    workspace,
  },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};

export const box2002: Box<number> = {
  content: 30,
  location: {
    key: 2002,
    workflow,
    workspace,
  },
  strategy: {
    name: 'lmdb-kv',
    valueSizeMax: 2022,
  },
};
