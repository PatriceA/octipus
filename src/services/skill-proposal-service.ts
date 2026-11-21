/**
 * Distilled-skill proposals: list, approve (promote), reject, merge, surface,
 * and the view the API serves (docs/plans/self-learning-consolidation.md).
 *
 * One implementation shared by the REST route and the gateway `/proposals`
 * command. The promotion is the part that must not be copied — it inserts a
 * skill or an expert and flips the proposal status in the SAME transaction,
 * so a failure can't leave an orphan row with the proposal still `pending`
 * (re-approvable → duplicates).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type SkillProposalRecord, skillProposals } from '@/db/schema/skill-proposals';
import { skills } from '@/db/schema/skills';
import { getConfig } from '@/config';
import { type MergeResult, mergeIntoProposal, ProposalNotOpenError, promoteIfEligible } from '@/services/skill-proposal-merge';
import { type SkillProposalView, sessionCountOf } from '@/shared/skill-proposals';
import { applySkillPatch, assertPatchable, SkillPatchError, skillContentHash } from '@/skills/patch';
import { normalizeSkillName } from '@/tools/skill-distill/distiller';
import { coreLogger } from '@/utils/logger';

/** 90 days — how long a rejected proposal stays suppressed. */
const REJECT_SUPPRESSION_MS = 90 * 24 * 60 * 60 * 1000;

/** Statuses a proposal can still be approved, rejected or merged from. */
const OPEN_STATUSES: Array<'pending' | 'candidate'> = ['pending', 'candidate'];

/**
 * Pending proposals, most observations first, then oldest first. The gateway
 * `/proposals approve <n>` resolves its index against this same order, so it
 * is stable between the list and the action that follows it as long as
 * nothing is merged in between.
 *
 * `userId` scopes the list to its owner. Passing `undefined` returns every
 * user's — only for an admin/system caller.
 */
export async function listPendingProposals(userId?: string): Promise<SkillProposalRecord[]> {
  return listOpenProposals(userId, { includeCandidates: false });
}

/**
 * Pending proposals (sorted as `listPendingProposals`), followed by the
 * candidates (not shown yet) in the same order when `includeCandidates`.
 */
export async function listOpenProposals(userId: string | undefined, opts: { includeCandidates: boolean }): Promise<SkillProposalRecord[]> {
  const statuses: Array<'pending' | 'candidate'> = opts.includeCandidates ? OPEN_STATUSES : ['pending'];
  const filters = [inArray(skillProposals.status, statuses)];
  if (userId) filters.push(eq(skillProposals.userId, userId));
  return getDb().select().from(skillProposals).where(and(...filters)).orderBy(
    sql`(${skillProposals.status} = 'candidate')`,
    desc(skillProposals.exemplarCount),
    asc(skillProposals.createdAt),
    asc(skillProposals.id),
  );
}

/** Candidates (filed, not shown yet) of `userId`, or of everyone when `undefined`. */
export async function countCandidateProposals(userId?: string): Promise<number> {
  const filters = [eq(skillProposals.status, 'candidate')];
  if (userId) filters.push(eq(skillProposals.userId, userId));
  const [row] = await getDb().select({ n: sql<number>`count(*)::int` }).from(skillProposals).where(and(...filters));
  return Number(row?.n ?? 0);
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

/**
 * Promote a pending proposal, or a candidate the owner approves before it was
 * shown. Returns null when it isn't open (or isn't the caller's).
 */
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
  const filters = [eq(skillProposals.id, id), inArray(skillProposals.status, OPEN_STATUSES)];
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

      // Filter on the open statuses, not just the id: the SELECT above is outside this
      // transaction, so two approvals racing (the REST route and `/proposals
      // approve` are two front doors now) would both read it pending and both
      // insert. Whoever loses the flip finds no row and rolls their insert back.
      const [flipped] = await tx.update(skillProposals)
        .set({ status: 'promoted', promotedSkillId: created.id })
        .where(and(eq(skillProposals.id, id), inArray(skillProposals.status, OPEN_STATUSES)))
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
 * Reject an open (pending or candidate) proposal and suppress the same
 * distillation for 90 days. The rows merged into it (`merged_into_id`) are
 * rejected with the same `rejected_until` in the same transaction, so their
 * fingerprints are suppressed too. A `merged` row itself cannot be rejected.
 * Returns the suppression date, or null when the proposal isn't open (or
 * isn't the caller's).
 */
