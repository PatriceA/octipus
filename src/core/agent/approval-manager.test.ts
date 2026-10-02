/**
 * Agent approvals used to live only in a Map, so a restart lost every pending
 * one and the user's answer came back "Approval request not found". The
 * `agent_approvals` row is now the durable record; these pin that it is
 * written, settled exactly once, and expired — never left dangling — when its
 * waiter is gone.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { AgentContext } from '@/core/types';

const rand = (n: number) => randomBytes(n).toString('hex');
process.env.MASTER_KEY ??= `test-master-${rand(24)}`;
process.env.JWT_SECRET ??= `test-jwt-${rand(24)}`;
process.env.SESSION_SECRET ??= `test-session-${rand(24)}`;
process.env.LOG_LEVEL ??= 'error';

const aliceId = '11111111-1111-1111-1111-111111111111';
const bobId = '22222222-2222-2222-2222-222222222222';

type Mod = typeof import('./approval-manager');
let mod: Mod;
let queryRaw: typeof import('@/db/postgres').queryRaw;
let executeRaw: typeof import('@/db/postgres').executeRaw;

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-approvals-'));

  const db = await import('@/db/postgres');
  await db.initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  queryRaw = db.queryRaw;
  executeRaw = db.executeRaw;

  await executeRaw(
    `INSERT INTO users (id, username, is_admin) VALUES
       ('${aliceId}', 'alice', false),
       ('${bobId}', 'bob', false)
     ON CONFLICT DO NOTHING`,
  );

  mod = await import('./approval-manager');
  const { getNotificationService } = await import('@/core/notification-service');
  vi.spyOn(getNotificationService(), 'notify').mockResolvedValue(undefined);
});

afterEach(async () => {
  await executeRaw('DELETE FROM agent_approvals');
});

function ctx(userId: string, metadata: Record<string, unknown> = {}): AgentContext {
  return {
    id: 'agent-1', sessionId: randomUUID(), userId, topic: 't', model: 'm', role: 'general',
    status: 'running', createdAt: new Date(), updatedAt: new Date(), metadata,
  };
}

async function row(id: string) {
  const { rows } = await queryRaw(`SELECT * FROM agent_approvals WHERE id = '${id}'`);
  return rows[0] as {
    status: string; response: string | null; resolved_by: string | null; user_id: string;
    summary: string; options: string[] | null; boot_id: string;
  } | undefined;
}

/** Start a request and wait until its row is written. */
async function ask(manager: InstanceType<Mod['ApprovalManager']>, context: AgentContext) {
  const answer = manager.requestApproval('Deploy', 'Ship it?', context, () => {}, ['Yes', 'No']) as Promise<Record<string, unknown>>;
  const { id } = manager.getPendingApprovals(context.userId).at(-1)!;
  await vi.waitFor(async () => expect(await row(id)).toBeDefined());
  return { id, answer };
}

/** A pending row with no waiter in this manager; by default from a previous boot. */
async function insertOrphan(bootId = 'previous-boot'): Promise<string> {
  const id = randomUUID();
  await executeRaw(
    `INSERT INTO agent_approvals (id, user_id, agent_id, boot_id, summary, question)
     VALUES ('${id}', '${aliceId}', 'dead-agent', '${bootId}', 'Old', 'Still there?')`,
  );
  return id;
}

