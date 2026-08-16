import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTemplateFile } from '../src/utils/template.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const tempDir = path.join(__dirname, 'temp-output');

describe('copyTemplateFile', () => {
  beforeAll(async () => {
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should copy and render an EJS template file correctly', async () => {
    const destPath = path.join(tempDir, 'package.json');
    const pluginName = 'my-awesome-test-plugin';

    await copyTemplateFile('plugin/package.json.ejs', destPath, {
      pluginName,
    });

    const fileExists = await fs.access(destPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    const content = await fs.readFile(destPath, 'utf-8');
    const parsed = JSON.parse(content);
    
    expect(parsed.name).toBe(pluginName);
    expect(parsed.description).toBe(`Rawbox plugin: ${pluginName}`);
    expect(parsed.license).toBe('BSD-3-Clause');
  });

  it('should create nested directories if they do not exist', async () => {
    const nestedDestPath = path.join(tempDir, 'nested', 'deeply', 'package.json');
    const pluginName = 'nested-plugin';

    await copyTemplateFile('plugin/package.json.ejs', nestedDestPath, {
      pluginName,
    });

    const fileExists = await fs.access(nestedDestPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    const content = await fs.readFile(nestedDestPath, 'utf-8');
    const parsed = JSON.parse(content);
    expect(parsed.name).toBe(pluginName);
  });
});

describe('plugin package.json template — dependency kinds', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const templatePath = path.join(
    repoRoot,
    'packages',
    'rawbox-cli',
    'src',
    'templates',
    'plugin',
    'package.json.ejs',
  );

  /** Renders the template with a plugin name and parses the result. */
  async function renderedManifest(): Promise<Record<string, Record<string, string>>> {
    const outputPath = path.join(tempDir, 'rendered-plugin-package.json');
    await copyTemplateFile('plugin/package.json.ejs', outputPath, {
      pluginName: 'rawbox-plugin-under-test',
    });
    return JSON.parse(await fs.readFile(outputPath, 'utf-8'));
  }

  it('declares @rawbox/plugin as a peer, never as a dependency', async () => {
    const manifest = await renderedManifest();

    // A plugin and the runner that loads it must share ONE @rawbox/plugin: it
    // defines the vocabulary they use to talk to each other. Declaring it under
    // `dependencies` lets a published plugin bring a second copy, which nothing
    // in the runtime would complain about — the contract guards are structural,
    // so two copies validate fine right up until someone adds an identity check.
    expect(manifest.peerDependencies).toHaveProperty('@rawbox/plugin');
    // `?? {}` because the scaffold now emits no `dependencies` block at all —
    // the passthrough subpaths left it with nothing to put there.
    expect(manifest.dependencies ?? {}).not.toHaveProperty('@rawbox/plugin');

    // ...and under devDependencies too, or the scaffolded plugin cannot build
    // or run its own tests before anything has installed it as a peer.
    expect(manifest.devDependencies).toHaveProperty('@rawbox/plugin');
  });

  it('keeps the shipped default plugin and the template in agreement', async () => {
    // The template teaches the shape; rawbox-plugin-default is the worked
    // example of it. If they disagree, one of them is lying to plugin authors.
    const shipped = JSON.parse(
      await fs.readFile(
        path.join(repoRoot, 'packages', 'rawbox-plugin-default', 'package.json'),
        'utf-8',
      ),
    );

    expect(shipped.peerDependencies).toHaveProperty('@rawbox/plugin');
    expect(shipped.dependencies ?? {}).not.toHaveProperty('@rawbox/plugin');
    expect(shipped.devDependencies).toHaveProperty('@rawbox/plugin');
  });

  it('names a template that actually exists', async () => {
    // Guards the paths above against a rename.
    expect(await fs.stat(templatePath)).toBeDefined();
  });

  it('declares no typebox or neverthrow of its own', async () => {
    const manifest = await renderedManifest();

    // Both arrive through `@rawbox/plugin`'s passthrough subpaths
    // (`@rawbox/plugin/typebox`, `@rawbox/plugin/neverthrow`), so a scaffolded
    // plugin declares neither and cannot drift from the framework's copy of
    // either. A `dependencies` block reappearing here is the regression: it
    // would install a second copy of a library the plugin already has, and
    // reintroduce the version-skew question the passthroughs exist to close.
    expect(manifest.dependencies ?? {}).not.toHaveProperty('typebox');
    expect(manifest.dependencies ?? {}).not.toHaveProperty('neverthrow');
    expect(manifest.devDependencies ?? {}).not.toHaveProperty('typebox');
    expect(manifest.devDependencies ?? {}).not.toHaveProperty('neverthrow');
  });

  it('floors @rawbox/plugin at a caret range, defaulting when none is supplied', async () => {
    // No `pluginSdkVersion` passed in. Two commands render this template —
    // `plugin create` and `project create` — and when only the first supplied
    // the value, the second rendered `^undefined`: a manifest that installs
    // nothing and fails at the scaffold's first import. The guard in the
    // template is what makes a forgetful third caller merely stale rather than
    // broken.
    const manifest = await renderedManifest();
    expect(manifest.peerDependencies?.['@rawbox/plugin']).toBe('^0.1.0');
    expect(manifest.devDependencies?.['@rawbox/plugin']).toBe('^0.1.0');
  });

  it('interpolates a supplied pluginSdkVersion as a caret range, not an exact pin', async () => {
    const outputPath = path.join(tempDir, 'rendered-plugin-package-pinned.json');
    await copyTemplateFile('plugin/package.json.ejs', outputPath, {
      pluginName: 'rawbox-plugin-pin-test',
      pluginSdkVersion: '0.2.3',
    });
    const manifest = JSON.parse(await fs.readFile(outputPath, 'utf-8'));

    // A floor, not a lock: from 0.1.0 a caret admits the rest of the minor
    // series, so a scaffolded plugin picks up SDK patch releases without an
    // edit. An exact pin would strand it on whatever version happened to be
    // installed the day it was scaffolded.
    expect(manifest.peerDependencies['@rawbox/plugin']).toBe('^0.2.3');
    expect(manifest.devDependencies['@rawbox/plugin']).toBe('^0.2.3');
  });
});
