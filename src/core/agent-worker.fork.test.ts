import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AgentWorker } from '@/core/agent-worker';
import type { ToolHandler } from '@/core/agent-base';
import type { AgentContext, AgentMessage } from '@/core/types';
import { messageRepository } from '@/db/repositories/message-repository';
import { sessionRepository } from '@/db/repositories/session-repository';
import { getLiteLLMClient, type CompletionResult } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import * as modelKey from '@/models/model-key';
import { FILE_CHANGES_REFUSED_KEY } from './tool-executor';
import { FORK_KEY, FORK_REFUSAL, FORK_REFUSED_TOOLS_KEY, forkRefusedTools, forkTaskMessage } from './swarm/fork';

/**
 * A cache-parity fork is only worth having if its first request IS its
 * parent's last request plus one message: the same messages, the same tool
 * bytes in the same order, the same cache routing. Pinned here end to end
 * through `getCompletion`, the call that builds what the provider sees.
 */

const ctx = (over: Partial<AgentContext> = {}): AgentContext => ({
  id: 'parent-1', sessionId: '00000000-0000-0000-0000-000000000000', userId: 'local', topic: 'test',
  model: 'claude-sonnet-5-5', role: 'general', status: 'idle', createdAt: new Date(), updatedAt: new Date(),
  metadata: {}, space: null, trigger: 'user', funding: 'own', ...over,
});
const cfg = { maxIterations: 10, contextWindowSize: 100_000, timeout: 600_000, maxTokenBudget: 1_000_000, toolOutputSoftCap: 1_000 };
const done = (content: string): CompletionResult => ({ content, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }, model: 'm', latencyMs: 1 });

const ran: string[] = [];
const handler = (name: string, toolId?: string): ToolHandler => ({
  name, toolId, description: `${name} tool`, parameters: { type: 'object', properties: {} },
  execute: async () => { ran.push(name); return 'ok'; },
});
// `agent` takes the executor's no-database fast path; what the fork rule looks
// at is only whether a handler has a tool group at all.
const tools = [handler('filesystem__read_file', 'agent'), handler('filesystem__write_file', 'agent'), handler('spawn_child'), handler('exit_plan_mode')];

type Sent = { messages: unknown; tools: unknown; cacheScope?: string; cachePacing?: string };
let sent: Sent[];
type Priv = { messages: AgentMessage[]; getCompletion: () => Promise<CompletionResult>; addUserMessage: (c: string) => Promise<void> };
const executorOf = (w: AgentWorker) => (w as unknown as { toolExecutor: import('./tool-executor').ToolExecutor }).toolExecutor;

beforeEach(() => {
  ran.length = 0;
  sent = [];
  vi.spyOn(sessionRepository, 'findById').mockResolvedValue(null);
  vi.spyOn(messageRepository, 'findContextMessages').mockResolvedValue([]);
  vi.spyOn(messageRepository, 'create').mockResolvedValue({} as never);
  vi.spyOn(getModelRegistry(), 'getModelByModelId').mockResolvedValue({ name: 'claude-sonnet-5-5', modelId: 'claude-sonnet-5-5', provider: 'litellm', metadata: null, supportsTools: true } as never);
  vi.spyOn(getModelRegistry(), 'getModelForTopic').mockResolvedValue(undefined as never);
  vi.spyOn(modelKey, 'resolveModelKey').mockResolvedValue(undefined);
  vi.spyOn(getLiteLLMClient(), 'complete').mockImplementation((async (opts: Sent) => {
    // Snapshotted: the worker keeps mutating the array it passed.
    sent.push(JSON.parse(JSON.stringify({ messages: opts.messages, tools: opts.tools, cacheScope: opts.cacheScope, cachePacing: opts.cachePacing })));
    // The parent's reply is the spawn_child call: the assistant turn in flight.
    return sent.length === 1 ? { ...done(''), toolCalls: [{ id: 'c2', name: 'spawn_child', arguments: { fork: true } }] } : done('ok');
  }) as never);
});
afterEach(() => vi.restoreAllMocks());

