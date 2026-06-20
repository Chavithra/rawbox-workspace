import type { Result } from 'neverthrow';

import { type Box, type BoxLocation } from '../box.js';

export interface BoxStore {
  get(boxLocation: BoxLocation): Promise<Result<unknown, string>>;
  put(box: Box<unknown>): Promise<Result<void, string>>;
}
