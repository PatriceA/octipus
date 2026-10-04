/**
 * Coworking S0b — one multi-user model.
 *
 *   - A stored row of the removed workspaces switch is deleted at startup.
 *   - A user id that is not a uuid reaching a uuid column is a bug and
 *     throws: no "first admin" stand-in, no first-user fallback.
 *   - The server's workspace derive fails closed: when the resolver throws,
 *     an authenticated request answers 503 instead of running unscoped.
 *   - Deleting a user goes through `assertDeletable`: never the last admin.
 *
 * Backed by ephemeral PGlite; the 503 case drives the real `createServer()`.
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-4111-8111-111111111111';
const adminId = '33333333-3333-4333-8333-333333333333';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-s0b-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { initializeStorage } = await import('@/db/storage');
  initializeStorage({ mode: 'external' });

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: adminId, username: 'root', isAdmin: true },
  ]);
}, 120_000);

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

describe('workspaces are always on', () => {
  test('startup deletes a stored row of the removed switch', async () => {
    const { getDb } = await import('@/db/postgres');
    const { settings } = await import('@/db/schema/settings');
    const { eq } = await import('drizzle-orm');
    const { REMOVED_SETTING_KEYS, SettingsService } = await import('@/config/settings-service');
    const [key] = REMOVED_SETTING_KEYS;
    const db = getDb();
    await db.insert(settings).values({ key, value: 'false', valueType: 'boolean', category: 'multiuser' });

    const svc = new SettingsService();
    await svc.warmCache();

    expect(await db.select().from(settings).where(eq(settings.key, key))).toEqual([]);
    expect(svc.getSync(key)).toBeUndefined();
  });
});

describe('no pseudo-user ids', () => {
  test('a non-uuid user id at a uuid column throws', async () => {
    const { userRepository } = await import('@/db/repositories/user-repository');
    await expect(userRepository.findById('system')).rejects.toThrow();
  });

  test('the profiles tool refuses a turn without a real user instead of picking one', async () => {
    const { ProfilesTool } = await import('@/tools/profiles');
    const tool = new ProfilesTool();
    await tool.initialize();
    const list = tool.getTool('list_profiles')!;
    const as = (userId: string | undefined) => ({ id: 'agent-1', userId, sessionId: 's' }) as unknown as AgentContext;
    // The old fallback answered with the first user's profiles. Now the id
    // throws at the first uuid column it reaches (here the permission rows).
    await expect(list.execute({}, as('system'))).rejects.toThrow();
    await expect(list.execute({}, as(undefined))).rejects.toThrow();
    await expect(list.execute({}, as(aliceId))).resolves.toMatchObject({ profiles: [] });
  });

  test('updating a skill as a non-uuid user throws before any lookup', async () => {
    const { updateSkill } = await import('@/skills/update');
    await expect(updateSkill('skill', { content: 'x' }, 'system')).rejects.toThrow('Expected a user id (uuid)');
  });
});

describe('fail closed on workspace resolution', () => {
  test('a resolver failure answers 503 for an authenticated request', async () => {
    const { getSessionManager } = await import('@/security/auth/session');
    const { getOrgWorkspaceManager } = await import('@/security/orgs');
    const { createServer } = await import('./server');
    const app = createServer();
    const token = (await getSessionManager().create(aliceId)).token;
    const request = () => app.handle(new Request('http://localhost/api/me/workspaces', {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect((await request()).status).toBe(200);

    const spy = vi.spyOn(getOrgWorkspaceManager(), 'ensureDefaultWorkspace')
      .mockRejectedValue(new Error('database unavailable'));
    try {
      const res = await request();
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'Workspace unavailable. Try again shortly.' });
      // OpenAI-compatible surface too.
      const v1 = await app.handle(new Request('http://localhost/v1/models', {
        headers: { authorization: `Bearer ${token}` },
      }));
      expect(v1.status).toBe(503);
      // An anonymous request never resolves a workspace and is unaffected.
      expect((await app.handle(new Request('http://localhost/api/health'))).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('user deletion', () => {
  test('the last active admin cannot be deleted; a second admin unblocks it', async () => {
    const { assertDeletable, UserNotDeletableError } = await import('@/security/user-deletion');
    const { userRepository } = await import('@/db/repositories/user-repository');
    await expect(userRepository.delete(adminId)).rejects.toBeInstanceOf(UserNotDeletableError);
    expect(await userRepository.findById(adminId)).not.toBeNull();

    await expect(assertDeletable(aliceId)).resolves.toBeUndefined();
    await expect(assertDeletable('system')).rejects.toThrow('Expected a user id (uuid)');

    const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
    const otherAdmin = '44444444-4444-4444-8444-444444444444';
    await seedUsers([{ id: otherAdmin, username: 'root2', isAdmin: true }]);
    await expect(assertDeletable(adminId)).resolves.toBeUndefined();
    expect(await userRepository.delete(otherAdmin)).toBe(true);
  });
});
