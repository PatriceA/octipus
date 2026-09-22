import { expect, test } from 'vitest';
import { stripSpeechSources } from './speech-sources';

test.each([
  '\n\n_Sources: recent 2 msgs, profile(Patrice, 8 facts)_',
  '\nSources: profile(Patrice, 8 facts)',
  '\r\n\r\n**Sources:** recent 2 msgs',
  '\n\n## Sources\n- [Academy](https://example.com)\n- another source',
  '\n\n**Quellen:**\n- Academy',
  ' Source: [Academy](https://example.com).',
])('removes spoken source format %s', suffix => {
  expect(stripSpeechSources('The answer.' + suffix)).toBe('The answer.');
});
test('preserves ordinary prose mentioning sources and later non-source paragraphs', () => {
  expect(stripSpeechSources('Sources of energy include wind.')).toBe('Sources of energy include wind.');
  expect(stripSpeechSources('Use a section called Sources: for citations.')).toBe('Use a section called Sources: for citations.');
  expect(stripSpeechSources('Answer. Source: Academy.\n\nAnother point.')).toBe('Answer.\n\nAnother point.');
});
