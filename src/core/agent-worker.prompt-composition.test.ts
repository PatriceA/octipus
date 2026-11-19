/**
 * The worker end of the Context inspector: the root's user message carries
 * the request's sizes by category, measured with the history the worker
 * loaded and the tools it advertises; a worker's sizes go on its agent row
 * (run view); an unstaged agent carries none.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import type { Message } from '@/db/schema/messages';
import type { AgentMessage } from './types';

const fixture = vi.hoisted(() => ({ rows: [] as Message[], agentMeta: [] as Array<[string, Record<string, unknown>]> }));
vi.mock('@/db/repositories/agent-repository', () => ({ agentRepository: {
  mergeMetadata: async (id: string, patch: Record<string, unknown>) => { fixture.agentMeta.push([id, patch]); },
} }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { incrementMessageCount: async () => {} } }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: {
  create: async (data: object) => {
    const row = { ...data, id: `message-${fixture.rows.length}`, createdAt: new Date() } as Message;
    fixture.rows.push(row);
    return row;
  },
} }));

import { AgentWorker } from './agent-worker';
import { beginReadOnlyTurn, endReadOnlyTurn } from '@/security/read-only-turn';
import { getContextFill } from './agent/prompt-budget';
import { _resetPromptCompositionForTesting, bindStagedRootPrompt, getAgentComposition, getLatestComposition, promptPart, stageAgentPrompt, stageRootPrompt } from './agent/prompt-composition';

beforeEach(() => { fixture.rows = []; fixture.agentMeta = []; _resetPromptCompositionForTesting(); });

function worker(id: string, root: boolean, codemode = false) {
  return new AgentWorker({ space: null, trigger: 'user', funding: 'own', id, sessionId: 'session', userId: 'user', model: 'm', role: 'general', topic: 'test',
    status: 'idle', createdAt: new Date(), updatedAt: new Date(), root, metadata: {} },
    { maxIterations: 3, maxTokenBudget: 1_000_000, contextWindowSize: 200_000, timeout: 30_000, toolOutputSoftCap: 100, codemode });
}
const history = (w: AgentWorker, messages: AgentMessage[]) => { (w as unknown as { messages: AgentMessage[] }).messages = messages; };

test('codemode omits 250 ordinary schemas from API requests and context measurements', async () => {
  stageAgentPrompt('compact', { parts: [], role: 'general', model: 'm' });
  const w = worker('compact', false, true);
  for (let i = 0; i < 250; i++) w.registerTool({ name: `notes__read_${i}`, toolId: 'notes', description: 'Read notes. '.repeat(100), parameters: { type: 'object' }, execute: async () => null });
  w.registerTool({ name: 'spawn_child', description: 'Delegate work', parameters: { type: 'object' }, execute: async () => null });
  await w.addUserMessage('Read a note');
  const sections = getAgentComposition('compact')?.sections ?? [];
  expect(sections.some(s => s.label.startsWith('notes__'))).toBe(false);
  expect(sections.map(s => s.label)).toContain('codemode');
  expect(sections.map(s => s.label)).toContain('spawn_child');
  // Exercise the actual request assembly, including Anthropic's alternate
  // tool-search path, rather than only the inspector's schema estimate.
  const request = w as unknown as { requestTools(model: { provider: string; modelId: string }): { declarableTools: Array<{ function: { name: string } }>; deferredTools?: string[] } };
  for (const provider of ['ollama', 'anthropic', 'openai']) {
    const tools = request.requestTools({ provider, modelId: 'test' });
    expect(tools.declarableTools.map(t => t.function.name)).toEqual(['codemode', 'spawn_child']);
    expect(tools.deferredTools).toBeUndefined();
  }
});

test('a blocked codemode restores direct tools and read-only turns retain readers', async () => {
  const w = worker('fallback', false, true);
  w.registerTool({ name: 'filesystem__read_file', toolId: 'filesystem', permissionAction: 'read', description: 'Read file', parameters: {}, execute: async () => 'ok' });
  expect(w.getToolInventory().advertised.map(t => t.name)).not.toContain('filesystem__read_file');
  beginReadOnlyTurn('session');
  try { expect(w.getToolInventory().advertised.map(t => t.name)).toContain('filesystem__read_file'); }
  finally { endReadOnlyTurn('session'); }
  const executor = (w as unknown as { toolExecutor: { handleToolCalls(calls: Array<{ id: string; name: string; arguments: { code: string } }>): Promise<unknown> } }).toolExecutor;
  for (let i = 0; i < 3; i++) await executor.handleToolCalls([{ id: `failure-${i}`, name: 'codemode', arguments: { code: 'throw new Error("bad script")' } }]);
  const names = w.getToolInventory().advertised.map(t => t.name);
  expect(names).not.toContain('codemode');
  expect(names).toContain('filesystem__read_file');
});

test('root session context counter uses compact worker declarations', async () => {
  stageRootPrompt('session', { parts: [], role: 'general', model: 'm' });
  bindStagedRootPrompt('session', 'compact-root');
  const w = worker('compact-root', true, true);
  w.registerTool({ name: 'notes__read', toolId: 'notes', description: 'hidden '.repeat(30000), parameters: {}, execute: async () => null });
  await w.addUserMessage('Read notes');
  expect(getContextFill('session')?.promptTokens).toBe(getLatestComposition('session')?.composition.totals.tokens);
  expect(getContextFill('session')!.promptTokens).toBeLessThan(3000);
});

test('the root turn stores its composition with the user message and keeps the text in memory', async () => {
  stageRootPrompt('session', { parts: [promptPart('static', 'role', 'general role prompt', 'You are Octipus. '.repeat(20))], role: 'general', model: 'm', contextWindow: 200_000 });
  bindStagedRootPrompt('session', 'root-1', { add: [promptPart('static', 'skills', 'Selected skills', 'SKILL BODY')] });
  const w = worker('root-1', true);
  w.registerTool({ name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, execute: async () => ({ success: true, output: '' }) } as never);
  history(w, [
    { role: 'system', content: 'You are Octipus. '.repeat(20), timestamp: new Date() },
    { role: 'user', content: 'Earlier question', timestamp: new Date() },
    { role: 'assistant', content: 'Earlier answer', timestamp: new Date() },
  ]);

  await w.addUserMessage('Which store?');

  const stored = fixture.rows[0].metadata?.promptComposition;
  expect(stored?.sections.map((s) => s.label)).toEqual(['general role prompt', 'read_file', 'Selected skills', 'Assistant messages and tool calls', 'Earlier user messages', 'Your new message']);
  expect(JSON.stringify(stored)).not.toContain('SKILL BODY');
  const latest = getLatestComposition('session');
  expect(latest).toMatchObject({ agentId: 'root-1', messageId: 'message-0' });
  expect(latest?.composition.sections.find((s) => s.label === 'Selected skills')?.text).toBe('SKILL BODY');
});

test('measured once: a second user message in the same run carries no composition', async () => {
  stageRootPrompt('session', { parts: [promptPart('static', 'role', 'r', 'role')], role: 'general', model: 'm' });
  bindStagedRootPrompt('session', 'root-2');
  const w = worker('root-2', true);
  await w.addUserMessage('first');
  await w.addUserMessage('second');
  expect(fixture.rows.map((r) => !!r.metadata?.promptComposition)).toEqual([true, false]);
});

test('a worker is measured with its brief and no history; its sizes go on its agent row, not a message', async () => {
  stageAgentPrompt('child-1', { parts: [promptPart('static', 'role', 'research role prompt', 'You research.')], role: 'research', model: 'm' });
  const w = worker('child-1', false);
  history(w, [{ role: 'system', content: 'You research.', timestamp: new Date() }]);
  await w.addUserMessage('YOUR TASK: compare two stores');
  expect(fixture.rows).toHaveLength(0);
  expect(getLatestComposition('session')).toBeUndefined();
  const [[id, patch]] = fixture.agentMeta;
  expect(id).toBe('child-1');
  const stored = patch.promptComposition as { sections: Array<{ label: string; text?: string }> };
  expect(stored.sections.map((s) => s.label)).toEqual(['research role prompt', 'Brief']);
  expect(stored.sections.some((s) => 'text' in s)).toBe(false);
  expect(getAgentComposition('child-1')?.sections.find((s) => s.label === 'Brief')?.text).toBe('YOUR TASK: compare two stores');
});
