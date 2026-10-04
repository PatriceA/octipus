import { expect, test, vi } from 'vitest';
import { workPlanRepository } from '@/db/repositories/work-plan-repository';
import { CommandRegistry, registerBuiltinCommands } from './commands';

const USER = '11111111-2222-4333-8444-555555555555';

test('work-plan commands read the plan under the connection\'s own user id', async () => {
  const read = vi.spyOn(workPlanRepository, 'read').mockResolvedValue({ current: null, revision: 0, feedback: [] } as never);
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const result = await registry.execute('/work-plan-status', { userId: USER, sessionId: 'sess-1', clientType: 'tui', trustLevel: 'user' });
  expect(result!.text).toBe('');
  expect(read).toHaveBeenCalledWith('sess-1', USER);
  read.mockRestore();
});

test('before the first message there is no session row, which is "no plan", not an error', async () => {
  const read = vi.spyOn(workPlanRepository, 'read').mockRejectedValue(new Error('Session not found'));
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const ctx = { userId: USER, sessionId: 'fresh', clientType: 'tui', trustLevel: 'user' as const };
  expect((await registry.execute('/work-plan-status', ctx))!.text).toBe('');
  expect((await registry.execute('/work-plan', ctx))!.text).toContain('No plan yet');
  read.mockRestore();
});
