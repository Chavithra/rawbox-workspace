import type {
  Contract,
  ContractRecord,
  ContractRegistryPath,
  SpecificContractRegistry,
} from './contract-registry-types.js';
import { TIMEOUT_MS_MAX } from './contract-registry-types.js';
import { getCallerFilePath } from '../entries-utils.js';

/**
 * Describe how one contract's `timeoutMs` is malformed, or `undefined` when it
 * is absent (the "deliberately unbounded" declaration) or a usable bound.
 *
 * Split out from the loop below so the sentence is written once: the same
 * mistake reached through `setupOperationContractRegistry`,
 * `setupControlFlowContractRegistry` and `setupPluginRegistry` must read
 * identically, since which of the three a plugin uses is a matter of when the
 * package was scaffolded.
 */
function describeTimeoutProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;

  if (typeof value !== 'number') {
    return `it is ${value === null ? 'null' : `of type ${typeof value}`}`;
  }

  if (!Number.isFinite(value)) {
    return `it is ${Number.isNaN(value) ? 'NaN' : String(value)}`;
  }

  if (!Number.isInteger(value)) {
    return `it is ${value}, which is not a whole number of milliseconds`;
  }

  if (value < 1) {
    // `0` is the trap this rejects: it reads as "no bound" in the C tradition
    // and as "fire immediately" to `setTimeout`, so accepting it would silently
    // discard a safety bound the author believed they had declared. Absence is
    // how unbounded is spelled, and absence cannot be produced by arithmetic.
    return `it is ${value}, and a bound must be at least 1ms`;
  }

  if (value > TIMEOUT_MS_MAX) {
    return (
      `it is ${value}, which exceeds ${TIMEOUT_MS_MAX} — Node clamps a larger ` +
      `setTimeout delay to 1ms with a TimeoutOverflowWarning, so such a bound ` +
      `fires immediately instead of never`
    );
  }

  return undefined;
}

/**
 * Build a contract registry from a record of contracts.
 *
 * This is the single choke point every registry construction funnels through —
 * `setupPluginRegistry` merges its two records and calls it, and the older
 * `setupOperationContractRegistry` / `setupControlFlowContractRegistry` pair
 * (still what the README's "Adding an Operation Type Component" and "Adding a Control-Flow Type Component" walkthroughs teach) are thin wrappers over
 * it — which is why the `timeoutMs` check lives here rather than in any of
 * them. A registry is built at module evaluation, so a malformed bound throws
 * when the plugin is *imported*: before discovery reports the package as
 * loadable and long before a workflow addresses one of its steps.
 *
 * @param options.contractRecord - definition path → contract.
 * @param options.contractRegistryPath - normally omitted; recovered from the
 *   call site.
 * @param callerDepth - how far up the stack the calling module sits, so a
 *   wrapper can account for its own frame.
 */
export function setupContractRegistry<
  TContractRecord extends ContractRecord<Contract>,
>(
  options: {
    contractRecord: TContractRecord;
    contractRegistryPath?: ContractRegistryPath;
  },
  callerDepth: number = 2,
): SpecificContractRegistry<TContractRecord> {
  const {
    contractRecord,
    contractRegistryPath = getCallerFilePath(callerDepth),
  } = options;

  for (const [definitionPath, contract] of Object.entries(contractRecord)) {
    const problem = describeTimeoutProblem(
      (contract as { timeoutMs?: unknown } | undefined)?.timeoutMs,
    );

    if (problem === undefined) continue;

    // Thrown rather than returned: `setupContractRegistry` has no failure
    // channel — its result is exported as a module's `default` — and a registry
    // whose bound cannot be believed must not become addressable. The message
    // names the definition path because a registry is one object literal
    // holding every contract in the package, so "which contract" is the only
    // thing the stack trace cannot say.
    throw new Error(
      `Contract "${definitionPath}" declares an invalid timeoutMs: ${problem}.\n` +
        `A contract's timeoutMs is a whole number of milliseconds from 1 to ` +
        `${TIMEOUT_MS_MAX}.\n` +
        `To declare this component deliberately unbounded, omit the key ` +
        `entirely — there is no "no bound" value, and absence is the ` +
        `declaration.`,
    );
  }

  return {
    contractRecord,
    contractRegistryPath,
    rawboxPluginVersion: '1.0.0',
  } as SpecificContractRegistry<TContractRecord>;
}
