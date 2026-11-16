/**
 * Distilled-skill proposals: list, approve (promote), reject.
 *
 * One implementation shared by the REST route and the gateway `/proposals`
 * command. The promotion is the part that must not be copied — it inserts a
 * skill or an expert and flips the proposal status in the SAME transaction,
 * so a failure can't leave an orphan row with the proposal still `pending`
 * (re-approvable → duplicates).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type SkillProposalRecord, skillProposals } from '@/db/schema/skill-proposals';
import { skills } from '@/db/schema/skills';
import { applySkillPatch, assertPatchable, SkillPatchError, skillContentHash } from '@/skills/patch';
import { normalizeSkillName } from '@/tools/skill-distill/distiller';
import { coreLogger } from '@/utils/logger';

/** 90 days — how long a rejected proposal stays suppressed. */
const REJECT_SUPPRESSION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Pending proposals, oldest first so a positional index (`/proposals approve 1`)
 * is stable between the list and the approval that follows it.
 *
 * `userId` scopes the list to its owner. Passing `undefined` returns every
 * user's — only for an admin/system caller.
 */
export async function listPendingProposals(userId?: string): Promise<SkillProposalRecord[]> {
  const db = getDb();
  const where = userId
    ? and(eq(skillProposals.status, 'pending'), eq(skillProposals.userId, userId))
    : eq(skillProposals.status, 'pending');
  return db.select().from(skillProposals).where(where).orderBy(asc(skillProposals.createdAt));
}

/**
 * Each pending patch proposal with its skill's current content and whether
 * that content still has the hash the patch was made against, so a reviewer
 * sees the change in context and knows up front an approval would be refused.
 * Other proposals pass through unchanged.
 */
export async function withPatchContext(proposals: SkillProposalRecord[]): Promise<Array<SkillProposalRecord & { currentContent?: string | null; stale?: boolean }>> {
  const ids = [...new Set(proposals.flatMap(p => p.kind === 'patch' && p.targetSkillId ? [p.targetSkillId] : []))];
  if (!ids.length) return proposals;
  const rows = await getDb().select({ id: skills.id, content: skills.content }).from(skills).where(inArray(skills.id, ids));
  const content = new Map(rows.map(row => [row.id, row.content]));
  return proposals.map(p => {
    if (p.kind !== 'patch' || !p.targetSkillId) return p;
    const current = content.get(p.targetSkillId) ?? null;
    return { ...p, currentContent: current, stale: skillContentHash(current) !== p.baseContentHash };
  });
}

export interface ApproveOptions {
  /** Restrict to this owner. Omit for an admin/system caller. */
  userId?: string;
  /** Override the proposal's own name / prompt before promoting. */
  name?: string;
  systemPrompt?: string;
  /**
   * Who approves. When it is the proposal's owner and they override the name
   * or prompt, the skill holds their own words: it is stamped owner-edited
   * (`ownerEditedAt`) and so locked against learning patches.
   */
  actorId?: string;
}

export type ApproveResult =
  | { promoted: 'skill'; id: string; name: string; record: unknown }
  | null;

/** A concurrent approval got there first. Reported as "no longer pending". */
class AlreadyResolvedError extends Error {
  constructor() { super('proposal already resolved'); }
}

/**
 * The proposal is pending but cannot be applied as it stands; it stays
 * pending for the owner to reject. `stale`: the skill changed since the patch
 * was made. `locked`: the owner edited the skill. `missing`: the skill is
 * gone. `invalid`: the patch no longer fits the skill (archived, no longer
 * the owner's, malformed). `override`: a patch takes no name/content override.
 */
export class ProposalRefusedError extends Error {
  constructor(readonly code: 'stale' | 'locked' | 'missing' | 'override' | 'invalid', message: string) { super(message); }
}

/** Promote a pending proposal. Returns null when it isn't pending (or isn't the caller's). */
export async function approveProposal(id: string, opts: ApproveOptions = {}): Promise<ApproveResult> {
  try {
    return await promote(id, opts);
  } catch (err) {
    if (err instanceof AlreadyResolvedError) return null;
    throw err;
  }
}

