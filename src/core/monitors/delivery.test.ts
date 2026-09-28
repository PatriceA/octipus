import { beforeEach, expect, test, vi } from 'vitest';
import { deliverMonitorResponse } from './delivery';
import { turnEventMessage } from '@/api/turn-event-message';
import { turnEventToGateway } from '@/core/gateway/event-bridge';
import type { Monitor } from '@/db/schema/monitors';
import type { TurnEvent, TurnResult } from '@/core/agent/service';
const fixture = vi.hoisted(() => ({ session: vi.fn(), publish: vi.fn(), send: vi.fn(), resolve: vi.fn() }));
vi.mock('@/channels/ownership', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/channels/ownership')>()),
  loadNotifyScope: async (userId: string) => ({ userId }),
  resolveTarget: fixture.resolve,
}));
const allowed = (_scope: unknown, type: string, id: string) => ({
  allowed: true, target: `${type}:${id}`, send: (res: unknown) => fixture.send(type, id, res),
});
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: fixture.session } }));
vi.mock('@/core/agent/service', () => ({ getAgentService: () => ({ publishResponse: fixture.publish }) }));
vi.mock('@/channels/interface', () => ({ getUMI: () => ({ send: fixture.send }) }));
const row = { id: 'monitor', sessionId: 'session', userId: 'owner', generation: '' } as Monitor;
const result: TurnResult = { response: 'Pipeline succeeded. Results collected.', sessionId: 'session', agentId: 'agent', outcome: 'success', classification: { type: 'casual', confidence: 1 } };
beforeEach(() => {
  fixture.session.mockReset().mockResolvedValue({ userId: 'owner', context: {}, channelType: 'webchat' });
  fixture.publish.mockReset(); fixture.send.mockReset().mockResolvedValue('sent');
  fixture.resolve.mockReset().mockImplementation(async (...a: [unknown, string, string]) => allowed(...a));
});
test('a session whose chat the owner may not notify gets no channel reply', async () => {
  fixture.session.mockResolvedValue({ userId: 'owner', context: {}, channelType: 'telegram', channelId: 'someone-else' });
  fixture.resolve.mockResolvedValue({ allowed: false, target: 'telegram:someone-else', reason: 'not_allowed', error: 'telegram:someone-else is not linked to you and not an approved shared destination; …' });
  await expect(deliverMonitorResponse(row, result)).rejects.toThrow('not an approved shared destination');
  expect(fixture.resolve).toHaveBeenCalledWith({ userId: 'owner' }, 'telegram', 'someone-else');
  expect(fixture.publish).toHaveBeenCalled(); // the in-app reply still lands
  expect(fixture.send).not.toHaveBeenCalled();
});
test('an unresolvable Teams conversation is reported as such, not as "not linked"', async () => {
  fixture.session.mockResolvedValue({ userId: 'owner', context: {}, channelType: 'teams', channelId: 'a:conv' });
  fixture.resolve.mockResolvedValue({ allowed: false, target: 'teams:a:conv', reason: 'unresolved', error: 'teams:a:conv: the Teams conversation cannot be resolved yet; the user must message the bot in Teams once' });
  await expect(deliverMonitorResponse(row, result)).rejects.toThrow('must message the bot');
  expect(fixture.send).not.toHaveBeenCalled();
});
test('background reply reaches both legacy webchat and gateway wire formats', async () => {
  await deliverMonitorResponse(row, result);
  expect(fixture.publish).toHaveBeenCalledWith('session', 'owner', result);
  const event: TurnEvent = { type: 'chat_response', sessionId: 'session', userId: 'owner', data: result, timestamp: new Date() };
  expect(turnEventMessage(event)).toMatchObject({ type: 'chat_response', response: result.response, sessionId: 'session' });
  expect(turnEventToGateway(event)).toMatchObject({ type: 'chat.response', userId: 'owner', sessionId: 'session', payload: { response: result } });
  expect(fixture.send).not.toHaveBeenCalled();
});
test.each(['telegram', 'slack', 'teams', 'whatsapp'])('reply goes back to its original %s conversation and thread', async channelType => {
  fixture.session.mockResolvedValue({ userId: 'owner', context: {}, channelType, channelId: 'chat', threadId: 'thread' });
  await deliverMonitorResponse(row, result);
  expect(fixture.send).toHaveBeenCalledWith(channelType, 'chat', expect.objectContaining({ content: result.response, threadId: 'thread' }));
});
test('cleared sessions do not receive a stale monitor reply', async () => {
  fixture.session.mockResolvedValue({ userId: 'owner', context: { conversationGeneration: 'new' }, channelType: 'telegram' });
  await deliverMonitorResponse(row, result);
  expect(fixture.publish).not.toHaveBeenCalled(); expect(fixture.send).not.toHaveBeenCalled();
});
test('channel delivery errors propagate so the monitor can surface needs-review', async () => {
  fixture.session.mockResolvedValue({ userId: 'owner', context: {}, channelType: 'telegram', channelId: 'chat' });
  fixture.send.mockRejectedValue(new Error('Channel disconnected'));
  await expect(deliverMonitorResponse(row, result)).rejects.toThrow('Channel disconnected');
});
