import { afterEach, expect, test, vi } from 'vitest';
import { applyProviderSettings, strictSchema, usesPromptCacheOptions } from './provider-options';
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
  expect(out.extraBody).toMatchObject({ reasoning_effort: 'low', prompt_cache_key: expect.stringMatching(/^octi-/), prompt_cache_retention: '24h' });
});
test('GPT-5.6+ gets prompt_cache_options.ttl instead of the replaced retention field', () => {
  for (const model of ['gpt-5.6', 'gpt-5.6-mini', 'openai/gpt-5.10', 'gpt-6.1-sol']) {
    expect(usesPromptCacheOptions(model), model).toBe(true);
    const out = applyProviderSettings({ ...options, model }, 'openai', { cachePolicy: 'session' }).extraBody;
    expect(out).toMatchObject({ prompt_cache_options: { ttl: '12h' } });
    expect(out).not.toHaveProperty('prompt_cache_retention');
  }
  for (const model of ['gpt-5', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-4.1', 'gpt-5-chat-latest']) {
    expect(usesPromptCacheOptions(model), model).toBe(false);
    expect(applyProviderSettings({ ...options, model }, 'openai', { cachePolicy: 'session' }).extraBody).toMatchObject({ prompt_cache_retention: '24h' });
  }
  // A caller's own lifetime setting wins.
  expect(applyProviderSettings({ ...options, model: 'gpt-5.6', extraBody: { prompt_cache_options: { ttl: '30m' } } }, 'openai', { cachePolicy: 'session' }).extraBody?.prompt_cache_options).toEqual({ ttl: '30m' });
});
test('OpenAI gets a prefix-family cache key by default, none when cache hints are off', () => {
  const byDefault = applyProviderSettings(options, 'openai');
  expect(byDefault.extraBody?.prompt_cache_key).toMatch(/^octi-/);
  expect(byDefault.extraBody).not.toHaveProperty('prompt_cache_retention');
  expect(applyProviderSettings(options, 'openai', { cachePolicy: 'off' }).extraBody).not.toHaveProperty('prompt_cache_key');
  // Same session and scope ⇒ same key; another scope (a child role) ⇒ another.
  expect(applyProviderSettings({ ...options, cacheScope: 'root:' }, 'openai').extraBody?.prompt_cache_key)
    .toBe(applyProviderSettings({ ...options, cacheScope: 'root:' }, 'openai').extraBody?.prompt_cache_key);
  expect(applyProviderSettings({ ...options, cacheScope: 'child:research' }, 'openai').extraBody?.prompt_cache_key)
    .not.toBe(applyProviderSettings({ ...options, cacheScope: 'root:' }, 'openai').extraBody?.prompt_cache_key);
  // Another session with the same prefix family shares the key: that is the
  // cross-session reuse a per-session key made impossible.
  expect(applyProviderSettings({ ...options, sessionId: 'other', userId: 'someone-else', cacheScope: 'root:' }, 'openai').extraBody?.prompt_cache_key)
    .toBe(applyProviderSettings({ ...options, cacheScope: 'root:' }, 'openai').extraBody?.prompt_cache_key);
  // A caller's own key wins.
  expect(applyProviderSettings({ ...options, extraBody: { prompt_cache_key: 'mine' } }, 'openai').extraBody?.prompt_cache_key).toBe('mine');
});
test('behind a proxy or custom endpoint the key is opt-in, and never for a Claude model', () => {
  for (const provider of ['litellm', 'custom-openai']) {
    expect(applyProviderSettings(options, provider).extraBody).not.toHaveProperty('prompt_cache_key');
    expect(applyProviderSettings(options, provider, { cachePolicy: 'session' }).extraBody?.prompt_cache_key).toMatch(/^octi-/);
    expect(applyProviderSettings({ ...options, model: 'anthropic/claude-sonnet-4-6' }, provider, { cachePolicy: 'session' }).extraBody).not.toHaveProperty('prompt_cache_key');
  }
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
