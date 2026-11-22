import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/db/repositories/document-repository', () => ({
  documentRepository: { protectionLevelsSystem: vi.fn(async () => { throw new Error('documents table unreachable'); }) },
}));

const { readKnowledge } = await import('./content-read');
const { resetSessionLevels, sessionProtectionLevel } = await import('./session-level');
const { securityLogger } = await import('@/utils/logger');

afterEach(() => {
  resetSessionLevels();
  vi.restoreAllMocks();
});

describe('readKnowledge when the levels cannot be read', () => {
  test('the session counts as holding unclear content, and the failure is logged', async () => {
    const warn = vi.spyOn(securityLogger, 'warn');
    await readKnowledge('sess-unreadable', [{ sourceId: 'doc:6f1c7c64-0f7e-4b8a-9d55-2f1b4f0c1a10' }]);
    expect(sessionProtectionLevel('sess-unreadable')).toBe(4);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-unreadable' }), expect.stringMatching(/levels unreadable/));
  });
});
