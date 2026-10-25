import { beforeEach, expect, test, vi } from 'vitest';
import { createActionRecoveryTools } from './recovery-tools';
const state = vi.hoisted(() => ({ pending: vi.fn(), acknowledge: vi.fn(), active: vi.fn() }));
vi.mock('@/db/repositories/tool-action-repository', () => ({ toolActionRepository: { pending: state.pending, acknowledge: state.acknowledge } }));
vi.mock('@/core/action-recovery', () => ({ actionRecovery: { isActive: state.active } }));
const tool = createActionRecoveryTools().find(tool => tool.name === 'resolve_tool_action')!;
const context = { id: 'root', userId: 'owner', sessionId: 'session' } as Parameters<typeof tool.execute>[1];
beforeEach(() => { vi.resetAllMocks(); state.pending.mockResolvedValue([{ id: 'record' }]); });
test('inspection can acknowledge a scoped uncertain record without fabricating a user approval (#43)', async () => {
  expect(await tool.execute({ id: 'record', outcome: 'effect_confirmed', evidence: 'Read the resulting commit and checked the recorded tree hash.' }, context)).toMatchObject({ resolved: true });
  expect(state.acknowledge).toHaveBeenCalledWith('owner', 'session', ['record'], expect.stringContaining('inspection'));
});
test('requires concrete evidence and refuses active or foreign actions', async () => {
  await expect(tool.execute({ id: 'record', outcome: 'effect_confirmed', evidence: 'guess' }, context)).rejects.toThrow('evidence');
  state.active.mockReturnValue(true);
  await expect(tool.execute({ id: 'record', outcome: 'effect_confirmed', evidence: 'Read the resulting commit and checked its hash.' }, context)).rejects.toThrow('still executing');
  state.pending.mockResolvedValue([]);
  await expect(tool.execute({ id: 'foreign', outcome: 'no_effect_confirmed', evidence: 'Read the resulting commit and checked its hash.' }, context)).rejects.toThrow('not found');
});
