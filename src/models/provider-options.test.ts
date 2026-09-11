import { afterEach, expect, test, vi } from 'vitest';
import { applyProviderSettings, strictSchema } from './provider-options';
const options = { model: 'gpt-5', messages: [], maxTokens: 4096, sessionId: 'session', userId: 'user' };
afterEach(() => vi.unstubAllEnvs());
test('preserves optional schema semantics', () => {
  expect(strictSchema({ type: 'object', properties: { x: { type: 'string' } }, required: [], additionalProperties: false })).toBe(false);
  expect(strictSchema({ type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false })).toBe(true);
});
test('rejects invalid types and arrays without item schemas', () => {
  expect(strictSchema({ type: 'made-up' })).toBe(false);
  expect(strictSchema({ type: 'array' })).toBe(false);
  expect(strictSchema({ type: 'array', items: { type: 'string' } })).toBe(true);
});
test('maps session cache affinity and reasoning', () => {
  const out = applyProviderSettings(options, 'openai', { reasoningEffort: 'low', cachePolicy: 'session' });
  expect(out.extraBody).toMatchObject({ reasoning_effort: 'low', prompt_cache_key: expect.stringMatching(/^octi-/) });
});
test('does not silently expand output ceiling for Claude thinking', () => {
  expect(() => applyProviderSettings({ ...options, model: 'claude-sonnet-4-5' }, 'anthropic', { thinkingBudget: 8192 })).toThrow('smaller');
});
test('new Claude models use adaptive thinking with effort', () => {
  expect(applyProviderSettings({ ...options, model: 'claude-opus-4-7' }, 'anthropic', { reasoningEffort: 'low' }).extraBody).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'low' } });
});
test('does not mark Anthropic tools strict while native Messages is rolled back', () => {
  vi.stubEnv('ANTHROPIC_NATIVE_MESSAGES', '0');
  const tools = [{ type: 'function' as const, function: { name: 'ping', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }];
  const tool = applyProviderSettings({ ...options, model: 'claude-sonnet-4-6', tools }, 'anthropic', { strictTools: true }).tools?.[0];
  expect(tool?.type).toBe('function');
  if (tool?.type === 'function') expect(tool.function.strict).toBeUndefined();
});
