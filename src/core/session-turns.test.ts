import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Message } from '@/db/schema/messages';
import type { SessionContext } from '@/db/schema/sessions';
import type { AgentMessage } from './types';
const fixture = vi.hoisted(() => ({ context: {} as SessionContext, rows: [] as Message[], failSummary: false, failInsert: false, noSavings: false, clearInSummary: false, summaries: [] as AgentMessage[][] }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async () => ({ id: 'session', userId: 'user', context: structuredClone(fixture.context) }),
  incrementMessageCount: async () => {},
  patchContextIfGeneration: async (_id: string, generation: string, patch: object) => {
    if ((fixture.context.clearedAt ?? '') !== generation) return false;
    Object.assign(fixture.context, structuredClone(patch)); return true;
  },
} }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: {
  create: async (data: object) => {
    const row = { ...data, id: `message-${fixture.rows.length}`, createdAt: new Date(1789500000000 + fixture.rows.length * 1000) } as Message;
    fixture.rows.push(row); return row;
  },
  findContextMessages: async (_id: string, since?: string, after?: { id: string }) => {
    const index = after ? fixture.rows.findIndex(r => r.id === after.id) : -1;
    return fixture.rows.filter((r, i) => i > index && (!since || r.createdAt >= new Date(since)));
  },
} }));
vi.mock('@/db/repositories/agent-repository', () => ({ agentRepository: { updateStatus: async () => {} } }));
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { logAgentCompleted: async () => {} } }));
vi.mock('@/core/agent-task-recorder', () => ({ recordAgentCompletion: async () => {} }));
vi.mock('@/tools/browser-ext', () => ({ closeAgentTabs: async () => {} }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getDefaultModel: async () => ({ modelId: 'summary-model' }) }) }));
vi.mock('@/db/repositories/compaction-entry-repository', () => ({ compactionEntryRepository: {
  insert: async () => { if (fixture.failInsert) throw new Error('audit insert failed'); return { id: `checkpoint-${fixture.summaries.length}` }; },
} }));
vi.mock('@/utils/context-compaction', async original => ({ ...await original<typeof import('@/utils/context-compaction')>(),
  createLLMSummary: async (messages: AgentMessage[], _model: string, options: { previousSummary?: string }) => {
    fixture.summaries.push(messages);
    if (fixture.failSummary) throw new Error('summary unavailable');
    const facts = [...new Set(((options.previousSummary ?? '') + messages.map(m => m.content).join(' ')).match(/FACT_\d+/g) ?? [])];
    const summaryText = fixture.noSavings ? messages.map(m => m.content).join(' ').repeat(3) : 'Completed decisions: ' + facts.join(' ');
    if (fixture.clearInSummary) fixture.context = { clearedAt: '2030-01-01T00:00:00Z' };
    return { summaryText, message: { role: 'system', content: '[Context Summary] ' + summaryText, timestamp: new Date() }, fileOps: { read: [], written: [], edited: [] } };
  },
}));
import { AgentWorker } from './agent-worker';
import { messageRepository } from '@/db/repositories/message-repository';
import { acknowledgeProviderTurn } from './cli-session-store';
import { maybeCompactSession } from './agent/session-compaction';
import { readSessionHistory } from './session-history';
import { OpenRouterProvider } from '@/models/providers/openrouter-provider';
import { estimateTokens } from '@/utils/token-count';

beforeEach(() => { fixture.context = {}; fixture.rows = []; fixture.failSummary = false; fixture.failInsert = false; fixture.noSavings = false; fixture.clearInSummary = false; fixture.summaries = []; });
function worker(turn: number, model = 'anthropic/claude-sonnet-4-6', root = true) {
  return new AgentWorker({ id: `agent-${turn}`, sessionId: 'session', userId: 'user', model, role: 'general', topic: 'test',
    status: 'idle', createdAt: new Date(), updatedAt: new Date(), root, metadata: {} },
    { maxIterations: 3, maxTokenBudget: 1_000_000, contextWindowSize: 200_000, timeout: 30_000, toolOutputSoftCap: 100 });
}
function privateWorker(w: AgentWorker) { return w as unknown as { messages: AgentMessage[]; loop(): Promise<string> }; }
async function turn(n: number, inspect?: (messages: AgentMessage[]) => void) {
  const w = worker(n); const state = privateWorker(w);
  w.addSystemMessage('Follow the project requirements. '.repeat(150) + `\n\nCURRENT DATE & TIME: turn ${n}`);
  state.loop = async () => {
    inspect?.(state.messages);
    state.messages.push({ role: 'assistant', content: '', timestamp: new Date(),
      toolCalls: [{ id: `tool-${n}`, name: 'read_file', arguments: { path: 'project.txt' } }],
      providerRaw: { openrouterModel: 'anthropic/claude-sonnet-4-6', reasoning_details: [{ type: 'reasoning.encrypted', data: `signed-${n}`, index: 0 }] } },
      { role: 'tool', content: `FACT_${n} ` + 'Verified project evidence. '.repeat(15), toolCallId: `tool-${n}`, timestamp: new Date() });
    return `Completed task ${n}.`;
  };
  const answer = await w.run(`Question ${n}: apply the project decision.`);
  const row = await messageRepository.create({ sessionId: 'session', role: 'assistant', content: answer });
  await acknowledgeProviderTurn('session', `agent-${n}`, row);
}

