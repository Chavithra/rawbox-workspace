import { int, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceTable = sqliteTable("workspace", {
  alias: text("alias").notNull(),
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
});
