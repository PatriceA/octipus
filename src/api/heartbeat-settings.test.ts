import { afterEach, expect, test, vi } from 'vitest';
import { getConfig } from '@/config';
import { principalFromUser } from '@/security/principal';
import { activateHeartbeatService } from './heartbeat-settings';
const calls = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('@/config/settings-service', () => ({ getSettingsService: () => ({ set: calls.set }) }));
const previous = getConfig().heartbeat.enabled;
const admin = { id: '11111111-1111-4111-8111-111111111111', username: 'owner', isAdmin: true };
afterEach(() => { getConfig().heartbeat.enabled = previous; calls.set.mockClear(); });
test('an admin enable action also activates the server prerequisite', async () => {
  getConfig().heartbeat.enabled = false;
  await activateHeartbeatService(admin, principalFromUser(admin));
  expect(calls.set).toHaveBeenCalledWith('heartbeat.enabled', true, admin.id);
});
test('member preferences and restricted admin tokens cannot change server policy', async () => {
  getConfig().heartbeat.enabled = false;
  await activateHeartbeatService({ ...admin, isAdmin: false }, principalFromUser({ ...admin, isAdmin: false }));
  await activateHeartbeatService(admin, { ...principalFromUser(admin), scopes: ['api:read'] });
  expect(calls.set).not.toHaveBeenCalled();
});
test('an already active server needs no additional setting write', async () => {
  getConfig().heartbeat.enabled = true;
  await activateHeartbeatService(admin, principalFromUser(admin));
  expect(calls.set).not.toHaveBeenCalled();
});
