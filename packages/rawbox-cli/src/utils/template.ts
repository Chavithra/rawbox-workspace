import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In compiled JS, __dirname is packages/rawbox-cli/dist/utils
// The templates are copied to packages/rawbox-cli/dist/templates
export const TEMPLATES_DIR = path.resolve(__dirname, '..', 'templates');

export async function copyTemplateFile(
  srcRelative: string,
  destPath: string,
  data: Record<string, any> = {}
) {
  const srcPath = path.join(TEMPLATES_DIR, srcRelative);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const content = await fs.readFile(srcPath, 'utf-8');
  let rendered = content;
  if (srcRelative.endsWith('.ejs')) {
    rendered = ejs.render(content, data);
  }
  await fs.writeFile(destPath, rendered, 'utf-8');
}
