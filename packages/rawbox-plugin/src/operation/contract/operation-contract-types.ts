import type { TObject } from 'typebox';

import type { Contract } from '../../core/contracts/contract-registry-types.js';

export interface OperationContract<
  ErrorSchema extends TObject = TObject,
  InputSchema extends TObject = TObject,
  OutputSchema extends TObject = TObject,
> extends Contract {
  type: 'operation';
  description: string;
  errorSchema: ErrorSchema;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  version: string;
}
