import { Static } from 'typebox';
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from 'drizzle-typebox';

import { ContractRegistryTable } from '../../drizzle/tables/contracts-registry.table.js';

export const ContractRegistrySelectSchema = createSelectSchema(
  ContractRegistryTable,
);
export type ContractRegistrySelectSchema = Static<
  typeof ContractRegistrySelectSchema
>;

export const ContractRegistryInsertSchema = createInsertSchema(
  ContractRegistryTable,
);
export type ContractRegistryInsertSchema = Static<
  typeof ContractRegistryInsertSchema
>;

export const ContractRegistryUpdateSchema = createUpdateSchema(
  ContractRegistryTable,
);
export type ContractRegistryUpdateSchema = Static<
  typeof ContractRegistryUpdateSchema
>;
