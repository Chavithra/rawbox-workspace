import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import YAML from 'yaml';
import { DOCUMENT_KIND, FORMAT_VERSION } from '@rawbox/runner';
import { getErrorMessage } from '../../utils/error.js';

// ---------------------------------------------------------------------------
// Annotated YAML emission
//
// The generators emit YAML rather than JSON for one reason: these documents
// exist to be read and edited by humans and agents, and JSON cannot carry a
// comment.
// A comment-free YAML file would satisfy the letter of that decision and none
// of its purpose, so everything scaffolded here is annotated — including the
// shapes an author is least likely to guess (a `storage.keys` entry's
// `strategy:`, the long form of a binding, the control-flow asymmetry), which are emitted
// commented-out where the real document has no use for them.
//
// The `yaml` Document API is used instead of string templating so that every
// dynamic value (workspace names, specifiers, paths) is quoted by the
// serializer rather than by hand.
// ---------------------------------------------------------------------------

/** Where a comment attaches, and what it says. */
export interface YamlAnnotation {
  /**
   * Path to the map entry or sequence item the annotation decorates, e.g.
   * `['storage', 'seed']` or `['steps', 0]`.
   */
  path: readonly (string | number)[];
  /** Comment block placed above the entry. One `#` line per source line. */
  before?: string;
  /** Trailing comment on the value's own line. */
  inline?: string;
  /** Blank line before the entry. Defaults to true whenever `before` is set. */
  spaceBefore?: boolean;
  /** Force double quotes, for values that read as noise unquoted. */
  quote?: boolean;
}

/**
 * Turns plain text into the form `yaml` expects for a comment: the library
 * prefixes each line with `#`, so a leading space is added here to get
 * `# text` rather than `#text`.
 *
 * A blank line becomes a lone space rather than nothing, because the library
 * leaves genuinely empty lines unprefixed — a paragraph break would otherwise
 * split one comment into two blocks with a bare blank line between them.
 */
function toCommentText(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? ` ${line}` : ' '))
    .join('\n');
}

/** The node carrying an entry's leading comment, and the one carrying its inline comment. */
interface AnnotationTargets {
  before: YAML.Node;
  inline: YAML.Node;
}

/**
 * Locates the nodes an annotation applies to.
 *
 * For a map entry the leading comment belongs on the **key** — a comment set on
 * the value is emitted after `key:` — while an inline comment belongs on the
 * value. For a sequence item both are the item itself.
 */
function annotationTargets(
  doc: YAML.Document,
  nodePath: readonly (string | number)[],
): AnnotationTargets {
  const parentPath = nodePath.slice(0, -1);
  const last = nodePath[nodePath.length - 1];
  const parent =
    parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);

  if (!YAML.isCollection(parent)) {
    throw new Error(`No collection at "${parentPath.join('.')}" to annotate.`);
  }

  if (typeof last === 'number') {
    const item = parent.items[last];
    if (!YAML.isNode(item)) {
      throw new Error(`No sequence item at "${nodePath.join('.')}" to annotate.`);
    }
    return { before: item, inline: item };
  }

  const pair = (parent.items as unknown[]).find(
    (candidate) =>
      YAML.isPair(candidate) &&
      (YAML.isScalar(candidate.key) ? candidate.key.value : candidate.key) === last,
  );
  if (!YAML.isPair(pair) || !YAML.isNode(pair.key) || !YAML.isNode(pair.value)) {
    throw new Error(`No map entry at "${nodePath.join('.')}" to annotate.`);
  }
  return { before: pair.key, inline: pair.value };
}

/**
 * Serializes `data` to YAML with a header comment and per-entry annotations.
 *
 * @param data - The document contents, already in its final shape.
 * @param header - Comment block placed at the very top of the file.
 * @param annotationList - Comments to attach to individual entries.
 * @returns The YAML text, ready to write.
 */
