import { beforeEach, expect, test, vi } from 'vitest';
import type { GatewayHub } from './hub';
import type { ClientMessage, ConnectionContext } from './protocol';
const mock = vi.hoisted(() => ({ handle: vi.fn(async (..._args: unknown[]) => ({ response: 'image received' })), store: vi.fn(async (..._args: unknown[]) => [{ path: '.octipus/attachments/id/paste.png' }]) }));
const sid = 'aaaaaaaa-0000-4000-8000-000000000000';
vi.mock('@/core/agent', () => ({ getAgentService: () => ({ handleMessage: mock.handle }) }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async () => ({ id: 'aaaaaaaa-0000-4000-8000-000000000000', userId: 'user' }) } }));
vi.mock('@/core/agent/session-resolver', () => ({ resolveSession: async () => 'aaaaaaaa-0000-4000-8000-000000000000', turnWorkspaceId: async () => 'workspace' }));
vi.mock('@/core/chat-uploads', async importOriginal => ({ ...await importOriginal<typeof import('@/core/chat-uploads')>(), storeChatUploads: mock.store }));
vi.mock('@/security/workspace-fs', () => ({ WorkspaceFS: { forSession: () => ({ root: '/session' }) } }));
vi.mock('@/models/cost-tracker', () => ({ getCostTracker: () => ({ getSessionStats: async () => ({}) }) }));
import { wireMessageHandler } from './message-handler';
beforeEach(() => { vi.clearAllMocks(); });
test('gateway decodes image bytes and forwards persisted refs to the general agent', async () => {
  let handler!: (id: string, context: ConnectionContext, message: ClientMessage) => Promise<void>;
  const send = vi.fn();
  wireMessageHandler({ setMessageHandler: (fn: typeof handler) => { handler = fn; }, publishEvent: vi.fn(), connectionManager: { sendToConnection: send } } as unknown as GatewayHub);
  await handler('connection', { userId: 'user', trustLevel: 'user', clientType: 'tui' } as ConnectionContext,
    { type: 'chat.send', sessionId: sid, content: 'Describe [image1]', attachments: [{ name: 'paste.png', mimeType: 'image/png', data: 'aW1hZ2U=' }] });
  expect(mock.store).toHaveBeenCalledTimes(1);
  const files = mock.store.mock.calls[0][1] as File[];
  expect(Buffer.from(await files[0].arrayBuffer()).toString()).toBe('image');
  expect(mock.handle).toHaveBeenCalledWith(sid, 'user', expect.stringContaining('Describe [image1]'), 'tui', [{ path: '.octipus/attachments/id/paste.png' }], undefined);
  expect(mock.handle.mock.calls[0][2]).toContain('Attached file: .octipus/attachments/id/paste.png');
  expect(send).not.toHaveBeenCalled();
});
