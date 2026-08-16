export type { BoxStore } from './box-store/box-store.js';
export { Box, BoxLocation, BoxStrategy, BoxLocationRecord, WriteBoxLocation, ReadBoxLocation } from './box.js';
export { StrictObject } from './schema.js';
export { buildBoxRecord, buildRecord } from './box-utils.js';
export {
  LMDB_BUDGET_RESIDUAL_FACTOR,
  LMDB_DBI_BYTES,
  LMDB_ENV_BASE_BYTES,
  LMDB_ENV_OVERHEAD_BYTES,
  LMDB_FIFO_CURSOR_BYTES,
  LMDB_INDEX_POINTER,
  LMDB_INPAGE_KEY_PLUS_VALUE_MAX,
  LMDB_KEY_SIZE_MAX_DEFAULT,
  LMDB_LEAF_FILL,
  LMDB_NODE_HEADER,
  LMDB_OVERFLOW_PAGE_ID,
  LMDB_PAGE_CAPACITY,
  LMDB_PAGE_HEADER,
  LMDB_PAGE_SIZE_DEFAULT,
  LMDB_VALUE_FRAMING_BYTES,
  RAWBOX_KEY_DERIVATION_OVERHEAD_MAX,
  RAWBOX_KEY_SIZE_MAX,
  entryOverhead,
  measureKeySize,
  readMaxKeySize,
  recommendedVolumeBytesFor,
  measureValueSize,
} from './box-size.js';
export type {
  BoxStorage,
  KeyBudget,
  KeyBudgetSource,
  VolumeRecommendationOptions,
} from './box-size.js';

// What each storage strategy decides, one record per member of the
// `BoxStrategy` union: schema, seed semantics, the sentence an empty read
// fails with, whether depth means anything, and the byte budget. Pure — it
// opens no database, which is why it belongs in the main entry.
export {
  STRATEGY_NAME_LIST,
  descriptorFor,
  keyBudgetOf,
  seedCapacityOf,
  storeIdentityOf,
} from './strategy/descriptor.js';
export type { StoreIdentity, StrategyDescriptor } from './strategy/descriptor.js';

// The budget's dispatch half: which of `box-size.ts`'s budget functions a
// strategy uses, and the sum over a `storage:` block. Re-exported here under
// the names they have always had — `budgetForKey` and `budgetForStorage` moved
// out of `box-size.ts` so they could read `StrategyDescriptor.budget`, which is
// optional by design, without `box-size.ts` importing `strategy/` and closing
// an import cycle (see the module comment in `strategy/budget.ts`).
//
// **The names are unchanged; the types are not.** `budgetForKey` now returns
// `KeyBudgetOutcome`, which is a `KeyBudget` *or* an `UnbudgetableKey` naming a
// key whose strategy has no byte model, and `StorageBudget` carries the
// unbudgetable keys as their own list so a total can never quietly cover fewer
// keys than the document declares.
export {
  budgetForKey,
  budgetForStorage,
  partitionKeyBudgetOutcomeList,
} from './strategy/budget.js';
export type {
  KeyBudgetOutcome,
  KeyBudgetPartition,
  StorageBudget,
  UnbudgetableKey,
} from './strategy/budget.js';

// The observation surface. The pure half lives here in the main entry; the
// two LMDB-backed classes stay on their own subpaths (`@rawbox/store/
// box-store-lmdb`, `@rawbox/store/box-observer-lmdb`) so importing the
// package for its types does not drag in an environment opener.
export {
  depthStatic,
  fifoDataKey,
  fifoHeadKey,
  fifoTailKey,
  inspectStatic,
  parseDerivedFifoKey,
  peekAllStatic,
  peekStatic,
  ringCapacity,
  ringIndexList,
  ringUsed,
} from './box-store/box-peek.js';
export type {
  BoxFifoInspection,
  BoxInspection,
  BoxQueueDepth,
  BoxReadDbi,
  DerivedFifoKey,
} from './box-store/box-peek.js';
export type { BoxObserver, BoxObserverAsync } from './box-store/box-observer.js';
