import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { OperationContract } from 'rawbox-plugin/operation-definition';
import { ControlFlowContract } from 'rawbox-default-plugins/control-flow-definition';

type SupportedContract = OperationContract | ControlFlowContract;
type SupportedContractRecord = Record<string, SupportedContract>;

export const ContractRegistryTable = sqliteTable('contracts-registry', {
  contractRegistryPath: text('ContractRegistryPath').primaryKey(),
  contractRecord: text('ContractRecord', { mode: 'json' })
    .notNull()
    .$type<SupportedContractRecord>(),
});