async function promote(id: string, opts: ApproveOptions): Promise<ApproveResult> {
  const db = getDb();
  const filters = [eq(skillProposals.id, id), eq(skillProposals.status, 'pending')];
  if (opts.userId) filters.push(eq(skillProposals.userId, opts.userId));

  const [proposal] = await db.select().from(skillProposals).where(and(...filters)).limit(1);
  if (!proposal) return null;
  if (proposal.kind === 'patch') return applyPatch(proposal, opts);

  // Every proposal promotes into a SKILL. A proposal used to be able to become
  // an expert instead — a row carrying a prompt and a role — which is the layer
  // that has been retired: a distilled procedure is a skill, and a skill is the
  // thing an agent can actually load. `kind` is kept on the row because it
  // records what the distiller thought it was proposing; it no longer decides
  // where the proposal lands.
  {
    let merged = false;
    const name = opts.name ?? proposal.name;
    const content = opts.systemPrompt ?? proposal.draftPromptTemplate;
    const normalized = normalizeSkillName(name);
    const ownerWritten = (opts.name !== undefined || opts.systemPrompt !== undefined) && opts.actorId === proposal.userId;

    const skill = await db.transaction(async (tx) => {
      // Approving a proposal for a skill the user already has updates that
      // skill rather than filing a second row under the same name. Looked up
      // INSIDE the transaction: read outside, the row could be deleted before
      // the update, which would match nothing and still flip the proposal to
      // `promoted` — a proposal that can never be approved again and no skill
      // to show for it. A name that normalizes to nothing ('---') matches
      // every other such name, so it never merges.
      const [duplicate] = normalized
        ? await tx
            .select({ id: skills.id, ownerEditedAt: skills.ownerEditedAt })
            .from(skills)
            .where(and(
              eq(skills.userId, proposal.userId),
              isNull(skills.archivedAt),
              sql`trim(both '-' from lower(regexp_replace(${skills.name}, '[^a-zA-Z0-9]+', '-', 'g'))) = ${normalized}`,
            ))
            .limit(1)
            // Held until commit: an owner edit landing between this read and
            // the merge below waits, and is not overwritten.
            .for('update')
        : [];

      // Merging would overwrite a skill the owner wrote: the owner-edit lock
      // holds against this automatic update too. Approving under another
      // name (`opts.name`) still creates a separate skill.
      if (duplicate?.ownerEditedAt) {
        throw new ProposalRefusedError('locked', `You edited the existing skill "${name}", so this proposal will not overwrite it. Reject it, or approve it under another name.`);
      }

      const [created] = duplicate
        ? await tx.update(skills)
            .set({
              name,
              description: proposal.description,
              content,
              // Name/description changed, so the stored vector no longer
              // describes this row — same contract SkillRepository.update
              // enforces. Left stale, discovery and the distiller's own
              // near-duplicate check would compare against the old text.
              descriptionEmbedding: null,
              descriptionHash: null,
              updatedAt: new Date(),
              ...(ownerWritten ? { ownerEditedAt: new Date() } : {}),
            })
            .where(and(eq(skills.id, duplicate.id), isNull(skills.ownerEditedAt)))
            .returning()
        : await tx.insert(skills).values({
            id: randomUUID(),
            name,
            description: proposal.description,
            content,
            category: 'general',
            isSystem: false,
            userId: proposal.userId,
            ownerEditedAt: ownerWritten ? new Date() : null,
          }).returning();

      // The update matched nothing (row deleted mid-transaction) — roll back
      // rather than promote a proposal into thin air.
      if (!created) throw new AlreadyResolvedError();
      merged = Boolean(duplicate);

      // Filter on `pending`, not just the id: the SELECT above is outside this
      // transaction, so two approvals racing (the REST route and `/proposals
      // approve` are two front doors now) would both read it pending and both
      // insert. Whoever loses the flip finds no row and rolls their insert back.
      const [flipped] = await tx.update(skillProposals)
        .set({ status: 'promoted', promotedSkillId: created.id })
        .where(and(eq(skillProposals.id, id), eq(skillProposals.status, 'pending')))
        .returning({ id: skillProposals.id });
      if (!flipped) throw new AlreadyResolvedError();
      return created;
    });

    coreLogger.info(
      { proposalId: id, skillId: skill?.id, merged },
      merged ? 'Skill proposal merged into existing skill' : 'Skill proposal promoted to skill',
    );
    return { promoted: 'skill', id: skill.id, name: skill.name, record: skill };
  }

}

