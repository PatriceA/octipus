import { expect, test } from 'vitest';
import { CLIOutputParser } from './cli-adapters';
test('Claude reports its actual model and current-request input, including cache, without summing prior requests', () => {
  const readings: Array<{ model?: string; usedTokens?: number; contextWindow?: number; source: string }> = [];
  const p = new CLIOutputParser('a', 'cli/claude', () => {}, { onTurn: () => {}, onContext: (r) => readings.push(r) });
  p.parse({ type: 'system', subtype: 'init', model: 'actual-model' }, 'Claude Code');
  for (const [id, fresh] of [
    ['first', 100],
    ['second', 200],
  ] as const) {
    p.parse(
      {
        type: 'assistant',
        message: {
          id,
          model: 'actual-model',
          content: [],
          usage: {
            input_tokens: fresh,
            cache_read_input_tokens: 900,
            cache_creation_input_tokens: 50,
            output_tokens: 20,
          },
        },
      },
      'Claude Code',
    );
  }
  expect(readings.some((r) => r.model === 'actual-model')).toBe(true);
  expect(readings.filter((r) => r.usedTokens != null).map((r) => r.usedTokens)).toEqual([1050, 1150]);
  p.parse(
    {
      type: 'result',
      usage: { input_tokens: 1000000 },
      modelUsage: { 'actual-model': { contextWindow: 200000, inputTokens: 1000000 } },
    },
    'Claude Code',
  );
  expect(readings.at(-1)).toMatchObject({ contextWindow: 200000 });
  expect(readings.filter((r) => r.usedTokens != null).at(-1)?.usedTokens).toBe(1150);
});
test('Muse context events preserve real occupancy; token billing is not occupancy', () => {
  const readings: unknown[] = [];
  const p = new CLIOutputParser('a', 'cli/muse', () => {}, { onTurn: () => {}, onContext: (r) => readings.push(r) });
  p.parse({ method: 'session/contextUsage', params: { usedTokens: 1200, windowTokens: 200000 } }, 'Muse Code');
  expect(readings).toEqual([{ usedTokens: 1200, contextWindow: 200000, source: 'CLI context event' }]);
});
test('Codex aggregate turn usage is not mislabeled as a context reading', () => {
  const readings: unknown[] = [];
  const p = new CLIOutputParser('a', 'cli/codex', () => {}, { onTurn: () => {}, onContext: (r) => readings.push(r) });
  p.parse({ type: 'turn.completed', usage: { input_tokens: 900000, output_tokens: 500 } }, 'Codex CLI');
  expect(readings).toEqual([]);
});
