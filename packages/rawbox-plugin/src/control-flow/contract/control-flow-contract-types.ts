import { type TObject } from 'typebox';

import { type Contract } from '../../core/contracts/contract-registry-types.js';

export interface ControlFlowContract<
  TInputSchema extends TObject = TObject,
  TErrorSchema extends TObject = TObject,
> extends Contract {
  type: 'control-flow';
  description: string;
  errorSchema: TErrorSchema;
  inputSchema: TInputSchema;
  version: string;
}
