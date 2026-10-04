import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentContext } from '@/core/types';
import { saveProgressMessage } from './progress-message';

const f = vi.hoisted(() => ({ session: vi.fn(), create: vi.fn() }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: f.session } }));
vi.mock('@/db/repositories/message-repository', () => ({ messageRepository: { createForGeneration: f.create } }));
const context = (): AgentContext => ({ space: null, trigger: 'user', funding: 'own',  id: 'a', sessionId: 's', userId: 'u', topic: 'general', model: 'cli/claude',
  role: 'general', status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata: { sessionGeneration: 'before-clear' } });

beforeEach(() => {
  f.session.mockReset().mockResolvedValue({ userId: 'u', context: {} });
  f.create.mockReset().mockResolvedValue({ id: 'm1', createdAt: new Date('2026-09-29T12:00:00Z') });
});

it('persists progress with its original generation and deduplicates concurrent text/tool updates', async () => {
  const ctx = context();
  const [first, duplicate] = await Promise.all([
    saveProgressMessage('Found the regression.', ctx), saveProgressMessage('Found the regression.', ctx),
  ]);
  expect(first).toEqual({ message: 'Found the regression.', messageId: 'm1', createdAt: '2026-09-29T12:00:00.000Z' });
  expect(duplicate).toBeNull();
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'assistant', content: 'Found the regression.', metadata: { kind: 'progress' } }), 'before-clear');
});

it('does not publish a message rejected by the generation guard', async () => {
  f.create.mockResolvedValue(null);
  expect(await saveProgressMessage('Late update', context(), 'old-cli-generation')).toBeNull();
  expect(f.create.mock.calls[0][1]).toBe('old-cli-generation');
});

it('checks session ownership before writing', async () => {
  f.session.mockResolvedValue({ userId: 'someone-else' });
  expect(await saveProgressMessage('Update', context())).toBeNull();
  expect(f.create).not.toHaveBeenCalled();
});

it('allows retry after persistence failure', async () => {
  const ctx = context();
  f.create.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(saveProgressMessage('Update', ctx)).rejects.toThrow('database unavailable');
  expect(await saveProgressMessage('Update', ctx)).toMatchObject({ messageId: 'm1' });
});
