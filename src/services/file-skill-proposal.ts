import { getDb } from '@/db/postgres';
import { skillProposals } from '@/db/schema/skill-proposals';
import { type DedupHit, findExisting } from '@/tools/skill-distill/dedup';
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