export function renderAnnotatedYaml(
  data: unknown,
  header: string,
  annotationList: readonly YamlAnnotation[] = [],
): string {
  const doc = new YAML.Document(data);
  doc.commentBefore = toCommentText(header);

  for (const annotation of annotationList) {
    const targets = annotationTargets(doc, annotation.path);

    if (annotation.before !== undefined) {
      targets.before.commentBefore = toCommentText(annotation.before);
      if (annotation.spaceBefore !== false) {
        targets.before.spaceBefore = true;
      }
    }
    if (annotation.inline !== undefined) {
      targets.inline.comment = ` ${annotation.inline}`;
    }
    if (annotation.quote && YAML.isScalar(targets.inline)) {
      targets.inline.type = YAML.Scalar.QUOTE_DOUBLE;
    }
  }

  // `lineWidth: 0` disables folding: a wrapped comment or specifier is harder
  // to read and to diff than a long line.
  return doc.toString({ lineWidth: 0 });
}

// ---------------------------------------------------------------------------
// Shared document building blocks
// ---------------------------------------------------------------------------

/** The plugin every scaffolded workspace starts from. */
export const DEFAULT_PLUGIN_PACKAGE = '@rawbox/rawbox-plugin-default';

/**
 * Registry range for the default plugin, written into every scaffolded
 * workflow. Must match the published version of the lockstep `@rawbox/*` set.
 *
 * From `0.1.0` a caret behaves the way one reads it — `^0.1.0` is
 * `>=0.1.0 <0.2.0`, so a patch release is picked up without editing every
 * scaffolded document. That was not true while the set was on `0.0.x`, where a
 * caret admits one exact version (`^0.0.1` is `>=0.0.1 <0.0.2`) and every
 * release therefore stranded every document written against the previous one.
 */
const DEFAULT_PLUGIN_RANGE = '^0.1.0';

/** Subpath every Rawbox plugin exports to expose its `ContractRegistry`. */
const REGISTRY_SUBPATH = 'contract-registry';

/**
 * `storage.defaultStrategy` for a scaffolded workflow.
 *
 * 1900 keeps a scaffolded workflow's writes on shared LMDB leaf pages. The
 * cutoff is `keyBytes + valueSizeMax ≤ 2013` (rawbox-store/README.md, "Key and
 * Value Sizes"), so this leaves ≈113 bytes for the key —
 * enough even for the `fifo:<key>:data:<n>` a queue derives from an author key
 * of ~95 characters.
 */
export const DEFAULT_STORAGE_STRATEGY = {
  name: 'lmdb-kv',
  valueSizeMax: 1900,
} as const;

/**
 * Emits a `workspace.yaml`.
 *
 * `kind: Workspace` is what `workflow verify` reads when it walks up from a
 * workflow looking for its context, so it is never omitted.
 */