export async function rejectProposal(id: string, userId?: string): Promise<Date | null> {
  const { rejected, rejectedUntil } = await rejectOpen([id], userId);
  return rejected.length > 0 ? rejectedUntil : null;
}

/**
 * Reject several open proposals at once (see `rejectProposal`). An id that is
 * not an open proposal of `userId` (any owner when `undefined`) is reported
 * in `notFound` and nothing happens to it.
 */
export async function rejectProposals(ids: string[], userId?: string): Promise<{ rejected: string[]; notFound: string[] }> {
  const unique = [...new Set(ids)];
  const { rejected } = await rejectOpen(unique, userId);
  const done = new Set(rejected);
  return { rejected, notFound: unique.filter(id => !done.has(id)) };
}

async function rejectOpen(ids: string[], userId: string | undefined): Promise<{ rejected: string[]; rejectedUntil: Date }> {
  const rejectedUntil = new Date(Date.now() + REJECT_SUPPRESSION_MS);
  const valid = ids.filter(id => UUID.test(id));
  if (valid.length === 0) return { rejected: [], rejectedUntil };
  const filters = [inArray(skillProposals.id, valid), inArray(skillProposals.status, OPEN_STATUSES)];
  if (userId) filters.push(eq(skillProposals.userId, userId));

  const rejected = await getDb().transaction(async (tx) => {
    const rows = await tx.update(skillProposals)
      .set({ status: 'rejected', rejectedUntil })
      .where(and(...filters))
      .returning({ id: skillProposals.id });
    const targets = rows.map(row => row.id);
    if (targets.length > 0) {
      const absorbed = await tx.update(skillProposals)
        .set({ status: 'rejected', rejectedUntil })
        .where(and(inArray(skillProposals.mergedIntoId, targets), eq(skillProposals.status, 'merged')))
        .returning({ id: skillProposals.id });
      if (absorbed.length > 0) coreLogger.info({ targets, absorbed: absorbed.length }, 'Rejected the proposals merged into rejected skill proposals');
    }
    return targets;
  });
  // In the order asked for, so a caller can line them up.
  const done = new Set(rejected);
  return { rejected: valid.filter(id => done.has(id)), rejectedUntil };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── merge, surface ────────────────────────────────────────────────

/**
 * A manual merge that cannot be done. `not_found`: either id is not a
 * proposal of the caller. `same`: a proposal cannot be merged into itself.
 * `patch`: patches are never merged. `owner`: the two belong to different
 * users (only an admin can name both). `not_open`: either is no longer
 * pending or a candidate.
 */
export class ProposalMergeError extends Error {
  constructor(readonly code: 'not_found' | 'same' | 'patch' | 'owner' | 'not_open', message: string) {
    super(message);
    this.name = 'ProposalMergeError';
  }
}

export type AbsorbResult =
  /** `row` is now `merged` into `target`; `proposal` is the target after the merge (and any promotion). */
  | { outcome: 'merged'; verdict: 'merged' | 'unchanged'; mergeDegraded: boolean; proposal: SkillProposalRecord; promoted: boolean }
  /** The merge model said they are different skills (only with `allowDistinct`): both stay open. */
  | { outcome: 'distinct' }
  /** `row` or `target` was no longer open: nothing changed. */
  | { outcome: 'not_open'; proposalId: string };

/**
 * Absorb the open proposal `row` into the open proposal `target` (same owner,
 * neither a patch): the merge model folds `row`'s text, `source_refs` and
 * `exemplar_count` into `target`, `row` becomes `merged` with
 * `merged_into_id = target`, and `target` is promoted when it is eligible.
 *
 * Order, chosen so a process dying half-way never counts `row` twice: `row`
 * is marked `merged` FIRST (one conditional update, which also claims it
 * against a concurrent merge or rejection), then merged into `target`. When
 * the merge does not happen (`distinct`, `target` no longer open, an error)
 * the mark is undone. Dying between the two leaves `row` merged into a target
 * that lacks its count and sources: an undercount, never a duplicate shown
 * twice or counted twice, and the fingerprint still redirects to `target`.
 */
export async function absorbProposal(
  row: SkillProposalRecord,
  target: SkillProposalRecord,
  opts: { allowDistinct?: boolean } = {},
): Promise<AbsorbResult> {
  const db = getDb();
  const [claimed] = await db.update(skillProposals)
    .set({ status: 'merged', mergedIntoId: target.id })
    .where(and(eq(skillProposals.id, row.id), inArray(skillProposals.status, OPEN_STATUSES)))
    .returning({ id: skillProposals.id });
  if (!claimed) return { outcome: 'not_open', proposalId: row.id };

  const release = async () => {
    await db.update(skillProposals)
      .set({ status: row.status, mergedIntoId: null })
      .where(and(eq(skillProposals.id, row.id), eq(skillProposals.status, 'merged'), eq(skillProposals.mergedIntoId, target.id)));
  };

  let merge: MergeResult;
  try {
    merge = await mergeIntoProposal(
      target,
      { name: row.name, description: row.description, content: row.draftPromptTemplate, signal: row.signal },
      row.sourceRefs.length > 0 ? row.sourceRefs : (row.sourceRef ? [row.sourceRef] : []),
      { allowDistinct: opts.allowDistinct ?? false, exemplars: row.exemplarCount },
    );
  } catch (err) {
    await release();
    if (err instanceof ProposalNotOpenError) return { outcome: 'not_open', proposalId: target.id };
    throw err;
  }
  if (merge.verdict === 'distinct') {
    await release();
    return { outcome: 'distinct' };
  }

  // Rows merged into `row` earlier now point at `target`, so a rejection of
  // `target` reaches them and a fingerprint redirect is one hop.
  await db.update(skillProposals).set({ mergedIntoId: target.id })
    .where(and(eq(skillProposals.mergedIntoId, row.id), eq(skillProposals.status, 'merged')));

  let proposal = merge.proposal;
  let promoted = false;
  if (row.status === 'pending' && proposal.status === 'candidate') {
    // A shown proposal was folded into one not shown yet: the topic was
    // already in front of the owner, so the merged proposal stays in front of them.
    const [surfaced] = await db.update(skillProposals).set({ status: 'pending', surfacedAt: new Date() })
      .where(and(eq(skillProposals.id, proposal.id), eq(skillProposals.status, 'candidate'))).returning();
    if (surfaced) { proposal = surfaced; promoted = true; }
  } else {
    const promotion = await promoteIfEligible(proposal);
    if (promotion.promoted) { proposal = promotion.proposal; promoted = true; }
  }
  coreLogger.info({ proposalId: row.id, into: target.id, verdict: merge.verdict, mergeDegraded: merge.mergeDegraded, promoted },
    'Skill proposal absorbed into another');
  return { outcome: 'merged', verdict: merge.verdict, mergeDegraded: merge.mergeDegraded, proposal, promoted };
}

/**
 * The owner merges proposal `id` into `intoId` by hand (both open, same
 * owner, neither a patch). `userId` scopes both to the caller; `undefined`
 * (admin) still requires the two to share an owner. Throws
 * `ProposalMergeError`.
 */
export async function mergeProposals(id: string, intoId: string, userId?: string): Promise<Extract<AbsorbResult, { outcome: 'merged' }>> {
  if (id === intoId) throw new ProposalMergeError('same', 'A proposal cannot be merged into itself.');
  if (!UUID.test(id) || !UUID.test(intoId)) throw new ProposalMergeError('not_found', 'proposal not found');
  const filters = [inArray(skillProposals.id, [id, intoId])];
  if (userId) filters.push(eq(skillProposals.userId, userId));
  const rows = await getDb().select().from(skillProposals).where(and(...filters));
  const row = rows.find(r => r.id === id);
  const target = rows.find(r => r.id === intoId);
  if (!row || !target) throw new ProposalMergeError('not_found', 'proposal not found');
  if (row.kind === 'patch' || target.kind === 'patch') throw new ProposalMergeError('patch', 'A patch proposal cannot be merged.');
  if (row.userId !== target.userId) throw new ProposalMergeError('owner', 'The two proposals belong to different users.');
  for (const p of [row, target]) {
    if (p.status !== 'pending' && p.status !== 'candidate') {
      throw new ProposalMergeError('not_open', `Proposal ${p.id} is ${p.status}, not pending or a candidate: nothing merged.`);
    }
  }
  const result = await absorbProposal(row, target, { allowDistinct: false });
  if (result.outcome === 'not_open') {
    throw new ProposalMergeError('not_open', `Proposal ${result.proposalId} is no longer pending or a candidate: nothing merged.`);
  }
  // allowDistinct is false: the merge model cannot answer distinct.
  if (result.outcome === 'distinct') throw new Error('merge model answered distinct without allowDistinct');
  return result;
}

/**
 * The owner shows a candidate now: it becomes pending with `surfaced_at` set.
 * The recurrence gate and the caps do not apply. Returns null when it is not
 * a candidate of `userId` (any owner when `undefined`).
 */
export async function surfaceProposal(id: string, userId?: string): Promise<SkillProposalRecord | null> {
  if (!UUID.test(id)) return null;
  const filters = [eq(skillProposals.id, id), eq(skillProposals.status, 'candidate')];
  if (userId) filters.push(eq(skillProposals.userId, userId));
  const [row] = await getDb().update(skillProposals).set({ status: 'pending', surfacedAt: new Date() }).where(and(...filters)).returning();
  if (row) coreLogger.info({ proposalId: id, userId: row.userId }, 'Skill proposal surfaced by its owner');
  return row ?? null;
}

// ── view ──────────────────────────────────────────────────────────

/**
 * For each proposal with an embedding, the nearest live skill of its owner
 * or the system at or above `learning.relatedSimilarity`, computed in SQL
 * from the stored vectors (another dimension is skipped).
 */
async function similarSkillsOf(proposals: SkillProposalRecord[]): Promise<Map<string, NonNullable<SkillProposalView['similarSkill']>>> {
  const ids = proposals.filter(p => p.embedding !== null && p.kind !== 'patch').map(p => p.id);
  const found = new Map<string, NonNullable<SkillProposalView['similarSkill']>>();
  if (ids.length === 0) return found;
  const { relatedSimilarity } = getConfig().learning;
  const res = await getDb().execute(sql`
    SELECT p.id AS proposal_id, s.id AS skill_id, s.name AS skill_name,
           1 - (s.description_embedding <=> p.embedding) AS similarity
    FROM ${skillProposals} p
    CROSS JOIN LATERAL (
      SELECT k.id, k.name, k.description_embedding
      FROM ${skills} k
      WHERE (k.user_id = p.user_id OR k.is_system = true)
        AND k.archived_at IS NULL
        AND k.description_embedding IS NOT NULL
        AND vector_dims(k.description_embedding) = vector_dims(p.embedding)
      ORDER BY k.description_embedding <=> p.embedding
      LIMIT 1
    ) s
    WHERE p.id IN (${sql.join(ids.map(id => sql`${id}::uuid`), sql`, `)})
      AND p.embedding IS NOT NULL
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? []) as Array<{
    proposal_id: string; skill_id: string; skill_name: string; similarity: number | string;
  }>;
  for (const row of rows) {
    const similarity = Number(row.similarity);
    if (similarity >= relatedSimilarity) found.set(row.proposal_id, { id: row.skill_id, name: row.skill_name, similarity: Math.round(similarity * 1000) / 1000 });
  }
  return found;
}

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

/**
 * Proposals as the API serves them (`SkillProposalView`): the row without its
 * embedding (and without `rejected_until`), dates as ISO strings, plus
 * `sessionCount`, `similarSkill` and, for a patch, its skill's current
 * content and whether it is stale.
 */
export async function toProposalViews(proposals: SkillProposalRecord[]): Promise<SkillProposalView[]> {
  const [withContext, similar] = await Promise.all([withPatchContext(proposals), similarSkillsOf(proposals)]);
  return withContext.map((p): SkillProposalView => ({
    id: p.id,
    userId: p.userId,
    fingerprint: p.fingerprint,
    name: p.name,
    description: p.description,
    draftPromptTemplate: p.draftPromptTemplate,
    exemplarCount: p.exemplarCount,
    lastExemplarAt: p.lastExemplarAt.toISOString(),
    kind: p.kind,
    sourceRef: p.sourceRef,
    status: p.status,
    createdAt: p.createdAt.toISOString(),
    targetSkillId: p.targetSkillId,
    patchOldText: p.patchOldText,
    patchNewText: p.patchNewText,
    baseContentHash: p.baseContentHash,
    promotedSkillId: p.promotedSkillId,
    sourceRefs: p.sourceRefs,
    sessionCount: sessionCountOf(p.sourceRefs),
    signal: p.signal,
    previousDraft: p.previousDraft,
    surfacedAt: iso(p.surfacedAt),
    mergedIntoId: p.mergedIntoId,
    similarSkill: similar.get(p.id) ?? null,
    ...('currentContent' in p ? { currentContent: p.currentContent, stale: p.stale } : {}),
  }));
}
