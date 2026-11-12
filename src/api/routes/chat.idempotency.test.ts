/**
 * POST /chat with `Idempotency-Key` (docs/plans/orchestration-gaps-2026-11.md §2):
 * a retry of a turn still running joins it instead of appending the message
 * again and starting a second turn; a retry after it finished replays the
 * answer; the key reused for another message is refused; a failed turn frees
 * the key.
 */
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import { closeStorage, initializeStorage } from '@/db/storage';
import { principalFromUser } from '@/security/principal';
const f = vi.hoisted(() => ({ handle: vi.fn(), release: () => {}, created: [] as unknown[] }));
vi.mock('@/core/agent', () => ({ getAgentService: () => ({ handleMessage: f.handle }) }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ stopSession: vi.fn() }) }));
vi.mock('@/db/repositories/scoped', () => ({ scopedRepos: () => ({ sessions: {
  findById: async () => ({ id: 'existing' }),
  create: async (row: unknown) => { f.created.push(row); return { id: `new-session-${f.created.length}` }; },
} }) }));
vi.mock('@/security/devmode', () => ({ devModeAllowed: () => true, checkProjectPath: () => ({ allowed: true }) }));
import { chatRoutes } from './chat';

beforeAll(() => { initializeStorage({ mode: 'embedded' }); });
afterAll(async () => { await closeStorage(); });

const user = { id: 'user', username: 'test', isAdmin: false };
const app = new Elysia().derive(() => ({ user, principal: principalFromUser(user) })).use(chatRoutes);
const post = (body: object, key?: string) => app.handle(new Request('http://test/chat/', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
  body: JSON.stringify(body),
}));

test('a retried chat call joins the running turn and replays its answer', async () => {
  f.handle.mockImplementation((sessionId: string) => new Promise(resolve => {
    f.release = () => resolve({ response: 'the answer', sessionId, agentId: 'agent' });
  }));
  const first = post({ message: 'build it', channel: 'mcp' }, 'retry-1');
  await vi.waitFor(() => expect(f.handle).toHaveBeenCalledTimes(1));
  const retry = post({ message: 'build it', channel: 'mcp' }, 'retry-1');
  await new Promise(r => setTimeout(r, 30));
  f.release();
  const [a, b] = await Promise.all([first, retry]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(b.headers.get('idempotent-replayed')).toBe('true');
  expect(await b.json()).toEqual(await a.json());
  // One session, one turn.
  expect(f.created).toHaveLength(1);
  expect(f.handle).toHaveBeenCalledTimes(1);

  const later = await post({ message: 'build it', channel: 'mcp' }, 'retry-1');
  expect(later.headers.get('idempotent-replayed')).toBe('true');
  expect((await later.json()).response).toBe('the answer');
  expect(f.handle).toHaveBeenCalledTimes(1);
});

test('the same key for another message is refused; no key runs every time', async () => {
  f.handle.mockReset();
  f.handle.mockImplementation(async (sessionId: string) => ({ response: 'ok', sessionId }));
  expect((await post({ message: 'one', sessionId: 'existing' }, 'retry-2')).status).toBe(200);
  const reused = await post({ message: 'two', sessionId: 'existing' }, 'retry-2');
  expect(reused.status).toBe(422);
  expect((await reused.json()).code).toBe('idempotency_key_reused');
  await post({ message: 'one', sessionId: 'existing' });
  await post({ message: 'one', sessionId: 'existing' });
  expect(f.handle).toHaveBeenCalledTimes(3);
});

test('a long answer is kept cut for a replay, pointing at its session', async () => {
  f.handle.mockReset();
  f.handle.mockImplementation(async (sessionId: string) => ({ response: 'x'.repeat(20_000), sessionId }));
  expect((await (await post({ message: 'essay', sessionId: 'existing' }, 'retry-long')).json()).response).toHaveLength(20_000);
  const replay = await (await post({ message: 'essay', sessionId: 'existing' }, 'retry-long')).json();
  expect(replay.truncated).toBe(true);
  expect(replay.response).toContain('full text is in session existing');
  expect(f.handle).toHaveBeenCalledOnce();
});

test('a failed turn frees the key, so the retry runs', async () => {
  f.handle.mockReset();
  f.handle.mockRejectedValueOnce(new Error('model down'));
  f.handle.mockImplementation(async (sessionId: string) => ({ response: 'recovered', sessionId }));
  expect((await (await post({ message: 'hi', sessionId: 'existing' }, 'retry-3')).json()).error).toBe('Failed to process message');
  expect((await (await post({ message: 'hi', sessionId: 'existing' }, 'retry-3')).json()).response).toBe('recovered');
  expect(f.handle).toHaveBeenCalledTimes(2);
});
