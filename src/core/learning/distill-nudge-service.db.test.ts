/**
 * The distil offer against embedded PGlite: a finished run's recorded events
 * decide the offer, the offer sits on the answer, and each decision is
 * stored. Accepting runs the real distillation and filing path with a
 * scripted background model; nothing else calls a model.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '@/config/schema';
import type { NudgeTurnFacts } from './distill-nudge';

const userId = '77777777-7777-4777-8777-777777777777';
const otherUserId = '88888888-8888-4888-8888-888888888888';

const complete = vi.fn(async (_request: { messages: Array<{ content: string }> }) => ({
  content: JSON.stringify({ name: 'release-checklist', description: 'Cut a release safely', content: '1. Run the tests\n2. Tag\n3. Publish' }),
  finishReason: 'stop',
}));

let learning: Config['learning'];

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-distill-nudge-'));
  process.env.MASTER_KEY ??= randomUUID(); process.env.JWT_SECRET ??= randomUUID(); process.env.SESSION_SECRET ??= randomUUID();
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'distiller' }, { id: otherUserId, username: 'other' }]);
  const registry = await import('@/models/model-registry');
  vi.spyOn(registry, 'getModelRegistry').mockReturnValue({
    getModelForTopic: async (topic: string) => (topic === 'skill_distillation' ? { modelId: 'test-background', name: 'background-test' } : null),
  } as never);
  const client = await import('@/models/litellm-client');
  vi.spyOn(client, 'getLiteLLMClient').mockReturnValue({ complete } as never);
  const { setCapabilitiesForTest } = await import('@/core/capabilities/gates');
  setCapabilitiesForTest({ embedding: false });
  const { getConfig } = await import('@/config');
  learning = getConfig().learning;
});

afterAll(async () => {
  vi.restoreAllMocks();
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

beforeEach(async () => {
  complete.mockClear();
  Object.assign(learning, { distillNudge: true, distillNudgeMinToolCalls: 8, distillNudgeMinDistinctTools: 3, distillNudgeCooldownHours: 24 });
  const { executeRaw } = await import('@/db/postgres');
  await executeRaw(`DELETE FROM kv_store WHERE key LIKE 'learning:distill-nudge:%'`);
  await executeRaw(`DELETE FROM skill_proposals`);
  await executeRaw(`UPDATE users SET preferences = '{}'::jsonb`);
  await executeRaw(`DELETE FROM skill_permissions`);
});

const facts = (over: Partial<NudgeTurnFacts> = {}): NudgeTurnFacts => ({
  trigger: 'user', channel: 'webchat', clientRendersNudge: true, spoken: false, oneShot: false, synthetic: false,
  shared: false, contentStorageOff: false, outcome: 'success', limited: false, replaced: false, ...over,
});

/** A finished run in a fresh session: the request, the answer, and its recorded tool calls. */
async function finishedRun(tools: string[], owner = userId) {
  const { executeRaw, getDb } = await import('@/db/postgres');
  const { messages } = await import('@/db/schema/messages');
  const { agentEventRepository } = await import('@/db/repositories/agent-event-repository');
  const sessionId = randomUUID();
  const runId = `run_${randomUUID()}`;
  const startedAt = new Date(Date.now() - 60_000);
  await executeRaw(`INSERT INTO sessions (id, user_id, channel_type, channel_id) VALUES ('${sessionId}', '${owner}', 'webchat', '${sessionId}')`);
  await getDb().insert(messages).values({ sessionId, role: 'user', content: 'Cut the 2.4 release for me', createdAt: new Date(startedAt.getTime() + 1000) });
  for (const toolName of tools) {
    await agentEventRepository.create({ agentId: 'root-agent', sessionId, userId: owner, runId, type: 'action', data: { type: 'tool_call', toolName } });
  }
  const [answer] = await getDb().insert(messages).values({ sessionId, role: 'assistant', content: 'Released 2.4: tests green, tagged, published.', agentId: 'root-agent' }).returning();
  return { sessionId, runId, startedAt, answerId: answer.id, owner };
}

