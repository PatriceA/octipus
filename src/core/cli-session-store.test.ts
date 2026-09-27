import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { Session, SessionContext } from '@/db/schema/sessions';
import { childCliSessionKey, claimCliSession, cliSessionHolder, dropCliSession, isChildCliSessionKey, fingerprintRun, MAX_CHILD_CLI_SESSIONS, loadCliSession, releaseCliSessions, saveCliSession } from './cli-session-store';

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
    vi.spyOn(sessionRepository, 'patchContextIfGeneration').mockImplementation(async (id, generation, patch) => {
      const row = store.get(id) ?? { context: {} as SessionContext };
      if ((row.context.conversationGeneration ?? row.context.clearedAt ?? '') !== generation) return false;
      Object.assign(row.context, patch); store.set(id, row); return true;
    });
    // Mirrors the real per-key write: one cliSessions entry, generation-checked.
    vi.spyOn(sessionRepository, 'setContextKeyIfGeneration').mockImplementation(async (id, generation, path, value) => {
      const row = store.get(id) ?? { context: {} as SessionContext };
      if ((row.context.conversationGeneration ?? row.context.clearedAt ?? '') !== generation) return false;
      const map = { ...row.context.cliSessions } as Record<string, unknown>;
      if (value === undefined) delete map[path[1]]; else map[path[1]] = value;
      row.context.cliSessions = map as SessionContext['cliSessions']; store.set(id, row); return true;
    });
    // Mirrors the real single-statement trim (covered against SQL in session-context-patch.test.ts).
    vi.spyOn(sessionRepository, 'trimCliSessions').mockImplementation(async (id, prefixes, max) => {
      const row = store.get(id);
      const map = { ...row?.context.cliSessions };
      const matched = Object.entries(map).filter(([key]) => prefixes.some(p => key.startsWith(p)))
        .sort(([, a], [, b]) => b.lastUsedAt.localeCompare(a.lastUsedAt));
      for (const [key] of matched.slice(max)) delete map[key];
      if (row) row.context.cliSessions = map;
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
    await saveCliSession('s1', 'Claude Code', { id: 'u1', fingerprint: 'fp-a', generation: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-02T00:00:00.000Z' });
    expect(await loadCliSession('s1', 'Claude Code', 'fp-a')).toMatchObject({ id: 'u1' });
  });

  it('keeps a child task key apart from the root adapter key', async () => {
    const child = childCliSessionKey('Claude Code', 'coding:parser-fix');
    await saveCliSession('s1', child, { id: 'c1', fingerprint: 'fp-a', lastUsedAt: new Date().toISOString() });
    expect(await loadCliSession('s1', 'Claude Code', 'fp-a')).toBeNull();
    expect(await loadCliSession('s1', child, 'fp-a')).toMatchObject({ id: 'c1' });
    expect(await loadCliSession('s1', child, 'fp-b')).toBeNull();
    expect(isChildCliSessionKey(child)).toBe(true);
    expect(isChildCliSessionKey('Claude Code')).toBe(false);
    // Only a resumable adapter's exact `<adapter>::` prefix makes a child key.
    expect(isChildCliSessionKey('Some::Adapter')).toBe(false);
    expect(isChildCliSessionKey('Codex CLI::general>coding:t')).toBe(true);
  });

  it('evicts the least recently used child keys past the bound, never a root key', async () => {
    await saveCliSession('s1', 'Claude Code', { id: 'root', fingerprint: 'fp', lastUsedAt: '2000-01-01T00:00:00.000Z' });
    for (let i = 0; i <= MAX_CHILD_CLI_SESSIONS; i++) {
      const lastUsedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      await saveCliSession('s1', childCliSessionKey('Claude Code', `t${i}`), { id: `c${i}`, fingerprint: 'fp', lastUsedAt });
    }
    const keys = Object.keys(store.get('s1')!.context.cliSessions!);
    expect(keys).toHaveLength(MAX_CHILD_CLI_SESSIONS + 1);
    expect(keys).toContain('Claude Code');
    expect(keys).not.toContain('Claude Code::t0');
    expect(keys).toContain(`Claude Code::t${MAX_CHILD_CLI_SESSIONS}`);
  });

  it('writes one key at a time, so parallel saves to sibling keys both land', async () => {
    const lastUsedAt = new Date().toISOString();
    await Promise.all([
      saveCliSession('s1', 'Claude Code', { id: 'root', fingerprint: 'fp', lastUsedAt }),
      saveCliSession('s1', childCliSessionKey('Claude Code', 'a'), { id: 'a', fingerprint: 'fp', lastUsedAt }),
      saveCliSession('s1', childCliSessionKey('Claude Code', 'b'), { id: 'b', fingerprint: 'fp', lastUsedAt }),
    ]);
    expect(sessionRepository.patchContextIfGeneration).not.toHaveBeenCalled();
    expect(Object.keys(store.get('s1')!.context.cliSessions!).sort()).toEqual(['Claude Code', 'Claude Code::a', 'Claude Code::b']);
  });

  it('rejects a save from a stale generation', async () => {
    store.set('s1', { context: { clearedAt: '2026-01-02T00:00:00.000Z' } as SessionContext });
    await saveCliSession('s1', childCliSessionKey('Claude Code', 'a'), { id: 'a', fingerprint: 'fp', generation: '', lastUsedAt: new Date().toISOString() });
    expect(store.get('s1')!.context.cliSessions).toBeUndefined();
  });
});

describe('claimCliSession', () => {
  it('lets one live agent hold a key at a time, per session', () => {
    expect(claimCliSession('s1', 'k', 'a1')).toBe(true);
    expect(claimCliSession('s1', 'k', 'a1')).toBe(true);
    expect(claimCliSession('s1', 'k', 'a2')).toBe(false);
    expect(claimCliSession('s2', 'k', 'a2')).toBe(true);
    expect(cliSessionHolder('s1', 'k')).toBe('a1');
    releaseCliSessions('a1');
    expect(cliSessionHolder('s1', 'k')).toBeUndefined();
    expect(claimCliSession('s1', 'k', 'a2')).toBe(true);
    releaseCliSessions('a2');
  });

  it('releasing one agent leaves another agent\'s claims alone', () => {
    expect(claimCliSession('s1', 'k1', 'a1')).toBe(true);
    expect(claimCliSession('s1', 'k2', 'a2')).toBe(true);
    releaseCliSessions('a1');
    expect(claimCliSession('s1', 'k2', 'a3')).toBe(false);
    expect(claimCliSession('s1', 'k1', 'a3')).toBe(true);
    releaseCliSessions('a2');
    releaseCliSessions('a3');
  });
});
