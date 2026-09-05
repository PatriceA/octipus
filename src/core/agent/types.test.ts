import { describe, expect, test } from 'vitest';
import { appendSources } from './types';

describe('appendSources', () => {
  test('no sources → original content untouched', () => {
    expect(appendSources('hello', [])).toBe('hello');
  });

  test('single source → footer appended', () => {
    expect(appendSources('hello', ['profile(p, 3 facts)'])).toBe(
      'hello\n\n_Sources: profile(p, 3 facts)_',
    );
  });

  test('multiple sources → comma-joined', () => {
    expect(appendSources('hello', ['recent 5 msgs', 'session summary', 'classifier(coding)'])).toBe(
      'hello\n\n_Sources: recent 5 msgs, session summary, classifier(coding)_',
    );
  });

  test('empty content + no sources → empty string preserved', () => {
    expect(appendSources('', [])).toBe('');
  });

  test('empty content + sources → footer-only result', () => {
    expect(appendSources('', ['stage(1: Plan/research)'])).toBe(
      '\n\n_Sources: stage(1: Plan/research)_',
    );
  });

  test('content already containing _Sources_ literal → still appended (caller responsibility)', () => {
    // The helper is intentionally dumb — it does not de-dupe an
    // already-present footer. Idempotency is the consumer's job.
    const out = appendSources('reply\n\n_Sources: x_', ['y']);
    expect(out).toBe('reply\n\n_Sources: x_\n\n_Sources: y_');
  });
});