/**
 * Apply an approved patch proposal (src/skills/patch.ts) in one transaction:
 * the skill must still be a learned skill of the proposal's owner, unedited
 * by them, with exactly the content the patch was made against.
 */
async function applyPatch(proposal: SkillProposalRecord, opts: ApproveOptions): Promise<ApproveResult> {
  if (opts.name !== undefined || opts.systemPrompt !== undefined) {
    throw new ProposalRefusedError('override', 'A patch proposal is approved as proposed; it takes no name or content override.');
  }
  if (!proposal.targetSkillId || proposal.patchOldText == null || proposal.patchNewText == null || !proposal.baseContentHash) {
    throw new ProposalRefusedError('invalid', 'This patch proposal is incomplete; reject it.');
  }
  const { targetSkillId, patchOldText, patchNewText, baseContentHash } = proposal;
  const skill = await getDb().transaction(async (tx) => {
    // Locked until commit, so an owner edit cannot land between these checks
    // and the write; the write re-states them anyway (below).
    const [current] = await tx.select().from(skills).where(eq(skills.id, targetSkillId)).limit(1).for('update');
    try {
      assertPatchable(current, proposal.userId);
    } catch (err) {
      if (!(err instanceof SkillPatchError)) throw err;
      throw new ProposalRefusedError(err.code === 'locked' || err.code === 'missing' ? err.code : 'invalid', `${err.message}; reject this patch.`);
    }
    if (skillContentHash(current.content) !== baseContentHash) {
      throw new ProposalRefusedError('stale', 'The skill changed after this patch was proposed, so it was not applied. Reject it; a later learning check can propose a patch against the current text.');
    }
    let content: string;
    try {
      content = applySkillPatch(current.content ?? '', patchOldText, patchNewText);
    } catch (err) {
      if (!(err instanceof SkillPatchError)) throw err;
      throw new ProposalRefusedError('invalid', `${err.message}; reject this patch.`);
    }
    // Content only: name and description, and so the stored embedding, stay.
    // Written only while the content is still what was checked and nobody
    // has stamped the lock.
    const [updated] = await tx.update(skills).set({ content, updatedAt: new Date() })
      .where(and(eq(skills.id, current.id), isNull(skills.ownerEditedAt),
        current.content === null ? isNull(skills.content) : eq(skills.content, current.content)))
      .returning();
    if (!updated) {
      throw new ProposalRefusedError('stale', 'The skill changed while this patch was being applied, so it was not applied. Reject it.');
    }
    const [flipped] = await tx.update(skillProposals)
      .set({ status: 'promoted', promotedSkillId: updated.id })
      .where(and(eq(skillProposals.id, proposal.id), eq(skillProposals.status, 'pending')))
      .returning({ id: skillProposals.id });
    if (!flipped) throw new AlreadyResolvedError();
    return updated;
  });
  coreLogger.info({ proposalId: proposal.id, skillId: skill.id }, 'Skill patch proposal applied');
  return { promoted: 'skill', id: skill.id, name: skill.name, record: skill };
}

/**
 * Reject a pending proposal and suppress the same distillation for 90 days.
 * Returns the suppression date, or null when the proposal isn't pending.
 */
export async function rejectProposal(id: string, userId?: string): Promise<Date | null> {
  const db = getDb();
  const filters = [eq(skillProposals.id, id), eq(skillProposals.status, 'pending')];
  if (userId) filters.push(eq(skillProposals.userId, userId));

  const rejectedUntil = new Date(Date.now() + REJECT_SUPPRESSION_MS);
  const updated = await db
    .update(skillProposals)
    .set({ status: 'rejected', rejectedUntil })
    .where(and(...filters))
    .returning({ id: skillProposals.id });

  return updated.length > 0 ? rejectedUntil : null;
}
