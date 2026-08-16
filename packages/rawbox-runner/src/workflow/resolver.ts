import { ok, err, type Result } from 'neverthrow';

import {
  descriptorFor,
  type BoxStrategy,
  type ReadBoxLocation,
  type WriteBoxLocation,
} from '@rawbox/store';
import type {
  Contract,
  ContractRegistry,
  ContractRegistryCache,
} from '@rawbox/plugin/core';

import type { RawboxLock } from './lock-types.js';
import {
  checkFifoSeedIsList,
  collectLiteralBindingProblems,
  collectStorageOwnershipProblems,
} from './validation.js';
import { resolveKeyTable } from './key-table.js';
import type { ResolvedWorkflow, Seed, Workflow } from './workflow-types.js';
import {
  CONTROL_FLOW_OPERATION_PREFIX,
  TIMEOUT_MS_MAX,
  UNBOUNDED_TIMEOUT,
  type OutputRef,
  type ResolvedStep,
  type Step,
} from './step-types.js';

// ---------------------------------------------------------------------------
// Contract shapes
//
// The resolver reads exactly two fields off a contract, and both are
// host-execution policy rather than schema:
//
//   - `type`, to cross-check the `control-flow/` path convention against the
//     contract's real kind;
//   - `timeoutMs`, the bound a step's own `timeoutMs:` overrides.
//
// It deliberately reads neither `inputSchema` nor the other schemas. A seed
// value is checked against the field that consumes it in `validateSeedData`,
// on the resolved model, and keeping that split means the resolver never has to
// know what a schema is.
//
// A contract is *data from a third-party package*, not something this codebase
// typechecked: a plugin may be plain JavaScript, or compiled against an older
// `@rawbox/plugin` that had no `timeoutMs` at all. `Contract` now declares the
// field as `number | undefined`, which is what a well-behaved plugin provides
// and not what this layer may assume it holds — hence `BoundedContract`, which
// re-widens it to `unknown` so that reading it forces a check.
// ---------------------------------------------------------------------------

const CONTRACT_TYPE_OPERATION = 'operation';
const CONTRACT_TYPE_CONTROL_FLOW = 'control-flow';

/**
 * A contract as the resolver must treat one: `timeoutMs` widened back to
 * `unknown`.
 *
 * `Omit` is required rather than stylistic — an interface extending `Contract`
 * may only narrow a property, and `unknown` widens `number | undefined`.
 */
interface BoundedContract extends Omit<Contract, 'timeoutMs'> {
  timeoutMs?: unknown;
}

// ---------------------------------------------------------------------------
// Small text helpers — error quality is a deliverable, not polish.
// ---------------------------------------------------------------------------

/** Levenshtein distance, used only to suggest a nearest match in errors. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = current[j - 1]! + 1;
      const deletion = previous[j]! + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }

  return previous[b.length]!;
}

/**
 * Picks the closest candidate to `target`, or `undefined` when nothing is close
 * enough to be worth suggesting.
 */
function nearestMatch(
  target: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const distance = editDistance(target, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  if (best === undefined) return undefined;

  // Deliberately strict: the full candidate list is always printed, so a
  // missing suggestion costs nothing while a wrong one ("did you mean
  // @rawbox/rawbox-plugin-default?" for @acme/rawbox-plugin-kraken) actively
  // misleads. This admits typos and transpositions, not different names.
  const threshold = Math.max(2, Math.floor(Math.min(target.length, best.length) * 0.25));
  return bestDistance <= threshold ? best : undefined;
}

/**
 * Whether a value is a bound this runner could actually enforce: a whole number
 * of milliseconds from 1 to {@link TIMEOUT_MS_MAX}.
 *
 * The same predicate the SDK applies at registry setup and the same one the
 * document schema expresses as `Type.Integer({ minimum: 1, maximum: … })`. It
 * is restated here because the value being checked came out of a third-party
 * package rather than out of either of those.
 */
function isBoundedTimeoutMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= TIMEOUT_MS_MAX
  );
}

/**
 * Renders a rejected `timeoutMs` for a diagnostic.
 *
 * Guarded rather than a bare `JSON.stringify`, because the value came out of a
 * third-party package and may be a `BigInt`, a cycle or a `Symbol` — all of
 * which throw. A diagnostic that crashes while describing bad data is worse
 * than the bad data.
 */
function renderTimeoutValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Renders a bullet list, or a `(none)` marker when empty. */
function bulletList(items: readonly string[]): string {
  if (items.length === 0) return '  (none)';
  return items.map((item) => `  - ${item}`).join('\n');
}

/** Human-readable identity of a step, for error messages. */
function describeStep(step: Step, index: number): string {
  return step.label ? `step "${step.label}" (steps[${index}])` : `steps[${index}]`;
}

// ---------------------------------------------------------------------------
// Plugin → registry
//
// The package-name → registry-hash mapping is supplied by the caller. It
// cannot be recovered from `ContractRegistryCache`, which is keyed by content
// hash: a registry's only back-reference is `contractRegistryPath`, the file
// path of the module that called `setupContractRegistry`, and that path loses
// the package name whenever the plugin is symlinked — npm workspaces, or a
// `file:` specifier. The caller has the pairing already: `PluginDiscoverer`
// iterates package names while `addContractRegistry` returns the hash.
// ---------------------------------------------------------------------------

/** A declared package paired with the loaded registry that provides it. */
interface ResolvedPlugin {
  hash: string;
  registry: ContractRegistry<Contract>;
}

// ---------------------------------------------------------------------------
// resolveWorkflow
// ---------------------------------------------------------------------------

/**
 * Translates an authored workflow into the runtime model the XState machine consumes.
 *
 * - `plugin:` → `contractRegistryHash`, a direct lookup in
 *   `registryHashByPlugin`. A step naming a package that is not a key of
 *   `plugins:` lists the declared packages and suggests the nearest; a declared
 *   package absent from the supplied map lists the map's keys.
 * - `operation:` → `definitionPath: "./<operation>.definition.js"`, including
 *   nested control-flow paths. An unmatched value lists the registry's contract
 *   keys and suggests the nearest.
 * - bare key and long form → `BoxLocation`, with the strategy taken from
 *   `storage.keys[key].strategy ?? storage.defaultStrategy`.
 * - each `storage.keys` entry's `seed:` → `seedData`, one `Seed` per write. A
 *   seed for an `lmdb-fifo` key MUST be a list and is expanded into one `Seed`
 *   per element; a non-list is an error naming the key and its strategy.
 * - the `control-flow/` operation-path convention is cross-checked against the
 *   contract's real `type`, which the schema layer cannot see.
 * - `timeoutMs` → the step's effective bound, `step.timeoutMs ??
 *   contract.timeoutMs ?? unbounded`. The document overrides rather than
 *   tightens, so `timeoutMs: unbounded` removes a bound the contract declared;
 *   the word itself does not survive, because an absent `timeoutMs` on the
 *   resolved step *is* unbounded. A contract whose own `timeoutMs` is malformed
 *   is an error naming the plugin, since no edit to the document can fix it.
 * - when `lock` is supplied, each declared package's registry hash is verified
 *   and a mismatch is a hard error naming the package.
 *
 * Every problem found is reported, not just the first: these documents are
 * authored by agents iterating against `workflow verify`, so a single pass
 * should surface the whole fix list.
 *
 * Pure: it reads no files. The caller supplies the lock.
 *
 * @param workflow - The parsed, schema-valid authoring document.
 * @param registryCache - Cache already populated with the workspace's plugins.
 *   Needed to reach each contract once its hash is known.
 * @param registryHashByPlugin - Package name → contract-registry hash, produced
 *   by whoever loaded the plugins.
 * @param lock - Optional `rawbox.lock` contents to verify against.
 * @returns The resolved runtime workflow, or a multi-line diagnostic string.
 */
