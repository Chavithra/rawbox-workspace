import YAML from 'yaml';

/**
 * Parses content as either JSON or YAML.
 * If a filepath is provided and ends with .yaml/.yml, it will parse it as YAML first.
 * Otherwise, it will try parsing as JSON first, falling back to YAML if JSON parsing fails.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseConfig(content: string, filePath?: string): any {
  if (filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase();
    if (ext === 'yaml' || ext === 'yml') {
      return YAML.parse(content);
    }
  }

  try {
    return JSON.parse(content);
  } catch (jsonErr) {
    try {
      return YAML.parse(content);
    } catch {
      throw new Error(`Failed to parse config (tried JSON and YAML): ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
    }
  }
}