describe('ApprovalManager persistence', () => {
  test('a request is written as a pending row', async () => {
    const manager = new mod.ApprovalManager();
    const { id, answer } = await ask(manager, ctx(aliceId));

    expect(await row(id)).toMatchObject({ status: 'pending', user_id: aliceId, summary: 'Deploy', options: ['Yes', 'No'] });

    await manager.resolveApproval(id, false);
    await answer;
  });

  test('resolving settles the waiter and records the answer', async () => {
    const manager = new mod.ApprovalManager();
    const { id, answer } = await ask(manager, ctx(aliceId));

    expect(await manager.resolveApproval(id, true, 'Yes', { forUserId: aliceId, resolvedBy: aliceId })).toBe(true);
    expect(await answer).toMatchObject({ approved: true, response: 'Yes', requestId: id });
    expect(await row(id)).toMatchObject({ status: 'approved', response: 'Yes', resolved_by: aliceId });
    expect(manager.getPendingApprovals()).toEqual([]);
  });

  test('a second answer is refused', async () => {
    const manager = new mod.ApprovalManager();
    const { id, answer } = await ask(manager, ctx(aliceId));

    const [first, second] = await Promise.all([
      manager.resolveApproval(id, false, 'No'),
      manager.resolveApproval(id, true, 'Yes'),
    ]);
    expect([first, second]).toEqual([true, false]);
    expect(await manager.resolveApproval(id, true)).toBe(false);
    expect(await answer).toMatchObject({ approved: false });
    expect((await row(id))?.status).toBe('denied');
  });

  test('an answer that could not be recorded is not expired by a second answer', async () => {
    const manager = new mod.ApprovalManager();
    const { id, answer } = await ask(manager, ctx(aliceId));

    // Every UPDATE through the manager fails; reads and inserts still work.
    const { getDb } = await import('@/db/postgres');
    const real = getDb();
    Object.defineProperty(manager, 'db', {
      configurable: true,
      get: () => new Proxy(real, {
        get: (target, key) => {
          if (key === 'update') return () => { throw new Error('db unavailable'); };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    });

    expect(await manager.resolveApproval(id, true, 'Yes')).toBe(true);
    expect(await answer).toMatchObject({ approved: true, response: 'Yes' });
    expect((await row(id))?.status).toBe('pending');

    expect(await manager.resolveApprovalDetailed(id, false, undefined, { forUserId: bobId })).toEqual({ status: 'not_found' });
    expect(await manager.resolveApprovalDetailed(id, false)).toEqual({ status: 'already_resolved' });
    expect((await row(id))?.status).toBe('pending');
  });

  test('another user cannot answer it', async () => {
    const manager = new mod.ApprovalManager();
    const { id, answer } = await ask(manager, ctx(aliceId));

    expect(await manager.resolveApprovalDetailed(id, true, undefined, { forUserId: bobId })).toEqual({ status: 'not_found' });
    expect((await row(id))?.status).toBe('pending');

    await manager.resolveApproval(id, false);
    await answer;
  });

  test('a timeout expires the row', async () => {
    const manager = new mod.ApprovalManager();
    const answer = manager.requestApproval('Deploy', 'Ship it?', ctx(aliceId, { approvalTimeoutMs: 50 }), () => {});
    const { id } = manager.getPendingApprovals()[0];

    expect(await answer).toMatchObject({ approved: false, reason: 'Approval timed out' });
    await vi.waitFor(async () => expect((await row(id))?.status).toBe('expired'));
    expect(await manager.resolveApprovalDetailed(id, true))
      .toEqual({ status: 'timed_out', message: mod.TIMED_OUT_APPROVAL_MESSAGE });
  });

  test('an answer that beats the timeout\'s expiry write is told it timed out, not that the server restarted', async () => {
    const manager = new mod.ApprovalManager();
    const { id: live, answer } = await ask(manager, ctx(aliceId));
    const thisBoot = (await row(live))!.boot_id;
    await manager.resolveApproval(live, false);
    await answer;

    // The timeout has dropped the waiter but its expiry has not landed yet.
    const dropped = await insertOrphan(thisBoot);
    expect(await manager.resolveApprovalDetailed(dropped, true))
      .toEqual({ status: 'timed_out', message: mod.TIMED_OUT_APPROVAL_MESSAGE });
    expect(await row(dropped)).toMatchObject({ status: 'expired', response: mod.TIMED_OUT_APPROVAL_MESSAGE });
  });
});

describe('orphaned approvals', () => {
  test('the boot sweep expires rows left pending by a previous process', async () => {
    const orphan = await insertOrphan();

    expect(await mod.releaseOrphanedApprovals()).toBe(1);
    expect((await row(orphan))?.status).toBe('expired');
    expect(await mod.releaseOrphanedApprovals()).toBe(0);

    // Answered after the sweep, it still explains the restart.
    expect(await new mod.ApprovalManager().resolveApprovalDetailed(orphan, true))
      .toEqual({ status: 'orphaned', message: mod.ORPHANED_APPROVAL_MESSAGE });
  });

  test('answering one expires it and says why, instead of "not found"', async () => {
    const orphan = await insertOrphan();
    const manager = new mod.ApprovalManager();

    expect(await manager.resolveApprovalDetailed(orphan, true, undefined, { forUserId: bobId })).toEqual({ status: 'not_found' });
    expect(await manager.resolveApprovalDetailed(orphan, true, undefined, { forUserId: aliceId }))
      .toEqual({ status: 'orphaned', message: mod.ORPHANED_APPROVAL_MESSAGE });
    expect((await row(orphan))?.status).toBe('expired');
    expect(await manager.resolveApprovalDetailed(orphan, true))
      .toEqual({ status: 'orphaned', message: mod.ORPHANED_APPROVAL_MESSAGE });
    expect(await manager.resolveApprovalDetailed(randomUUID(), true)).toEqual({ status: 'not_found' });
  });
});

describe('typed answers', () => {
  test('a bare word answers; a request that starts like one does not', () => {
    for (const yes of ['yes', 'Yes!', 'go ahead', 'lgtm', 'proceed', 'yes, ship it', 'yeah sure']) expect(mod.replyAnswer(yes)).toBe('approve');
    for (const no of ['no', 'stop', 'Cancel.', 'abort', 'no, not yet', "don't"]) expect(mod.replyAnswer(no)).toBe('deny');
    for (const request of ['Cancel my 3pm with Bob', 'stop the staging server', 'confirm the booking for Friday', 'accept the invite', 'what next?']) {
      expect(mod.replyAnswer(request)).toBeNull();
    }
  });

  test('option labels still read as a refusal when worded as one', () => {
    expect(mod.approvalAnswer('Stop Pipeline')).toBe('deny');
    expect(mod.approvalAnswer('Abort Pipeline')).toBe('deny');
    expect(mod.approvalAnswer('Continue Anyway')).toBeNull();
  });
});
