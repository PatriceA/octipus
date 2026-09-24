import { beforeEach, expect, test, vi } from 'vitest';
import { BrowserExtTool } from './index';
import type { AgentContext } from '@/core/types';
const mocks = vi.hoisted(() => ({ check: vi.fn(), send: vi.fn(), recovery: vi.fn() }));
vi.mock('@/api/browser-bridge', () => ({ getBrowserBridge: () => ({ sendCommand: mocks.send }) }));
vi.mock('@/security/permissions', () => ({ getPermissionManager: () => ({ check: mocks.check }) }));
vi.mock('@/db/repositories/audit-repository', () => ({ auditRepository: { log: async () => {} } }));
vi.mock('@/core/action-recovery', () => ({ actionRecovery: { run: mocks.recovery }, isReadOnlyAction: (a: string) => a === 'read' }));
const context: AgentContext = { id: 'probe', userId: 'user', sessionId: 'session', role: 'general', root: false, attended: false, model: '', topic: '', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: {} };
const args = { tabId: 42, url: 'https://ci.example/123', selector: '#status' };
let tool: BrowserExtTool;
beforeEach(async () => {
  mocks.check.mockReset().mockResolvedValue({ level: 'ALLOW' });
  mocks.send.mockReset(); mocks.recovery.mockReset();
  tool = new BrowserExtTool(); await tool.initialize();
});
test('disconnect does not leave a mutation record that blocks later observations', async () => {
  mocks.send.mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValueOnce({ text: 'Succeeded' });
  const observe = tool.getTool('observe')!;
  await expect(observe.execute(args, context)).rejects.toThrow('Disconnected');
  await expect(observe.execute(args, context)).resolves.toEqual({ text: 'Succeeded' });
  expect(mocks.check.mock.calls[0].slice(0, 3)).toEqual(['user', 'browser-ext', 'extract']);
  expect(mocks.recovery).not.toHaveBeenCalled();
});
test.each(['DENY', 'ASK'])('existing %s extract policy prevents unattended observation', async level => {
  mocks.check.mockResolvedValue({ level });
  await expect(tool.getTool('observe')!.execute(args, context)).rejects.toThrow();
  expect(mocks.send).not.toHaveBeenCalled();
});