export function renderWorkspaceDocument(
  workspaceName: string,
  workflowPathList: readonly string[],
): string {
  const example = workflowPathList[0] ?? './workflows/launch.workflow.yaml';

  return renderAnnotatedYaml(
    {
      kind: DOCUMENT_KIND.WORKSPACE,
      name: workspaceName,
      workflowPathList: [...workflowPathList],
    },
    `Rawbox workspace — the runtime context its workflows execute in.\n` +
      `\n` +
      `\`kind:\` is how the tooling identifies this file: \`workflow verify\` walks up\n` +
      `from a workflow until it finds a "kind: ${DOCUMENT_KIND.WORKSPACE}" document, and uses that\n` +
      `directory to locate \`rawbox.lock\`.\n` +
      `\n` +
      `From this directory:\n` +
      `  npx rawbox-cli workspace verify ./workspace.yaml\n` +
      `  npx rawbox-cli workflow verify ${example}\n` +
      `  npx rawbox-cli workflow lock ${example}\n` +
      `  npx rawbox-cli workspace setup ./workspace.yaml`,
    [
      {
        path: ['workflowPathList'],
        before:
          `Where \`workspace setup\` installs the declared plugins, and where a run\n` +
          `resolves them from. Optional — it defaults to this directory, which is why\n` +
          `\`workspace setup ./workspace.yaml\` needs no second argument. Uncomment to\n` +
          `keep the installed packages out of the workspace directory:\n` +
          `\n` +
          `  targetFolder: ./target\n` +
          `\n` +
          `It is resolved relative to this file, like a \`file:\` plugin specifier, and\n` +
          `a \`target-folder\` argument on the command line overrides it. Whatever it\n` +
          `resolves to is on the run-time plugin resolution path, so setup and run\n` +
          `always agree.\n` +
          `\n` +
          `--\n` +
          `\n` +
          `The workflows that belong to this workspace, resolved relative to this\n` +
          `file. \`workspace setup\` installs the plugins all of them declare into one\n` +
          `target folder, and the \`rawbox.lock\` written beside this file records what\n` +
          `each package resolved to — one entry per package, shared by every workflow.\n` +
          `\n` +
          `--\n` +
          `\n` +
          `Optional. What a workflow's keys start with HERE, keyed by the workflow's\n` +
          `PATH — the very entry from the list above, since the same key name in two\n` +
          `workflows is two different boxes:\n` +
          `\n` +
          `  seedOverrides:\n` +
          `    ${example}:\n` +
          `      tick_ms: 250\n` +
          `\n` +
          `The path is matched after resolving it against this directory, so\n` +
          `\`./workflows/x.yaml\` and \`workflows/x.yaml\` are one workflow — and a path\n` +
          `in no \`workflowPathList\` entry is an error from \`run\`, \`workflow verify\`\n` +
          `and \`workspace verify\` alike, rather than a block that sits here looking\n` +
          `applied while every run uses the workflow's own value.\n` +
          `\n` +
          `(A WORKFLOW document names a sibling workflow by \`name:\` instead —\n` +
          `\`storage.keys.<key>.workflow\` — because a workflow must not depend on\n` +
          `this workspace's directory layout. Each document refers to a workflow by\n` +
          `the identifier it can check for itself.)\n` +
          `\n` +
          `It may only replace a seed the workflow already declares, replaces the\n` +
          `whole value, and is re-checked against the strategy that workflow\n` +
          `declares. It cannot change anything else about a key — not the strategy,\n` +
          `the sizing, the owner or the backend — so what an operation on that key\n` +
          `means is always what the workflow document says. \`--seed key=<json>\` on\n` +
          `\`workflow run\`/\`workflow verify\` is the same thing for one run, and wins\n` +
          `over this block.`,
      },
    ],
  );
}

interface WorkflowExampleOptions {
  /** Value of the workflow's `name:` field. */
  name: string;
  /** Path as it appears in `workflowPathList`, used in the header's commands. */
  relativePath: string;
  /** Package name declared in `plugins:`. */
  pluginPackage: string;
  /** npm dependency specifier for that package. */
  pluginSpecifier: string;
}

/**
 * A runnable launch countdown: five T-minus ticks, then liftoff.
 *
 * The loop is there deliberately — it exercises every shape a first document
 * needs: an operation reading and writing the same key (`t_minus`), constants
 * reaching handlers through seeds, and two control-flow steps whose asymmetry —
 * `inputs:` and `errors:` but never `outputs:` — is the shape an author is
 * least likely to guess. A scaffold that never shows it leaves the reader to
 * discover it from a validation error. Every jump target and constant comes
 * from a seeded key, because every input does: there is no inline-literal form.
 */
