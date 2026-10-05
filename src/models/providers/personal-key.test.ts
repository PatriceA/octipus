/**
 * Providers that can back a personal model row honour the per-request key
 * before their env/vault key (coworking spec §8.3): the row owner's key
 * arrives as `options.apiKey`, and an install key in the environment must not
 * win over it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AnthropicProvider } from './anthropic-provider';
import { DeepSeekProvider } from './deepseek-provider';
import { GeminiProvider } from './gemini-provider';
import { GrokProvider } from './grok-provider';
import { MistralProvider } from './mistral-provider';
import { MoonshotProvider } from './moonshot-provider';
import { OpenAIProvider } from './openai-provider';
import { OpenRouterProvider } from './openrouter-provider';
import { ZaiProvider } from './zai-provider';

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY', 'MOONSHOT_API_KEY', 'OPENROUTER_API_KEY', 'ZAI_API_KEY'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) process.env[k] = 'install-env-key';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type ClientFactory = { createClient: (...args: unknown[]) => Promise<{ apiKey: string }> };

describe('per-request key beats the install key', () => {
  test.each([
    ['anthropic', () => new AnthropicProvider(), (p: ClientFactory, k: string) => p.createClient(k)],
    ['openai', () => new OpenAIProvider(), (p: ClientFactory, k: string) => p.createClient(k)],
    ['gemini', () => new GeminiProvider(), (p: ClientFactory, k: string) => p.createClient(k)],
    ['deepseek', () => new DeepSeekProvider(), (p: ClientFactory, k: string) => p.createClient('deepseek-chat', k)],
    ['grok', () => new GrokProvider(), (p: ClientFactory, k: string) => p.createClient('grok-4', k)],
    ['mistral', () => new MistralProvider(), (p: ClientFactory, k: string) => p.createClient('mistral-large', k)],
    ['moonshot', () => new MoonshotProvider(), (p: ClientFactory, k: string) => p.createClient('kimi', k)],
    ['zai', () => new ZaiProvider(), (p: ClientFactory, k: string) => p.createClient('glm', k)],
    ['openrouter', () => new OpenRouterProvider(), (p: ClientFactory, k: string) => p.createClient(k)],
  ])('%s', async (_name, make, create) => {
    const provider = make() as unknown as ClientFactory;
    expect((await create(provider, 'sk-owner')).apiKey).toBe('sk-owner');
    expect((await create(provider, undefined as unknown as string)).apiKey).toBe('install-env-key');
  });

  test('anthropic native messages', async () => {
    const provider = new AnthropicProvider() as unknown as { nativeHeaders: (k?: string) => Promise<Record<string, string>> };
    expect((await provider.nativeHeaders('sk-owner'))['x-api-key']).toBe('sk-owner');
    expect((await provider.nativeHeaders())['x-api-key']).toBe('install-env-key');
  });
});
