import { beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ compact: vi.fn(), history: vi.fn(), patch: vi.fn() }));
vi.mock('@/core/cli-compaction', () => ({ rootCliConversation: () => ['Claude Code', { id: 'same-session' }], compactCliConversation: mocks.compact }));
vi.mock('@/core/session-history', () => ({ withSessionConversation: async (_id: string, run: () => unknown) => run(), readSessionHistory: mocks.history }));
vi.mock('@/db/repositories/session-repository', () => ({ sessionRepository: { findById: async () => ({ id: 'session', context: {} }), patchContextIfGeneration: mocks.patch } }));
import { audienceOf } from './audience';
import { compactSessionCommand, extractsMemoryOnCompaction, maybeCompactSession } from './session-compaction';
beforeEach(() => { vi.clearAllMocks(); });
test('automatic compaction never summarizes or rotates a root CLI history', async () => {
  expect(await maybeCompactSession('session')).toBe(false);
  expect(mocks.history).not.toHaveBeenCalled();
  expect(mocks.patch).not.toHaveBeenCalled();
  expect(mocks.compact).not.toHaveBeenCalled();
});
test('manual compaction delegates without publishing an Octipus checkpoint', async () => {
  mocks.compact.mockResolvedValue('Same CLI conversation compacted.');
  expect(await compactSessionCommand('session', ' keep decisions ')).toBe('Same CLI conversation compacted.');
  expect(mocks.compact).toHaveBeenCalledWith(expect.objectContaining({ id: 'session' }), 'keep decisions');
  expect(mocks.history).not.toHaveBeenCalled();
  expect(mocks.patch).not.toHaveBeenCalled();
});
test('native failure does not fall back to the thinner Octipus history', async () => {
  mocks.compact.mockRejectedValue(new Error('native compact failed'));
  expect(await compactSessionCommand('session', '')).toContain('Compaction failed');
  expect(mocks.history).not.toHaveBeenCalled();
  expect(mocks.patch).not.toHaveBeenCalled();
});
test('on-compaction memory extraction skips group-channel threads', () => {
  expect(extractsMemoryOnCompaction('on_compaction', audienceOf('personal'))).toBe(true);
  expect(extractsMemoryOnCompaction('on_compaction', audienceOf('group'))).toBe(false);
  expect(extractsMemoryOnCompaction('on_compaction', audienceOf('space'))).toBe(false);
  expect(extractsMemoryOnCompaction('per_turn', audienceOf('personal'))).toBe(false);
});
