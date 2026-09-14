import { beforeEach, expect, test, vi } from 'vitest';
import { Elysia } from '@/api/http';
import type { WebSocketHandlers } from '@/api/http/app';
import type { PermissionRequestEvent, PermissionResolvedEvent } from '@/security/permissions';

const state = vi.hoisted(() => ({
  requests: new Set<(event: PermissionRequestEvent) => void>(),
  resolved: new Set<(event: PermissionResolvedEvent) => void>(),
  snapshot: vi.fn(),
}));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({
  onRequest: (fn: (event: PermissionRequestEvent) => void) => { state.requests.add(fn); return () => state.requests.delete(fn); },
  onResolved: (fn: (event: PermissionResolvedEvent) => void) => { state.resolved.add(fn); return () => state.resolved.delete(fn); },
  getPendingRequests: state.snapshot,
}) }));
vi.mock('@/security/auth/session', () => ({ getSessionManager: () => ({ validate: async (token: string) => ({ userId: token }) }) }));
vi.mock('./browser-bridge', () => ({ getBrowserBridge: () => ({}) }));
vi.mock('./voice-media-ws', () => ({ setupVoiceMediaWebSocket: () => {} }));
vi.mock('./voice-ws', () => ({ setupVoiceWebSocket: () => {} }));
import { setupWebSocket } from './websocket';

beforeEach(() => { state.requests.clear(); state.resolved.clear(); state.snapshot.mockReset().mockResolvedValue([]); });
function fixture(userId: string) {
  const app = new Elysia(); setupWebSocket(app);
  const handlers = app.websocketRoutes().find(route => route.path === '/ws/permissions')!.handlers;
  const messages: Array<Record<string, unknown>> = [];
  const ws = { data: { request: new Request(`http://localhost/ws/permissions?token=${userId}`) },
    send: (frame: string) => messages.push(JSON.parse(frame)), close: vi.fn() } as unknown as Parameters<NonNullable<WebSocketHandlers['open']>>[0];
  return { handlers, ws, messages };
}

test('a decision from another channel updates every owner socket and no other user', async () => {
  const first = fixture('alice'); const second = fixture('alice'); const other = fixture('bob');
  await Promise.all([first, second, other].map(client => client.handlers.open!(client.ws)));
  const event: PermissionResolvedEvent = { requestId: 'req1', userId: 'alice', agentId: 'agent1', status: 'approved' };
  state.resolved.forEach(fn => fn(event));
  expect(first.messages.at(-1)).toMatchObject({ type: 'response_recorded', requestId: 'req1', status: 'approved' });
  expect(second.messages).toEqual(first.messages);
  expect(other.messages).toEqual([{ type: 'pending_requests', requests: [] }]);
  first.handlers.close!(first.ws, 1000, 'done');
  expect(state.resolved.size).toBe(2);
});

test('resolution during snapshot hydration follows the snapshot, so stale pending rows cannot win', async () => {
  let release!: (rows: unknown[]) => void;
  state.snapshot.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const client = fixture('alice'); const opening = client.handlers.open!(client.ws);
  await vi.waitFor(() => expect(state.snapshot).toHaveBeenCalled());
  state.resolved.forEach(fn => fn({ requestId: 'req1', userId: 'alice', agentId: 'agent1', status: 'expired' }));
  release([{ id: 'req1' }]); await opening;
  expect(client.messages.map(message => message.type)).toEqual(['pending_requests', 'response_recorded']);
});
