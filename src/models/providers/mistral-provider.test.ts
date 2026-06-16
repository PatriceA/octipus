import { describe, expect, it } from 'bun:test';
import { MistralProvider } from './mistral-provider';

describe('MistralProvider.supportsModel', () => {
  const p = new MistralProvider();

  it('matches the Mistral model families', () => {
    for (const m of [
      'mistral-large-latest',
      'mistral-small-latest',
      'mistral-embed',
      'magistral-medium-latest',
      'codestral-latest',
      'ministral-8b-latest',
      'devstral-small-latest',
      'pixtral-large-latest',
      'open-mistral-nemo',
    ]) {
      expect(p.supportsModel(m)).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(p.supportsModel('Mistral-Large-Latest')).toBe(true);
  });

  it('does not match other providers', () => {
    for (const m of ['gpt-4o', 'claude-sonnet-4-6', 'deepseek-chat', 'llama3.2:3b', 'gemini-2.0-flash']) {
      expect(p.supportsModel(m)).toBe(false);
    }
  });

  it('identifies as a direct provider named "mistral"', () => {
    expect(p.name).toBe('mistral');
    expect(p.type).toBe('direct');
  });
});
