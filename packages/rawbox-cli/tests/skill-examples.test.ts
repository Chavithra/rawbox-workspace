import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';

import { verifyWorkflow } from '../src/commands/workflow/verify.js';
import { verifyWorkspace } from '../src/commands/workspace/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root: packages/rawbox-cli/tests -> ../../.. */
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const tempDir = path.join(__dirname, 'temp-skill-examples');
const originalCwd = process.cwd();

// ---------------------------------------------------------------------------
// The SKILL files are the specification agents author workflow documents from,
// so a stale example there is worse than a stale README: it is copied verbatim
// into real workflows. The worked example is extracted from the Markdown and put
// through the real `workflow verify` here, so it cannot drift from the format
// without turning something red.
//
// Both copies are checked. `.agents/skills/…` is what this repo's own agents
// load; `packages/rawbox-cli/src/templates/skills/…` is what gets scaffolded
// into a generated project. They are separate files that must stay in sync,
// which is a rule nothing enforced until now.
// ---------------------------------------------------------------------------

const SKILL_RELATIVE_PATH = path.join(
  'rawbox-workflow-creation',
  'SKILL.md',
);

const SKILL_COPY_LIST = [
  {
    label: '.agents/skills',
    file: path.join(repoRoot, '.agents', 'skills', SKILL_RELATIVE_PATH),
  },
  {
    label: 'cli templates',
    file: path.join(
      repoRoot,
      'packages',
      'rawbox-cli',
      'src',
      'templates',
      'skills',
      SKILL_RELATIVE_PATH,
    ),
  },
] as const;

let messageList: string[];
let exitSpy: ReturnType<typeof vi.spyOn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function captureLog(): any {
  return vi.fn((...args: unknown[]) => {
    messageList.push(args.map(String).join(' '));
  });
}

beforeEach(() => {
  messageList = [];
  exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => undefined) as never);
  vi.spyOn(p.log, 'error').mockImplementation(captureLog());
  vi.spyOn(p.log, 'warn').mockImplementation(captureLog());
  vi.spyOn(p.log, 'info').mockImplementation(captureLog());
  vi.spyOn(p.log, 'step').mockImplementation(captureLog());
});

afterEach(() => {
  vi.restoreAllMocks();
});

function reported(): string {
  return messageList.join('\n').replace(/\[[0-9;]*m/g, '');
}

/** Every fenced ```yaml block in a Markdown document, in order. */
function yamlBlockList(markdown: string): string[] {
  return [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? '',
  );
}

/** The first block declaring the given `kind:`. */
function blockOfKind(blockList: string[], kind: string): string | undefined {
  return blockList.find((block) => block.trimStart().startsWith(`kind: ${kind}`));
}

beforeAll(async () => {
  await fs.mkdir(tempDir, { recursive: true });
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('rawbox-workflow-creation SKILL.md', () => {
  it('keeps both copies byte-identical', async () => {
    const [first, second] = await Promise.all(
      SKILL_COPY_LIST.map((copy) => fs.readFile(copy.file, 'utf-8')),
    );

    // Not a style rule: an agent loading `.agents/skills` and an agent working
    // in a scaffolded project must be taught the same format.
    expect(first).toBe(second);
  });

  for (const copy of SKILL_COPY_LIST) {
    describe(copy.label, () => {
      const caseDir = path.join(tempDir, copy.label.replace(/[^a-z]+/gi, '-'));
      const workflowFile = './workflows/skill-example.workflow.yaml';

      beforeAll(async () => {
        const markdown = await fs.readFile(copy.file, 'utf-8');
        const blockList = yamlBlockList(markdown);

        const workspaceBlock = blockOfKind(blockList, 'Workspace');
        const workflowBlock = blockOfKind(blockList, 'Workflow');
        expect(workspaceBlock, 'no `kind: Workspace` example').toBeDefined();
        expect(workflowBlock, 'no `kind: Workflow` example').toBeDefined();

        await fs.mkdir(path.join(caseDir, 'workflows'), { recursive: true });
        await fs.writeFile(
          path.join(caseDir, 'workspace.yaml'),
          // The workspace example names its own workflow path in TWO places —
          // the `workflowPathList` entry and the `seedOverrides:` key, which
          // is keyed by that same path — so both are pointed at the file
          // actually written. Rewriting only one would leave the block naming
          // a workflow the workspace does not list, which is exactly the error
          // the path keying exists to raise.
          (workspaceBlock as string)
            .replace(/^\s*-\s*\.\/workflows\/.*$/m, `  - ${workflowFile}`)
            .replace(/^\s*\.\/workflows\/\S*:\s*$/m, `  ${workflowFile}:`),
          'utf-8',
        );
        await fs.writeFile(
          path.join(caseDir, workflowFile),
          workflowBlock as string,
          'utf-8',
        );
      });

      it('documents a workspace that verifies', async () => {
        process.chdir(caseDir);
        await verifyWorkspace('./workspace.yaml');
        process.chdir(originalCwd);

        expect(exitSpy, reported()).not.toHaveBeenCalled();
      });

      it('documents a workflow that verifies against the real registry', async () => {
        // This is the assertion that matters: it resolves the declared package,
        // confirms every `operation:` exists in the registry that actually
        // loads, and validates every seeded constant against the input schema of
        // the field that reads it. A renamed or removed operation fails here.
        process.chdir(caseDir);
        await verifyWorkflow(workflowFile);
        process.chdir(originalCwd);

        expect(exitSpy, reported()).not.toHaveBeenCalled();
      });

      it('teaches the shapes a model is least likely to guess', async () => {
        const markdown = await fs.readFile(copy.file, 'utf-8');
        const workflowBlock = blockOfKind(
          yamlBlockList(markdown),
          'Workflow',
        ) as string;

        // Ease of correct generation is a design criterion of the format, and
        // storage strategies are where a model guesses wrong. A SKILL that
        // verifies but omits them still fails at its job.
        //
        // `keys:` is the only way to declare one (FORMAT.md, "`storage`"). What
        // must be shown is a per-key strategy declaration, which is the part a
        // model does not guess.
        expect(workflowBlock).toMatch(/^\s*keys:\s*$/m);
        expect(workflowBlock).toContain('name: lmdb-fifo');

        // The two removed `storage:` blocks, which a model that has seen an
        // older example will reach for. The SKILL must not be the example it
        // learns them from.
        expect(workflowBlock).not.toMatch(/^\s*strategies:\s*$/m);
        expect(workflowBlock).not.toMatch(/^\s{2}seed:\s*$/m);

        // A constant reaches a step through storage, and `{ value: … }` no
        // longer exists — see FORMAT.md, "Bindings". A model that
        // has seen the old form will reach for it, so the example must show a
        // jump target being seeded and bound by key — and must not show the
        // removed form anywhere.
        expect(workflowBlock).not.toMatch(/\{\s*value:/);
        expect(workflowBlock).toMatch(/^\s+thenLabel: \w+(?:\s+#.*)?$/m);

        // And the control-flow asymmetry must be shown, not merely asserted:
        // the example's control-flow step must carry no `outputs:`.
        const controlFlowIndex = workflowBlock.indexOf('operation: control-flow/');
        expect(controlFlowIndex, 'no control-flow step in the example').toBeGreaterThan(-1);
        expect(workflowBlock.slice(controlFlowIndex)).not.toContain('outputs:');
      });
    });
  }
});
