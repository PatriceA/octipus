import { describe, expect, it } from 'vitest';
import { antigravityConfig, parseAgyStreamJson } from './cli-provider';
import { CLIOutputParser } from '@/core/cli-adapters';
import { agyUsage, verifyAgyToollessOutput } from '@/core/agy-cli-protocol';

describe('managed Antigravity configuration', () => {
  it('keeps legacy aliases while using streamed, scoped MCP tools', () => {
    expect(antigravityConfig.modelPatterns).toEqual(expect.arrayContaining(['cli/gemini', 'cli/antigravity', 'cli/agy']));
    expect(antigravityConfig).toMatchObject({ binaryPath: 'agy', octipusToolsOnly: true, bufferOutput: false, toolBridge: 'mcp' });
    expect(() => antigravityConfig.buildArgs('hello')).toThrow('managed agent');
    expect(antigravityConfig.cliToolsStdin).toBeUndefined();
  });
  it('preserves cache usage without adding it or reasoning to totals twice', () => {
    const usage = { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 800, thinking_tokens: 70, total_tokens: 1100 };
    expect(agyUsage(usage)).toMatchObject({ inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 800, available: true });
    expect(parseAgyStreamJson(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'OK', usage } }), Date.now()).usage).toEqual(agyUsage(usage));
    expect(() => parseAgyStreamJson(JSON.stringify({ event: 'result', result: { status: 'CANCELLED' } }), Date.now())).toThrow('error');
  });
  it('streams text and scoped tool activity, captures IDs and reconciles aggregate usage', () => {
    const usageReports: Array<{ input: number; output: number; total: number; cacheRead?: number }> = [];
    const events: Array<{ type: string; data: unknown }> = [];
    const ids: string[] = []; let turns = 0; let tools = 0;
    const parser = new CLIOutputParser('a', 'cli/antigravity', (type, data) => events.push({ type, data }), {
      onTurn: () => { turns++; }, onToolCall: () => { tools++; }, onVendorSession: id => ids.push(id),
      onTokenUsage: value => usageReports.push(value), isBridgedTool: name => name.startsWith('octipus.'),
    });
    const feed = (event: Record<string, unknown>) => parser.parse(event, 'Antigravity');
    feed({ event: 'init', conversation_id: 'conversation', init: {} });
    const response = { conversation_id: 'conversation', step_index: 1, step_type: 'agent_response', state: 'DONE', text_delta: 'Checking',
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_tokens: 800 } };
    expect(feed({ event: 'step_update', step_update: response })).toEqual({ text: 'Checking' });
    // Replay must not charge the same completed step a second time.
    feed({ event: 'step_update', step_update: response });
    for (const state of ['ACTIVE', 'DONE']) feed({ event: 'step_update', step_update: { conversation_id: 'conversation', step_index: 2, step_type: 'tool', state,
      tool_name: 'call_mcp_tool', tool_info: { parameters: { ServerName: 'octipus', ToolName: 'sample_context', Arguments: {} }, output: 'OK' } } });
    expect(feed({ event: 'result', result: { status: 'SUCCESS', response: 'Done', usage: { input_tokens: 1200, output_tokens: 120, cache_read_tokens: 850 }, num_turns: 1 } })).toEqual({ text: 'Done', replace: true });
    expect(ids).toEqual(['conversation']); expect(turns).toBe(1); expect(tools).toBe(1);
    expect(usageReports.reduce((sum, u) => sum + u.total, 0)).toBe(1320);
    expect(usageReports.reduce((sum, u) => sum + (u.cacheRead ?? 0), 0)).toBe(850);
    expect(events.some(e => (e.data as { toolName?: string }).toolName === 'octipus.sample_context')).toBe(true);
    expect(parser.getSideEffectCounters()?.commandsRun).toBe(0);
  });
});

describe('tool-less Antigravity protocol verification', () => {
  const init = { event: 'init', init: { agent: 'octipus-managed', cwd: '/managed' } };
  const done = { event: 'result', result: { status: 'SUCCESS', response: 'Ready' } };
  const stream = (...events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n');
  it('requires managed startup and rejects native actions, MCP calls, agents and malformed sequences', () => {
    expect(() => verifyAgyToollessOutput(stream(init, done), '/managed')).not.toThrow();
    for (const bad of [stream(done), stream({ ...init, init: { agent: 'default', cwd: '/managed' } }, done),
      stream(init, init, done), stream(init, done, done), stream(init, done, { event: 'step_update' }),
      stream(init, { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'call_mcp_tool' } }, done),
      stream(init, { event: 'step_update', step_update: { subagent_info: {} } }, done), stream(init), 'not-json']) {
      expect(() => verifyAgyToollessOutput(bad, '/managed')).toThrow();
    }
  });
  it('charges only the new steps when resumed terminal usage includes earlier turns', () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const tokens: number[] = [];
    const parser = new CLIOutputParser('a', 'cli/antigravity', (type, data) => events.push({ type, data }), {
      onTurn: () => {}, onTokenUsage: u => tokens.push(u.total),
    });
    parser.parse({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 6, state: 'DONE',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 80 } } }, 'Antigravity');
    parser.parse({ event: 'result', result: { status: 'SUCCESS', num_turns: 2,
      usage: { input_tokens: 10000, output_tokens: 1000, cache_read_tokens: 8000 } } }, 'Antigravity');
    expect(tokens).toEqual([110]);
    expect(events.at(-1)?.data).toMatchObject({ stats: { inputTokens: 100, outputTokens: 10, cacheRead: 80, usageAvailable: true } });
  });
  it('preserves observed usage if the final aggregate regresses', () => {
    const events: Array<{ type: string; data: unknown }> = [];
    const tokens: number[] = [];
    const parser = new CLIOutputParser('a', 'cli/antigravity', (type, data) => events.push({ type, data }), {
      onTurn: () => {}, onTokenUsage: u => tokens.push(u.total),
    });
    parser.parse({ event: 'step_update', step_update: { step_type: 'agent_response', step_index: 1, state: 'DONE',
      usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 80 } } }, 'Antigravity');
    parser.parse({ event: 'result', result: { status: 'SUCCESS', usage: { input_tokens: 0, output_tokens: 0 } } }, 'Antigravity');
    expect(tokens).toEqual([110]);
    expect(events.at(-1)?.data).toMatchObject({ stats: { inputTokens: 100, outputTokens: 10, cacheRead: 80, usageAvailable: true, usageIncomplete: true } });
  });
});
