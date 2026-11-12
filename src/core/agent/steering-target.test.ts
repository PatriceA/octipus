/** One steering rule for the gateway and AgentService.canSteer / steer (monitor and companion wake-ups). */
import { expect, test, vi } from 'vitest';

const agents = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/core/agent-manager', () => ({ getAgentManager: () => ({ getBySession: () => agents.list }) }));

import { findSteeringTarget } from './steering-target';

const root = (over: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => ({
  getContext: () => ({ id: 'root', root: true, userId: 'u', sessionId: 's', metadata }),
  getStatus: () => 'running',
  steer: vi.fn(() => true),
  ...over,
});

test('a running root that takes input mid-turn is the target', () => {
  const r = root();
  agents.list = [{ ...root(), getContext: () => ({ id: 'child', root: false, userId: 'u', sessionId: 's' }) }, r];
  expect(findSteeringTarget('s')).toEqual({ root: r });
});

test.each([
  ['nothing runs', [], false, 'No turn is running in this session.'],
  ['a buffered CLI root', [root({ acceptsMidTurnSteering: () => false })], true, 'The running agent cannot take input mid-turn.'],
  ['a finishing root', [root({ canAcceptSteering: () => false })], true, 'The running turn is finishing and takes no more guidance.'],
  ['a room turn', [root({}, { room: true })], true, 'A room turn is never steered.'],
  ['a root without steer', [{ ...root(), steer: undefined }], true, 'The running agent cannot take guidance.'],
])('%s is no target', (_name, list, running, reason) => {
  agents.list = list;
  expect(findSteeringTarget('s')).toEqual({ root: null, running, reason });
});

test('AgentService.canSteer and steer follow the same rule', async () => {
  const { AgentService } = await import('./service');
  const buffered = root({ acceptsMidTurnSteering: () => false });
  agents.list = [buffered];
  const service = Object.create(AgentService.prototype) as InstanceType<typeof AgentService>;
  expect(service.canSteer('s')).toBe(false);
  expect(service.steer('s', { role: 'system', content: 'wake', timestamp: new Date() })).toBe(false);
  expect(buffered.steer).not.toHaveBeenCalled();
  const live = root();
  agents.list = [live];
  expect(service.canSteer('s')).toBe(true);
  expect(service.steer('s', { role: 'system', content: 'wake', timestamp: new Date() })).toBe(true);
  expect(live.steer).toHaveBeenCalledOnce();
});
