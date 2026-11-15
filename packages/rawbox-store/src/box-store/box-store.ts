import type { Result } from 'neverthrow';

import { type Box, type BoxLocation } from '../box.js';

export interface BoxTransactionBatch {
  /** Boxes to write in order before any reads in this batch are evaluated. */
  readonly puts?: readonly Box<unknown>[];
  /** Named locations to read after `puts` have been applied. */
  readonly gets?: Readonly<Record<string, BoxLocation>>;
}

export interface BoxStore {
  get(boxLocation: BoxLocation): Promise<Result<unknown, string>>;
  put(box: Box<unknown>): Promise<Result<void, string>>;
  /**
   * Executes all `puts` followed by all `gets` as an atomic, all-or-nothing batch.
   * On any write or read error, no mutation takes effect.
   */
  transact(
    batch: BoxTransactionBatch,
  ): Promise<Result<Record<string, unknown>, string>>;
}
