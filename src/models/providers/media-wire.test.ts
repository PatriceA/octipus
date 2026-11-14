/**
 * Images on the wire for providers with strict turn rules: the tool results
 * stay right after the assistant's tool calls, the images follow.
 */
import { describe, expect, test } from 'vitest';
import type { AgentMessage } from '@/core/types';
import { toAnthropicMessages } from './custom/anthropic-compat-provider';
import { buildGeminiContents } from './custom/gemini-envelope';

const t = new Date();
const conversation: AgentMessage[] = [
  { role: 'user', content: 'Look at a.png', timestamp: t },
  { role: 'assistant', content: '', timestamp: t, toolCalls: [{ id: 'c1', name: 'vision__view_image', arguments: { source: 'a.png' } }] },
  { role: 'tool', content: '{"status":"Image loaded"}', toolCallId: 'c1', timestamp: t },
  { role: 'user', content: '[The image you asked to see]', timestamp: t, media: [{ kind: 'image', path: '/w/a.png', mimeType: 'image/png', source: 'tool', data: 'iVBORw0' }] },
];

describe('media after tool results', () => {
  test('Anthropic: the tool_result block comes first in the user turn, then the text and the image', () => {
    const { messages } = toAnthropicMessages(conversation);
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    const blocks = last.content as Array<{ type: string }>;
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks.map((b) => b.type)).toContain('image');
    expect(blocks.findIndex((b) => b.type === 'image')).toBeGreaterThan(0);
    // The assistant tool_use turn is directly before it.
    expect(messages[messages.length - 2].role).toBe('assistant');
  });

  test('Gemini: the function response and the image reach the model after the function call, the image as inline_data', () => {
    const contents = buildGeminiContents(conversation) as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const callIdx = contents.findIndex((c) => c.parts.some((p) => 'functionCall' in p));
    const after = contents.slice(callIdx + 1);
    expect(after[0].parts.some((p) => 'functionResponse' in p)).toBe(true);
    expect(after.flatMap((c) => c.parts).some((p) => (p.inline_data as { data?: string } | undefined)?.data === 'iVBORw0')).toBe(true);
    expect(after.every((c) => c.role === 'user')).toBe(true);
  });
});
