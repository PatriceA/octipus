import { describe, expect, test } from 'vitest';
import { stripJsonThinkingLeak } from '@/models/litellm-client';
import { AnswerReleaseGate } from './openai-token-stream';

function run(deltas: string[]) {
  const gate = new AnswerReleaseGate();
  const sent = deltas.map((d) => gate.push(d));
  return { gate, sent };
}

describe('AnswerReleaseGate', () => {
  test('plain text goes out as it arrives', () => {
    const { gate, sent } = run(['Eight', ' arms', '.']);
    expect(sent).toEqual(['Eight', ' arms', '.']);
    expect(gate.rest('Eight arms.')).toBe('');
  });

  test('leading whitespace waits for the first visible character, then goes with it', () => {
    const { sent } = run(['\n', '  ', 'Hi', '!']);
    expect(sent).toEqual(['', '', '\n  Hi', '!']);
  });

  test('a whitespace-only reply sends nothing, matching what normalisation makes of it', () => {
    const { gate, sent } = run([' ', '\n']);
    expect(sent.join('')).toBe('');
    expect(gate.rest(stripJsonThinkingLeak(' \n'))).toBe('');
  });

  test('a reply opening with `{` is held whole: the normaliser may strip it', () => {
    const raw = ['  {"thought":"x"}', ' Eight.'];
    const { gate, sent } = run(raw);
    expect(sent.join('')).toBe('');
    expect(gate.rest(stripJsonThinkingLeak(raw.join('')))).toBe('Eight.');
  });

  test('from the first DeepSeek template bar on, the rest is held', () => {
    const { gate, sent } = run(['Sure. ', 'Then <｜tool', '▁calls▁begin｜>', ' more']);
    expect(sent).toEqual(['Sure. ', '', '', '']);
    expect(gate.rest('Sure. Then <｜tool▁calls▁begin｜> more')).toBe('Then <｜tool▁calls▁begin｜> more');
  });

  test('an answer that does not continue the sent text has no rest', () => {
    const { gate } = run(['Sure. ']);
    expect(gate.rest('')).toBeNull();
    expect(gate.rest('Something else')).toBeNull();
  });
});
