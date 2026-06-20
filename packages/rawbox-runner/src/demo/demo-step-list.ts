import type { Step } from '../step-types.js';
import { Box } from 'rawbox-store';

const workflow = 'simple';
const workspace = 'counting';
const strategy = {
  name: 'lmdb-kv' as const,
  valueSizeMax: 2022,
};

export const stepList: Step[] = [
  {
    definitionLocation: {
      contractRegistryPath:
        '/run/media/dtp1/workspace/code/javascript/real/rawbox-workspace/packages/rawbox-default-plugins/dist/maths/contract-registry.js',
      definitionPath: './sum.definition.js',
    },
    inputBoxLocationRecord: {
      a: {
        key: 1000,
        workflow,
        workspace,
        strategy,
      },
      b: {
        key: 1001,
        workflow,
        workspace,
        strategy,
      },
    },
    outputBoxLocationRecord: {
      value: {
        key: 1100,
        workflow,
        workspace,
        strategy,
      },
    },
    errorBoxLocationRecord: {
      message: {
        key: 1200,
        workflow,
        workspace,
        strategy,
      },
    },
  },
  {
    definitionLocation: {
      contractRegistryPath:
        '/run/media/dtp1/workspace/code/javascript/real/rawbox-workspace/packages/rawbox-default-plugins/dist/maths/contract-registry.js',
      definitionPath: './mul.definition.js',
    },
    inputBoxLocationRecord: {
      a: {
        key: 2000,
        workflow,
        workspace,
        strategy,
      },
      b: {
        key: 2001,
        workflow,
        workspace,
        strategy,
      },
      c: {
        key: 2002,
        workflow,
        workspace,
        strategy,
      },
    },
    outputBoxLocationRecord: {
      value: {
        key: 2100,
        workflow,
        workspace,
        strategy,
      },
    },
    errorBoxLocationRecord: {
      message: {
        key: 2200,
        workflow,
        workspace,
        strategy,
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
    strategy,
  },
};

export const box1001: Box<number> = {
  content: 2,
  location: {
    key: 2000,
    workflow,
    workspace,
    strategy,
  },
};

export const box2000: Box<number> = {
  content: 10,
  location: {
    key: 2000,
    workflow,
    workspace,
    strategy,
  },
};

export const box2001: Box<number> = {
  content: 20,
  location: {
    key: 2001,
    workflow,
    workspace,
    strategy,
  },
};

export const box2002: Box<number> = {
  content: 30,
  location: {
    key: 2002,
    workflow,
    workspace,
    strategy,
  },
};
