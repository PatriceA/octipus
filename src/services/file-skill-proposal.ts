import { createHash } from 'node:crypto';
import { filterPII } from '@/core/agent/pii-filter';
import { getDb } from '@/db/postgres';
import { skillRepository } from '@/db/repositories/skill-repository';
import { skillProposals } from '@/db/schema/skill-proposals';
import { assertPatchable, skillContentHash, validateSkillPatch } from '@/skills/patch';
import { type DedupHit, findExisting, findProposalByFingerprint } from '@/tools/skill-distill/dedup';
import { type DistilledSkill, skillFingerprint } from '@/tools/skill-distill/distiller';
import { toolLogger } from '@/utils/logger';

/** Shared proposal writer: manual and automatic learning use the same dedup and review path. */
export async function fileSkillProposal(distilled: DistilledSkill, userId: string, sourceRef: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const fingerprint = skillFingerprint(userId, distilled.name);
  const existing = await findExisting(userId, fingerprint, distilled);
  if (existing) return describeExisting(existing);

  // 5. File the proposal (pending review). kind='skill' routes the approve
  //    path to create a skill, not an expert.
  const [proposal] = await db
    .insert(skillProposals)
    .values({
      userId,
      fingerprint,
      name: distilled.name,
      description: distilled.description,
      draftPromptTemplate: distilled.content,
      kind: 'skill',
      sourceRef,
      lastExemplarAt: new Date(),
    })
    .returning();

  toolLogger.info(
    { proposalId: proposal?.id, name: distilled.name, userId },
    'Distilled a skill proposal',
  );
  return {
    distilled: true,
    proposalId: proposal?.id,
    name: distilled.name,
    description: distilled.description,
    status: 'pending',
    note: 'Filed as a pending skill proposal for review (not yet a live skill).',
  };
}

/** Turn a dedup hit into the tool result the model sees — no proposal filed. */
function describeExisting(hit: DedupHit): Record<string, unknown> {
  if (hit.kind === 'skill') {
    return {
      distilled: false,
      deduped: true,
      existingSkillId: hit.id,
      name: hit.name,
      message: `Already covered by the existing skill "${hit.name}" — nothing filed. Edit that skill if it needs updating.`,
    };
  }
  if (hit.kind === 'suppressed') {
    return {
      distilled: false,
      deduped: true,
      name: hit.name,
      message: `"${hit.name}" was rejected and stays suppressed until ${hit.until.toISOString().slice(0, 10)} — nothing filed.`,
    };
  }
  return {
    distilled: true,
    deduped: true,
    proposalId: hit.id,
    name: hit.name,
    status: 'pending',
    message: `An equivalent proposal ("${hit.name}") is already pending review.`,
  };
}

export interface SkillPatchInput { skillId: string; oldText: string; newText: string; reason: string }

/**
 * File a pending patch proposal against a learned skill (src/skills/patch.ts).
 * Throws `SkillPatchError` when the skill is not a patchable learned skill of
 * `userId` (system, mounted, someone else's, archived, owner-edited) or when
 * the patch fails the exactly-once, size or PII checks. The proposal records
 * the content hash it was made against; approval refuses once that changed.
 */
export async function fileSkillPatchProposal(patch: SkillPatchInput, userId: string, sourceRef: string): Promise<Record<string, unknown>> {
  const skill = await skillRepository.findById(patch.skillId);
  assertPatchable(skill, userId);
  const content = skill.content ?? '';

  const fingerprint = createHash('sha256')
    .update(`${userId}:patch:${skill.id}:${patch.oldText}\u0000${patch.newText}`).digest('hex');
  const existing = await findProposalByFingerprint(userId, fingerprint);
  if (existing?.kind === 'pending') {
    return { deduped: true, proposalId: existing.id, name: skill.name, status: 'pending', message: 'The same patch is already pending review.' };
  }
  if (existing?.kind === 'suppressed') {
    return { deduped: true, name: skill.name, message: `The same patch was rejected and stays suppressed until ${existing.until.toISOString().slice(0, 10)} — nothing filed.` };
  }
  // Approved before: filing it again would apply it twice where newText
  // contains oldText (validateSkillPatch catches most of those too).
  if (existing?.kind === 'promoted') {
    return { deduped: true, name: skill.name, message: 'The same patch was already approved — nothing filed.' };
  }
  const patched = validateSkillPatch(content, patch.oldText, patch.newText);

  const [proposal] = await getDb().insert(skillProposals).values({
    userId,
    fingerprint,
    name: skill.name,
    description: filterPII(patch.reason).filtered,
    // The skill as it would read after approval — what an older client that
    // only shows the draft displays. Approval recomputes it from the stored
    // passages after re-checking `baseContentHash`.
    draftPromptTemplate: patched,
    kind: 'patch',
    sourceRef,
    lastExemplarAt: new Date(),
    targetSkillId: skill.id,
    patchOldText: patch.oldText,
    patchNewText: patch.newText,
    baseContentHash: skillContentHash(content),
  }).returning();

  toolLogger.info({ proposalId: proposal?.id, skillId: skill.id, userId }, 'Filed a skill patch proposal');
  return { proposalId: proposal?.id, name: skill.name, status: 'pending', note: 'Filed as a pending patch proposal for review (the skill is unchanged until approved).' };
}
