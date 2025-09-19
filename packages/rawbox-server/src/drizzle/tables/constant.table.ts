import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { workspaceTable } from "./workspace.table.js";
import { workflowTable } from "./workflow.table.js";

export const constantTable = sqliteTable(
  "constant",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflowTable.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaceTable.id),
    keyId: text("key_id").notNull(),
    value: text("value", { mode: "json" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workflowId, table.workspaceId, table.keyId],
    }),
  ]
);
