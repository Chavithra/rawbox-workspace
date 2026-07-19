import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/utils/config.js';

describe('parseConfig', () => {
  it('should parse valid JSON', () => {
    const jsonContent = '{"name": "test", "value": 42}';
    const result = parseConfig(jsonContent, 'config.json');
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('should parse valid YAML when specified by file extension', () => {
    const yamlContent = `
name: test
value: 42
`;
    const result = parseConfig(yamlContent, 'config.yaml');
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('should parse valid YAML when specified by yml extension', () => {
    const yamlContent = `
name: test
value: 42
`;
    const result = parseConfig(yamlContent, 'config.yml');
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('should fallback to YAML if JSON parsing fails', () => {
    const yamlContent = `
name: test
value: 42
`;
    // No filepath extension specified
    const result = parseConfig(yamlContent);
    expect(result).toEqual({ name: 'test', value: 42 });
  });

  it('should throw an error when both JSON and YAML parsing fail', () => {
    const invalidContent = '{invalid json: [yaml';
    expect(() => parseConfig(invalidContent)).toThrow('Failed to parse config');
  });
});
