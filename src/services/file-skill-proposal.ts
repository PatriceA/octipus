import { createHash } from 'node:crypto';
import { filterPII } from '@/core/agent/pii-filter';
import { getDb } from '@/db/postgres';
import { skillRepository } from '@/db/repositories/skill-repository';
import { type SkillProposalSignal, skillProposals } from '@/db/schema/skill-proposals';
import { assertPatchable, skillContentHash, validateSkillPatch } from '@/skills/patch';
import { getConfig } from '@/config';
import { sessionCountOf } from '@/shared/skill-proposals';
import { type DedupDecision, decideSkillProposal, findProposalByFingerprint } from '@/tools/skill-distill/dedup';
import { initialProposalStatus, learnedSurfaceCap, type MergeResult, mergeIntoProposal, ProposalNotOpenError, promoteIfEligible } from './skill-proposal-merge';
import { surfaceProposal } from './skill-proposal-service';
import { type DistilledSkill, skillFingerprint } from '@/tools/skill-distill/distiller';
import { toolLogger } from '@/utils/logger';

export interface FileSkillProposalOptions {
  /** 'manual': the user asked (`distill_skill`), shown at once and exempt from the caps. */
  origin: 'manual' | 'learning';
  /** The kind of evidence: a user correction is shown at once. */
  signal?: SkillProposalSignal;
  /** An open proposal of the user the reviewer says this extends (`proposal:<id>` or the id). */
  extendsProposalId?: string;
}

/** What filing did, as the distill tool and the learning check report it. */
export interface FileSkillProposalResult {
  /** A proposal exists for it now (filed, or merged into one). */
  distilled: boolean;
  /** No new row: dropped, or merged into an existing proposal. */
  deduped?: boolean;
  /** Merged into the open proposal `proposalId`. */
  merged?: boolean;
  /** The merge model could not be used: only counted, the text is unchanged. */
  mergeDegraded?: boolean;
  proposalId?: string;
  /** Dropped because this live skill covers it. */
  existingSkillId?: string;
  name: string;
  description?: string;
  /** The proposal's status now: 'candidate' waits until it has been seen again. */
  status?: 'pending' | 'candidate';
  message?: string;
  note?: string;
}

/**
 * Shared proposal writer: manual and automatic learning use the same dedup,
 * merge and review path (docs/plans/self-learning-consolidation.md). Without
 * `opts` the proposal is the user's own request (`origin: 'manual'`).
 */
export async function fileSkillProposal(
  distilled: DistilledSkill,
  userId: string,
  sourceRef: string,
  opts: FileSkillProposalOptions = { origin: 'manual' },
): Promise<FileSkillProposalResult> {
  const fingerprint = skillFingerprint(userId, distilled.name);
  // The merge target can be approved, rejected or absorbed between the dedup
  // decision and the write. Deciding once more sees its new state (covered by
  // the live skill, suppressed, redirected, or new); a second miss throws.
  for (let attempt = 1; ; attempt++) {
    const decision = await decideSkillProposal(userId, fingerprint, distilled, { extendsProposalId: opts.extendsProposalId });
    if (decision.action === 'drop') return describeDrop(decision);
    if (decision.action === 'merge') {
      let merge: MergeResult;
      try {
        merge = await mergeIntoProposal(decision.target, { ...distilled, signal: opts.signal ?? null }, sourceRef,
          { allowDistinct: decision.allowDistinct });
      } catch (err) {
        if (!(err instanceof ProposalNotOpenError) || attempt > 1) throw err;
        toolLogger.info({ proposalId: err.proposalId, status: err.status, name: distilled.name, userId },
          'Skill proposal merge target was resolved meanwhile; deciding again');
        continue;
      }
      if (merge.verdict !== 'distinct') return describeMerge(merge, opts.origin);
    }
    return insertProposal(distilled, userId, sourceRef, fingerprint, opts, decision.embedding);
  }
}

