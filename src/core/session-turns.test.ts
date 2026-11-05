import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Message } from '@/db/schema/messages';
import type { SessionContext } from '@/db/schema/sessions';
import type { AgentMessage } from './types';
const fixture = vi.hoisted(() => ({ context: {} as SessionContext, rows: [] as Message[], sizeReads: 0, failSummary: false, failInsert: false, noSavings: false, clearInSummary: false, summaries: [] as AgentMessage[][], evidence: 15 }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async () => ({ id: 'session', userId: 'user', context: structuredClone(fixture.context) }),
  incrementMessageCount: async () => {},
  // Mirrors the real statement, including its in-SQL `cliSessions` filter.
  patchContextIfGeneration: async (_id: string, generation: string, patch: object, opts?: { keepCliSessionPrefixes?: string[] }) => {
    if ((fixture.context.conversationGeneration ?? fixture.context.clearedAt ?? '') !== generation) return false;
    Object.assign(fixture.context, structuredClone(patch));
    const prefixes = opts?.keepCliSessionPrefixes;
    if (prefixes) fixture.context.cliSessions = Object.fromEntries(Object.entries(fixture.context.cliSessions ?? {}).filter(([key]) => prefixes.some(p => key.startsWith(p))));
    return true;
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
  contextSize: async (_id: string, since?: string, after?: { id: string }) => {
    fixture.sizeReads++;
    const index = after ? fixture.rows.findIndex(r => r.id === after.id) : -1;
    const rows = fixture.rows.filter((r, i) => i > index && (!since || r.createdAt >= new Date(since)));
    return { rows: rows.length, bytes: rows.reduce((n, r) => n + Buffer.byteLength(r.content), 0) };
  },
} }));
vi.mock('@/db/repositories/agent-repository', () => ({ agentRepository: { updateStatus: async () => {} } }));
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { logAgentCompleted: async () => {} } }));
vi.mock('@/core/agent-task-recorder', () => ({ recordAgentCompletion: async () => {} }));
vi.mock('@/db/repositories/agent-repository', () => ({ agentRepository: {
  findLatestRootForSession: async () => ({ id: 'live-cli-root' }),
  updateStatus: async () => {},
} }));
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
import { COMPACTION_FAILURE_BACKOFF_MAX_MS, COMPACTION_FAILURE_BACKOFF_MS, COMPACTION_MESSAGE_THRESHOLD, COMPACTION_TRIGGER_MAX_TOKENS, COMPACTION_TRIGGER_MIN_TOKENS, compactSessionCommand, compactionRetryAt, compactionTriggerTokens, decideCompaction, maybeCompactSession } from './agent/session-compaction';
import { readSessionHistory } from './session-history';
import { OpenRouterProvider } from '@/models/providers/openrouter-provider';
import { estimateTokens } from '@/utils/token-count';

beforeEach(() => { fixture.context = {}; fixture.rows = []; fixture.sizeReads = 0; fixture.failSummary = false; fixture.failInsert = false; fixture.noSavings = false; fixture.clearInSummary = false; fixture.summaries = []; fixture.evidence = 15; });
function worker(turn: number, model = 'anthropic/claude-sonnet-4-6', root = true) {
  return new AgentWorker({ space: null, trigger: 'user', funding: 'own',  id: `agent-${turn}`, sessionId: 'session', userId: 'user', model, role: 'general', topic: 'test',
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
      { role: 'tool', content: `FACT_${n} ` + 'Verified project evidence. '.repeat(fixture.evidence), toolCallId: `tool-${n}`, timestamp: new Date() });
    return `Completed task ${n}.`;
  };
  const answer = await w.run(`Question ${n}: apply the project decision.`);
  const row = await messageRepository.create({ sessionId: 'session', role: 'assistant', content: answer });
  await acknowledgeProviderTurn('session', `agent-${n}`, row);
}

