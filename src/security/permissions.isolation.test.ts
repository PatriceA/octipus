/**
 * Phase 1c — root agent permission gate.
 *
 * Verifies the cross-tenant guards added to PermissionManager:
 *
 *   - alice cannot approve OR deny bob's pending request via
 *     PermissionManager.approve / deny (silent no-op, returns false,
 *     row stays pending).
 *   - there is no admin override on approve / deny; an admin answers
 *     another user's request only through `resolveAsAdmin` (the audited
 *     admin route's one entry point).
 *   - getPendingRequests(userId) returns only that user's rows.
 *
 * Backed by ephemeral PGlite — no Docker.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Exercise real SQL/migrations without Windows filesystem flushes on every
// statement. Persistence is covered by the embedded database suites.
vi.mock('@electric-sql/pglite', async importOriginal => {
  const actual = await importOriginal<typeof import('@electric-sql/pglite')>();
  return { ...actual, PGlite: { create: (options: Record<string, unknown>) => actual.PGlite.create({ ...options, dataDir: undefined }) } };
});

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-perm-iso-'));

  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();

  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([
    { id: aliceId, username: 'alice' },
    { id: bobId, username: 'bob' },
  ]);
}, 120_000); // Full embedded migration chain can exceed 30s on Windows.

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function createPendingRequest(userId: string): Promise<string> {
  const { getPermissionManager } = await import('@/security/permissions');
  const pm = getPermissionManager();
  return pm.requestApproval(
    userId,
    'agent-' + userId.slice(0, 4),
    'shell',
    'execute',
    { command: 'ls' },
    undefined,
    'shell',
  );
}

describe('PermissionManager.approve cross-tenant', () => {
  test('alice cannot approve bob’s pending request — silent no-op', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);

    // Alice attempts to approve — must return false, row stays pending.
    const ok = await pm.approve(reqId, aliceId);
    expect(ok).toBe(false);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT status FROM permission_requests WHERE id='${reqId}'`);
    expect(rows[0]?.status).toBe('pending');
  });

  test('bob can approve his own request', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);
    const ok = await pm.approve(reqId, bobId);
    expect(ok).toBe(true);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT status, resolved_by FROM permission_requests WHERE id='${reqId}'`);
    expect(rows[0]?.status).toBe('approved');
    expect(rows[0]?.resolved_by).toBe(bobId);
  });

  test('resolveAsAdmin lets a non-owner approve', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);
    const resolved = await pm.resolveAsAdmin(reqId, true, aliceId, 'unblocking a stuck run');
    expect(resolved?.userId).toBe(bobId);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT status FROM permission_requests WHERE id='${reqId}'`);
    expect(rows[0]?.status).toBe('approved');
  });
});

describe('PermissionManager.deny cross-tenant', () => {
  test('alice cannot deny bob’s pending request', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);
    const ok = await pm.deny(reqId, aliceId, 'pwned');
    expect(ok).toBe(false);

    const { queryRaw } = await import('@/db/postgres');
    const { rows } = await queryRaw(`SELECT status FROM permission_requests WHERE id='${reqId}'`);
    expect(rows[0]?.status).toBe('pending');
  });

  test('resolveAsAdmin lets a non-owner deny', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const reqId = await createPendingRequest(bobId);
    const resolved = await pm.resolveAsAdmin(reqId, false, aliceId, 'override');
    expect(resolved?.status).toBe('denied');
  });
});

describe('PermissionManager.getPendingRequests', () => {
  test('returns only the principal’s pending rows', async () => {
    await createPendingRequest(aliceId);
    await createPendingRequest(bobId);
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();

    const aliceRows = await pm.getPendingRequests(aliceId);
    expect(aliceRows.every((r) => r.userId === aliceId)).toBe(true);
    expect(aliceRows.length).toBeGreaterThan(0);

    const bobRows = await pm.getPendingRequests(bobId);
    expect(bobRows.every((r) => r.userId === bobId)).toBe(true);
    expect(bobRows.find((r) => r.userId === aliceId)).toBeUndefined();
  });
});

describe('multiuser.enforcePermissions flag', () => {
  test('default is true (multi-user isolation enforced; legacy single-user opts out via MULTIUSER=false)', async () => {
    // Local single-user installs commonly set MULTIUSER_ENFORCE_PERMISSIONS=false
    // in their .env so the legacy permissive bypass stays on. Clear it for
    // this test so the assertion exercises the actual default, not the
    // developer's local override.
    const previous = process.env.MULTIUSER_ENFORCE_PERMISSIONS;
    delete process.env.MULTIUSER_ENFORCE_PERMISSIONS;
    try {
      const { getConfig, resetConfig } = await import('@/config');
      resetConfig();
      expect(getConfig().multiuser.enforcePermissions).toBe(true);
    } finally {
      if (previous !== undefined) process.env.MULTIUSER_ENFORCE_PERMISSIONS = previous;
      const { resetConfig } = await import('@/config');
      resetConfig();
    }
  });
});

// Use the real manager and database so aliases cannot accidentally lose user,
// action, expiration, or condition filtering at the lookup boundary.
describe('CLI native permission identity compatibility', () => {
  beforeEach(async () => {
    const { getDb } = await import('@/db/postgres');
    const { toolPermissions } = await import('@/db/schema/permissions');
    await getDb().delete(toolPermissions);
    const { DEFAULT_PERMISSION_RULES, getPermissionRuleEngine } = await import('./permission-rules');
    getPermissionRuleEngine().load(DEFAULT_PERMISSION_RULES);
  });

  test('MCP defaults to allow but explicit ask and deny rules still take precedence', async () => {
    const { getPermissionManager } = await import('./permissions');
    const { getPermissionRuleEngine } = await import('./permission-rules');
    const pm = getPermissionManager();
    expect(await pm.check(aliceId, 'mcp', 'qa.read')).toMatchObject({ allowed: true, level: 'ALLOW' });
    await pm.setPermission(aliceId, 'mcp', 'qa.read', 'ASK');
    expect(await pm.check(aliceId, 'mcp', 'qa.read')).toMatchObject({ allowed: false, level: 'ASK' });
    await pm.setPermission(aliceId, 'mcp', 'qa.read', 'ALLOW');
    getPermissionRuleEngine().load({ deny: ['mcp(*)'] });
    expect(await pm.check(aliceId, 'mcp', 'qa.read')).toMatchObject({ allowed: false, level: 'DENY' });
  });

  test('legacy stored DENY wins over new read defaults and explicit grants', async () => {
    const { getPermissionManager } = await import('./permissions');
    const pm = getPermissionManager();
    const denied = await pm.setPermission(aliceId, 'cli-native', 'Read', 'DENY', {
      expiresAt: new Date(Date.now() - 1),
    });
    await pm.setPermission(aliceId, 'cli-native:Read', 'Read', 'ALLOW');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read')).toMatchObject({
      allowed: false, level: 'DENY', source: `permission:${denied.id}`,
    });
    expect(await pm.check(bobId, 'cli-native:Read', 'Read')).toMatchObject({ allowed: true });
    expect(await pm.check(aliceId, 'cli-native:Glob', 'Glob')).toMatchObject({ allowed: true });
  });

  test('legacy deny rules still match vendor arguments despite a specific grant', async () => {
    const { getPermissionManager } = await import('./permissions');
    const { getPermissionRuleEngine } = await import('./permission-rules');
    const pm = getPermissionManager();
    getPermissionRuleEngine().load({ allow: ['cli-native:Read(*)'], deny: ['cli-native(/secret:*)'] });
    await pm.setPermission(aliceId, 'cli-native:Read', 'Read', 'ALLOW');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/secret/token' }))
      .toMatchObject({ allowed: false, level: 'DENY', source: 'rule' });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/public/readme' }))
      .toMatchObject({ allowed: true });
  });

  test('legacy ASK policies and rules retain approval over new read defaults', async () => {
    const { getPermissionManager } = await import('./permissions');
    const { getPermissionRuleEngine } = await import('./permission-rules');
    const pm = getPermissionManager();
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ASK');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read'))
      .toMatchObject({ allowed: false, level: 'ASK', requiresApproval: true });
    await pm.deletePermission(aliceId, 'cli-native', 'Read');
    getPermissionRuleEngine().load({ allow: ['cli-native:Read(*)'], ask: ['cli-native(*)'] });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read'))
      .toMatchObject({ allowed: false, level: 'ASK', requiresApproval: true });
  });

  test('legacy scoped grants apply only to their session and path and still expire', async () => {
    const { getPermissionManager } = await import('./permissions');
    const pm = getPermissionManager();
    const conditions = [
      { type: 'session' as const, value: 'session-one' },
      { type: 'path_pattern' as const, value: '^/workspace/' },
    ];
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ALLOW', { conditions });
    const scope = { sessionId: 'session-one', workspaceId: null };
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/workspace/readme' }, scope))
      .toMatchObject({ allowed: true });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/secret' }, scope))
      .toMatchObject({ allowed: false, requiresApproval: true });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/workspace/readme' }, { ...scope, sessionId: 'another' }))
      .toMatchObject({ allowed: false, requiresApproval: true });
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ALLOW', { conditions, expiresAt: new Date(Date.now() - 1) });
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read', { file_path: '/workspace/readme' }, scope))
      .toMatchObject({ allowed: false, reason: 'Permission expired' });
  });

  test('specific policies override non-denying legacy policies, while specific denials remain final', async () => {
    const { getPermissionManager } = await import('./permissions');
    const pm = getPermissionManager();
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ASK');
    const specific = await pm.setPermission(aliceId, 'cli-native:Read', 'Read', 'ALLOW');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read'))
      .toMatchObject({ allowed: true, source: `permission:${specific.id}` });
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'ALLOW');
    await pm.setPermission(aliceId, 'cli-native:Read', 'Read', 'DENY');
    expect(await pm.check(aliceId, 'cli-native:Read', 'Read')).toMatchObject({ allowed: false, level: 'DENY' });
  });

  test('legacy rate-limit accounting keeps its original identity during fallback and revalidation', async () => {
    const { getPermissionManager } = await import('./permissions');
    const { getRateLimiter } = await import('./rate-limiter');
    const pm = getPermissionManager();
    const limiter = vi.spyOn(getRateLimiter(), 'check').mockResolvedValue({ allowed: true, remaining: 1 });
    try {
      await pm.setPermission(aliceId, 'cli-native', 'Read', 'ALLOW', {
        conditions: [{ type: 'rate_limit', value: { maxRequests: 2, windowMs: 60_000 } }],
      });
      expect(await pm.check(aliceId, 'cli-native:Read', 'Read')).toMatchObject({ allowed: true });
      expect(limiter).toHaveBeenCalledWith(`perm:rl:${aliceId}:cli-native:Read`, 2, 60);
      await pm.check(aliceId, 'cli-native:Read', 'Read', {}, undefined, { revalidate: true });
      expect(limiter).toHaveBeenCalledTimes(1);
    } finally { limiter.mockRestore(); }
  });

  test('compatibility does not alias unrelated tools', async () => {
    const { getPermissionManager } = await import('./permissions');
    const pm = getPermissionManager();
    await pm.setPermission(aliceId, 'cli-native', 'Read', 'DENY');
    expect(await pm.check(aliceId, 'other:Read', 'Read')).toMatchObject({ level: 'ASK' });
  });
});


describe('permission resolution notifications across clients', () => {
  test.each(['approve', 'deny'] as const)('%s broadcasts once to both observers with the owner identity', async (action) => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();
    const first = vi.fn(); const second = vi.fn();
    const unsubscribeFirst = pm.onResolved(first); const unsubscribeSecond = pm.onResolved(second);
    try {
      const requestId = await createPendingRequest(bobId);
      expect(await pm[action](requestId, aliceId)).toBe(false);
      expect(first).not.toHaveBeenCalled();
      expect(await pm[action](requestId, bobId)).toBe(true);
      const expected = { requestId, userId: bobId, status: action === 'approve' ? 'approved' : 'denied' };
      expect(first).toHaveBeenCalledWith(expect.objectContaining(expected));
      expect(second).toHaveBeenCalledWith(expect.objectContaining(expected));
      expect(await pm[action](requestId, bobId)).toBe(false);
      expect(first).toHaveBeenCalledTimes(1);
      unsubscribeSecond();
      const next = await createPendingRequest(bobId);
      await pm[action](next, bobId);
      expect(second).toHaveBeenCalledTimes(1);
    } finally { unsubscribeFirst(); unsubscribeSecond(); }
  });

  test('agent cancellation broadcasts expiry after the row is persisted', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager(); const seen = vi.fn();
    const unsubscribe = pm.onResolved(seen);
    try {
      const requestId = await createPendingRequest(bobId);
      pm.cancelWaits('agent-' + bobId.slice(0, 4));
      await vi.waitFor(() => expect(seen).toHaveBeenCalledWith(expect.objectContaining({ requestId, userId: bobId, status: 'expired' })));
      expect((await pm.getPendingRequests(bobId)).some(row => row.id === requestId)).toBe(false);
    } finally { unsubscribe(); }
  });
});

describe('CLI question answers', () => {
  test('keeps a bare approval pending and delivers only the owner’s complete answer', async () => {
    const { getPermissionManager } = await import('@/security/permissions');
    const pm = getPermissionManager();
    const id = await pm.requestApproval(bobId, 'question-agent', 'cli-native:AskUserQuestion', 'AskUserQuestion', {
      questions: [{ question: 'Which model?', options: [{ label: 'Manual' }] }],
    });
    const waiting = pm.waitForApproval(id, { agentId: 'question-agent' });
    const { ApprovalNeedsAnswersError } = await import('@/security/permissions');
    await expect(pm.approve(id, bobId)).rejects.toThrow(/Answer every question/);
    await expect(pm.approve(id, bobId)).rejects.toBeInstanceOf(ApprovalNeedsAnswersError);
    await expect(pm.approve(id, bobId, 'not json')).rejects.toBeInstanceOf(ApprovalNeedsAnswersError);
    expect((await pm.getPendingRequests(bobId)).some(r => r.id === id)).toBe(true);
    const resolution = JSON.stringify({ 'Which model?': 'Manual' });
    expect(await pm.approve(id, aliceId, resolution)).toBe(false);
    expect(await pm.approve(id, bobId, resolution)).toBe(true);
    expect(await waiting).toBe(true);
    expect(await pm.getApprovedResolution(id, bobId)).toBe(resolution);
    expect(await pm.getApprovedResolution(id, aliceId)).toBeUndefined();
  });
});

describe('durable recovery consent', () => {
  async function action(sessionId: string, owner = aliceId, createdAt = new Date(Date.now() - 1000)) {
    const { randomUUID } = await import('node:crypto');
    const { toolActionRepository } = await import('@/db/repositories/tool-action-repository');
    const id = randomUUID();
    await toolActionRepository.start({ id, userId: owner, sessionId, agentId:'old-worker', toolId:'shell', toolName:'shell__run', argumentHash:'fixture', status:'uncertain', createdAt });
    return id;
  }
  test('a pipeline coordinator approval acknowledges the same snapshot even after its worker was cancelled', async () => {
    const { randomUUID } = await import('node:crypto');
    const { getPermissionManager } = await import('./permissions');
    const { toolActionRepository } = await import('@/db/repositories/tool-action-repository');
    const { getDb } = await import('@/db/postgres');
    const { toolActions } = await import('@/db/schema/tool-actions');
    const { eq } = await import('drizzle-orm');
    const pm = getPermissionManager(); const session = randomUUID(); const id = await action(session);
    const args = { recoveryActionIds:[id], previousActions:'one uncertain shell attempt' };
    const worker = await pm.requestApproval(aliceId,'gone-worker','action_recovery','retry',args,session);
    pm.cancelWaits('gone-worker');
    await pm.waitForApproval(worker,{agentId:'gone-worker'});
    const parent = await pm.requestApproval(aliceId,'pipeline:fixture','action_recovery','retry',args,session);
    expect(await pm.approve(parent,aliceId)).toBe(true);
    const [row] = await getDb().select().from(toolActions).where(eq(toolActions.id,id));
    expect(row.reviewId).toBe(parent); expect(row.reviewedAt).not.toBeNull(); expect(row.status).toBe('uncertain');
    expect(await toolActionRepository.pending(aliceId,session)).toEqual([]);
  });
  test('acknowledgement survives cancellation before the original worker receives the approved answer', async () => {
    const {randomUUID}=await import('node:crypto'); const {getPermissionManager}=await import('./permissions');
    const {toolActionRepository}=await import('@/db/repositories/tool-action-repository');
    const pm=getPermissionManager();const session=randomUUID();const id=await action(session);
    const request=await pm.requestApproval(aliceId,'cancel-on-resolution','action_recovery','retry',{recoveryActionIds:[id]},session);
    const waiting=pm.waitForApproval(request,{agentId:'cancel-on-resolution'});
    const unsubscribe=pm.onResolved(event=>{if(event.requestId===request&&event.status==='approved')pm.cancelWaits('cancel-on-resolution');});
    try {
      expect(await pm.approve(request,aliceId)).toBe(true);expect(await waiting).toBe(false);
      expect(await toolActionRepository.pending(aliceId,session)).toEqual([]);
    } finally {unsubscribe();}
  });
  test('recovery scope cannot acknowledge another user/session, newer effects or denied requests', async () => {
    const { randomUUID } = await import('node:crypto');
    const { getPermissionManager } = await import('./permissions');
    const { toolActionRepository } = await import('@/db/repositories/tool-action-repository');
    const session=randomUUID();const own=await action(session);const foreign=await action(session,bobId);const otherSession=randomUUID();const elsewhere=await action(otherSession);
    const future=await action(session,aliceId,new Date(Date.now()+60_000));const pm=getPermissionManager();
    const denied=await pm.requestApproval(aliceId,'denied-review','action_recovery','retry',{recoveryActionIds:[own]},session);
    await pm.deny(denied,aliceId);expect((await toolActionRepository.pending(aliceId,session)).some(row=>row.id===own)).toBe(true);
    const review=await pm.requestApproval(aliceId,'actual-review','action_recovery','retry',{recoveryActionIds:[own,foreign,elsewhere,future]},session);
    expect(await pm.approve(review,bobId)).toBe(false);
    expect(await pm.approve(review,aliceId)).toBe(true);
    expect((await toolActionRepository.pending(aliceId,session)).map(row=>row.id)).toEqual([future]);
    expect((await toolActionRepository.pending(bobId,session)).map(row=>row.id)).toEqual([foreign]);
    expect((await toolActionRepository.pending(aliceId,otherSession)).map(row=>row.id)).toEqual([elsewhere]);
  });
  test('approval and recovery acknowledgement roll back together on a journal write failure', async () => {
    const { randomUUID } = await import('node:crypto');const { getPermissionManager }=await import('./permissions');
    const consent=await import('@/db/repositories/recovery-consent');const pm=getPermissionManager();const session=randomUUID();const id=await action(session);
    const request=await pm.requestApproval(aliceId,'atomic-review','action_recovery','retry',{recoveryActionIds:[id]},session);
    const broken=vi.spyOn(consent,'acknowledgeRecoveryApproval').mockRejectedValueOnce(new Error('journal unavailable'));
    try { await expect(pm.approve(request,aliceId)).rejects.toThrow('journal unavailable'); }
    finally { broken.mockRestore(); }
    expect((await pm.getPendingRequests(aliceId)).some(row=>row.id===request)).toBe(true);
    expect(await pm.approve(request,aliceId)).toBe(true);
  });
  test('microsecond ordering survives approval and reconciliation when the original waiter is gone', async () => {
    const {randomUUID}=await import('node:crypto');const {getDb}=await import('@/db/postgres');
    const {toolActions}=await import('@/db/schema/tool-actions');const {permissionRequests}=await import('@/db/schema/permissions');
    const {toolActionRepository}=await import('@/db/repositories/tool-action-repository');const {getPermissionManager}=await import('./permissions');const {eq,sql}=await import('drizzle-orm');
    const session=randomUUID();const id=await action(session);const pm=getPermissionManager();
    const request=await pm.requestApproval(aliceId,'pipeline:precision','action_recovery','retry',{recoveryActionIds:[id]},session);
    await getDb().update(toolActions).set({createdAt:sql`'2026-01-01T00:00:00.123100Z'::timestamptz`}).where(eq(toolActions.id,id));
    await getDb().update(permissionRequests).set({createdAt:sql`'2026-01-01T00:00:00.123900Z'::timestamptz`}).where(eq(permissionRequests.id,request));
    expect(await pm.approve(request,aliceId)).toBe(true);
    expect(await toolActionRepository.pending(aliceId,session)).toEqual([]);
    // Simulate an approval persisted by an older process without acknowledgement.
    await getDb().update(toolActions).set({reviewedAt:null,reviewId:null}).where(eq(toolActions.id,id));
    expect(await toolActionRepository.reconcileApproved(aliceId,session,[id])).toBe(1);
    expect(await toolActionRepository.pending(aliceId,session)).toEqual([]);
  });
  test('a fresh process reconciles approved legacy recovery prompts without assuming the unknown action failed', async () => {
    const { randomUUID }=await import('node:crypto');const { getDb }=await import('@/db/postgres');
    const { permissionRequests }=await import('@/db/schema/permissions');const { toolActions }=await import('@/db/schema/tool-actions');
    const { toolActionRepository }=await import('@/db/repositories/tool-action-repository');const { eq }=await import('drizzle-orm');
    const session=randomUUID();const id=await action(session);const request=randomUUID();
    await getDb().insert(permissionRequests).values({id:request,userId:aliceId,sessionId:session,agentId:'pipeline:old',toolId:'action_recovery',action:'retry',status:'approved',resolvedBy:aliceId,resolvedAt:new Date(),context:{toolName:'Recovery',toolArguments:{previousActions:`- shell__run at ${new Date().toISOString()}: outcome unknown; record ${id}`}}});
    expect(await toolActionRepository.reconcileApproved(aliceId,session,[id])).toBe(1);
    expect(await toolActionRepository.reconcileApproved(aliceId,session,[id])).toBe(0);
    const [row]=await getDb().select().from(toolActions).where(eq(toolActions.id,id));expect(row.reviewId).toBe(request);expect(row.status).toBe('uncertain');
  });
});
