import YAML from 'yaml';
import { err, ok, type Result } from 'neverthrow';

import { getErrorMessage } from './error.js';

/**
 * Parses a Rawbox document — workspace, workflow, lock — as YAML or JSON.
 *
 * `filePath`, when given, picks the parser by extension (`.yaml`/`.yml` is
 * YAML; anything else tries JSON first and YAML second) and names the file in
 * the message. Without one, JSON is tried first and YAML second.
 *
 * An `Err`, never a throw, on malformed content. Every caller — five in this
 * package, ten in `@rawbox/cli` — used to wrap this in its own `try/catch`
 * just to turn the parser's exception back into a sentence, and the `.yaml`
 * path did not even reach this module's own wrapper, so a tab-indented
 * document surfaced as a raw `YAMLParseError`. The value is `unknown`: this
 * parses, it does not validate, and the caller's schema check is what narrows.
 */
export function parseConfig(
  content: string,
  filePath?: string,
): Result<unknown, string> {
  const label = filePath ?? 'config';
  const extension = filePath?.split('.').pop()?.toLowerCase();

  if (extension === 'yaml' || extension === 'yml') {
    try {
      return ok(YAML.parse(content));
    } catch (e) {
      return err(`Failed to parse "${label}" as YAML: ${getErrorMessage(e)}`);
    }
  }

  try {
    return ok(JSON.parse(content));
  } catch (jsonError) {
    try {
      return ok(YAML.parse(content));
    } catch {
      return err(
        `Failed to parse "${label}" (tried JSON and YAML): ${getErrorMessage(jsonError)}`,
      );
    }
  }
}