export function resolveWorkflow(
  workflow: Workflow,
  registryCache: ContractRegistryCache,
  registryHashByPlugin: Readonly<Record<string, string>>,
  lock?: RawboxLock,
): Result<ResolvedWorkflow, string> {
  const errors: string[] = [];
  const { storage } = workflow;

  // `resolveKeyTable` is the one place `keys:` is read — see `key-table.ts`.
  // Computed once and reused below for both `strategyFor` (a step's own
  // locations) and the seed loop, so a key's strategy and a key's seed are read
  // off the same table rather than from two independent walks of `storage.keys`
  // that could disagree about what the block declares.
  const { byKey, entryList } = resolveKeyTable(storage);

  // A lookup rather than a scan, because `byKey` is a `Map` — see the note on
  // `StorageKeyTable.byKey` (`key-table.ts`). Falls back to `defaultStrategy`
  // for a key `storage.keys` does not declare (named only by a step binding),
  // which is the format's one resolution rule.
  const strategyFor = (key: string): BoxStrategy =>
    byKey.get(key)?.strategy ?? storage.defaultStrategy;

  // Who owns the box, when `storage.keys.<key>.workflow` says so. This is what
  // makes ownership a property of the *key* rather than of one read: a bare
  // `inputs: { ms: shared_state }` resolves to a cross-workflow
  // `ReadBoxLocation` because the key table says the box is another
  // workflow's, with nothing about the binding having to repeat it.
  //
  // Undefined for every key the table does not declare foreign — including
  // every key of every document written before ownership existed — so a bare
  // input still resolves to a plain local read, unchanged.
  const ownerFor = (key: string): string | undefined => byKey.get(key)?.workflow;

  // -- Rejected `{ value: … }` binding ---------------------------------------
  // Defensive rather than expected: every entry point validates the document
  // first, and `validateWorkflowType` rejects this shape before the schema even
  // runs. `resolveWorkflow` is exported and pure, though, so it cannot assume it
  // was called in order — and a literal reaching the loop below would resolve to
  // a binding with no key at all rather than to an error. The shared helper keeps
  // the two diagnostics identical rather than merely similar.
  errors.push(...collectLiteralBindingProblems(workflow));

  // -- Writes to a key another workflow owns ---------------------------------
  // Defensive for the same reason and in the same way: every entry point
  // validates first (`validateStorageOwnership`), but this function is exported
  // and pure. Left unchecked, an `outputs:` binding on a key declaring
  // `workflow:` would resolve into a perfectly ordinary local
  // `WriteBoxLocation` — a second box of the same name in this workflow, which
  // is precisely the silent divergence the rule exists to prevent, and the one
  // thing no check on the resolved model can still see. The shared helper keeps
  // the two diagnostics identical rather than merely similar.
  errors.push(...collectStorageOwnershipProblems(workflow));

  // -- Plugin → registry -----------------------------------------------------
  const declaredPackages = Object.keys(workflow.plugins);
  const suppliedPackages = Object.keys(registryHashByPlugin);
  const resolvedPlugins = new Map<string, ResolvedPlugin>();

  for (const packageName of declaredPackages) {
    const hash = registryHashByPlugin[packageName];

    if (hash === undefined) {
      const suggestion = nearestMatch(packageName, suppliedPackages);
      errors.push(
        `Plugin "${packageName}" is declared in \`plugins:\` but no contract registry ` +
          `was loaded for it.\n` +
          `Registries were loaded for (${suppliedPackages.length}):\n` +
          `${bulletList(suppliedPackages)}` +
          (suggestion ? `\nDid you mean "${suggestion}"?` : '') +
          `\nInstall and compile the package, then retry ` +
          `(npx rawbox-cli workspace setup <workspace file> [target folder]).`,
      );
      continue;
    }

    const registry = registryCache.getContractRegistry(hash);
    if (!registry) {
      errors.push(
        `Plugin "${packageName}" was loaded with contract registry hash ${hash}, but no ` +
          `registry with that hash is in the cache.\n` +
          `The hash map and the registry cache disagree — they are produced together when ` +
          `a workspace's plugins are loaded, so this is a stale map rather than an ` +
          `authoring mistake.`,
      );
      continue;
    }

    resolvedPlugins.set(packageName, { hash, registry });
  }

  // -- rawbox.lock verification ----------------------------------------------
  // A missing lock means "resolve whatever is installed"; a missing *entry* in
  // a present lock is treated the same way, so a partially locked workspace is
  // usable. A present entry that disagrees is a hard error.
  if (lock) {
    for (const packageName of declaredPackages) {
      const entry = lock.plugins[packageName];
      const resolved = resolvedPlugins.get(packageName);
      if (!entry || !resolved) continue;
      if (entry.registryHash !== resolved.hash) {
        errors.push(
          `rawbox.lock mismatch for plugin "${packageName}".\n` +
            `  locked   : ${entry.registryHash} (resolved version ${entry.resolved})\n` +
            `  installed: ${resolved.hash}\n` +
            `The installed package's contracts differ from the locked ones. ` +
            `Re-lock with: npx rawbox-cli workflow lock <workflow file>`,
        );
      }
    }
  }

  // -- Steps ----------------------------------------------------------------
  const stepList: ResolvedStep[] = [];

  workflow.steps.forEach((step, index) => {
    const where = describeStep(step, index);

    if (!Object.prototype.hasOwnProperty.call(workflow.plugins, step.plugin)) {
      const suggestion = nearestMatch(step.plugin, declaredPackages);
      errors.push(
        `${where}: plugin "${step.plugin}" is not declared in \`plugins:\`.\n` +
          `Declared packages:\n${bulletList(declaredPackages)}` +
          (suggestion ? `\nDid you mean "${suggestion}"?` : ''),
      );
      return;
    }

    const resolvedPlugin = resolvedPlugins.get(step.plugin);
    // The "no registry loaded" error was already reported once, at the
    // declaration; repeating it per step would bury the real fix list.
    if (!resolvedPlugin) return;

    const definitionPath = `./${step.operation}.definition.js`;
    const contractKeys = Object.keys(resolvedPlugin.registry.contractRecord).sort();
    const contract = resolvedPlugin.registry.contractRecord[definitionPath] as
      | BoundedContract
      | undefined;

    if (!contract) {
      const suggestion = nearestMatch(definitionPath, contractKeys);
      const asOperation = (path: string): string =>
        path.replace(/^\.\//, '').replace(/\.definition\.js$/, '');
      errors.push(
        `${where}: operation "${step.operation}" was not found in plugin ` +
          `"${step.plugin}" (looked for "${definitionPath}").\n` +
          `Operations provided by this plugin:\n` +
          `${bulletList(contractKeys.map(asOperation))}` +
          (suggestion ? `\nDid you mean "${asOperation(suggestion)}"?` : ''),
      );
      return;
    }

    // -- Control-flow cross-check -------------------------------------------
    // The schema discriminates on the `control-flow/` path prefix because that
    // is the only signal available before the registry loads. That prefix is a
    // convention of `@rawbox/rawbox-plugin-default`, not a guarantee, so the
    // contract's real `type` is authoritative here.
    const pathSaysControlFlow = step.operation.startsWith(
      CONTROL_FLOW_OPERATION_PREFIX,
    );
    const outputs =
      (step as { outputs?: Record<string, OutputRef> }).outputs ?? {};
    const declaresOutputs = Object.keys(outputs).length > 0;

    if (
      contract.type !== CONTRACT_TYPE_OPERATION &&
      contract.type !== CONTRACT_TYPE_CONTROL_FLOW
    ) {
      errors.push(
        `${where}: contract "${definitionPath}" in plugin "${step.plugin}" declares ` +
          `an unrecognised type "${contract.type}". Expected ` +
          `"${CONTRACT_TYPE_OPERATION}" or "${CONTRACT_TYPE_CONTROL_FLOW}".`,
      );
      return;
    }

    if (contract.type === CONTRACT_TYPE_CONTROL_FLOW && declaresOutputs) {
      // Reachable only when a control-flow contract lives outside the
      // `control-flow/` prefix, so the schema classified the step as an
      // operation and allowed `outputs:`. A control-flow contract has no
      // `outputSchema` — it returns `{ label }` — so these writes can never be
      // satisfied.
      errors.push(
        `${where}: operation "${step.operation}" resolves to a control-flow contract ` +
          `(type: "${CONTRACT_TYPE_CONTROL_FLOW}"), which produces no outputs, but the ` +
          `step declares outputs: ${Object.keys(outputs).join(', ')}.\n` +
          `Remove \`outputs:\`. Note that this step's operation path does not start ` +
          `with "${CONTROL_FLOW_OPERATION_PREFIX}", so the schema could not reject it.`,
      );
      return;
    }

    if (contract.type === CONTRACT_TYPE_OPERATION && pathSaysControlFlow) {
      // The mirror image: an ordinary operation placed under `control-flow/`.
      // The schema forbids `outputs:` on this step, so the operation's results
      // would be silently discarded — a data-loss shape with no author-visible
      // symptom.
      errors.push(
        `${where}: operation "${step.operation}" is under "${CONTROL_FLOW_OPERATION_PREFIX}" ` +
          `but its contract in plugin "${step.plugin}" declares type ` +
          `"${CONTRACT_TYPE_OPERATION}".\n` +
          `The schema forbids \`outputs:\` on any step whose operation path starts with ` +
          `"${CONTROL_FLOW_OPERATION_PREFIX}", so this operation's outputs could never be ` +
          `written. Move the definition out of "${CONTROL_FLOW_OPERATION_PREFIX}", or ` +
          `declare its contract as "${CONTRACT_TYPE_CONTROL_FLOW}".`,
      );
      return;
    }

    // -- Bounded step -------------------------------------------------------
    // Placed after the cross-checks above, all of which `return`: a step whose
    // operation is in the wrong half of the format has a more fundamental
    // problem than its bound, and reporting both would bury the one that has to
    // be fixed first.
    //
    // Composition is **override**, not minimum:
    //
    //     effective = step.timeoutMs ?? contract.timeoutMs ?? unbounded
    //
    // so a document may tighten the contract's bound, loosen it, or remove it
    // outright with `timeoutMs: unbounded`. A minimum would make that last case
    // inexpressible wherever a contract already declared a bound, and it is the
    // case that matters most: an operation that blocks until a third party
    // sends the next message is frequently the workflow's own pacing mechanism.
    // The document is also the only side that can know the number — in practice
    // a bound is derived from other values seeded in the same file, which no
    // plugin author can see.
    const declaredContractTimeout: unknown = contract.timeoutMs;

    if (
      declaredContractTimeout !== undefined &&
      !isBoundedTimeoutMs(declaredContractTimeout)
    ) {
      // The plugin's mistake, not the document's, and the message has to say so
      // — the author cannot fix this by editing their workflow. Same reasoning
      // as the unrecognised-`contract.type` error above: a contract is data
      // from a third-party package, so the resolver states which package and
      // which contract rather than assuming the SDK vetted it.
      // `setupContractRegistry` rejects this at module evaluation, so reaching
      // here means a plugin built the record some other way.
      errors.push(
        `${where}: contract "${definitionPath}" in plugin "${step.plugin}" declares ` +
          `an invalid timeoutMs (${renderTimeoutValue(declaredContractTimeout)}). ` +
          `A contract's timeoutMs must be a whole number of milliseconds from 1 to ` +
          `${TIMEOUT_MS_MAX}, or be omitted entirely to declare the component unbounded.\n` +
          `This is the plugin's own declaration, not this document's — nothing in ` +
          `this workflow can correct it. Report it to the plugin's author, or pin ` +
          `a version that does not carry it.`,
      );
      return;
    }

    // Re-derived through the guard rather than reusing the narrowing above:
    // `declaredContractTimeout` is `unknown`, and this is what turns it into
    // the `number | undefined` the merge is written over.
    const contractTimeoutMs = isBoundedTimeoutMs(declaredContractTimeout)
      ? declaredContractTimeout
      : undefined;

    const effectiveTimeout = step.timeoutMs ?? contractTimeoutMs;
    // `'unbounded'` is an authoring spelling and stops here: the resolved model
    // has two states, and a present `timeoutMs` is the whole of "bounded".
    const resolvedTimeoutMs =
      effectiveTimeout === UNBOUNDED_TIMEOUT ? undefined : effectiveTimeout;

    // -- Storage locations --------------------------------------------------
    const inputRecord: Record<string, ReadBoxLocation> = {};
    const outputRecord: Record<string, WriteBoxLocation> = {};
    const errorRecord: Record<string, WriteBoxLocation> = {};

    for (const [field, ref] of Object.entries(step.inputs ?? {})) {
      const key = typeof ref === 'string' ? ref : ref.key;
      const strategy = strategyFor(key);

      // The binding's own `workflow:` first, then the key table's. This is a
      // pick between two spellings of one fact, not a precedence rule: the two
      // are only ever both present when they agree, because disagreeing is an
      // error `collectStorageOwnershipProblems` reports by name (pushed above,
      // and by every entry point before this function runs). The binding is
      // read first only because it is the narrower statement — it names one
      // read, where the table names the box.
      const workflowName =
        (typeof ref === 'string' ? undefined : ref.workflow) ?? ownerFor(key);

      // Conditional spread rather than `workflow: workflowName`:
      // `exactOptionalPropertyTypes` is on, and `ReadBoxLocation.workflow` is
      // optional, so an explicit `undefined` is a different value from an
      // absent key — and absent is what "this workflow's own box" is.
      inputRecord[field] = {
        key,
        strategy,
        ...(workflowName === undefined ? {} : { workflow: workflowName }),
      };
    }

    for (const [field, ref] of Object.entries(outputs)) {
      const key = typeof ref === 'string' ? ref : ref.key;
      outputRecord[field] = { key, strategy: strategyFor(key) };
    }

    for (const [field, ref] of Object.entries(step.errors ?? {})) {
      const key = typeof ref === 'string' ? ref : ref.key;
      errorRecord[field] = { key, strategy: strategyFor(key) };
    }

    stepList.push({
      definitionLocation: {
        contractRegistryHash: resolvedPlugin.hash,
        definitionPath,
      },
      storageLocation: {
        error: errorRecord,
        input: inputRecord,
        output: outputRecord,
      },
      ...(step.label === undefined ? {} : { label: step.label }),
      // Conditional spread, not `timeoutMs: resolvedTimeoutMs`:
      // `exactOptionalPropertyTypes` is on, so an explicit `undefined` is a
      // different thing from an absent key and would not typecheck against
      // `Type.Optional(...)`. It is also the difference the resolved model is
      // built on — absent *is* unbounded.
      ...(resolvedTimeoutMs === undefined ? {} : { timeoutMs: resolvedTimeoutMs }),
    });
  });

  // -- Seeds ----------------------------------------------------------------
  // Seeds keep their document order, so the list is stable across runs. That
  // order is `entryList`'s — the `keys:` entries as written (see the note on
  // `StorageKeyTable.entryList`) — filtered to the keys with `hasSeed: true`,
  // which is the same order `validateStorageSizes` sweeps in, so the checks and
  // the writes agree about which seed is which.
  //
  // This is where an `lmdb-fifo` seed is *expanded*: the authored list becomes
  // one `Seed` per element, so a `Seed` means exactly one write under every
  // strategy. Expanding here rather than at the point of writing buys two
  // things. `validateSeedData` then checks each element against the consuming
  // step's `inputSchema` for free, which is the right pairing — one `get` on a
  // FIFO dequeues one entry, so the field's schema types one entry, not the
  // list. And `run-workflow.ts`'s seeding loop stays a dumb
  // one-`putSync`-per-`Seed` loop with no strategy special case in it.
  //
  // Several `Seed`s therefore share a key. Nothing downstream indexes
  // `seedData` by key — the writer iterates it and `validateSeedData` scans
  // it — and FIFO order is the array's order, which `entryList` and the loop
  // below both preserve.
  const seedData: Seed[] = [];

  for (const entry of entryList) {
    if (!entry.hasSeed) continue;

    const { key, strategy, seed: value, declaredAt } = entry;

    // The question is whether one seed entry expands into N writes rather
    // than one, which is `descriptorFor(strategy).seedExpandsList` — not
    // specifically whether the strategy is named `lmdb-fifo`
    // (`@rawbox/store`'s `strategy/descriptor.ts`). A cell's seed is the
    // value, stored as written, so a strategy that answers `false` here
    // takes this branch unexpanded regardless of its name.
    if (!descriptorFor(strategy).seedExpandsList) {
      seedData.push({ key, strategy, value });
      continue;
    }

    // Defensive: every entry point validates the document before resolving it,
    // so `validateStorageSizes` has already reported this. `resolveWorkflow` is
    // exported and pure, though, so it cannot assume it was called in order —
    // and the shared helper keeps the two diagnostics identical rather than
    // merely similar.
    const shapeProblem = checkFifoSeedIsList({
      value,
      strategy,
      // Present exactly when `hasSeed` is (`ResolvedStorageKey`'s invariant,
      // `key-table.ts`), which the `if (!entry.hasSeed) continue;` above
      // already established.
      subject: declaredAt.seed!,
      strategyLabel: declaredAt.strategy,
    });
    if (shapeProblem) {
      errors.push(shapeProblem);
      continue;
    }

    for (const element of value as readonly unknown[]) {
      seedData.push({ key, strategy, value: element });
    }
  }

  if (errors.length > 0) {
    return err(
      `Failed to resolve workflow "${workflow.name}":\n\n${errors.join('\n\n')}`,
    );
  }

  return ok({
    name: workflow.name,
    pluginPathList: declaredPackages,
    stepList,
    ...(seedData.length === 0 ? {} : { seedData }),
  });
}
