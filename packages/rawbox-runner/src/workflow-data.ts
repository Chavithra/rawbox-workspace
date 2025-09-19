import { createSimpleBoxLocation } from "rawbox-store/box-store-utils";

import type { Workflow, Step } from "./workflow.js";
import { Type } from "@sinclair/typebox";
import { encodeBoxList } from "./workflow-utils.js";

const stepList: Step[] = [
  {
    definitionLocation: {
      contractsRegistryPath:
        "/home/dtp2/code/javascript/real/rawbox-workspace/packages/rawbox-extension-maths/dist/contracts-registry.js",
      definitionPath: "./sum.definition.js",
    },
    inputLocationRecord: {
      a: createSimpleBoxLocation("env1", "dbi1", "input-a"),
      b: createSimpleBoxLocation("env1", "dbi1", "input-b"),
    },
    outputLocationRecord: {
      value: createSimpleBoxLocation("env1", "dbi1", "output-value"),
    },
    errorLocationRecord: {
      message: createSimpleBoxLocation("env1", "dbi1", "error-message"),
    },
  },
  {
    definitionLocation: {
      contractsRegistryPath:
        "/home/dtp2/code/javascript/real/rawbox-workspace/packages/rawbox-extension-maths/dist/contracts-registry.js",
      definitionPath: "./mul.definition.js",
    },
    inputLocationRecord: {
      a: createSimpleBoxLocation("env1", "dbi1", "input-a"),
      b: createSimpleBoxLocation("env1", "dbi1", "input-b"),
      c: createSimpleBoxLocation("env1", "dbi1", "input-c"),
    },
    outputLocationRecord: {
      value: createSimpleBoxLocation("env1", "dbi1", "output-value"),
    },
    errorLocationRecord: {
      message: createSimpleBoxLocation("env1", "dbi1", "error-message"),
    },
  },
];

export const workflow: Workflow = {
  id: "workflow1",
  alias: "workflow1",
  description: "Test workflow",
  stepList,
  workspaceId: "workspace1",
};

export const inputBoxItemA = {
  location: createSimpleBoxLocation("env1", "dbi1", "input-a"),
  content: {
    schema: Type.Number(),
    data: 1,
  },
};

export const inputBoxItemB = {
  location: createSimpleBoxLocation("env1", "dbi1", "input-b"),
  content: {
    schema: Type.Number(),
    data: 2,
  },
};

export const inputBoxItemC = {
  location: createSimpleBoxLocation("env1", "dbi1", "input-c"),
  content: {
    schema: Type.Number(),
    data: 2,
  },
};

export const inputBoxList = encodeBoxList([
  inputBoxItemA,
  inputBoxItemB,
  inputBoxItemC,
]);
