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

    // Verify file exists
    const fileExists = await fs.access(destPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    // Verify file content is rendered correctly
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
