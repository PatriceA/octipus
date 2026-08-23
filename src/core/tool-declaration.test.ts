import { describe, expect, test } from 'vitest';
import { historyReferencesTools } from './agent-worker';

// Why this matters: a turn with tools DISABLED used to send `tools: undefined`
// while the history still carried tool_use/tool_result blocks. Anthropic-family
// providers reject that ("The toolConfig field must be defined when using
// toolUse and toolResult content blocks"), which killed a research child
// mid-run on 2026-08-02 — and the spawner's retry then answered from model
// recall having made no searches at all.
describe('historyReferencesTools', () => {
  test('a plain conversation does not', () => {
    expect(historyReferencesTools([{ role: 'user' }, { role: 'assistant' }])).toBe(false);
  });

  test('a tool RESULT counts', () => {
    expect(historyReferencesTools([{ role: 'user' }, { role: 'tool' }])).toBe(true);
  });

  test('an assistant turn that CALLED a tool counts, even with its result gone', () => {
    // Compaction can drop the result and keep the call, or the reverse — each
    // shape alone is still a reference the provider will validate.
    expect(historyReferencesTools([{ role: 'assistant', toolCalls: [{ id: '1' }] }])).toBe(true);
  });

  test('an empty toolCalls array is not a reference', () => {
    expect(historyReferencesTools([{ role: 'assistant', toolCalls: [] }])).toBe(false);
  });
});
