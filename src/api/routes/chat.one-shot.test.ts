import { expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import { principalFromUser } from '@/security/principal';
const f = vi.hoisted(() => ({ stop: vi.fn(), release: () => {}, created: [] as unknown[] }));
vi.mock('@/core/agent', () => ({ getAgentService: () => ({ handleMessage: () => new Promise(resolve => {
  f.release = () => resolve({ response: 'done', sessionId: 'new-session', agentId: 'agent' });
}) }) }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ stopSession: f.stop }) }));
vi.mock('@/db/repositories/scoped', () => ({ scopedRepos: () => ({ sessions: {
  findById: async () => ({ id: 'existing' }),
  create: async (row: unknown) => { f.created.push(row); return { id: 'new-session' }; },
} }) }));
vi.mock('@/security/devmode', () => ({ devModeAllowed: () => true, checkProjectPath: () => ({ allowed: true }) }));
import { chatRoutes } from './chat';

const user = { id: 'user', username: 'test', isAdmin: false };
const app = new Elysia().derive(() => ({ user, principal: principalFromUser(user) })).use(chatRoutes);
const post = (body: object, signal: AbortSignal) => app.handle(new Request('http://test/chat/', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
}));

test('a one-shot caller that hangs up stops its run; the session is marked one-shot', async () => {
  f.stop.mockReset();
  const ac = new AbortController();
  const pending = post({ message: 'build it', channel: 'api', oneShot: true }, ac.signal).catch(() => null);
  await vi.waitFor(() => expect(f.created).toHaveLength(1));
  expect(f.created[0]).toMatchObject({ context: { oneShot: true } });
  ac.abort();
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledWith('new-session', 'user'));
  f.release(); await pending;
});

test('an interactive caller that drops keeps its run', async () => {
  f.stop.mockReset();
  const ac = new AbortController();
  const pending = post({ message: 'hello', sessionId: 'existing' }, ac.signal).catch(() => null);
  await new Promise(r => setTimeout(r, 20));
  ac.abort();
  await new Promise(r => setTimeout(r, 20));
  expect(f.stop).not.toHaveBeenCalled();
  f.release(); await pending;
});
