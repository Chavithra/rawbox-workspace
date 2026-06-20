import {
  ContractRegistryTable,
  workflowRelations,
  workflowTable,
  workspaceRelations,
  workspaceTable,
} from './tables/index.js';

export const schema = {
  ContractRegistryTable,
  workflowRelations,
  workflowTable,
  workspaceRelations,
  workspaceTable,
};

export const drizzleConfig = { schema };
