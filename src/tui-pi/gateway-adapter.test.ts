import { describe, expect, test } from 'bun:test';
import { type AgentSessionEvent, decodeGatewayEvent } from './gateway-adapter';

function single(events: AgentSessionEvent[]): AgentSessionEvent {
  expect(events.length).toBe(1);
  return events[0];
}

describe('decodeGatewayEvent', () => {
  test('permission.request → detail uses path when available', () => {
    const out = decodeGatewayEvent({
      type: 'permission.request',
      payload: { requestId: 'req-1', toolName: 'write_file', args: { path: '/tmp/x' } },
    });
    const event = single(out);
    expect(event.kind).toBe('permission');
    if (event.kind !== 'permission') return;
    expect(event.requestId).toBe('req-1');
    expect(event.toolName).toBe('write_file');
    expect(event.detail).toBe('write_file → /tmp/x');
  });

  test('permission.request → command truncates beyond 80 chars', () => {
    const long = 'a'.repeat(120);
    const event = single(decodeGatewayEvent({
      type: 'permission.request',
      payload: { toolName: 'bash', args: { command: long } },
    }));
    if (event.kind !== 'permission') throw new Error('expected permission');
    expect(event.detail.endsWith('...')).toBe(true);
    expect(event.detail.length).toBeLessThanOrEqual('bash → '.length + 80);
  });

  test('permission.request → falls back when no args', () => {
    const event = single(decodeGatewayEvent({ type: 'permission.request', payload: { toolName: 'foo' } }));
    if (event.kind !== 'permission') throw new Error('expected permission');
    expect(event.detail).toBe('foo');
  });

  test('agent.spawned → emits agent.start + system message', () => {
    const out = decodeGatewayEvent({
      type: 'agent.spawned',
      payload: { role: 'planner', model: 'claude-opus' },
    });
    expect(out.length).toBe(2);
    expect(out[0].kind).toBe('agent.start');
    expect(out[1].kind).toBe('message');
    if (out[0].kind !== 'agent.start' || out[1].kind !== 'message') return;
    expect(out[0].role).toBe('planner');
    expect(out[0].model).toBe('claude-opus');
    expect(out[1].content).toBe('Agent spawned: planner (claude-opus)');
  });

  test('agent.spawned → reads nested data when top-level missing', () => {
    const out = decodeGatewayEvent({
      type: 'agent.spawned',
      payload: { data: { role: 'worker', model: 'sonnet' } },
    });
    expect(out[0].kind).toBe('agent.start');
    if (out[0].kind === 'agent.start') {
      expect(out[0].role).toBe('worker');
      expect(out[0].model).toBe('sonnet');
    }
  });

  test('agent.completed → reads stats and emits agent.end + system message', () => {
    const out = decodeGatewayEvent({
      type: 'agent.completed',
      payload: { stats: { totalTokens: 1234, totalCostUsd: 0.05, durationMs: 800 } },
    });
    expect(out.length).toBe(2);
    expect(out[0].kind).toBe('agent.end');
    if (out[0].kind === 'agent.end') {
      expect(out[0].stats.tokens).toBe(1234);
      expect(out[0].stats.cost).toBeCloseTo(0.05);
      expect(out[0].stats.durationMs).toBe(800);
    }
  });

  test('agent.completed → handles snake_case keys', () => {
    const out = decodeGatewayEvent({
      type: 'agent.completed',
      payload: { data: { total_tokens: 7, total_cost_usd: 1.5 } },
    });
    if (out[0].kind === 'agent.end') {
      expect(out[0].stats.tokens).toBe(7);
      expect(out[0].stats.cost).toBe(1.5);
    }
  });

  test('agent.action → tool_call emits pending', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'edit' } },
    });
    const event = single(out);
    if (event.kind !== 'tool') throw new Error('expected tool');
    expect(event.tool.state).toBe('pending');
    expect(event.tool.name).toBe('edit');
  });

  test('agent.action → cli_tool_result emits completed with preview', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'cli_tool_result', toolName: 'bash', output: 'first\nsecond' } },
    });
    const event = single(out);
    if (event.kind !== 'tool') throw new Error('expected tool');
    expect(event.tool.state).toBe('completed');
    expect(event.tool.preview).toBe('first');
  });

  test('agent.action → tool_result with error flag emits error state', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_result', toolName: 'edit', isError: true } },
    });
    const event = single(out);
    if (event.kind !== 'tool') throw new Error('expected tool');
    expect(event.tool.state).toBe('error');
  });

  test('agent.action → tool_call_complete uses the rich title + structured result', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: {
        data: {
          type: 'tool_call_complete',
          name: 'filesystem__read_file',
          title: 'Read poem.md (3 lines)',
          status: 'ok',
          role: 'writing',
          durationMs: 200,
          result: { kind: 'text', text: 'roses are red\nviolets are blue' },
        },
      },
    });
    const toolEvent = out.find((e) => e.kind === 'tool');
    if (!toolEvent || toolEvent.kind !== 'tool') throw new Error('expected tool');
    expect(toolEvent.tool.state).toBe('completed');
    // Row identity is now the human title, not the raw tool name.
    expect(toolEvent.tool.name).toBe('Read poem.md (3 lines)');
    expect(toolEvent.tool.preview).toBe('roses are red');
    // Narration uses the title too.
    const narration = out.find((e) => e.kind === 'message');
    if (!narration || narration.kind !== 'message') throw new Error('expected narration');
    expect(narration.content).toContain('writing arm · Read poem.md (3 lines)');
  });

  test('agent.action → tool_call_complete falls back to name + resultPreview (old server)', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: {
        data: { type: 'tool_call_complete', name: 'read_file', status: 'ok', resultPreview: 'legacy preview' },
      },
    });
    const toolEvent = out.find((e) => e.kind === 'tool');
    if (!toolEvent || toolEvent.kind !== 'tool') throw new Error('expected tool');
    expect(toolEvent.tool.name).toBe('read_file');
    expect(toolEvent.tool.preview).toBe('legacy preview');
  });

  test('agent.action → propagates mcpServer badge when present', () => {
    const out = decodeGatewayEvent({
      type: 'agent.action',
      payload: { data: { type: 'tool_call', toolName: 'search', mcpServer: 'serpapi' } },
    });
    const event = single(out);
    if (event.kind !== 'tool') throw new Error('expected tool');
    expect(event.tool.mcpServer).toBe('serpapi');
  });

  test('chat.response is a no-op (handled via onResponse)', () => {
    const out = decodeGatewayEvent({ type: 'chat.response', payload: { response: 'hi' } });
    expect(out.length).toBe(0);
  });

  test('unknown event type produces no events', () => {
    const out = decodeGatewayEvent({ type: 'mystery', payload: { foo: 1 } });
    expect(out.length).toBe(0);
  });
});
