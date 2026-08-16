import type {
  Contract,
  ObjectSchemaLike,
} from '../../core/contracts/contract-registry-types.js';

export interface OperationContract<
  ErrorSchema extends ObjectSchemaLike = ObjectSchemaLike,
  InputSchema extends ObjectSchemaLike = ObjectSchemaLike,
  OutputSchema extends ObjectSchemaLike = ObjectSchemaLike,
> extends Contract {
  type: 'operation';
  description: string;
  errorSchema: ErrorSchema;
  inputSchema: InputSchema;
  outputSchema: OutputSchema;
  version: string;
}
