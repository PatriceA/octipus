import { describe, expect, test } from 'bun:test';
import { humanizeProviderError } from './humanize';

describe('humanizeProviderError', () => {
  test('maps malformed Ollama tool-call output', () => {
    expect(humanizeProviderError("Value looks like object, but can't find closing '}' symbol"))
      .toContain('malformed tool-call output');
  });

  test('names an unavailable Ollama model', () => {
    expect(humanizeProviderError('404 model "qwen3:32b" not found'))
      .toBe('Model "qwen3:32b" is not available on the configured provider. Pull or assign it before retrying.');
  });

  test.each([
    ['ECONNREFUSED upstream', 'unreachable'],
    ['429 Too Many Requests', 'rate-limiting'],
    ['maximum context length exceeded', 'grown larger than the model can handle'],
  ])('maps known provider failure: %s', (raw, expected) => {
    expect(humanizeProviderError(raw)).toContain(expected);
  });

  test('returns unknown errors trimmed and reports an empty error honestly', () => {
    expect(humanizeProviderError('  unexpected upstream error  ')).toBe('unexpected upstream error');
    expect(humanizeProviderError('   ')).toBe('unknown error');
  });
});
