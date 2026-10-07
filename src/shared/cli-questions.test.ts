import { expect, it } from 'vitest';
import { parseCliAnswers } from './cli-questions';
const input = { questions: [{ question: 'Which model?', options: [] }, { question: 'Which limit?', options: [] }] };
it('requires every answer and rejects blank or malformed responses', () => {
  for (const answer of [undefined, 'approved', '{}', '{"Which model?":"Manual"}', '{"Which model?":"Manual","Which limit?":" "}']) {
    expect(() => parseCliAnswers(input, answer)).toThrow();
  }
});
it('preserves custom answers and multi-select values, discarding unrelated keys', () => {
  expect(parseCliAnswers(input, JSON.stringify({ 'Which model?': 'A, B', 'Which limit?': 'Use 75', extra: 'ignored' })))
    .toEqual({ 'Which model?': 'A, B', 'Which limit?': 'Use 75' });
});
