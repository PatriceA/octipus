import { beforeEach, expect, test, vi } from 'vitest';
import { AgentService, type TurnResult } from './service';
const fixture = vi.hoisted(() => ({ command: vi.fn(), userId: 'user' }));
vi.mock('@/core/commands', () => ({ handleCommand: fixture.command }));
vi.mock('./session-resolver', () => ({ resolveSession: async (id: string) => id }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async (id: string) => ({ id, userId: fixture.userId, context: {} }) } }));
beforeEach(() => { fixture.userId = 'user'; fixture.command.mockReset().mockResolvedValue('Control handled'); });

test.each(['/stop', '/clear', '/status', '/cancel'])('%s bypasses a running turn, but another normal turn stays queued', async command => {
  const service = new AgentService();
  let release!: () => void;
  const inner = vi.spyOn(service as unknown as { handleMessageInner: () => Promise<TurnResult> }, 'handleMessageInner')
    .mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ response: 'done', classification: { type: 'casual', confidence: 1 } }); }))
    .mockResolvedValue({ response: 'next', classification: { type: 'casual', confidence: 1 } });
  const running = service.handleMessage('session', 'user', 'long task');
  await vi.waitFor(() => expect(inner).toHaveBeenCalledTimes(1));
  const waiting = service.handleMessage('session', 'user', 'next task');
  const control = await service.handleMessage('session', 'user', command, 'webchat');
  expect(control.response).toBe('Control handled');
  expect(fixture.command).toHaveBeenCalledWith(command, 'session', 'user');
  expect(inner).toHaveBeenCalledTimes(1);
  release(); await running; await waiting;
  expect(inner).toHaveBeenCalledTimes(2);
});
test('control bypass still checks session ownership', async () => {
  fixture.userId = 'other';
  await expect(new AgentService().handleMessage('session', 'user', '/stop')).rejects.toThrow('Session not found');
  expect(fixture.command).not.toHaveBeenCalled();
});
test('background continuation cannot use the interactive control bypass', async () => {
  const service = new AgentService();
  const inner = vi.spyOn(service as unknown as { handleMessageInner: () => Promise<TurnResult> }, 'handleMessageInner')
    .mockResolvedValue({ response: 'done', classification: { type: 'casual', confidence: 1 } });
  const before = vi.fn();
  await service.handleMessage('session', 'user', '/stop', 'monitor', [], undefined, before);
  expect(before).toHaveBeenCalled(); expect(inner).toHaveBeenCalled();
  expect(fixture.command).not.toHaveBeenCalled();
});