export function renderDefaultWorkflowDocument(
  options: WorkflowExampleOptions,
): string {
  const { name, relativePath, pluginPackage, pluginSpecifier } = options;

  return renderAnnotatedYaml(
    {
      kind: DOCUMENT_KIND.WORKFLOW,
      formatVersion: FORMAT_VERSION,
      name,
      description:
        'Scaffolded example: a launch countdown — five T-minus ticks, then liftoff.',
      plugins: { [pluginPackage]: pluginSpecifier },
      storage: {
        defaultStrategy: { ...DEFAULT_STORAGE_STRATEGY },
        keys: {
          t_minus: { seed: 5 },
          minus_one: { seed: -1 },
          zero: { seed: 0 },
          op_gt: { seed: 'gt' },
          level: { seed: 'info' },
          tick_msg: { seed: 'T-minus' },
          tick_ms: { seed: 500 },
          label_tick: { seed: 'tick' },
          label_liftoff: { seed: 'liftoff' },
          liftoff_reason: { seed: '🚀 Liftoff!' },
        },
      },
      steps: [
        {
          label: 'tick',
          plugin: pluginPackage,
          operation: 'observability/log',
          inputs: { level: 'level', message: 'tick_msg', data: 't_minus' },
          outputs: { timestamp: 'tick_at' },
        },
        {
          plugin: pluginPackage,
          operation: 'time/sleep',
          inputs: { ms: 'tick_ms' },
          outputs: { timestamp: 'slept_at' },
        },
        {
          plugin: pluginPackage,
          operation: 'value-ops/increment',
          inputs: { value: 't_minus', step: 'minus_one' },
          outputs: { value: 't_minus' },
        },
        {
          plugin: pluginPackage,
          operation: 'value-ops/compare',
          inputs: { a: 't_minus', b: 'zero', operator: 'op_gt' },
          outputs: { result: 'still_counting' },
          errors: { message: 'compare_error' },
        },
        {
          plugin: pluginPackage,
          operation: 'control-flow/branch',
          inputs: {
            condition: 'still_counting',
            thenLabel: 'label_tick',
            elseLabel: 'label_liftoff',
          },
          errors: { message: 'branch_error' },
        },
        {
          label: 'liftoff',
          plugin: pluginPackage,
          operation: 'control-flow/halt',
          inputs: { reason: 'liftoff_reason' },
        },
      ],
    },
    `Rawbox workflow — format v${FORMAT_VERSION}.\n` +
      `\n` +
      `A launch countdown: log "T-minus" with the current count, sleep one tick,\n` +
      `count down, and loop while the count is above zero — then 🚀 Liftoff.\n` +
      `About 2.5 seconds end to end.\n` +
      `\n` +
      `Written to be edited by hand or by an agent. Check every change with:\n` +
      `  npx rawbox-cli workflow verify ${relativePath}\n` +
      `\n` +
      `The errors name the field that is wrong and list the values that would be\n` +
      `right, so verify early rather than at the end.`,
    [
      {
        path: ['plugins'],
        before:
          `The plugins this workflow uses: package name -> npm dependency specifier,\n` +
          `exactly the shape of \`dependencies\` in a package.json. The specifier\n` +
          `carries the source, so there is no separate source or path field:\n` +
          `\n` +
          `  "^0.1.0"                         from the npm registry\n` +
          `  "file:../../packages/my-plugin"  a local directory, resolved against the\n` +
          `                                   workspace directory — not against this file\n` +
          `  "git+https://host/repo.git#v1.2.3"  a git repository, pinned to a tag\n` +
          `\n` +
          `Every \`plugin:\` below must match a key here exactly. Resolved versions and\n` +
          `contract-registry hashes are deliberately absent: they belong to the\n` +
          `generated \`rawbox.lock\` beside workspace.yaml, so this file stays pure\n` +
          `"name: range" and is never rewritten under you.`,
      },
      { path: ['plugins', pluginPackage], quote: true },
      {
        path: ['storage'],
        before:
          `Storage. A strategy describes a box, so it is declared once per key here\n` +
          `and never repeated on a step: a key resolves as\n` +
          `\`keys[key].strategy ?? defaultStrategy\`, for seeds and step bindings\n` +
          `alike.`,
      },
      {
        path: ['storage', 'defaultStrategy'],
        before: 'Applies to every key the key table gives no strategy of its own.',
        spaceBefore: false,
      },
      {
        path: ['storage', 'defaultStrategy', 'valueSizeMax'],
        inline: 'largest value this box will hold, in bytes',
      },
      {
        path: ['storage', 'keys'],
        before:
          `The key table — one entry per key, holding everything this document says\n` +
          `about it. Uncomment to say more about a key than the default covers: a\n` +
          `FIFO queue rather than a key/value cell, say, or a box another workflow\n` +
          `owns. Every step that names the key picks it up, with no way for two\n` +
          `steps to disagree:\n` +
          `\n` +
          `  keys:\n` +
          `    queue_items:\n` +
          `      strategy:\n` +
          `        name: lmdb-fifo\n` +
          `        queueSizeMax: 1024  # entries the ring holds (1023 usable — one slot is reserved)\n` +
          `        valueSizeMax: 1900  # largest value one item in this queue will hold, in bytes\n` +
          `      seed: []              # an lmdb-fifo seed is a list, so this starts it empty\n` +
          `    shared_state:\n` +
          `      workflow: other-flow  # another workflow's box: readable here, never written here\n` +
          `\n` +
          `--\n` +
          `\n` +
          `Each key below carries a \`seed:\` — its initial value, written into\n` +
          `storage before the first step runs — on EVERY run, not only the first.\n` +
          `A seeded key is reset each time: the countdown writes \`t_minus\` down to\n` +
          `0, and the next run starts it back at 5. Seed configuration and starting\n` +
          `points, never accumulated state.\n` +
          `\n` +
          `The strategy comes from \`defaultStrategy\` above unless a key overrides\n` +
          `it, so a seed never restates it and can never contradict the step that\n` +
          `reads it. Constants live here too — a binding names a storage key,\n` +
          `never a value — so the log level, the "gt" operator and both jump\n` +
          `targets below are seeded, then bound by key like everything else.\n` +
          `\n` +
          `\`keys:\` is the only way to declare a key. Two earlier top-level blocks,\n` +
          `\`strategies:\` and \`seed:\`, stated the same two facts one map per fact;\n` +
          `both were removed, and \`workflow verify\` refuses a document still\n` +
          `writing either, printing the \`keys:\` entry that replaces it.\n` +
          `\n` +
          `A seed for an lmdb-fifo key must be a list, and each element becomes one\n` +
          `queue entry: [a, b, c] seeds three, [[a, b, c]] seeds one holding the list,\n` +
          `[] seeds an empty queue.\n` +
          `\n` +
          `A workspace may replace any of these values without editing this file —\n` +
          `only the value, never the strategy, the sizing or the owner:\n` +
          `\n` +
          `  seedOverrides:      # in workspace.yaml, keyed by this file's PATH —\n` +
          `    ${relativePath}:   # the entry workflowPathList holds\n` +
          `      tick_ms: 250\n` +
          `\n` +
          `  npx rawbox-cli run ${relativePath} --seed tick_ms=250\n` +
          `\n` +
          `Either may only replace a seed already declared here, and \`--seed\` wins\n` +
          `over the workspace for the same key.`,
      },
      {
        path: ['steps'],
        before:
          `Steps run top to bottom until a control-flow step redirects or the list\n` +
          `ends. \`plugin:\` is a key of \`plugins:\` above, matched exactly;\n` +
          `\`operation:\` is the contract path inside that plugin, so \`time/sleep\`\n` +
          `addresses "./time/sleep.definition.js" in its contract registry.\n` +
          `\n` +
          `This list is a countdown loop: tick -> sleep -> count down -> compare ->\n` +
          `branch back to \`tick\`, until the count reaches zero and the branch falls\n` +
          `through to \`liftoff\`.`,
      },
      {
        path: ['steps', 0],
        before:
          `\`inputs:\` read storage; \`outputs:\` and \`errors:\` write it. The short form\n` +
          `is just the storage key, which is what nearly every binding needs. The\n` +
          `long forms are:\n` +
          `\n` +
          `  data: { key: t_minus }                       the same thing, spelled out\n` +
          `  data: { key: shared, workflow: other-flow }  read another workflow's box\n` +
          `\n` +
          `\`workflow:\` is legal on inputs only — a step may never write outside its\n` +
          `own workflow, and no binding may name another workspace. A box another\n` +
          `workflow owns is usually better declared once on the key itself\n` +
          `(\`keys: { shared: { workflow: other-flow } }\`), after which the plain short\n` +
          `form above reads it; where both are written they must agree.\n` +
          `\n` +
          `\`label:\` is optional; it exists to be a jump target. \`tick\` is where the\n` +
          `branch below loops back to.`,
        spaceBefore: false,
      },
      {
        path: ['steps', 2],
        before:
          `Reads and writes the same box: \`t_minus\` steps by the seeded -1, so it\n` +
          `counts 5, 4, 3, 2, 1 across iterations — and the seed resets it to 5 when\n` +
          `the next run starts.`,
      },
      {
        path: ['steps', 3],
        before:
          `\`errors:\` is where this step's failure message would land. \`compare_error\`\n` +
          `is bound here and declared nowhere else — legal: a key a step writes needs\n` +
          `no seed, and takes \`defaultStrategy\` like any undeclared key.`,
      },
      {
        path: ['steps', 4],
        before:
          `A control-flow step steers execution instead of producing data. It takes\n` +
          `\`inputs:\` and \`errors:\` but never \`outputs:\` — the schema rejects them,\n` +
          `because a control-flow contract returns only a label.\n` +
          `\n` +
          `Its inputs are storage keys like any other step's — there is no\n` +
          `inline-literal form — so the jump targets are the seeded \`label_tick\` and\n` +
          `\`label_liftoff\`: while \`still_counting\` is true, jump back to the step\n` +
          `labelled \`tick\`; at zero, fall through to \`liftoff\`.`,
      },
      {
        path: ['steps', 5],
        before:
          `\`halt\` ends the run. Its \`reason\` reads the seeded \`liftoff_reason\` — the\n` +
          `🚀 printed at the end of a run is that seed arriving at the handler.`,
      },
    ],
  );
}

