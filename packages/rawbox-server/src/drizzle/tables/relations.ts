import { relations } from "drizzle-orm";
import { workflowTable } from "./workflow.table.js";
import { workspaceTable } from "./workspace.table.js";
import { constantTable } from "./constant.table.js";

export const workspaceRelations = relations(workspaceTable, ({ many }) => ({
  workflows: many(workflowTable),
  constants: many(constantTable),
}));

export const workflowRelations = relations(workflowTable, ({ one, many }) => ({
  workspace: one(workspaceTable, {
    fields: [workflowTable.workspaceId],
    references: [workspaceTable.id],
  }),
  constants: many(constantTable),
}));

export const constantRelations = relations(constantTable, ({ one }) => ({
  workspace: one(workspaceTable, {
    fields: [constantTable.workspaceId],
    references: [workspaceTable.id],
  }),
  workflow: one(workflowTable, {
    fields: [constantTable.workflowId],
    references: [workflowTable.id],
  }),
}));