type Run = Awaited<ReturnType<typeof finishedRun>>;
const COMPLEX = ['run_tests', 'run_tests', 'git_tag', 'git_push', 'npm_publish', 'read_file', 'read_file', 'write_file'];

async function offer(run: Run, over: Partial<NudgeTurnFacts> = {}) {
  const { offerDistillNudge } = await import('./distill-nudge-service');
  return offerDistillNudge({ runId: run.runId, sessionId: run.sessionId, userId: run.owner, rootAgentId: 'root-agent',
    answerMessageId: run.answerId, startedAt: run.startedAt, facts: facts(over) });
}

async function nudgeOf(messageId: string) {
  const { getDb } = await import('@/db/postgres');
  const { messages } = await import('@/db/schema/messages');
  const { eq } = await import('drizzle-orm');
  const [row] = await getDb().select({ metadata: messages.metadata }).from(messages).where(eq(messages.id, messageId));
  return row?.metadata?.skillNudge;
}

describe('the offer', () => {
  test('a complex, successful run is offered on its answer, once per cool-down, without a model call', async () => {
    const { openDistillNudge } = await import('./distill-nudge-service');
    const run = await finishedRun(COMPLEX);
    expect(await offer(run)).toEqual({ messageId: run.answerId });
    expect(await nudgeOf(run.answerId)).toMatchObject({ state: 'offered', runId: run.runId, userId });
    expect(await openDistillNudge(run.sessionId, userId)).toMatchObject({ messageId: run.answerId });
    // Never to someone else.
    expect(await openDistillNudge(run.sessionId, otherUserId)).toBeNull();

    // The user's next qualifying run, in another session, waits for the cool-down.
    const next = await finishedRun(COMPLEX);
    expect(await offer(next)).toBeNull();
    expect(await nudgeOf(next.answerId)).toBeUndefined();
    // Another user's cool-down is their own.
    expect(await offer(await finishedRun(COMPLEX, otherUserId))).not.toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  test('without a cool-down every qualifying run is offered', async () => {
    learning.distillNudgeCooldownHours = 0;
    expect(await offer(await finishedRun(COMPLEX))).not.toBeNull();
    expect(await offer(await finishedRun(COMPLEX))).not.toBeNull();
  });

  test('a simple run is not offered, and does not take the cool-down', async () => {
    expect(await offer(await finishedRun(['read_file', 'read_file']))).toBeNull();
    expect(await offer(await finishedRun(COMPLEX))).not.toBeNull();
  });

  test.each([
    ['a hook', { trigger: 'schedule', channel: 'hook' }],
    ['a cron job', { trigger: 'schedule', channel: 'cron' }],
    ['a heartbeat', { trigger: 'schedule', channel: 'heartbeat' }],
    ['a monitor', { trigger: 'monitor', channel: 'monitor' }],
    ['a webhook', { channel: 'webhook' }],
    ['voice', { spoken: true }],
    ['a messaging channel', { channel: 'telegram', clientRendersNudge: false }],
  ] as const)('a run from %s is never offered', async (_what, over) => {
    const run = await finishedRun(COMPLEX);
    expect(await offer(run, over)).toBeNull();
    expect(await nudgeOf(run.answerId)).toBeUndefined();
    // …and leaves the cool-down for an attended run.
    expect(await offer(await finishedRun(COMPLEX))).not.toBeNull();
  });

  test('a run whose session already produced an open proposal is not offered', async () => {
    const { getDb } = await import('@/db/postgres');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const run = await finishedRun(COMPLEX);
    await getDb().insert(skillProposals).values({ userId, fingerprint: 'f', name: 'earlier', description: 'd', draftPromptTemplate: 'x',
      kind: 'skill', status: 'rejected', rejectedUntil: new Date(Date.now() + 86_400_000), lastExemplarAt: new Date(),
      sourceRef: 'text', sourceRefs: ['text', `learning:job1:session:${run.sessionId}`] });
    expect(await offer(run)).toBeNull();
  });

  test('a run that loaded a skill is not offered', async () => {
    expect(await offer(await finishedRun([...COMPLEX, 'get_skill']))).toBeNull();
  });

  test('a user who said "never" is not offered', async () => {
    const { userRepository } = await import('@/db/repositories/user-repository');
    await userRepository.setDistillNudge(userId, false);
    expect(await offer(await finishedRun(COMPLEX))).toBeNull();
  });

  test('the operator switch turns offers off', async () => {
    learning.distillNudge = false;
    expect(await offer(await finishedRun(COMPLEX))).toBeNull();
  });

  test('an offer lapses when another answer follows it', async () => {
    const { openDistillNudge } = await import('./distill-nudge-service');
    const { getDb } = await import('@/db/postgres');
    const { messages } = await import('@/db/schema/messages');
    const run = await finishedRun(COMPLEX);
    await offer(run);
    await getDb().insert(messages).values({ sessionId: run.sessionId, role: 'assistant', content: 'Anything else?', createdAt: new Date(Date.now() + 1000) });
    expect(await openDistillNudge(run.sessionId, userId)).toBeNull();
  });

  test('an offer that cannot be stored gives the cool-down back', async () => {
    const run = await finishedRun(COMPLEX);
    expect(await offer({ ...run, answerId: '00000000-0000-4000-8000-000000000000' })).toBeNull();
    expect(await offer(await finishedRun(COMPLEX))).not.toBeNull();
  });
});

describe('the decision', () => {
  test('accept distils the run into a pending proposal of its user, once', async () => {
    const { resolveDistillNudge, openDistillNudge } = await import('./distill-nudge-service');
    const { getDb } = await import('@/db/postgres');
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const run = await finishedRun(COMPLEX);
    await offer(run);

    const outcome = await resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept');
    expect(outcome).toMatchObject({ state: 'accepted', distilled: true, status: 'pending' });
    expect(complete).toHaveBeenCalledTimes(1);
    // The run itself is the material: its request, its answer and the tools it used.
    const material = complete.mock.calls[0][0].messages[1].content;
    expect(material).toContain('user: Cut the 2.4 release for me');
    expect(material).toContain('assistant: Released 2.4');
    expect(material).toContain('run_tests, git_tag, git_push, npm_publish, read_file, write_file');

    const proposals = await getDb().select().from(skillProposals);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ id: outcome.proposalId, userId, name: 'release-checklist', status: 'pending', kind: 'skill',
      sourceRef: `session:${run.sessionId}` });
    expect(await nudgeOf(run.answerId)).toMatchObject({ state: 'accepted', proposalId: outcome.proposalId });
    expect(await openDistillNudge(run.sessionId, userId)).toBeNull();

    await expect(resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'decided' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('a failed distillation leaves the offer open to retry', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    const run = await finishedRun(COMPLEX);
    await offer(run);
    complete.mockResolvedValueOnce({ content: 'not json', finishReason: 'stop' });
    await expect(resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'failed' });
    expect(await nudgeOf(run.answerId)).toMatchObject({ state: 'offered' });
    await expect(resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept')).resolves.toMatchObject({ state: 'accepted' });
  });

  test('dismiss is stored, distils nothing, and the same run is never offered again', async () => {
    const { resolveDistillNudge, openDistillNudge } = await import('./distill-nudge-service');
    const run = await finishedRun(COMPLEX);
    await offer(run);
    expect(await resolveDistillNudge(run.sessionId, run.answerId, userId, 'dismiss')).toMatchObject({ state: 'dismissed' });
    expect(await nudgeOf(run.answerId)).toMatchObject({ state: 'dismissed' });
    expect(await openDistillNudge(run.sessionId, userId)).toBeNull();
    await expect(resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'decided' });
    expect(complete).not.toHaveBeenCalled();
  });

  test('never dismisses and turns the offers off for the user', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    const { userRepository } = await import('@/db/repositories/user-repository');
    learning.distillNudgeCooldownHours = 0;
    const run = await finishedRun(COMPLEX);
    await offer(run);
    expect(await resolveDistillNudge(run.sessionId, run.answerId, userId, 'never')).toMatchObject({ state: 'dismissed', optedOut: true });
    expect((await userRepository.findById(userId))?.preferences?.distillNudge).toBe(false);
    expect(await offer(await finishedRun(COMPLEX))).toBeNull();
    // Turned back on, offers resume.
    await userRepository.setDistillNudge(userId, true);
    expect(await offer(await finishedRun(COMPLEX))).not.toBeNull();
  });

  test('only the run\'s user decides', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    const run = await finishedRun(COMPLEX);
    await offer(run);
    await expect(resolveDistillNudge(run.sessionId, run.answerId, otherUserId, 'accept')).rejects.toMatchObject({ code: 'not_found' });
    await expect(resolveDistillNudge(randomUUID(), run.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'not_found' });
    expect(complete).not.toHaveBeenCalled();
  });

  test('a lapsed offer cannot be decided', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    const { getDb } = await import('@/db/postgres');
    const { messages } = await import('@/db/schema/messages');
    const run = await finishedRun(COMPLEX);
    await offer(run);
    await getDb().insert(messages).values({ sessionId: run.sessionId, role: 'assistant', content: 'Anything else?', createdAt: new Date(Date.now() + 1000) });
    await expect(resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'lapsed' });
    expect(complete).not.toHaveBeenCalled();
    expect(await nudgeOf(run.answerId)).toMatchObject({ state: 'offered' });
  });

  test('accepting goes through the tool middleware and is audited as the owner\'s approval', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    const { getDb } = await import('@/db/postgres');
    const { auditLog } = await import('@/db/schema/audit');
    const { and, eq } = await import('drizzle-orm');
    const run = await finishedRun(COMPLEX);
    await offer(run);
    await resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept');
    const rows = await getDb().select({ details: auditLog.details }).from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'permission_granted'), eq(auditLog.resourceId, 'skill-distill.distill')));
    expect(rows.map((row) => row.details)).toContainEqual(expect.objectContaining({
      authorizationSource: `approval:distill-nudge:${run.answerId}`, toolId: 'skill-distill', action: 'distill' }));
  });

  test('a plugin\'s tool:before denial refuses it and leaves the offer open', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    const { getAgentHooks } = await import('@/core/agent/hooks');
    const off = getAgentHooks().register('tool:before', (ctx) => {
      if (ctx.toolId === 'skill-distill') ctx.shortCircuit = { deny: 'no skills from chat today' };
    });
    try {
      const run = await finishedRun(COMPLEX);
      await offer(run);
      await expect(resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'refused' });
      expect(complete).not.toHaveBeenCalled();
      expect(await nudgeOf(run.answerId)).toMatchObject({ state: 'offered' });
    } finally { off(); }
  });

  test('a stored DENY refuses it; a plain ASK is answered by the click; an expired policy is not', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    const { getPermissionManager } = await import('@/security/permissions');
    learning.distillNudgeCooldownHours = 0;
    await getPermissionManager().setPermission(userId, 'skill-distill', 'distill', 'DENY');
    const denied = await finishedRun(COMPLEX);
    await offer(denied);
    await expect(resolveDistillNudge(denied.sessionId, denied.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'refused' });

    await getPermissionManager().setPermission(userId, 'skill-distill', 'distill', 'ASK');
    const asked = await finishedRun(COMPLEX);
    await offer(asked);
    await expect(resolveDistillNudge(asked.sessionId, asked.answerId, userId, 'accept')).resolves.toMatchObject({ state: 'accepted', distilled: true });

    await getPermissionManager().setPermission(userId, 'skill-distill', 'distill', 'ALLOW', { expiresAt: new Date(Date.now() - 60_000) });
    const expired = await finishedRun(COMPLEX);
    await offer(expired);
    await expect(resolveDistillNudge(expired.sessionId, expired.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'refused' });
    expect(await nudgeOf(expired.answerId)).toMatchObject({ state: 'offered' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  test('a cut-off reply closes the offer as failed; so do repeated failures', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    learning.distillNudgeCooldownHours = 0;
    const cut = await finishedRun(COMPLEX);
    await offer(cut);
    complete.mockResolvedValueOnce({ content: '{"name":"rel', finishReason: 'length' });
    await expect(resolveDistillNudge(cut.sessionId, cut.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'failed', final: true });
    expect(await nudgeOf(cut.answerId)).toMatchObject({ state: 'failed', failures: 1 });
    await expect(resolveDistillNudge(cut.sessionId, cut.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'decided' });

    const flaky = await finishedRun(COMPLEX);
    await offer(flaky);
    for (let i = 1; i < 3; i++) {
      complete.mockResolvedValueOnce({ content: 'not json', finishReason: 'stop' });
      await expect(resolveDistillNudge(flaky.sessionId, flaky.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'failed', final: false });
      expect(await nudgeOf(flaky.answerId)).toMatchObject({ state: 'offered', failures: i });
    }
    complete.mockResolvedValueOnce({ content: 'not json', finishReason: 'stop' });
    await expect(resolveDistillNudge(flaky.sessionId, flaky.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'failed', final: true });
    expect(await nudgeOf(flaky.answerId)).toMatchObject({ state: 'failed', failures: 3 });
  });

  test('an error before the model call leaves the offer open, not stuck in accepted', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    const permissions = await import('@/security/permissions');
    const run = await finishedRun(COMPLEX);
    await offer(run);
    const check = vi.spyOn(permissions.getPermissionManager(), 'check').mockRejectedValueOnce(new Error('policy store down'));
    try {
      await expect(resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept')).rejects.toMatchObject({ code: 'failed' });
    } finally { check.mockRestore(); }
    expect(await nudgeOf(run.answerId)).toMatchObject({ state: 'offered' });
    await expect(resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept')).resolves.toMatchObject({ state: 'accepted' });
  });

  test('a long run is handed to the distiller within the bounds, request and answer kept', async () => {
    const { resolveDistillNudge } = await import('./distill-nudge-service');
    const { getDb } = await import('@/db/postgres');
    const { messages } = await import('@/db/schema/messages');
    const { eq } = await import('drizzle-orm');
    const { RUN_MATERIAL_LIMITS } = await import('./distill-nudge');
    const run = await finishedRun(COMPLEX);
    const base = run.startedAt.getTime() + 2000;
    await getDb().insert(messages).values(Array.from({ length: 60 }, (_, i) => ({
      sessionId: run.sessionId, role: 'assistant' as const, content: `progress ${i} ${'x'.repeat(5000)}`, createdAt: new Date(base + i),
      metadata: { kind: 'progress' as const },
    })));
    await getDb().update(messages).set({ createdAt: new Date(Date.now() + 60_000) }).where(eq(messages.id, run.answerId));
    await offer(run);
    await resolveDistillNudge(run.sessionId, run.answerId, userId, 'accept');
    const material = complete.mock.calls[0][0].messages[1].content;
    expect(material.length).toBeLessThanOrEqual(RUN_MATERIAL_LIMITS.totalChars);
    expect(material.startsWith('user: Cut the 2.4 release for me')).toBe(true);
    expect(material).toContain('assistant: Released 2.4');
    expect(material).toContain('progress 59 ');
    expect(material).not.toContain('progress 0 ');
  });
});