// ---------------------------------------------------------------------------
// Plugin availability
// ---------------------------------------------------------------------------

/**
 * Answers one question: can `workflow verify` load this package's contract
 * registry from here *right now*?
 *
 * The answer never changes what is scaffolded — the runnable example is always
 * emitted, because a run's auto-setup installs the declared plugin on the
 * first `rawbox-cli run` (from the registry the workspace's `.npmrc` names,
 * when one exists). The probe only decides whether to tell the author that
 * `workflow verify` needs a `workspace setup` first.
 *
 * It is deliberately the same procedure `workflow verify` uses — resolve
 * `<package>/contract-registry` as Node would from the workspace directory,
 * import it, and check it carries a `contractRecord` — so the notice fires
 * exactly when verification would fail.
 *
 * No registry hash is needed at scaffold time: hashes live in `rawbox.lock`, so
 * the answer here is a plain yes/no rather than a hash.
 */
async function isPluginRegistryLoadable(
  packageName: string,
  searchDirectoryList: readonly string[],
): Promise<boolean> {
  for (const directory of searchDirectoryList) {
    let modulePath: string;
    try {
      const requireFrom = createRequire(
        path.join(directory, '__rawbox_scaffold__.cjs'),
      );
      modulePath = requireFrom.resolve(`${packageName}/${REGISTRY_SUBPATH}`);
    } catch {
      continue;
    }

    try {
      const module = await import(pathToFileURL(modulePath).href);
      const registry = module.default ?? module.contractRegistry;
      if (registry?.contractRecord) {
        return true;
      }
    } catch {
      // Resolvable but not importable — not usable, so keep looking.
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Workflow file targets
// ---------------------------------------------------------------------------

interface WorkflowTarget {
  /** Entry as written in `workflowPathList`. */
  relativePath: string;
  /** Absolute path the file is written to. */
  absolutePath: string;
  /** Value of the document's `name:` field. */
  name: string;
}

/** Recognised document suffixes, longest first so `.workflow.yaml` wins. */
const WORKFLOW_SUFFIX_LIST = [
  '.workflow.yaml',
  '.workflow.yml',
  '.workflow.json',
  '.yaml',
  '.yml',
  '.json',
];

/**
 * Maps a `workflowPathList` entry to the file to write and the workflow name to
 * put inside it.
 *
 * Entries that would escape the workspace directory are skipped: the generator
 * writes the paths it advertises, and nothing else.
 */
function toWorkflowTarget(
  relativePath: string,
  targetDir: string,
): WorkflowTarget | undefined {
  const absolutePath = path.resolve(targetDir, relativePath);
  const relativeToTarget = path.relative(targetDir, absolutePath);
  if (
    relativeToTarget.length === 0 ||
    relativeToTarget.startsWith('..') ||
    path.isAbsolute(relativeToTarget)
  ) {
    return undefined;
  }

  const fileName = path.basename(absolutePath);
  const lowered = fileName.toLowerCase();
  const suffix = WORKFLOW_SUFFIX_LIST.find((candidate) =>
    lowered.endsWith(candidate),
  );
  const name =
    suffix === undefined ? fileName : fileName.slice(0, -suffix.length);

  return { relativePath, absolutePath, name: name || fileName };
}

// ---------------------------------------------------------------------------
// workspace create
// ---------------------------------------------------------------------------

/**
 * Content of the `.gitignore` written into every scaffolded workspace
 * directory.
 *
 * `.rawbox/` is where `workspace setup` installs plugins and a run writes its
 * LMDB data by default (`resolveTargetFolder`'s default, `<workspace
 * directory>/.rawbox`) — generated, machine-owned, safe to delete. `rawbox.lock`
 * is deliberately not covered: it is committed. See rawbox-cli README, "Workspace Initialization (`workspace setup`)".
 */
export const WORKSPACE_GITIGNORE =
  `# Generated by \`workspace setup\` / a run's auto-setup. Machine-owned and safe\n` +
  `# to delete — see rawbox-cli README, "Workspace Initialization".\n` +
  `.rawbox/\n`;

/**
 * Content of the `.npmrc` written when `--registry <url>` is passed to
 * `project create` / `workspace create`.
 *
 * The line is *scoped* on purpose: only `@rawbox/*` packages are routed to the
 * given registry (a local Verdaccio, a corporate proxy), while every
 * third-party dependency keeps resolving from the ambient registry.
 */
export function renderRegistryNpmrc(registryUrl: string): string {
  return (
    `# scaffolded by --registry; scoped, so third-party packages still come from npmjs\n` +
    `@rawbox:registry=${registryUrl}\n`
  );
}

/**
 * Minimal validation for a `--registry` value: it must parse as a URL and use
 * `http:` or `https:`. Returns the error message to report, or `undefined`
 * when the value is acceptable. The value is otherwise written into the
 * `.npmrc` exactly as given — npm, not rawbox, is the authority on the rest.
 */
export function registryUrlError(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return (
      `--registry expects a URL, got "${rawUrl}". ` +
      `Example: --registry http://localhost:4873`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return (
      `--registry expects an http:// or https:// URL, got "${rawUrl}" ` +
      `(protocol "${parsed.protocol}").`
    );
  }
  return undefined;
}

/**
 * Scaffolds a workspace directory: `workspace.yaml`, a `.gitignore` covering
 * `.rawbox/`, and one workflow per entry of `workflowPathList`. Run logs need
 * no scaffolding: they default to `.rawbox/logs/` inside the machine-owned
 * folder a run creates on demand.
 *
 * Everything emitted is YAML. The default plugin is always declared with the
 * published registry range (`DEFAULT_PLUGIN_RANGE`), never a `file:`
 * specifier — including when the workspace is scaffolded inside this
 * monorepo, where `workspace setup`/a run's auto-setup still resolves it with
 * no install and no registry contact, by walking up to the hoisted sibling
 * package (see CONTRIBUTING.md).
 */
export async function createWorkspace(options: {
  name?: string | undefined;
  workflows?: string[] | undefined;
  registry?: string | undefined;
} = {}) {
  // `--registry` is optional and never prompted for: absent, the scaffold is
  // exactly what it always was. Validated before anything else so a typo fails
  // here, not as a broken `.npmrc` discovered at install time.
  const registryUrl = options.registry?.trim();
  if (registryUrl !== undefined) {
    const urlError = registryUrlError(registryUrl);
    if (urlError !== undefined) {
      p.log.error(pc.red(urlError));
      process.exit(1);
      return;
    }
  }

  let workspaceName = options.name?.trim();

  if (!workspaceName) {
    p.intro(pc.cyan('Create a new Rawbox Workspace'));

    const answers = await p.group(
      {
        workspaceName: async () =>
          p.text({
            message: 'What is the name of your workspace?',
            placeholder: 'workspace-example',
            validate: (val) => {
              if (!val?.trim()) return 'Workspace name is required';
            },
          }),
      },
      {
        onCancel: () => {
          p.cancel('Operation cancelled.');
          process.exit(0);
        },
      }
    );

    workspaceName = answers.workspaceName.trim();
  }

  const rootDir = process.cwd();
  let inMonorepo = false;
  try {
    const pkg = JSON.parse(await fs.readFile(path.resolve(rootDir, 'package.json'), 'utf-8'));
    if (pkg.workspaces && Array.isArray(pkg.workspaces)) {
      inMonorepo = true;
    }
  } catch {
    // No readable package.json here — treat as a standalone (non-monorepo) target.
  }

  const targetParentDir = inMonorepo ? path.resolve(rootDir, 'workspaces') : rootDir;
  const targetDir = path.resolve(targetParentDir, workspaceName);

  const s = p.spinner();
  s.start(`Generating workspace files in ${pc.green(targetDir)}...`);

  try {
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(path.join(targetDir, 'workflows'), { recursive: true });

    const workflowPathList = options.workflows !== undefined
      ? options.workflows
      : ['./workflows/launch.workflow.yaml'];

    await fs.writeFile(
      path.join(targetDir, 'workspace.yaml'),
      renderWorkspaceDocument(workspaceName, workflowPathList),
      'utf-8'
    );
    await fs.writeFile(path.join(targetDir, '.gitignore'), WORKSPACE_GITIGNORE, 'utf-8');

    // Beside workspace.yaml, so `workspace setup` finds it in the workspace
    // directory and copies it into the target folder before every install —
    // see setupNpmPackage in @rawbox/runner.
    if (registryUrl !== undefined) {
      await fs.writeFile(
        path.join(targetDir, '.npmrc'),
        renderRegistryNpmrc(registryUrl),
        'utf-8',
      );
    }

    // Always the published registry range — never a `file:` specifier, even
    // inside this monorepo. Auto-setup resolves it there with no install by
    // walking up to the hoisted sibling package (CONTRIBUTING.md).
    const pluginSpecifier = DEFAULT_PLUGIN_RANGE;
    const pluginLoadable = await isPluginRegistryLoadable(DEFAULT_PLUGIN_PACKAGE, [
      targetDir,
      rootDir,
    ]);

    for (const workflowPath of workflowPathList) {
      const target = toWorkflowTarget(workflowPath, targetDir);
      if (!target) {
        p.log.warn(
          `Skipped "${workflowPath}": it resolves outside the workspace directory, ` +
            `so no file was generated for it.`,
        );
        continue;
      }

      // Always the runnable example — never an empty stub. A fresh consumer
      // has no `@rawbox/rawbox-plugin-default` installed, and does not need
      // one: the first run's auto-setup installs it.
      const content = renderDefaultWorkflowDocument({
        name: target.name,
        relativePath: target.relativePath,
        pluginPackage: DEFAULT_PLUGIN_PACKAGE,
        pluginSpecifier,
      });

      await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
      await fs.writeFile(target.absolutePath, content, 'utf-8');
    }

    s.stop('Workspace structure and files generated successfully.');
    if (!pluginLoadable) {
      p.log.info(
        `"${DEFAULT_PLUGIN_PACKAGE}" is not installed yet. The first ` +
          `\`rawbox-cli run\` installs it automatically (from the registry the ` +
          `workspace's .npmrc names, when one exists); run ` +
          `\`rawbox-cli workspace setup ./workspace.yaml\` first if you want ` +
          `\`workflow verify\` to pass before the first run.`,
      );
    }
    p.outro(pc.green('✅ Workspace generation complete!'));
  } catch (error) {
    s.error('Generation failed.');
    p.log.error(pc.red(`Error generating workspace: ${getErrorMessage(error)}`));
    process.exit(1);
  }
}
