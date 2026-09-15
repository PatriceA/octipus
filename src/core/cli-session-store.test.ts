import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { Session, SessionContext } from '@/db/schema/sessions';
import { dropCliSession, fingerprintRun, loadCliSession, saveCliSession } from './cli-session-store';

describe('fingerprintRun', () => {
  it('changes when the model changes', () => {
    const a = fingerprintRun({ model: 'sonnet', permissionMode: 'acceptEdits', planMode: false, workingDirectory: '/w' });
    const b = fingerprintRun({ model: 'opus', permissionMode: 'acceptEdits', planMode: false, workingDirectory: '/w' });
    expect(a).not.toBe(b);
  });

  it('changes when plan mode changes — resume cannot switch it', () => {
    const a = fingerprintRun({ model: 'sonnet', permissionMode: 'acceptEdits', planMode: false, workingDirectory: '/w' });
    const b = fingerprintRun({ model: 'sonnet', permissionMode: 'acceptEdits', planMode: true, workingDirectory: '/w' });
    expect(a).not.toBe(b);
  });

  it('is stable for identical runs', () => {
    const r = { model: 'sonnet', permissionMode: 'acceptEdits', planMode: false, workingDirectory: '/w' };
    expect(fingerprintRun(r)).toBe(fingerprintRun(r));
  });
});

describe('cli session store', () => {
  // Repository-stubbing pattern from src/core/agent-worker.hardening.test.ts:
  // spy on the real sessionRepository singleton instead of hitting Postgres,
  // backed here by an in-memory map so findById/update round-trip like a DB would.
  let store: Map<string, { context: SessionContext }>;

  beforeEach(() => {
    store = new Map();
    vi.spyOn(sessionRepository, 'findById').mockImplementation(async (id: string) => {
      const row = store.get(id);
      if (!row) return null;
      return { id, context: row.context } as unknown as Session;
    });
    vi.spyOn(sessionRepository, 'update').mockImplementation(async (id: string, data: { context?: unknown }) => {
      const existing = store.get(id) ?? { context: {} };
      const context = (data.context ?? existing.context) as SessionContext;
      store.set(id, { context });
      return { id, context } as unknown as Session;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when the stored fingerprint does not match', async () => {
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp-a', lastUsedAt: new Date().toISOString() });
    expect(await loadCliSession('s1', 'Claude Code', 'fp-b')).toBeNull();
  });

  it('round-trips a matching record', async () => {
    const rec = { id: 'u1', fingerprint: 'fp-a', lastUsedAt: new Date().toISOString() };
    await saveCliSession('s1', 'Claude Code', rec);
    expect(await loadCliSession('s1', 'Claude Code', 'fp-a')).toMatchObject({ id: 'u1' });
  });

  it('forgets a dropped session', async () => {
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp-a', lastUsedAt: new Date().toISOString() });
    await dropCliSession('s1', 'Claude Code');
    expect(await loadCliSession('s1', 'Claude Code', 'fp-a')).toBeNull();
  });

  it('never returns another octipus session’s vendor session', async () => {
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp-a', lastUsedAt: new Date().toISOString() });
    expect(await loadCliSession('s2', 'Claude Code', 'fp-a')).toBeNull();
  });
});
