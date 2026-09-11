import { expect, test, vi } from 'vitest';
import { workPlanRepository } from '@/db/repositories/work-plan-repository';
import { CommandRegistry, registerBuiltinCommands } from './commands';

const ADMIN = '11111111-2222-4333-8444-555555555555';
vi.mock('./resolve-user', () => ({ resolveUserId: async (id: string) => (id === 'local' ? ADMIN : id) }));

/**
 * The TUI polls `/work-plan-status` from its first connected second, and a
 * local console's principal is the literal 'local'. Handed to the uuid
 * `user_id` column that was a Postgres cast error on the status line.
 */
test('work-plan commands resolve the local principal before touching the plan row', async () => {
  const read = vi.spyOn(workPlanRepository, 'read').mockResolvedValue({ current: null, revision: 0, feedback: [] } as never);
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const result = await registry.execute('/work-plan-status', { userId: 'local', sessionId: 'sess-1', clientType: 'tui', trustLevel: 'local' });
  expect(result!.text).toBe('');
  expect(read).toHaveBeenCalledWith('sess-1', ADMIN);
  read.mockRestore();
});
