import {
  type Contract,
  type ObjectSchemaLike,
} from '../../core/contracts/contract-registry-types.js';

export interface ControlFlowContract<
  TInputSchema extends ObjectSchemaLike = ObjectSchemaLike,
  TErrorSchema extends ObjectSchemaLike = ObjectSchemaLike,
> extends Contract {
  type: 'control-flow';
  description: string;
  errorSchema: TErrorSchema;
  inputSchema: TInputSchema;
  version: string;
}
