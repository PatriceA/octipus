import { describe, expect, test, vi } from 'vitest';
import type { AgentMessage } from '@/core/types';

process.env.OPENROUTER_API_KEY ??= 'test-key';

// OpenAI SDK mock — mirrors the pattern in litellm-client.test.ts so
// client.chat.completions.create can be inspected without a real network call.
let captured: any;
vi.mock('openai', async () => {
  const actual = await vi.importActual<typeof import('openai')>('openai');
  class FakeOpenAI {
    chat: any;
    constructor() {
      this.chat = {
        completions: {
          create: (params: any) => {
            captured = params;
            return Promise.resolve({
              id: 'req1',
              model: params.model,
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
          },
        },
      };
    }
  }
  return { ...actual, default: FakeOpenAI };
});

const { OpenRouterProvider } = await import('./openrouter-provider');

const ts = () => new Date(0);
const userMsg = (content: string): AgentMessage => ({ role: 'user', content, timestamp: ts() });

describe('OpenRouterProvider — cachePolicy off disables cache_control', () => {
  test('sends plain string content, no cache_control blocks, for an Anthropic model', async () => {
    const provider = new OpenRouterProvider();
    await provider.complete({
      model: 'anthropic/claude-sonnet-4-6',
      cachePolicy: 'off',
      messages: [
        { role: 'system', content: `${'x'.repeat(5000)}\n\nCURRENT DATE/TIME: now`, timestamp: ts() },
        userMsg('first'),
        { role: 'assistant', content: 'answer', timestamp: ts() },
        userMsg('second'),
      ],
    } as any);

    for (const m of captured.messages) expect(typeof m.content).toBe('string');
  });
});
