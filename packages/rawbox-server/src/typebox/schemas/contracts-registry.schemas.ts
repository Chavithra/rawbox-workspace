import { Static } from "@sinclair/typebox";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-typebox";

import { contractsRegistryTable } from "../../drizzle/tables/contracts-registry.table.js";

export const ContractsRegistrySelectSchema = createSelectSchema(
  contractsRegistryTable
);
export type ContractsRegistrySelectSchema = Static<
  typeof ContractsRegistrySelectSchema
>;

export const ContractsRegistryInsertSchema = createInsertSchema(
  contractsRegistryTable
);
export type ContractsRegistryInsertSchema = Static<
  typeof ContractsRegistryInsertSchema
>;

export const ContractsRegistryUpdateSchema = createUpdateSchema(
  contractsRegistryTable
);
export type ContractsRegistryUpdateSchema = Static<
  typeof ContractsRegistryUpdateSchema
>;
