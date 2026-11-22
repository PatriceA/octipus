import { beforeEach, expect, test, vi } from 'vitest';
import { emptyWorkPlan } from '@/shared/work-plan';

const calls = vi.hoisted(() => ({ order: [] as string[], save: vi.fn(), publish: vi.fn() }));
vi.mock('@/db/repositories/work-plan-repository', () => ({ workPlanRepository: { save: calls.save } }));
vi.mock('@/core/gateway/hub', () => ({ getGatewayHub: () => ({ publishEvent: calls.publish }) }));

import { saveWorkPlan } from './work-plan-store';

beforeEach(() => {
  calls.order = [];
  calls.save.mockReset().mockImplementation(async () => { calls.order.push('save'); });
  calls.publish.mockReset().mockImplementation(() => { calls.order.push('publish'); });
});

const SESSION = '11111111-2222-4333-8444-555555555555';

test('a saved plan is announced to its owner, for its session, with the new revision, after the write', async () => {
  const state = { ...emptyWorkPlan(), revision: 4 };
  await saveWorkPlan(SESSION, 'user-1', 3, state);
  expect(calls.save).toHaveBeenCalledWith(SESSION, 'user-1', 3, state);
  expect(calls.publish).toHaveBeenCalledWith({ type: 'session.plan_updated', source: 'work-plan', userId: 'user-1', sessionId: SESSION, payload: { revision: 4 } });
  expect(calls.order).toEqual(['save', 'publish']);
});

test('a save that fails announces nothing and fails', async () => {
  calls.save.mockRejectedValue(new Error('Plan changed. Refresh and try again.'));
  await expect(saveWorkPlan(SESSION, 'user-1', 3, emptyWorkPlan())).rejects.toThrow('Plan changed');
  expect(calls.publish).not.toHaveBeenCalled();
});

test('a failed announcement does not undo or fail the save', async () => {
  calls.publish.mockImplementation(() => { throw new Error('bus down'); });
  await expect(saveWorkPlan(SESSION, 'user-1', 0, emptyWorkPlan())).resolves.toBeUndefined();
  expect(calls.save).toHaveBeenCalled();
});
