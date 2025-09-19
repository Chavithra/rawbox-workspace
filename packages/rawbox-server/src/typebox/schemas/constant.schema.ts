import { Static } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";

import { constantTable } from "../../drizzle/tables/constant.table.js";

export const ConstantSelectSchema = createSelectSchema(constantTable);
export type ConstantSelectSchema = Static<typeof ConstantSelectSchema>;

export const ConstantInsertSchema = createInsertSchema(constantTable);
export type ConstantInsertSchema = Static<typeof ConstantInsertSchema>;

export const ConstantUpdateSchema = createUpdateSchema(constantTable);
export type ConstantUpdateSchema = Static<typeof ConstantUpdateSchema>;
