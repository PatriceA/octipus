/**
 * The worker end of the Context inspector: the root's user message carries
 * the request's sizes by category, measured with the history the worker
 * loaded and the tools it advertises; workers and unstaged agents carry none.
 */
import { beforeEach, expect, test, vi } from 'vitest';
import type { Message } from '@/db/schema/messages';
import type { AgentMessage } from './types';

const fixture = vi.hoisted(() => ({ rows: [] as Message[] }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { incrementMessageCount: async () => {} } }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: {
  create: async (data: object) => {
    const row = { ...data, id: `message-${fixture.rows.length}`, createdAt: new Date() } as Message;
    fixture.rows.push(row);
    return row;
  },
} }));

import { AgentWorker } from './agent-worker';
import { _resetPromptCompositionForTesting, bindStagedRootPrompt, getLatestComposition, promptPart, stageRootPrompt } from './agent/prompt-composition';

beforeEach(() => { fixture.rows = []; _resetPromptCompositionForTesting(); });

function worker(id: string, root: boolean) {
  return new AgentWorker({ space: null, trigger: 'user', funding: 'own', id, sessionId: 'session', userId: 'user', model: 'm', role: 'general', topic: 'test',
    status: 'idle', createdAt: new Date(), updatedAt: new Date(), root, metadata: {} },
    { maxIterations: 3, maxTokenBudget: 1_000_000, contextWindowSize: 200_000, timeout: 30_000, toolOutputSoftCap: 100 });
}
const history = (w: AgentWorker, messages: AgentMessage[]) => { (w as unknown as { messages: AgentMessage[] }).messages = messages; };

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

test('a worker is never measured, even with a staged prompt under its id', async () => {
  stageRootPrompt('session', { parts: [promptPart('static', 'role', 'r', 'role')], role: 'general', model: 'm' });
  bindStagedRootPrompt('session', 'child-1');
  await worker('child-1', false).addUserMessage('task');
  expect(fixture.rows).toHaveLength(0);
  expect(getLatestComposition('session')).toBeUndefined();
});
