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
    // Mirrors the real jsonb patch (`setContextKey`): one key, siblings intact.
    vi.spyOn(sessionRepository, 'setContextKey').mockImplementation(async (id: string, path: string[], value: unknown) => {
      const row = store.get(id) ?? { context: {} as SessionContext };
      let node = row.context as Record<string, unknown>;
      for (const seg of path.slice(0, -1)) {
        if (typeof node[seg] !== 'object' || node[seg] === null) node[seg] = {};
        node = node[seg] as Record<string, unknown>;
      }
      const leaf = path[path.length - 1];
      if (value === undefined) delete node[leaf];
      else node[leaf] = value;
      store.set(id, row);
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

  // Defence in depth (Task 3): a /clear sets `clearedAt` AND drops
  // `cliSessions` at the write, but a stored record that somehow survives a
  // clear (a future write path that forgets to drop it, exactly like the
  // chat-text /clear bug this guards against) must still not be resumable —
  // it would hand the vendor CLI the whole pre-clear conversation back.
  it('refuses a stored record that predates the session’s clearedAt', async () => {
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp-a', lastUsedAt: '2026-01-01T00:00:00.000Z' });
    const row = store.get('s1')!;
    row.context = { ...row.context, clearedAt: '2026-01-02T00:00:00.000Z' };
    expect(await loadCliSession('s1', 'Claude Code', 'fp-a')).toBeNull();
  });

  it('still resumes a record saved after the session’s clearedAt', async () => {
    const row0 = { context: { clearedAt: '2026-01-01T00:00:00.000Z' } as SessionContext };
    store.set('s1', row0);
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp-a', lastUsedAt: '2026-01-02T00:00:00.000Z' });
    expect(await loadCliSession('s1', 'Claude Code', 'fp-a')).toMatchObject({ id: 'u1' });
  });
});
