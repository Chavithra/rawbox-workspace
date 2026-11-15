import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/utils/config.js';

describe('parseConfig', () => {
  it('parses JSON when the extension says so', () => {
    const result = parseConfig('{"name": "test", "value": 42}', 'config.json');
    expect(result._unsafeUnwrap()).toEqual({ name: 'test', value: 42 });
  });

  it('parses YAML for a .yaml extension', () => {
    const result = parseConfig('name: test\nvalue: 42\n', 'config.yaml');
    expect(result._unsafeUnwrap()).toEqual({ name: 'test', value: 42 });
  });

  it('parses YAML for a .yml extension', () => {
    const result = parseConfig('name: test\nvalue: 42\n', 'config.yml');
    expect(result._unsafeUnwrap()).toEqual({ name: 'test', value: 42 });
  });

  it('falls back to YAML when JSON parsing fails and no extension is given', () => {
    const result = parseConfig('name: test\nvalue: 42\n');
    expect(result._unsafeUnwrap()).toEqual({ name: 'test', value: 42 });
  });

  it('reports content that is neither JSON nor YAML as an Err, never a throw', () => {
    const result = parseConfig('{invalid json: [yaml');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toContain('tried JSON and YAML');
  });

  it('reports a malformed .yaml file as an Err naming the file, never a raw parser throw', () => {
    // The mistake as an author makes it: a tab where YAML wants spaces. This
    // path used to bypass the module's own wrapping and surface a raw
    // `YAMLParseError`.
    const result = parseConfig('kind: Workspace\n\tname: broken\n', '/tmp/workspace.yaml');
    expect(result.isErr()).toBe(true);
    const message = result._unsafeUnwrapErr();
    expect(message).toContain('/tmp/workspace.yaml');
    expect(message).toContain('YAML');
  });
});
