/**
 * C3 for the tool block: two users of one install, with different per-user
 * and runtime tools (connectors, MCP, extension tools, the inline-UI tool) and
 * different sticky lazy groups, send the same bytes up to and including the
 * tools breakpoint, because those tools come after the ones the install
 * shares (`orderForCache`) and the breakpoint sits on the last shared one.
 *
 * Built from a real AgentWorker (its tool assembly and deferral) and sent
 * through the real native request builder.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as config from '@/config';
import type { ToolAdvertisement, ToolHandler } from '@/core/agent-base';
import { AgentWorker } from '@/core/agent-worker';
import type { AgentContext, AgentMessage } from '@/core/types';
import type { CompletionOptions } from '@/models/litellm-client';
import { AnthropicProvider } from '@/models/providers/anthropic-provider';

const h = (name: string, toolId?: string): ToolHandler => ({
  name, toolId, description: `${name} does its thing`, parameters: { type: 'object', properties: { q: { type: 'string' } } }, execute: async () => null,
});

/** The install's built-ins, in the order the root registers them. */
const builtins = [
  h('filesystem__read_file', 'filesystem'), h('shell__run', 'shell'), h('notes__search', 'notes'),
  h('websearch__search', 'websearch'), h('skill_distill', 'skill-distill'),
];
const discovery = [h('list_tools', 'tool_discovery'), h('describe_tool', 'tool_discovery')];
const meta = [h('spawn_child'), h('collect_children')];
const selfReport = h('capabilities', 'self_report');

/**
 * One user's registered tools, in the root's registration order: built-ins,
 * then MCP (where `getToolsForRole` appends it), the inline-UI tool, the
 * discovery and meta-tools, the self-report tool; connectors and extension
 * tools where a worker gets them (after the role's tools).
 */
function registered(user: 'alice' | 'bob'): ToolHandler[] {
  const alice = user === 'alice';
  return [
    ...builtins,
    ...(alice ? [h('mcp__crm__lookup', 'mcp'), h('mcp_list_tools', 'mcp'), h('mcp_call_tool', 'mcp')] : []),
    ...(alice ? [h('mcp__plugin_weather__forecast', 'mcp')] : []),
    ...(alice ? [h('ext_quotes__get', 'ext_quotes')] : [h('ext_tides__get', 'ext_tides')]),
    ...(alice ? [h('gmail_search', 'connector')] : [h('slack_post', 'connector'), h('slack_read', 'connector')]),
    ...(alice ? [h('inline_ui_ask', 'inline-ui')] : []),
    ...discovery,
    ...meta,
    selfReport,
  ];
}

const ctx = (userId: string): AgentContext => ({
  id: `w-${userId}`, sessionId: '00000000-0000-0000-0000-000000000000', userId, topic: 't', model: 'claude-opus-5-5',
  role: 'general', status: 'idle', createdAt: new Date(), updatedAt: new Date(), metadata: {}, space: null, trigger: 'user', funding: 'own',
});

type Probe = { requestTools(m: { provider?: string; modelId: string }): { declarableTools: NonNullable<CompletionOptions['tools']>; sharedToolCount: number; deferredTools?: string[] } };

function request(user: 'alice' | 'bob', advertisement: ToolAdvertisement, model = { provider: 'anthropic', modelId: 'claude-opus-5-5' }) {
  const w = new AgentWorker(ctx(user), { maxIterations: 1, contextWindowSize: 100_000, timeout: 60_000, maxTokenBudget: 0, toolOutputSoftCap: 1000, toolAdvertisement: advertisement });
  w.registerTools(registered(user));
  return (w as unknown as Probe).requestTools(model);
}

const messages: AgentMessage[] = [
  { role: 'system', content: 'INSTALL TIER', cacheBreak: true, timestamp: new Date() },
  { role: 'system', content: 'USER TIER', timestamp: new Date() },
  { role: 'user', content: 'earlier', timestamp: new Date() },
  { role: 'assistant', content: 'answer', timestamp: new Date() },
  { role: 'user', content: 'now', timestamp: new Date() },
];

function nativeBody(r: ReturnType<typeof request>): Record<string, unknown> {
  return (new AnthropicProvider() as unknown as { buildNativeBody(o: CompletionOptions, s: boolean): Record<string, unknown> }).buildNativeBody({
    model: 'claude-opus-5-5', messages: messages as CompletionOptions['messages'], tools: r.declarableTools,
    ...(r.deferredTools ? { deferredTools: r.deferredTools } : {}), sharedToolCount: r.sharedToolCount,
    cacheScope: 'root:g1', cachePacing: 'human',
  }, false);
}