describe('session lifecycle across ephemeral root workers', () => {
  test('manual compact forces a small session and reports real outcomes', async () => {
    expect(await compactSessionCommand('session', '', 'u1')).toContain('was not compacted');
    for (let i = 0; i < 4; i++) await turn(i);
    expect(await maybeCompactSession('session')).toBe(false);
    expect(await compactSessionCommand('session', '', 'u1')).toContain('Session compacted.');
    expect(fixture.context.checkpoint).toBeDefined();
  });
  test('manual compact reports failures and invalidated checkpoints', async () => {
    for (let i = 0; i < 4; i++) await turn(i);
    fixture.failSummary = true;
    expect(await compactSessionCommand('session', 'keep decisions', 'u1')).toContain('Compaction failed: summary unavailable');
    fixture.failSummary = false;
    fixture.clearInSummary = true;
    expect(await compactSessionCommand('session', '', 'u1')).toContain('was not compacted');
  });
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
    // A root CLI session from an earlier generation: compaction may rotate it,
    // so a failed compaction must leave it in place. (A live one would stop
    // compaction before either failure point; see the test below.)
    fixture.context.cliSessions = { 'Claude Code': { id: 'live', fingerprint: 'f', lastUsedAt: '', generation: 'earlier' } };
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
  test('a long but small session is not re-checkpointed after every turn', async () => {
    // 12 turns, 24 rows, a few thousand tokens: this used to compact (20 rows
    // or 8k tokens), and again on nearly every later turn — each pass a cold
    // prompt cache for the whole conversation and an extra summary call.
    for (let i = 0; i < 12; i++) await turn(i);
    expect(await maybeCompactSession('session')).toBe(false);
    expect(fixture.summaries).toHaveLength(0);
    expect(fixture.context.checkpoint).toBeUndefined();
  });
  test('the automatic trigger scales with the context window, below the in-turn compaction', async () => {
    const { CONTEXT_MESSAGE_CAP } = await vi.importActual<typeof import('@/db/repositories/message-repository')>('@/db/repositories/message-repository');
    expect(compactionTriggerTokens(32_000)).toBe(16_000);
    expect(compactionTriggerTokens(200_000)).toBe(COMPACTION_TRIGGER_MAX_TOKENS);
    expect(compactionTriggerTokens(1_000_000)).toBe(COMPACTION_TRIGGER_MAX_TOKENS);
    expect(compactionTriggerTokens(4_000)).toBe(COMPACTION_TRIGGER_MIN_TOKENS);
    expect(COMPACTION_TRIGGER_MAX_TOKENS).toBeLessThan(100_000); // agent-worker AUTO_COMPACT_THRESHOLD
    expect(COMPACTION_MESSAGE_THRESHOLD).toBeLessThan(CONTEXT_MESSAGE_CAP);
  });
  test('a large session compacts, and the retained turns lose their signed reasoning', async () => {
    fixture.evidence = 1_200; // ~5k tokens of tool output per turn
    for (let i = 0; i < 6; i++) await turn(i);
    expect(fixture.context.nativeConversation?.messages.some(m => m.providerRaw?.reasoning_details)).toBe(true);
    expect(await maybeCompactSession('session')).toBe(true);
    const kept = fixture.context.nativeConversation?.messages ?? [];
    expect(kept[0].content).toContain('[Conversation checkpoint]');
    expect(kept.some(m => m.role === 'tool')).toBe(true);
    expect(kept.some(m => m.providerRaw?.reasoning_details)).toBe(false);
  });
  test('ineffective automatic compaction keeps state and waits for real context growth', async () => {
    fixture.evidence = 1_200;
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
  test('a failed automatic summary backs off instead of retrying on every turn', async () => {
    fixture.evidence = 1_200;
    for (let i = 0; i < 12; i++) await turn(i);
    fixture.failSummary = true;
    await expect(maybeCompactSession('session')).rejects.toThrow('summary unavailable');
    expect(fixture.context.compactionState).toMatchObject({ failedPasses: 1 });
    // The next turn skips the pass (no second summary call), without
    // reading the transcript to find that out…
    const read = vi.spyOn(messageRepository, 'findContextMessages');
    expect(await maybeCompactSession('session')).toBe(false);
    expect(fixture.summaries).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    // …a manual /compact does not wait…
    fixture.failSummary = false;
    expect(await maybeCompactSession('session', { force: true })).toBe(true);
    // …and a success clears the failure record.
    expect(fixture.context.compactionState?.failedPasses).toBeUndefined();
  });
  test('the backoff doubles with each failure in a row, up to a ceiling', () => {
    const at = Date.parse('2030-01-01T00:00:00Z');
    const retry = (failedPasses: number) => compactionRetryAt({ lastFailedAt: new Date(at).toISOString(), failedPasses })! - at;
    expect(retry(1)).toBe(COMPACTION_FAILURE_BACKOFF_MS);
    expect(retry(3)).toBe(4 * COMPACTION_FAILURE_BACKOFF_MS);
    expect(retry(30)).toBe(COMPACTION_FAILURE_BACKOFF_MAX_MS);
    const config = { minSavingsRatio: 0.15, growthMultiplier: 1.5, hardCeiling: 100_000 };
    const state = { lastFailedAt: new Date(at).toISOString(), failedPasses: 1 };
    expect(decideCompaction({ currentTokens: 10_000_000, state, config, now: at + 1 })).toMatchObject({ allow: false, reason: 'failed-backing-off' });
    expect(decideCompaction({ currentTokens: 10_000, state, config, now: at + COMPACTION_FAILURE_BACKOFF_MS })).toMatchObject({ allow: true });
  });
  test('a short session is settled without reading its transcript', async () => {
    for (let i = 0; i < 2; i++) await turn(i);
    fixture.context.nativeConversation = undefined;
    const read = vi.spyOn(messageRepository, 'findContextMessages');
    expect(await maybeCompactSession('session')).toBe(false);
    expect(fixture.sizeReads).toBe(1);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });
  test('manual compact summarizes chat when only an older provider session remains', async () => {
    for (let i = 0; i < 6; i++) await turn(i);
    fixture.context.cliSessions = { 'Claude Code': {
      id: 'old-claude', ownerAgentId: 'old-root', fingerprint: 'f', lastUsedAt: '', generation: '',
    } };
    expect(await compactSessionCommand('session', '', 'user')).toContain('Session compacted.');
    expect(fixture.context.checkpoint).toBeDefined();
    expect(fixture.context.cliSessions?.['Claude Code']).toBeUndefined();
  });
  test('a live root vendor session is never compacted onto an Octipus checkpoint', async () => {
    for (let i = 0; i < 6; i++) await turn(i);
    const rec = { fingerprint: 'f', lastUsedAt: '', generation: '' };
    const sessions = { 'Claude Code': { id: 'root', ownerAgentId: 'live-cli-root', ...rec }, 'Claude Code::general>coding:t1': { id: 'child', ...rec } };
    fixture.context.cliSessions = structuredClone(sessions);
    expect(await maybeCompactSession('session', { force: true })).toBe(false);
    expect(fixture.context.checkpoint).toBeUndefined();
    expect(fixture.context.cliSessions).toEqual(sessions);
  });
  test('compaction rotates stale root vendor sessions but keeps child task sessions', async () => {
    for (let i = 0; i < 6; i++) await turn(i);
    const rec = { fingerprint: 'f', lastUsedAt: '', generation: 'earlier' };
    fixture.context.cliSessions = { 'Claude Code': { id: 'root', ...rec }, 'Codex CLI': { id: 'root-codex', ...rec }, 'Claude Code::general>coding:t1': { id: 'child', ...rec } };
    await maybeCompactSession('session', { force: true });
    expect(fixture.context.checkpoint).toBeDefined();
    expect(Object.keys(fixture.context.cliSessions ?? {})).toEqual(['Claude Code::general>coding:t1']);
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

  describe('signed reasoning and the conversation it was bound to', () => {
    type Guarded = { messages: AgentMessage[]; lastPrefixFingerprint?: string | null; guardSignedReasoning(tools?: unknown[]): void; loadHistory(): Promise<void> };
    const signed = (n: number): AgentMessage => ({ role: 'assistant', content: '', timestamp: new Date(),
      toolCalls: [{ id: `tool-${n}`, name: 'read_file', arguments: {} }],
      providerRaw: { anthropicContent: [{ type: 'thinking', thinking: '', signature: `sig-${n}` }, { type: 'tool_use', id: `tool-${n}`, name: 'read_file', input: {} }] } });
    const tool = (name: string) => ({ type: 'function' as const, function: { name, description: name, parameters: { type: 'object' } } });
    const blocks = (messages: AgentMessage[]) => messages.flatMap(m => (m.providerRaw?.anthropicContent as Array<{ type: string }> | undefined) ?? []).map(b => b.type);

    test('a changed tool set mid-run strips every replayed thinking block, an unchanged one keeps them', () => {
      const w = worker(1) as unknown as Guarded;
      w.messages = [{ role: 'system', content: 'sys', timestamp: new Date() }, { role: 'user', content: 'q', timestamp: new Date() }, signed(1)];
      w.guardSignedReasoning([tool('read_file')]);
      w.guardSignedReasoning([tool('read_file')]);
      expect(blocks(w.messages)).toEqual(['thinking', 'tool_use']);
      // Order alone is not a change (Claude binds tools as a name-sorted set).
      w.guardSignedReasoning([tool('read_file'), tool('write_file')]);
      expect(blocks(w.messages)).toEqual(['tool_use']);
      w.messages.push(signed(2));
      w.guardSignedReasoning([tool('write_file'), tool('read_file')]);
      expect(blocks(w.messages)).toEqual(['tool_use', 'thinking', 'tool_use']);
    });

    test('under manual thinking (budget_tokens) the loop keeps them: those models check no binding, and need the in-flight block', () => {
      const w = worker(1) as unknown as Guarded & { manualThinking: boolean };
      w.manualThinking = true;
      w.messages = [{ role: 'system', content: 'sys', timestamp: new Date() }, signed(1)];
      w.guardSignedReasoning([tool('read_file')]);
      w.guardSignedReasoning([tool('write_file')]);
      expect(blocks(w.messages)).toEqual(['thinking', 'tool_use']);
    });

    test('a summary folded into the system prompt strips them too', () => {
      const w = worker(1) as unknown as Guarded;
      w.messages = [{ role: 'system', content: 'sys', timestamp: new Date() }, signed(1)];
      w.guardSignedReasoning([]);
      w.messages.splice(1, 0, { role: 'system', content: '[Context Summary] earlier work', timestamp: new Date() });
      w.guardSignedReasoning([]);
      expect(blocks(w.messages)).toEqual(['tool_use']);
    });

    test('the next turn compares against the prompt the snapshot recorded', async () => {
      await turn(1);
      // The stubbed loop made no model call, so this snapshot recorded no
      // prompt: its reasoning is treated as bound to an unknown one.
      fixture.context.nativeConversation!.messages[1] = { ...signed(1), timestamp: new Date().toISOString() } as never;
      const next = worker(2) as unknown as Guarded;
      await next.loadHistory();
      expect(next.lastPrefixFingerprint).toBeNull();
      next.guardSignedReasoning([]);
      expect(blocks(next.messages)).toEqual(['tool_use']);
    });
  });
});
