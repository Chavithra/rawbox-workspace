import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import { OperationContract } from "rawbox-plugin/operation-definition";
import { ControlFlowContract } from "rawbox-default-plugins/control-flow-definition";

type SupportedContract = OperationContract | ControlFlowContract;
type SupportedContractsRecord = Record<string, SupportedContract>;

export const contractsRegistryTable = sqliteTable("contracts-registry", {
  contractsRegistryPath: text("contractsRegistryPath").primaryKey(),
  contractsRecord: text("contractsRecord", { mode: "json" })
    .notNull()
    .$type<SupportedContractsRecord>(),
});
