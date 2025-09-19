import {
  contractsRegistryTable,
  workflowRelations,
  workflowTable,
  workspaceRelations,
  workspaceTable,
} from "./tables/index.js";

export const schema = {
  contractsRegistryTable,
  workflowRelations,
  workflowTable,
  workspaceRelations,
  workspaceTable,
};

export const drizzleConfig = { schema };
