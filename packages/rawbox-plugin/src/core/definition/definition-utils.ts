import { type Definition } from './definition-types.js';
import type { Contract } from '../contracts/contract-registry-types.js';

export function definitionGuard(
  definition: object,
): definition is Definition<Contract> {
  return (
    typeof definition === 'object' &&
    definition !== null &&
    'contract' in definition &&
    'handler' in definition &&
    'validatedHandler' in definition
  );
}