async function insertProposal(
  distilled: DistilledSkill,
  userId: string,
  sourceRef: string,
  fingerprint: string,
  opts: FileSkillProposalOptions,
  embedding: number[] | null,
): Promise<FileSkillProposalResult> {
  let status = initialProposalStatus({ origin: opts.origin, signal: opts.signal, recurrenceSessions: getConfig().learning.recurrenceSessions });
  const cap = status === 'pending' && opts.origin === 'learning' ? await learnedSurfaceCap(userId) : null;
  if (cap) status = 'candidate';
  const now = new Date();
  // kind='skill' routes the approve path to create a skill, not an expert.
  const [proposal] = await getDb()
    .insert(skillProposals)
    .values({
      userId,
      fingerprint,
      name: distilled.name,
      description: distilled.description,
      draftPromptTemplate: distilled.content,
      kind: 'skill',
      status,
      sourceRef,
      sourceRefs: [sourceRef],
      exemplarCount: 1,
      signal: opts.signal ?? null,
      embedding,
      surfacedAt: status === 'pending' ? now : null,
      lastExemplarAt: now,
    })
    .returning({ id: skillProposals.id });

  toolLogger.info(
    { proposalId: proposal?.id, name: distilled.name, userId, status, origin: opts.origin, signal: opts.signal, cap },
    'Distilled a skill proposal',
  );
  return {
    distilled: true,
    proposalId: proposal?.id,
    name: distilled.name,
    description: distilled.description,
    status,
    note: status === 'pending'
      ? 'Filed as a pending skill proposal for review (not yet a live skill).'
      : 'Filed as a candidate skill proposal: it is shown for review once it has been seen again (not yet a live skill).',
  };
}

/** A dedup drop as the tool result the model sees — no proposal filed. */
function describeDrop(hit: Extract<DedupDecision, { action: 'drop' }>): FileSkillProposalResult {
  if (hit.reason === 'skill') {
    return {
      distilled: false,
      deduped: true,
      existingSkillId: hit.id,
      name: hit.name,
      message: `Already covered by the existing skill "${hit.name}" — nothing filed. Edit that skill if it needs updating.`,
    };
  }
  return {
    distilled: false,
    deduped: true,
    name: hit.name,
    message: `"${hit.name}" was rejected and stays suppressed until ${hit.until.toISOString().slice(0, 10)} — nothing filed.`,
  };
}

async function describeMerge(merge: Extract<MergeResult, { verdict: 'merged' | 'unchanged' }>, origin: FileSkillProposalOptions['origin']): Promise<FileSkillProposalResult> {
  let proposal = merge.proposal;
  let surfaced = false;
  if (origin === 'manual' && proposal.status === 'candidate') {
    // The user asked for this skill: shown at once, past the recurrence gate and the caps.
    const shown = await surfaceProposal(proposal.id, proposal.userId);
    if (shown) { proposal = shown; surfaced = true; }
  } else {
    const promotion = await promoteIfEligible(proposal);
    if (promotion.promoted) { proposal = promotion.proposal; surfaced = true; }
  }
  const status = proposal.status === 'candidate' ? 'candidate' : 'pending';
  const seen = `seen ${proposal.exemplarCount}× in ${sessionCountOf(proposal.sourceRefs)} session(s)`;
  const text = merge.verdict === 'merged' ? 'its draft now includes this' : 'its draft already covered this';
  return {
    distilled: true,
    deduped: true,
    merged: true,
    ...(merge.mergeDegraded ? { mergeDegraded: true } : {}),
    proposalId: proposal.id,
    name: proposal.name,
    status,
    message: `Merged into the ${status === 'candidate' ? 'candidate' : 'pending'} proposal "${proposal.name}" (${seen}); `
      + (merge.mergeDegraded ? 'the merge model was unavailable, so only the count changed.' : `${text}.`)
      + (surfaced ? ' It is now shown for review.' : ''),
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
    sourceRefs: [sourceRef],
    exemplarCount: 1,
    // Patches are exempt from the recurrence gate and the caps: shown at once.
    surfacedAt: new Date(),
    lastExemplarAt: new Date(),
    targetSkillId: skill.id,
    patchOldText: patch.oldText,
    patchNewText: patch.newText,
    baseContentHash: skillContentHash(content),
  }).returning();

  toolLogger.info({ proposalId: proposal?.id, skillId: skill.id, userId }, 'Filed a skill patch proposal');
  return { proposalId: proposal?.id, name: skill.name, status: 'pending', note: 'Filed as a pending patch proposal for review (the skill is unchanged until approved).' };
}
