import { afterEach, expect, test, vi } from 'vitest';
import { sessionRepository } from '@/db/repositories/session-repository';
import { sessionAccessError } from './message-handler';

const me = '11111111-2222-4333-8444-555555555555';
const other = '22222222-2222-4333-8444-555555555555';
const sid = 'aaaaaaaa-0000-4000-8000-000000000000';
afterEach(() => { vi.restoreAllMocks(); });

test('another user\'s existing session is refused for a user-trust connection', async () => {
  vi.spyOn(sessionRepository, 'findById').mockResolvedValue({ id: sid, userId: other } as never);
  expect(await sessionAccessError(sid, { userId: me, trustLevel: 'user' })).toBe('Session not found');
});

test('own, not-yet-created, channel-style, and trusted-console sessions pass', async () => {
  const findById = vi.spyOn(sessionRepository, 'findById').mockResolvedValue({ id: sid, userId: me } as never);
  expect(await sessionAccessError(sid, { userId: me, trustLevel: 'user' })).toBeNull();
  findById.mockResolvedValue(null);
  expect(await sessionAccessError(sid, { userId: me, trustLevel: 'user' })).toBeNull();
  findById.mockResolvedValue({ id: sid, userId: other } as never);
  expect(await sessionAccessError('telegram-123', { userId: me, trustLevel: 'user' })).toBeNull();
  expect(await sessionAccessError(sid, { userId: 'local', trustLevel: 'local' })).toBeNull();
});
