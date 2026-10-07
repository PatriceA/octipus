import { expect, it, vi } from 'vitest';
import { createSteerChildTool } from './steer-tool';
import type { AgentWorker } from '@/core/agent-worker';
const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => state }));

it('only forwards guidance when the parent explicitly selects its own running child', async () => {
  const steer = vi.fn();
  const child = { getContext: () => ({ userId: 'u', sessionId: 's' }), getStatus: () => 'running', steer };
  state.get.mockReturnValue(child);
  const parent = { listPendingDetached: () => [{ childId: 'owned' }], getContext: () => ({ userId: 'u', sessionId: 's' }) } as unknown as AgentWorker;
  const tool = createSteerChildTool({ current: parent });
  const invoke = (args: Record<string, unknown>) => tool.execute(args, {} as never);
  expect(await invoke({ childId: 'unrelated', message: 'change' })).toContain('not pending under you');
  expect(steer).not.toHaveBeenCalled();
  expect(await invoke({ childId: 'owned', message: 'adjust your scope' })).toContain('Guidance queued');
  expect(steer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ role: 'user', content: 'adjust your scope' }));
  steer.mockClear();
  state.get.mockReturnValue({ ...child, getStatus: () => 'completed' });
  expect(await invoke({ childId: 'owned', message: 'change' })).toContain('follow-up');
  expect(steer).not.toHaveBeenCalled();
  state.get.mockReturnValue({ ...child, getContext: () => ({ userId: 'other', sessionId: 's' }) });
  expect(await invoke({ childId: 'owned', message: 'change' })).toContain('unavailable');
  expect(steer).not.toHaveBeenCalled();
});
