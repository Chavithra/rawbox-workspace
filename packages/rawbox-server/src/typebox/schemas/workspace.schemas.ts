import { Static } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";

import { workspaceTable } from "../../drizzle/tables/workspace.table.js";

export const WorkspaceSelectSchema = createSelectSchema(workspaceTable);
export type WorkspaceSelectSchema = Static<typeof WorkspaceSelectSchema>;

export const WorkspaceInsertSchema = createInsertSchema(workspaceTable);
export type WorkspaceInsertSchema = Static<typeof WorkspaceInsertSchema>;

export const WorkspaceUpdateSchema = createUpdateSchema(workspaceTable);
export type WorkspaceUpdateSchema = Static<typeof WorkspaceUpdateSchema>;