describe('session lifecycle across ephemeral root workers', () => {
  test('retains native tool evidence and signed state and appends only unseen turns', async () => {
    await turn(1);
    await messageRepository.create({ sessionId: 'session', role: 'user', content: 'CORRECTION from CLI' });
    await messageRepository.create({ sessionId: 'session', role: 'assistant', content: 'CLI answer' });
    await turn(2, messages => {
      expect(messages.filter(m => m.content === 'Completed task 1.')).toHaveLength(1);
      expect(messages.some(m => m.role === 'tool' && m.content.includes('FACT_1'))).toBe(true);
      expect(messages.some(m => m.providerRaw?.reasoning_details)).toBe(true);
      expect(messages.some(m => m.content.includes('CORRECTION from CLI'))).toBe(true);
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).not.toContain('CURRENT DATE');
    });
    const child = worker(3, undefined, false); await child.loadHistory();
    expect(privateWorker(child).messages).toEqual([]);
  });
  test('a provider switch retains tool evidence but strips incompatible signed state', async () => {
    await turn(1);
    const switched = worker(2, 'openai/example'); await switched.loadHistory();
    const messages = privateWorker(switched).messages;
    expect(messages.some(m => m.role === 'tool' && m.content.includes('FACT_1'))).toBe(true);
    expect(messages.some(m => m.providerRaw)).toBe(false);
  });
  test('does not rotate provider state if summary or audit persistence fails', async () => {
    for (let i = 0; i < 6; i++) await turn(i);
    fixture.context.cliSessions = { 'Claude Code': { id: 'live', fingerprint: 'f', lastUsedAt: '', generation: '' } };
    const original = structuredClone(fixture.context.nativeConversation);
    fixture.failSummary = true;
    await expect(maybeCompactSession('session', { force: true })).rejects.toThrow('summary unavailable');
    expect(fixture.context.nativeConversation).toEqual(original);
    fixture.failSummary = false; fixture.failInsert = true;
    await expect(maybeCompactSession('session', { force: true })).rejects.toThrow('audit insert failed');
    expect(fixture.context.checkpoint).toBeUndefined();
    expect(fixture.context.cliSessions?.['Claude Code'].id).toBe('live');
    expect(fixture.context.nativeConversation).toEqual(original);
  });
  test('ineffective automatic compaction keeps state and waits for real context growth', async () => {
    for (let i = 0; i < 12; i++) await turn(i);
    const original = structuredClone(fixture.context.nativeConversation);
    fixture.noSavings = true;
    await maybeCompactSession('session');
    expect(fixture.context.checkpoint).toBeUndefined();
    expect(fixture.context.nativeConversation).toEqual(original);
    expect(fixture.context.compactionState?.compactionIneffective).toBe(true);
    await maybeCompactSession('session');
    expect(fixture.summaries).toHaveLength(1);
  });
  test('a clear during summarization prevents checkpoint publication', async () => {
    for (let i = 0; i < 6; i++) await turn(i);
    fixture.clearInSummary = true;
    await maybeCompactSession('session', { force: true });
    expect(fixture.context.checkpoint).toBeUndefined();
    expect(fixture.context.nativeConversation).toBeUndefined();
    expect(fixture.context.clearedAt).toBe('2030-01-01T00:00:00Z');
  });
  test('40-turn benchmark preserves facts through repeated checkpoints and a clear', async () => {
    const provider = new OpenRouterProvider() as unknown as { buildParams(options: object, stream: boolean): { messages: unknown[] } };
    let priorBlocks: string[] = []; let inputTokens = 0; let reusablePrefixTokens = 0; let checkpoints = 0;
    const samples: object[] = [];
    for (let n = 1; n <= 40; n++) {
      if (n === 26) { fixture.context = { clearedAt: new Date(1789500000000 + fixture.rows.length * 1000).toISOString() }; priorBlocks = []; }
      await turn(n, messages => {
        const text = messages.map(m => m.content).join(' ');
        if (n > 1 && n !== 26) expect(text).toContain(`FACT_${n - 1}`);
        if (n > 26) expect(text).not.toMatch(/FACT_(?:[1-9]|1[0-9]|2[0-5])\b/);
        const wire = provider.buildParams({ model: 'anthropic/claude-sonnet-4-6', messages, sessionId: 'session', cacheScope: fixture.context.clearedAt ?? '', cachePolicy: 'off' }, false);
        const blocks = wire.messages.map(m => JSON.stringify(m));
        let common = 0; while (common < priorBlocks.length && blocks[common] === priorBlocks[common]) common++;
        const input = estimateTokens(blocks.join('\n')); const reusable = estimateTokens(blocks.slice(0, common).join('\n'));
        inputTokens += input; reusablePrefixTokens += reusable; priorBlocks = blocks;
        samples.push({ turn: n, inputTokens: input, potentialReusablePrefixTokens: reusable });
      });
      if ([10, 20, 35].includes(n)) {
        await maybeCompactSession('session', { force: true }); checkpoints++;
        expect(fixture.context.nativeConversation?.checkpointId).toBe(fixture.context.checkpoint?.entryId);
        expect(fixture.context.nativeConversation?.messages.some(m => m.role === 'tool')).toBe(true);
        const history = await readSessionHistory('session');
        expect(history.rows).toHaveLength(6);
        expect(history.checkpoint?.summary).toContain(`FACT_${n - 3}`);
      }
    }
    expect(fixture.summaries.flat().some(m => m.role === 'tool')).toBe(true);
    expect(reusablePrefixTokens / inputTokens).toBeGreaterThan(0.5);
    const report = { kind: 'deterministic structural benchmark; no live provider calls', turns: 40, checkpoints, clears: 1,
      inputTokens, potentialReusablePrefixTokens: reusablePrefixTokens, potentialPrefixReuseRatio: reusablePrefixTokens / inputTokens,
      measuredProviderCost: null, measuredCacheHits: null, samples };
    if (process.env.SESSION_BENCHMARK_REPORT) writeFileSync(process.env.SESSION_BENCHMARK_REPORT, JSON.stringify(report, null, 2) + '\n');
  });
});
