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
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { experts } from '@/db/schema/experts';
import { type SkillProposalRecord, skillProposals } from '@/db/schema/skill-proposals';
import { skills } from '@/db/schema/skills';
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

export interface ApproveOptions {
  /** Restrict to this owner. Omit for an admin/system caller. */
  userId?: string;
  /** Override the proposal's own name / prompt before promoting. */
  name?: string;
  systemPrompt?: string;
  /** Role for an expert promotion. Ignored for a `skill` proposal. */
  role?: string;
}

export type ApproveResult =
  | { promoted: 'skill'; id: string; name: string; record: unknown }
  | { promoted: 'expert'; id: string; name: string; record: unknown }
  | null;

/** A concurrent approval got there first. Reported as "no longer pending". */
class AlreadyResolvedError extends Error {
  constructor() { super('proposal already resolved'); }
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

  // A distilled *procedure* promotes into a skill; a *specialist* into an
  // expert (the default / legacy path).
  if (proposal.kind === 'skill') {
    const skill = await db.transaction(async (tx) => {
      const [created] = await tx.insert(skills).values({
        id: randomUUID(),
        name: opts.name ?? proposal.name,
        description: proposal.description,
        content: opts.systemPrompt ?? proposal.draftPromptTemplate,
        category: 'general',
        isSystem: false,
        userId: proposal.userId,
      }).returning();

      // Filter on `pending`, not just the id: the SELECT above is outside this
      // transaction, so two approvals racing (the REST route and `/proposals
      // approve` are two front doors now) would both read it pending and both
      // insert. Whoever loses the flip finds no row and rolls their insert back.
      const [flipped] = await tx.update(skillProposals)
        .set({ status: 'promoted' })
        .where(and(eq(skillProposals.id, id), eq(skillProposals.status, 'pending')))
        .returning({ id: skillProposals.id });
      if (!flipped) throw new AlreadyResolvedError();
      return created;
    });

    coreLogger.info({ proposalId: id, skillId: skill?.id }, 'Skill proposal promoted to skill');
    return { promoted: 'skill', id: skill.id, name: skill.name, record: skill };
  }

  const expert = await db.transaction(async (tx) => {
    const [created] = await tx.insert(experts).values({
      userId: proposal.userId,
      name: opts.name ?? proposal.name,
      description: proposal.description,
      role: opts.role ?? 'general',
      systemPrompt: opts.systemPrompt ?? proposal.draftPromptTemplate,
      isSystem: false,
    }).returning();

    const [flipped] = await tx.update(skillProposals)
      .set({ status: 'promoted' })
      .where(and(eq(skillProposals.id, id), eq(skillProposals.status, 'pending')))
      .returning({ id: skillProposals.id });
    if (!flipped) throw new AlreadyResolvedError();
    return created;
  });

  coreLogger.info({ proposalId: id, expertId: expert?.id }, 'Skill proposal promoted to expert');
  return { promoted: 'expert', id: expert.id, name: expert.name, record: expert };
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
