import { beforeEach, expect, test, vi } from 'vitest';
import type { Message } from '@/db/schema/messages';
import type { SessionContext } from '@/db/schema/sessions';
const fixture = vi.hoisted(() => ({ rows: [] as Message[], context: {} as SessionContext, requests: [] as any[], clearDuringCall: false }));
vi.mock('@/skills/selection', () => ({ buildSelectedSkillPrompt: async () => '\n\nFULL SELECTED SKILL' }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: {
  findById: async () => ({ id: 's', userId: 'u', context: fixture.context, metadata: { showSources: false } }),
  incrementMessageCount: async () => {},
} }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: {
  findContextMessages: async (_id: string, since?: string, after?: { id: string }) => fixture.rows.filter((row, i) =>
    (!since || row.createdAt >= new Date(since)) && (!after || i > fixture.rows.findIndex(r => r.id === after.id))),
  createForGeneration: async (data: any, generation: string) => {
    if ((fixture.context.clearedAt ?? '') !== generation) return null;
    const row = { ...data, id: `m${fixture.rows.length}`, createdAt: new Date() }; fixture.rows.push(row); return row;
  },
} }));
vi.mock('@/models/litellm-client', () => ({ getLiteLLMClient: () => ({ complete: async (options: any) => {
  fixture.requests.push(structuredClone(options));
  if (fixture.clearDuringCall) fixture.context = { clearedAt: '2030-01-01T00:00:00Z' };
  return { content: 'answer', usage: { totalTokens: 2 } };
} }) }));
vi.mock('@/models/model-registry', () => ({ getModelRegistry: () => ({ getModelByModelId: async () => ({ name: 'model', defaultMaxTokens: 1024 }) }) }));
vi.mock('@/core/response-cache', () => ({ getResponseCache: () => ({ get: async () => null, set: async () => {} }) }));
vi.mock('@/core/personas/resolver', () => ({ resolvePersonaForUser: async () => ({ promptBlock: 'Stable persona.' }) }));
vi.mock('@/db/repositories/profile-repository', () => ({ ProfileRepository: class { async findUserProfile() { return null; } } }));
import { directResponse } from './direct-response';
const selector = { selectByComplexity: async () => 'model' } as any;
beforeEach(() => { fixture.rows = []; fixture.context = {}; fixture.requests = []; fixture.clearDuringCall = false; });
test('casual turns retain the full checkpoint suffix and append immutable live context', async () => {
  fixture.rows = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `prior ${i}`, createdAt: new Date(0) } as Message));
  fixture.context.checkpoint = { generation: '', through: { id: 'm1', createdAt: new Date(0).toISOString() },
    summary: 'CHECKPOINT', fileOps: { read: [], written: [], edited: [] } };
  await directResponse('first', 's', 'u', selector);
  await directResponse('second', 's', 'u', selector);
  const [first, second] = fixture.requests;
  expect(first.messages[0].content).toContain('FULL SELECTED SKILL');
  expect(first.messages[0].content).not.toContain('CURRENT DATE');
  expect(first.messages[1].content).toContain('CHECKPOINT');
  expect(first.messages.some((m: any) => m.content === 'prior 2')).toBe(true);
  expect(first.messages.some((m: any) => m.content === 'prior 0')).toBe(false);
  expect(first.messages.at(-1).content).toContain('CURRENT DATE');
  expect(second.messages.slice(0, first.messages.length).map((m: any) => [m.role, m.content])).toEqual(first.messages.map((m: any) => [m.role, m.content]));
  expect(fixture.rows.find(r => r.content === 'first')?.metadata?.promptContext).toContain('CURRENT DATE');
});
test('a clear during casual inference prevents an old assistant answer being persisted', async () => {
  fixture.clearDuringCall = true;
  const result = await directResponse('question', 's', 'u', selector);
  expect(result.response).toContain('cleared');
  expect(fixture.rows.some(r => r.role === 'assistant')).toBe(false);
});
