import { describe, expect, test } from 'vitest';
import type { AgentMessage } from '@/core/types';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { buildGeminiContents, buildGeminiTools } from './custom/gemini-envelope';
import { GeminiProvider, sanitizeToolsForGemini } from './gemini-provider';
import { sanitizeGeminiHistory } from './gemini-history';

const now = new Date();

/** Assert every assistant tool_call id has a matching following tool message. */
function assertNoOrphanToolCalls(wire: Array<Record<string, unknown>>): void {
  const declared = new Set<string>();
  const answered = new Set<string>();
  for (const m of wire) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<{ id: string }>) declared.add(tc.id);
    }
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') answered.add(m.tool_call_id);
  }
  for (const id of declared) expect(answered.has(id)).toBe(true);
}

describe('sanitizeGeminiHistory (G1 + item 8)', () => {
  test('orphaned tool call gets a synthetic error result instead of dropping the round', () => {
    const history: AgentMessage[] = [
      { role: 'user', content: 'do both', timestamp: now },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_a', name: 'read', arguments: {} },
          { id: 'call_b', name: 'write', arguments: {} },
        ],
        timestamp: now,
      },
      { role: 'tool', content: 'ok', toolCallId: 'call_a', name: 'read', timestamp: now },
      // call_b has NO result — orphaned.
    ];
    const out = sanitizeGeminiHistory(history);
    const synthetic = out.find((m) => m.role === 'tool' && m.toolCallId === 'call_b');
    expect(synthetic).toBeDefined();
    expect(synthetic!.content).toBe('No result provided');
    // Both calls kept, both answered.
    const asst = out.find((m) => m.role === 'assistant' && m.toolCalls?.length);
    expect(asst!.toolCalls).toHaveLength(2);
  });

  test('empty-id tool calls get synthesized call_${index} ids and providerRaw dropped', () => {
    const history: AgentMessage[] = [
      { role: 'user', content: 'go', timestamp: now },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '', name: 'search', arguments: {} }],
        providerRaw: { role: 'assistant', tool_calls: [{ id: '', function: { name: 'search' } }] },
        timestamp: now,
      },
      { role: 'tool', content: 'r', toolCallId: '', name: 'search', timestamp: now },
    ];
    const out = sanitizeGeminiHistory(history);
    const asst = out.find((m) => m.role === 'assistant' && m.toolCalls?.length)!;
    expect(asst.toolCalls![0].id).toBe('call_0');
    // providerRaw stripped because its embedded ids no longer match.
    expect(asst.providerRaw).toBeUndefined();
    // The tool response is paired to the synthesized id.
    assertNoOrphanToolCalls([
      { role: 'assistant', tool_calls: asst.toolCalls!.map((tc) => ({ id: tc.id })) },
      ...out.filter((m) => m.role === 'tool').map((m) => ({ role: 'tool', tool_call_id: m.toolCallId })),
    ]);
  });

  test('empty-content thinking-only turns are filtered', () => {
    const history: AgentMessage[] = [
      { role: 'user', content: 'hi', timestamp: now },
      { role: 'assistant', content: '   ', timestamp: now },
      { role: 'assistant', content: 'real answer', timestamp: now },
    ];
    const out = sanitizeGeminiHistory(history);
    expect(out.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(out.find((m) => m.role === 'assistant')!.content).toBe('real answer');
  });

  test('conformance replay: a multi-turn flash-lite-style history reaches the wire with no orphan tool_calls', () => {
    const history: AgentMessage[] = [
      { role: 'system', content: 'you are a rootAgent', timestamp: now },
      { role: 'user', content: 'delegate the task', timestamp: now },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_x', name: 'spawn_child', arguments: { role: 'coding' } }],
        timestamp: now,
      },
      { role: 'tool', content: 'spawned', toolCallId: 'call_x', name: 'spawn_child', timestamp: now },
      {
        role: 'assistant',
        content: '',
        // Second round, orphaned (result never recorded — the failure mode).
        toolCalls: [{ id: 'call_y', name: 'collect_children', arguments: {} }],
        timestamp: now,
      },
    ];
    const provider = new GeminiProvider();
    const sanitized = sanitizeGeminiHistory(history);
    const wire = (provider as unknown as {
      formatMessagesRaw: (m: AgentMessage[]) => Array<Record<string, unknown>>;
    }).formatMessagesRaw(sanitized);
    assertNoOrphanToolCalls(wire);
  });
});

describe('custom-gemini / main-provider parity', () => {
  const tools: ChatCompletionTool[] = [
    {
      type: 'function',
      function: {
        name: 'edit',
        parameters: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { path: { type: 'string' }, ref: { $ref: '#/$defs/x' } },
          additionalProperties: false,
        },
      },
    },
  ];

  test('envelope and main provider sanitize schemas equivalently', () => {
    const mainParams = (sanitizeToolsForGemini(tools)[0] as { function: { parameters: unknown } }).function.parameters;
    const envParams = (buildGeminiTools(tools)[0].functionDeclarations as Array<{ parameters: unknown }>)[0].parameters;
    expect(envParams).toEqual(mainParams);
    // Meta keys gone, $ref preserved.
    expect(JSON.stringify(envParams)).not.toContain('$schema');
    expect(JSON.stringify(envParams)).not.toContain('additionalProperties');
    expect(JSON.stringify(envParams)).toContain('$ref');
  });

  test('both repair orphaned histories identically (shared sanitizeGeminiHistory)', () => {
    const history: AgentMessage[] = [
      { role: 'user', content: 'go', timestamp: now },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 't', arguments: {} }], timestamp: now },
    ];
    const sanitized = sanitizeGeminiHistory(history);
    // Native envelope consumes the same sanitized history.
    const contents = buildGeminiContents(sanitized);
    // The synthetic error result surfaces as a functionResponse in the wire.
    const hasFunctionResponse = contents.some((c) => {
      const parts = (c.parts as Array<Record<string, unknown>>) || [];
      return parts.some((p) => 'functionResponse' in p);
    });
    expect(hasFunctionResponse).toBe(true);
  });
});
