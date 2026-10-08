/**
 * One helper decides who may act in a session (docs/plans/coworking-spec.md
 * §6.2): `canActInSession`. A room is a session of its creator (`user_id`)
 * that every member with access may post in, so an inline
 * `session.userId !== userId` check is wrong for it in one direction or the
 * other. This test fails on a new inline comparison anywhere in `src/`;
 * the allowlist names the comparisons that are not about who may act in a
 * chat or a room.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { canActInSession, type SessionAction } from './access';

const SRC = join(import.meta.dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** `file` → why its comparison is not an "act in this session" check. */
const ALLOWED: Record<string, string> = {
  // The helper itself: a personal chat is its owner's.
  'core/rooms/access.ts': 'the helper',
  // The one scope resolver: a room returns before it (resolveRoomScope).
  'core/agent/context.ts': 'personal branch of resolveAgentScope, after the room branch',
  // Compares a group thread session with the task it carries, not a caller.
  'channels/taken-task-notices.ts': 'session owner vs the task owner',
  // A learning job, monitor or delivery against the row that queued it (all personal-only, refused in rooms).
  'core/learning/processor.ts': 'job owner vs its session',
  'core/monitors/service.ts': 'monitor owner vs its session',
  'core/monitors/delivery.ts': 'monitor owner vs its session',
  // An auth session (login), not a chat.
  'security/auth/session.ts': 'auth session',
  // A visitor-agent listener against its own personal session (never a room).
  'core/federation/visitor-agent.ts': 'listener owner vs its personal remote-room session',
};

describe('canActInSession', () => {
  test('no new inline session.userId comparison outside the allowlist', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file).split('\\').join('/');
      const src = readFileSync(file, 'utf8');
      if (!/\bsession\??\.userId\s*[!=]==/.test(src)) continue;
      if (!ALLOWED[rel]) offenders.push(rel);
    }
    expect(offenders, 'use canActInSession(session, userId, action) (src/core/rooms/access.ts)').toEqual([]);
  });

  test('a personal chat is its owner\'s for every action; a missing session for nobody', async () => {
    const chat = { id: '00000000-0000-4000-8000-000000000001', userId: 'u-1', kind: 'chat' as const };
    const actions: SessionAction[] = ['post', 'turn', 'stop', 'control', 'manage', 'settings', 'requester', 'personal_tool', 'learning', 'voice', 'chat'];
    for (const action of actions) {
      expect(await canActInSession(chat, 'u-1', action), action).toBe(true);
      expect(await canActInSession(chat, 'u-2', action), action).toBe(false);
      expect(await canActInSession(null, 'u-1', action), action).toBe(false);
    }
  });

  test('a room refuses the personal-only actions without reading anything, its creator included', async () => {
    const room = { id: '00000000-0000-4000-8000-000000000002', userId: 'creator', kind: 'room' as const };
    for (const action of ['settings', 'personal_tool', 'learning', 'voice', 'chat'] as const) {
      expect(await canActInSession(room, 'creator', action), action).toBe(false);
    }
  });
});
