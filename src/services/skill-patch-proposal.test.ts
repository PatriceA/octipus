/**
 * Patch proposals for learned skills against embedded PGlite: exactly-once
 * filing, the content hash re-checked at approval (stale refusal), the
 * owner-edit lock, and the curator/learning reads that honour it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const userId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const content = '1. Build the image.\n2. Push it.\n3. Restart the service.\n4. Push it.\n';

beforeAll(async () => {
  process.env.STORAGE_MODE = 'embedded';
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'octipus-skill-patch-'));
  const { initializeDb } = await import('@/db/postgres');
  await initializeDb();
  const { runMigrations } = await import('@/db/migrate');
  await runMigrations();
  const { seedUsers } = await import('@/test-helpers/multiuser-fixtures');
  await seedUsers([{ id: userId, username: 'patcher' }, { id: otherId, username: 'other' }]);
});

afterAll(async () => {
  const { closeDb } = await import('@/db/postgres');
  await closeDb();
});

async function db() {
  const { getDb } = await import('@/db/postgres');
  return getDb();
}

async function seedSkill(overrides: Record<string, unknown> = {}): Promise<string> {
  const { skills } = await import('@/db/schema/skills');
  const id = randomUUID();
  await (await db()).insert(skills).values({ id, name: `deploy-${id.slice(0, 6)}`, description: 'Deploy the service', content, userId, ...overrides });
  return id;
}

async function readSkill(id: string) {
  const { eq } = await import('drizzle-orm');
  const { skills } = await import('@/db/schema/skills');
  const [row] = await (await db()).select().from(skills).where(eq(skills.id, id));
  return row;
}

async function readProposal(id: string) {
  const { eq } = await import('drizzle-orm');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const [row] = await (await db()).select().from(skillProposals).where(eq(skillProposals.id, id));
  return row;
}

async function file(skillId: string, oldText: string, newText: string) {
  const { fileSkillPatchProposal } = await import('@/services/file-skill-proposal');
  return fileSkillPatchProposal({ skillId, oldText, newText, reason: 'The untagged push failed' }, userId, 'learning:test');
}

beforeEach(async () => {
  const { skills } = await import('@/db/schema/skills');
  const { skillProposals } = await import('@/db/schema/skill-proposals');
  const { agentEvents } = await import('@/db/schema/agent-events');
  const conn = await db();
  await conn.delete(skillProposals);
  await conn.delete(skills);
  await conn.delete(agentEvents);
});

describe('filing a patch proposal', () => {
  test('records a pending patch with the base content hash; the skill is unchanged', async () => {
    const { skillContentHash } = await import('@/skills/patch');
    const skillId = await seedSkill();
    const result = await file(skillId, '2. Push it.', '2. Push it with --tag.');
    const proposal = await readProposal(result.proposalId as string);
    expect(proposal).toMatchObject({
      kind: 'patch', status: 'pending', targetSkillId: skillId, patchOldText: '2. Push it.', patchNewText: '2. Push it with --tag.',
      baseContentHash: skillContentHash(content), description: 'The untagged push failed',
    });
    expect(proposal.draftPromptTemplate).toContain('2. Push it with --tag.\n3.');
    expect((await readSkill(skillId)).content).toBe(content);
    expect(await file(skillId, '2. Push it.', '2. Push it with --tag.')).toMatchObject({ deduped: true, proposalId: proposal.id });
  });

  test('refuses zero and multiple matches, PII, and skills that are not the owner\'s learned skills', async () => {
    const skillId = await seedSkill();
    await expect(file(skillId, '5. Celebrate.', 'x')).rejects.toMatchObject({ code: 'not_found' });
    await expect(file(skillId, 'Push it.', 'Push it with --tag.')).rejects.toMatchObject({ code: 'ambiguous' });
    await expect(file(skillId, '2. Push it.', '2. Push it and mail ops@example.com.')).rejects.toMatchObject({ code: 'pii' });
    await expect(file(await seedSkill({ isSystem: true, userId: null }), '2. Push it.', 'x')).rejects.toMatchObject({ code: 'not_patchable' });
    await expect(file(await seedSkill({ userId: otherId }), '2. Push it.', 'x')).rejects.toMatchObject({ code: 'not_patchable' });
    await expect(file('external:user:deploy', '2. Push it.', 'x')).rejects.toMatchObject({ code: 'missing' });
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    expect(await (await db()).select().from(skillProposals)).toHaveLength(0);
  });
});

describe('approving a patch proposal', () => {
  test('applies the replacement when the skill is unchanged', async () => {
    const { approveProposal } = await import('@/services/skill-proposal-service');
    const skillId = await seedSkill();
    const { proposalId } = await file(skillId, '3. Restart the service.', '3. Restart the service and wait for /health.');
    expect(await approveProposal(proposalId as string, { userId })).toMatchObject({ promoted: 'skill', id: skillId });
    expect((await readSkill(skillId)).content).toBe(content.replace('3. Restart the service.', '3. Restart the service and wait for /health.'));
    expect((await readProposal(proposalId as string)).status).toBe('promoted');
  });

  test('refuses as stale once the skill changed since the patch was made, and leaves it pending', async () => {
    const { approveProposal, ProposalRefusedError } = await import('@/services/skill-proposal-service');
    const skillId = await seedSkill();
    const first = await file(skillId, '2. Push it.', '2. Push it with --tag.');
    const second = await file(skillId, '1. Build the image.', '1. Build the image with --pull.');
    await approveProposal(first.proposalId as string, { userId });
    const changed = (await readSkill(skillId)).content;
    const refusal = await approveProposal(second.proposalId as string, { userId }).catch(err => err);
    expect(refusal).toBeInstanceOf(ProposalRefusedError);
    expect(refusal.code).toBe('stale');
    expect((await readSkill(skillId)).content).toBe(changed);
    expect((await readProposal(second.proposalId as string)).status).toBe('pending');
  });

  test('takes no name or content override', async () => {
    const { approveProposal } = await import('@/services/skill-proposal-service');
    const { proposalId } = await file(await seedSkill(), '2. Push it.', '2. Push it with --tag.');
    await expect(approveProposal(proposalId as string, { userId, systemPrompt: 'other' })).rejects.toMatchObject({ code: 'override' });
  });
});

describe('the owner-edit lock', () => {
  test('an owner edit through the API stamps the lock; the agent tool does not', async () => {
    const { updateSkill } = await import('@/skills/update');
    const skillId = await seedSkill();
    await updateSkill(skillId, { description: 'Deploy, by the agent' }, userId);
    expect((await readSkill(skillId)).ownerEditedAt).toBeNull();
    await updateSkill(skillId, { content: `${content}5. Check logs.\n` }, userId, { ownerEdit: true });
    expect((await readSkill(skillId)).ownerEditedAt).toBeInstanceOf(Date);
  });

  test('no patch is filed against an owner-edited skill, and a pending one is refused on approval', async () => {
    const { updateSkill } = await import('@/skills/update');
    const { approveProposal } = await import('@/services/skill-proposal-service');
    const skillId = await seedSkill();
    const pending = await file(skillId, '2. Push it.', '2. Push it with --tag.');
    await updateSkill(skillId, { description: 'Deploy (edited)' }, userId, { ownerEdit: true });
    await expect(file(skillId, '1. Build the image.', '1. Build it.')).rejects.toMatchObject({ code: 'locked' });
    await expect(approveProposal(pending.proposalId as string, { userId })).rejects.toMatchObject({ code: 'locked' });
    expect((await readSkill(skillId)).content).toBe(content);
  });

  test('a new-skill proposal does not merge into an owner-edited skill of the same name', async () => {
    const { skillProposals } = await import('@/db/schema/skill-proposals');
    const { approveProposal } = await import('@/services/skill-proposal-service');
    const skillId = await seedSkill({ name: 'Token Rotation', ownerEditedAt: new Date() });
    const [proposal] = await (await db()).insert(skillProposals).values({
      userId, fingerprint: randomUUID(), name: 'token-rotation', description: 'rotate', draftPromptTemplate: 'new steps', kind: 'skill', lastExemplarAt: new Date(),
    }).returning();
    await expect(approveProposal(proposal.id, { userId })).rejects.toMatchObject({ code: 'locked' });
    expect((await readSkill(skillId)).content).toBe(content);
    expect(await approveProposal(proposal.id, { userId, name: 'token-rotation-v2' })).toMatchObject({ name: 'token-rotation-v2' });
  });

  test('the curator\'s stale scan skips owner-edited skills and lists least recently used first', async () => {
    const { skillRepository } = await import('@/db/repositories/skill-repository');
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const older = new Date(Date.now() - 300 * 24 * 60 * 60 * 1000);
    const locked = await seedSkill({ lastUsedAt: older, ownerEditedAt: new Date() });
    const used = await seedSkill({ lastUsedAt: old });
    const never = await seedSkill();
    const lessUsed = await seedSkill({ lastUsedAt: older });
    const stale = (await skillRepository.findStale(90)).map(skill => skill.id);
    expect(stale).toEqual([never, lessUsed, used]);
    expect(stale).not.toContain(locked);
    await skillRepository.recordUsage([never]);
    const row = await readSkill(never);
    expect(row.usageCount).toBe(1);
    expect(row.lastUsedAt).toBeInstanceOf(Date);
  });
});

describe('learning review targets', () => {
  test('offers only unlocked learned skills that the session\'s events name', async () => {
    const { agentEvents } = await import('@/db/schema/agent-events');
    const { gatherPatchableSkills } = await import('@/core/learning/evidence');
    const referenced = await seedSkill();
    const locked = await seedSkill({ ownerEditedAt: new Date() });
    await seedSkill();
    const sessionId = randomUUID();
    await (await db()).insert(agentEvents).values([referenced, locked].map(id => ({
      agentId: 'agent-1', sessionId, userId, type: 'action', data: { toolName: 'get_skill', args: { skill_id: id } }, createdAt: new Date(Date.now() - 1000),
    })));
    const offered = await gatherPatchableSkills(userId, sessionId, new Date());
    expect(offered.map(skill => skill.id)).toEqual([referenced]);
    expect(offered[0].content).toBe(content);
    expect(await gatherPatchableSkills(userId, sessionId, new Date(Date.now() - 60_000))).toEqual([]);
  });
});
