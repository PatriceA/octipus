import { expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import { principalFromUser } from '@/security/principal';
const fixture = vi.hoisted(() => ({
  result: { response: 'The answer.\n\n**Sources:** recent 2 msgs, profile(Patrice, 8 facts)', sessionId: 'session', agentId: 'agent', classification: { type: 'casual', confidence: 1 } },
}));
vi.mock('@/core/agent', () => ({ getAgentService: () => ({ handleMessage: async () => fixture.result }) }));
vi.mock('@/db/repositories/scoped', () => ({ scopedRepos: () => ({ sessions: { findById: async () => ({ id: 'session' }) } }) }));
vi.mock('@/security/devmode', () => ({ devModeAllowed: () => true, checkProjectPath: () => ({ allowed: true }) }));
import { chatRoutes } from './chat';

test.each(['mobile-voice', 'mobile', 'webchat'])('source filtering at the HTTP boundary: %s', async channel => {
  const user = { id: 'user', username: 'test', isAdmin: false };
  const app = new Elysia().derive(() => ({ user, principal: principalFromUser(user) })).use(chatRoutes);
  const response = await app.handle(new Request('http://test/chat/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Question', sessionId: 'session', channel }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.response).toBe(channel === 'mobile-voice' ? 'The answer.' : fixture.result.response);
  expect(body.agentId).toBe('agent');
  expect(fixture.result.response).toContain('**Sources:**'); // Never mutate the stored reply.
});