/** A parent mid-turn: it has read a file, and its next turn is the spawn_child call in flight. */
async function parentMidTurn(metadata: Record<string, unknown> = {}) {
  const parent = new AgentWorker(ctx({ metadata }), cfg);
  parent.registerTools(tools);
  const p = parent as unknown as Priv;
  p.messages = [
    { role: 'system', content: 'You are the root agent.', timestamp: new Date() },
    { role: 'user', content: 'refactor the parser', timestamp: new Date() },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'filesystem__read_file', arguments: { path: 'parser.ts' } }], timestamp: new Date() },
    { role: 'tool', toolCallId: 'c1', content: 'export function parse() {}', timestamp: new Date() },
  ];
  await p.getCompletion(); // the parent's last request; its reply is the spawn in flight
  expect(p.messages.at(-1)?.toolCalls?.[0]?.name).toBe('spawn_child');
  return parent;
}

async function forkOf(parent: AgentWorker, parentMetadata: Record<string, unknown> = {}) {
  const seed = parent.forkSnapshot();
  const fork = new AgentWorker(ctx({
    id: 'fork-1', role: 'coding',
    metadata: {
      [FORK_KEY]: { cacheScope: seed.cacheScope, cachePacing: seed.cachePacing },
      [FORK_REFUSED_TOOLS_KEY]: forkRefusedTools(seed.tools),
      ...(parentMetadata[FILE_CHANGES_REFUSED_KEY] ? { [FILE_CHANGES_REFUSED_KEY]: parentMetadata[FILE_CHANGES_REFUSED_KEY] } : {}),
    },
  }), cfg);
  fork.registerTools(seed.tools);
  fork.seedConversation(seed);
  return fork;
}

describe('a fork reads its parent\'s cached prefix', () => {
  test('its first request is the parent\'s last request plus one message', async () => {
    const parent = await parentMidTurn();
    const fork = await forkOf(parent);
    const f = fork as unknown as Priv;
    await f.addUserMessage(forkTaskMessage('check the tests for parse()'));
    await f.getCompletion();

    const [parentLast, forkFirst] = sent;
    const forkMessages = forkFirst.messages as Array<{ role: string; content: string }>;
    expect(forkMessages.slice(0, -1)).toEqual(parentLast.messages);
    expect(forkMessages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('FORK of this conversation') });
    expect(forkFirst.tools).toEqual(parentLast.tools);
    expect(forkFirst.cacheScope).toBe(parentLast.cacheScope);
    expect(forkFirst.cachePacing).toBe(parentLast.cachePacing);
  });

  test('the parent\'s run-bound handlers stay declared and are refused; its tool groups run', async () => {
    const fork = await forkOf(await parentMidTurn());
    const results = await executorOf(fork).handleToolCalls([
      { id: 'a', name: 'spawn_child', arguments: {} },
      { id: 'b', name: 'exit_plan_mode', arguments: {} },
      { id: 'c', name: 'filesystem__read_file', arguments: { path: 'x' } },
    ]);
    expect(ran).toEqual(['filesystem__read_file']);
    expect(String(results[0].content)).toContain(FORK_REFUSAL);
    expect(String(results[1].content)).toContain(FORK_REFUSAL);
  });

  test('a parent in plan mode passes its file-change refusal on', async () => {
    const meta = { [FILE_CHANGES_REFUSED_KEY]: 'plan_mode' };
    const fork = await forkOf(await parentMidTurn(meta), meta);
    const results = await executorOf(fork).handleToolCalls([{ id: 'w', name: 'filesystem__write_file', arguments: { path: 'x', content: 'y' } }]);
    expect(ran).toEqual([]);
    expect(String(results[0].content)).toMatch(/Plan mode is on/);
  });

  test('signed reasoning is kept on the same model and dropped on another', () => {
    const fork = new AgentWorker(ctx({ id: 'fork-2', model: 'gpt-5.6' }), cfg);
    const messages: AgentMessage[] = [{ role: 'assistant', content: 'x', providerRaw: { thinking: 'signed' }, timestamp: new Date() }];
    fork.seedConversation({ messages, model: 'claude-sonnet-5-5' });
    expect((fork as unknown as Priv).messages[0].providerRaw).toBeUndefined();
    fork.seedConversation({ messages, model: 'gpt-5.6' });
    expect((fork as unknown as Priv).messages[0].providerRaw).toEqual({ thinking: 'signed' });
  });
});
