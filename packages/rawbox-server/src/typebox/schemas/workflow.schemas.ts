import { Static } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";

import { workflowTable } from "../../drizzle/tables/workflow.table.js";

export const WorkflowSelectSchema = createSelectSchema(workflowTable);
export type WorkflowSelectSchema = Static<typeof WorkflowSelectSchema>;

export const WorkflowInsertSchema = createInsertSchema(workflowTable);
export type WorkflowInsertSchema = Static<typeof WorkflowInsertSchema>;

export const WorkflowUpdateSchema = createUpdateSchema(workflowTable);
export type WorkflowUpdateSchema = Static<typeof WorkflowUpdateSchema>;
