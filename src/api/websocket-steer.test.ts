import { beforeEach, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import type { WebSocketHandlers } from '@/api/http/app';

const state = vi.hoisted(() => ({
  steer: vi.fn(),
  handleMessage: vi.fn(),
  owner: 'alice' as string | null,
}));
vi.mock('@/security/auth/session', () => ({ getSessionManager: () => ({ validate: async (token: string) => ({ userId: token }) }) }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ onRequest: () => () => {} }) }));
vi.mock('@/channels/webchat', () => ({ webChatChannel: { registerConnection: () => 'conn1', unregisterConnection: () => {} } }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ onEvent: () => () => {} }) }));
vi.mock('@/core/agent', () => ({ getAgentService: () => ({ onEvent: () => () => {}, handleMessage: state.handleMessage }) }));
vi.mock('@/core/documents/queue', () => ({ getDocumentQueue: () => ({ on: () => {}, off: () => {} }) }));
vi.mock('@/core/gateway/message-handler', () => ({ trySteerRunningRootAgent: state.steer }));
vi.mock('@/db/repositories/session-repository', () => ({
  sessionRepository: { findById: async () => (state.owner ? { userId: state.owner } : null) },
}));
vi.mock('./browser-bridge', () => ({ getBrowserBridge: () => ({}) }));
vi.mock('./voice-media-ws', () => ({ setupVoiceMediaWebSocket: () => {} }));
vi.mock('./voice-ws', () => ({ setupVoiceWebSocket: () => {} }));
import { setupWebSocket } from './websocket';

beforeEach(() => {
  state.steer.mockReset().mockResolvedValue(true);
  state.handleMessage.mockReset().mockResolvedValue({ response: 'done', sessionId: 's1' });
  state.owner = 'alice';
});

async function send(frame: Record<string, unknown>) {
  const app = new Elysia(); setupWebSocket(app);
  const handlers = app.websocketRoutes().find(route => route.path === '/ws')!.handlers;
  const messages: Array<Record<string, unknown>> = [];
  const ws = { data: { request: new Request('http://localhost/ws?token=alice') },
    send: (f: string) => messages.push(JSON.parse(f)), close: vi.fn() } as unknown as Parameters<NonNullable<WebSocketHandlers['open']>>[0];
  await handlers.open!(ws);
  await handlers.message!(ws, JSON.stringify(frame));
  return messages.slice(1);
}

test('a chat message during a running turn steers it instead of queueing a second turn', async () => {
  expect(await send({ type: 'chat', content: 'change direction', sessionId: 's1' }))
    .toEqual([{ type: 'steer_result', sessionId: 's1', steered: true }]);
  expect(state.steer).toHaveBeenCalledWith('s1', 'change direction');
  expect(state.handleMessage).not.toHaveBeenCalled();
});

test('no running turn: the message starts a normal turn', async () => {
  state.steer.mockResolvedValue(false);
  expect((await send({ type: 'chat', content: 'hi', sessionId: 's1' }))[0]).toMatchObject({ type: 'chat_response', response: 'done' });
  expect(state.handleMessage).toHaveBeenCalledOnce();
});

test("another user's session is never steered", async () => {
  state.owner = 'bob';
  await send({ type: 'chat', content: 'hi', sessionId: 's1' });
  expect(state.steer).not.toHaveBeenCalled();
});

test('attachments need a real turn, so they are not steered', async () => {
  await send({ type: 'chat', content: 'hi', sessionId: 's1', fileRefs: [{ path: 'a.md' }] });
  expect(state.steer).not.toHaveBeenCalled();
  expect(state.handleMessage).toHaveBeenCalledOnce();
});