type Tool = { name: string; cache_control?: unknown; defer_loading?: boolean };
/** The tool block up to and including its breakpoint: the bytes the tools entry is keyed on. */
function upToBreakpoint(body: Record<string, unknown>): string {
  const tools = body.tools as Tool[];
  const at = tools.findIndex((t) => t.cache_control);
  expect(at).toBeGreaterThanOrEqual(0);
  // Deferred tools are outside the prompt prefix; they are dropped here so the
  // comparison is of what the API renders before the breakpoint.
  return JSON.stringify(tools.slice(0, at + 1).filter((t) => !t.defer_loading));
}
const countBreakpoints = (body: unknown) => JSON.stringify(body).split('"cache_control"').length - 1;
const toolName = (t: NonNullable<CompletionOptions['tools']>[number]) => (t.type === 'function' ? t.function.name : t.type);

const lazy = (groupOrder: string[]): ToolAdvertisement => ({
  mode: 'lazy', coreToolIds: [...groupOrder, 'self_report', 'inline-ui'], groupOrder,
});
// Alice's conversation reached for web search, Bob's for his notes.
const aliceLazy = lazy(['filesystem', 'shell', 'websearch', 'skill-distill']);
const bobLazy = lazy(['filesystem', 'shell', 'notes', 'skill-distill']);

afterEach(() => vi.restoreAllMocks());

describe('(a) first-party Claude with tool search', () => {
  const on = () => vi.spyOn(config, 'getConfig').mockReturnValue({ agent: { nativeToolSearch: true } } as never);

  test('identical bytes up to and including the tools breakpoint for two users', () => {
    on();
    const a = nativeBody(request('alice', aliceLazy));
    const b = nativeBody(request('bob', bobLazy));
    expect(upToBreakpoint(a)).toBe(upToBreakpoint(b));
    expect((a.tools as Tool[]).find((t) => t.cache_control)?.name).toBe('capabilities');
  });

  test('the per-user tools are deferred, except the inline-UI tool, which is in the floor and after the breakpoint', () => {
    on();
    const tools = nativeBody(request('alice', aliceLazy)).tools as Tool[];
    const deferred = tools.filter((t) => t.defer_loading).map((t) => t.name);
    expect(deferred).toEqual(expect.arrayContaining(['gmail_search', 'ext_quotes__get', 'notes__search', 'websearch__search']));
    const loaded = tools.filter((t) => !t.defer_loading).map((t) => t.name);
    const mark = tools.findIndex((t) => t.cache_control);
    // Loaded and per-user: after the breakpoint.
    for (const name of ['inline_ui_ask', 'mcp_list_tools', 'mcp__crm__lookup']) {
      expect(loaded).toContain(name);
      expect(tools.findIndex((t) => t.name === name)).toBeGreaterThan(mark);
    }
  });

  test('four breakpoints at most: tools, install, system end, history', () => {
    on();
    expect(countBreakpoints(nativeBody(request('alice', aliceLazy)))).toBe(4);
  });
});

describe('(b) first-party Claude without tool search', () => {
  const off = () => vi.spyOn(config, 'getConfig').mockReturnValue({ agent: { nativeToolSearch: false } } as never);

  test.each([
    ['lazy, different sticky groups', aliceLazy, bobLazy],
    ['full advertisement', { mode: 'full' } as const, { mode: 'full' } as const],
  ])('%s: identical bytes up to and including the tools breakpoint', (_label, adA, adB) => {
    off();
    const a = nativeBody(request('alice', adA));
    const b = nativeBody(request('bob', adB));
    expect(a.tools).not.toEqual(b.tools);
    expect(upToBreakpoint(a)).toBe(upToBreakpoint(b));
    expect(countBreakpoints(a)).toBe(4);
  });

  test('order: shared built-ins, then per-user and runtime tools, then the sticky groups in first-used order', () => {
    off();
    const names = request('alice', aliceLazy).declarableTools.map(toolName);
    expect(names).toEqual([
      'filesystem__read_file', 'shell__run', 'skill_distill', 'list_tools', 'describe_tool', 'spawn_child', 'collect_children', 'capabilities',
      'mcp__crm__lookup', 'mcp_list_tools', 'mcp_call_tool', 'mcp__plugin_weather__forecast', 'inline_ui_ask',
      'websearch__search',
    ]);
  });

  test('a group used later is appended at the tail: every earlier tool keeps its place', () => {
    off();
    const before = request('alice', aliceLazy).declarableTools.map(toolName);
    const after = request('alice', lazy(['filesystem', 'shell', 'websearch', 'skill-distill', 'notes'])).declarableTools.map(toolName);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.at(-1)).toBe('notes__search');
  });
});

describe('(c) OpenAI-compatible (automatic prefix caching)', () => {
  test('the shared tools are the leading entries of the tool array, the same for two users', () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({ agent: { nativeToolSearch: true } } as never);
    const model = { provider: 'openai', modelId: 'gpt-5.6' };
    const a = request('alice', aliceLazy, model);
    const b = request('bob', bobLazy, model);
    expect(a.deferredTools).toBeUndefined();
    expect(a.sharedToolCount).toBe(b.sharedToolCount);
    expect(JSON.stringify(a.declarableTools.slice(0, a.sharedToolCount))).toBe(JSON.stringify(b.declarableTools.slice(0, b.sharedToolCount)));
  });
});
