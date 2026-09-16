/**
 * Task 3: the chat-text `/clear` (this file — distinct from the gateway
 * `/clear` in src/core/gateway/commands.ts, which was already correct) did
 * not clear `cliSessions` and did not set `clearedAt`. With CLI session
 * reuse always on now (no more `cli.reuseSessions` gate), a user who cleared
 * a conversation here would get the vendor CLI session resumed on the next
 * turn holding the whole prior conversation. Verify both are now set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionRepository } from '@/db/repositories/session-repository';
import type { Session, SessionContext } from '@/db/schema/sessions';
import './clear'; // self-registers the /clear command
import { getCommand } from './registry';

describe('/clear command (chat-text)', () => {
  let store: Map<string, { context: SessionContext }>;

  beforeEach(() => {
    store = new Map();
    vi.spyOn(sessionRepository, 'findById').mockImplementation(async (id: string) => {
      const row = store.get(id);
      return row ? ({ id, context: row.context } as unknown as Session) : null;
    });
    vi.spyOn(sessionRepository, 'clearContext').mockImplementation(async id => {
      const row = store.get(id)!;
      row.context = { ...row.context, clearedAt: new Date().toISOString(), cliSessions: undefined, compactedSummary: undefined, checkpoint: undefined };
    });
    vi.spyOn(sessionRepository, 'update').mockImplementation(async (id: string, data: { context?: unknown }) => {
      const existing = store.get(id) ?? { context: {} as SessionContext };
      const context = (data.context ?? existing.context) as SessionContext;
      store.set(id, { context });
      return { id, context } as unknown as Session;
    });
  });

  it('sets clearedAt and drops cliSessions', async () => {
    store.set('s1', {
      context: {
        compactedSummary: 'old summary',
        cliSessions: { 'Claude Code': { id: 'vendor-1', fingerprint: 'fp', lastUsedAt: new Date().toISOString() } },
      } as SessionContext,
    });

    const cmd = getCommand('clear')!;
    await cmd.execute({ sessionId: 's1', userId: 'u1', args: '' });

    const after = store.get('s1')!.context;
    expect(typeof after.clearedAt).toBe('string');
    expect(Number.isNaN(new Date(after.clearedAt!).getTime())).toBe(false);
    expect(after.cliSessions).toBeUndefined();
    expect(after.compactedSummary).toBeUndefined();
  });
});
