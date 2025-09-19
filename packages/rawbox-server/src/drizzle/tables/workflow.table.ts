import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { workspaceTable } from "./workspace.table.js";

import { Step } from "rawbox-runner";

export const workflowTable = sqliteTable("workflow", {
  alias: text("alias").notNull(),
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  stepList: text("step_list", { mode: "json" }).notNull().$type<Step[]>(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaceTable.id),
});
