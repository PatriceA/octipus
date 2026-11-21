/**
 * Merging a new observation into an open skill proposal, and surfacing a
 * candidate once it has proven itself (docs/plans/self-learning-consolidation.md).
 *
 * `mergeIntoProposal` asks the background model once whether the incoming
 * skill adds to the target (`merged`: new description and draft, the old
 * draft kept as `previous_draft`), adds nothing (`unchanged`) or, only with
 * `allowDistinct`, is another skill (`distinct`: nothing written, the caller
 * files a new row). `merged` and `unchanged` both count the observation:
 * `exemplar_count`, `source_refs`, `last_exemplar_at` and the stronger
 * `signal`. A model that is unbound, truncated or malformed degrades to that
 * count-only merge and says so (`mergeDegraded`), except in the related band
 * (`allowDistinct`), where only the model's verdict could make the two one
 * skill: there it answers `distinct` (with `degradedReason`). The target's
 * name and fingerprint never change.
 *
 * `promoteIfEligible` moves a candidate to pending once it was seen in
 * `learning.recurrenceSessions` sessions or rests on a user correction, while
 * neither cap (`maxSkillProposalsPerDay`, `maxPendingSkillProposals`) is reached.
 */
import { and, eq, gte, inArray, like, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getConfig } from '@/config';
import { filterPII } from '@/core/agent/pii-filter';
import { SECURITY_PREAMBLE } from '@/core/agent/roles';
import { capabilityConfigured } from '@/core/capabilities/gates';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { getDb } from '@/db/postgres';
import { DEFAULT_MAX_OUTPUT_TOKENS } from '@/db/schema/models';
import { SKILL_PROPOSAL_SIGNALS, type SkillProposalRecord, type SkillProposalSignal, skillProposals } from '@/db/schema/skill-proposals';
import { getLiteLLMClient } from '@/models/litellm-client';
import { getModelRegistry } from '@/models/model-registry';
import { withInstallUsage } from '@/models/providers/instrumented';
import { sessionCountOf } from '@/shared/skill-proposals';
import { similarityText } from '@/tools/skill-distill/distiller';
import { toolLogger } from '@/utils/logger';

/** Most `source_refs` kept on a proposal; the oldest go first. */
export const MAX_SOURCE_REFS = 50;
/** Most characters of a merged draft. */
export const MAX_MERGED_CONTENT_CHARS = 8000;

/** Thrown when the merge target is no longer pending or a candidate. */
export class ProposalNotOpenError extends Error {
  readonly code = 'proposal_not_open';
  constructor(readonly proposalId: string, readonly status: string) {
    super(`Skill proposal ${proposalId} is ${status}, not open: nothing merged`);
    this.name = 'ProposalNotOpenError';
  }
}

/** The stronger of two signals: correction > recovery > procedure > none. */
export function strongerSignal(a: SkillProposalSignal | null | undefined, b: SkillProposalSignal | null | undefined): SkillProposalSignal | null {
  const rank = (s: SkillProposalSignal | null | undefined) => (s ? SKILL_PROPOSAL_SIGNALS.length - SKILL_PROPOSAL_SIGNALS.indexOf(s) : 0);
  const best = rank(a) >= rank(b) ? a : b;
  return best ?? null;
}

/** `existing` with `added` appended, newest last, at most `MAX_SOURCE_REFS`. */
export function appendSourceRefs(existing: string[], added: string[]): string[] {
  return [...existing, ...added].slice(-MAX_SOURCE_REFS);
}

/**
 * The status a new proposal is filed with before the caps: pending when the
 * user asked for it, when a user correction backs it, or when the recurrence
 * gate is off; a candidate otherwise.
 */
export function initialProposalStatus(input: {
  origin: 'manual' | 'learning';
  signal?: SkillProposalSignal | null;
  recurrenceSessions: number;
}): 'pending' | 'candidate' {
  if (input.origin === 'manual' || input.signal === 'correction' || input.recurrenceSessions <= 1) return 'pending';
  return 'candidate';
}

/** Whether a candidate has proven itself (before the caps). */
export function candidateIsRecurring(proposal: { sourceRefs: string[]; signal: SkillProposalSignal | null }, recurrenceSessions: number): boolean {
  return proposal.signal === 'correction' || sessionCountOf(proposal.sourceRefs) >= recurrenceSessions;
}

/** Which surfacing cap a learned proposal of `userId` hits now, if any. Patches never count. */
export async function learnedSurfaceCap(userId: string): Promise<'max_pending' | 'per_day' | null> {
  const { maxPendingSkillProposals, maxSkillProposalsPerDay } = getConfig().learning;
  const db = getDb();
  const [pending] = await db.select({ n: sql<number>`count(*)::int` }).from(skillProposals)
    .where(and(eq(skillProposals.userId, userId), eq(skillProposals.status, 'pending'), ne(skillProposals.kind, 'patch')));
  if (Number(pending?.n ?? 0) >= maxPendingSkillProposals) return 'max_pending';
  // Learned = filed by a learning check (its first sourceRef). Whatever
  // became of it since, a proposal surfaced in the window counts.
  const [today] = await db.select({ n: sql<number>`count(*)::int` }).from(skillProposals)
    .where(and(
      eq(skillProposals.userId, userId),
      ne(skillProposals.kind, 'patch'),
      like(skillProposals.sourceRef, 'learning:%'),
      gte(skillProposals.surfacedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
    ));
  if (Number(today?.n ?? 0) >= maxSkillProposalsPerDay) return 'per_day';
  return null;
}

export type PromoteResult =
  | { promoted: true; proposal: SkillProposalRecord }
  | { promoted: false; reason: 'not_found' | 'not_candidate' | 'not_recurring' | 'max_pending' | 'per_day' };

/**
 * Surface the candidate `proposal` (re-read from the database) when it is
 * recurring and no cap is reached: status pending, `surfaced_at` now.
 */
export async function promoteIfEligible(proposal: Pick<SkillProposalRecord, 'id'>): Promise<PromoteResult> {
  const db = getDb();
  const [row] = await db.select().from(skillProposals).where(eq(skillProposals.id, proposal.id)).limit(1);
  if (!row) return { promoted: false, reason: 'not_found' };
  if (row.status !== 'candidate') return { promoted: false, reason: 'not_candidate' };
  if (!candidateIsRecurring(row, getConfig().learning.recurrenceSessions)) return { promoted: false, reason: 'not_recurring' };
  const cap = await learnedSurfaceCap(row.userId);
  if (cap) {
    toolLogger.info({ proposalId: row.id, userId: row.userId, cap }, 'Skill proposal stays a candidate: surfacing cap reached');
    return { promoted: false, reason: cap };
  }
  const [updated] = await db.update(skillProposals).set({ status: 'pending', surfacedAt: new Date() })
    .where(and(eq(skillProposals.id, row.id), eq(skillProposals.status, 'candidate')))
    .returning();
  if (!updated) return { promoted: false, reason: 'not_candidate' };
  toolLogger.info({ proposalId: row.id, userId: row.userId, sessions: sessionCountOf(row.sourceRefs), signal: row.signal }, 'Skill proposal surfaced');
  return { promoted: true, proposal: updated };
}

// ── merge ─────────────────────────────────────────────────────────

export interface MergeIncoming {
  name: string;
  description: string;
  content: string;
  signal?: SkillProposalSignal | null;
}

export interface MergeOptions {
  /** The related band: the model may answer `distinct`, and nothing is written. */
  allowDistinct?: boolean;
  /** Observations the incoming side stands for (an absorbed proposal's `exemplar_count`). Default 1. */
  exemplars?: number;
}

export type MergeResult =
  /**
   * Another skill: the model said so, or (with `degradedReason`) it could not
   * judge a related-band pair, which then stays apart for now.
   */
  | { verdict: 'distinct'; degradedReason?: 'no_model' | 'truncated' | 'malformed' | 'model_error' }
  | {
    verdict: 'merged' | 'unchanged';
    /** The model could not be used: counted only, the text is unchanged. */
    mergeDegraded: boolean;
    degradedReason?: 'no_model' | 'truncated' | 'malformed' | 'model_error' | 'concurrent_change';
    proposal: SkillProposalRecord;
  };

const MERGE_PROMPT = `You maintain proposed reusable skills. EXISTING is a proposed skill; INCOMING is a new observation that may be the same skill.
Reply with ONLY a JSON object: {"verdict": "merged" | "unchanged" | "distinct", "description": string, "content": string}.
- "merged": INCOMING adds steps, gotchas or corrections that EXISTING lacks. Return the combined skill: "description" one sentence, "content" markdown with numbered steps. Keep everything in EXISTING that is still right, prefer INCOMING where they conflict, drop instance details (names, ids, paths, secrets). At most ${MAX_MERGED_CONTENT_CHARS} characters.
- "unchanged": INCOMING adds nothing new. "description" and "content" are "".
- "distinct": INCOMING is a different skill. Only when "allowDistinct" is true; otherwise choose "merged" or "unchanged".
Never rename the skill.`;

const mergeReplySchema = z.object({
  verdict: z.enum(['merged', 'unchanged', 'distinct']),
  description: z.string(),
  content: z.string(),
});

export type MergeReply =
  | { kind: 'merged'; description: string; content: string }
  | { kind: 'unchanged' }
  | { kind: 'distinct' }
  | { kind: 'truncated' }
  | { kind: 'malformed'; reason: string };

/**
 * Classify the merge model's reply. `distinct` without `allowDistinct` is read
 * as `unchanged`: the proposals are the same skill by similarity. A `merged`
 * reply is PII-filtered and its content capped.
 */
export function interpretMergeReply(raw: string, finishReason: string | undefined, allowDistinct: boolean): MergeReply {
  if (finishReason === 'length') return { kind: 'truncated' };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { kind: 'malformed', reason: 'no JSON object in the response' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    // Fixed reason: JSON.parse messages quote the input.
    return { kind: 'malformed', reason: 'invalid JSON' };
  }
  const reply = mergeReplySchema.safeParse(parsed);
  if (!reply.success) return { kind: 'malformed', reason: 'verdict, description and content are required' };
  if (reply.data.verdict === 'distinct') return allowDistinct ? { kind: 'distinct' } : { kind: 'unchanged' };
  if (reply.data.verdict === 'unchanged') return { kind: 'unchanged' };
  const description = filterPII(reply.data.description.trim()).filtered;
  const content = filterPII(reply.data.content.trim()).filtered.slice(0, MAX_MERGED_CONTENT_CHARS);
  if (!description || !content) return { kind: 'malformed', reason: 'a merged reply needs a description and content' };
  return { kind: 'merged', description, content };
}

async function askMergeModel(target: SkillProposalRecord, incoming: MergeIncoming, allowDistinct: boolean): Promise<MergeReply | { kind: 'no_model' } | { kind: 'model_error' }> {
  const model = await getModelRegistry().getModelForTopic('background');
  if (!model) return { kind: 'no_model' };
  const input = JSON.stringify({
    allowDistinct,
    existing: { name: target.name, description: target.description, content: target.draftPromptTemplate },
    incoming: { name: incoming.name, description: incoming.description, content: incoming.content },
  });
  try {
    // Learning is install work: stamped `install` (coworking spec §9.1).
    const response = await withInstallUsage(() => getLiteLLMClient().complete({
      model: model.modelId, modelConfigName: model.name, userId: target.userId,
      requestType: 'skill-proposal-merge', temperature: 0,
      maxTokens: Math.min(model.defaultMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS, model.maxTokens ?? Infinity),
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${SECURITY_PREAMBLE}\n\n${MERGE_PROMPT}`, timestamp: new Date() },
        { role: 'user', content: input, timestamp: new Date() },
      ],
    }));
    return interpretMergeReply(response.content ?? '', response.finishReason, allowDistinct);
  } catch (err) {
    toolLogger.warn({ err, proposalId: target.id, model: model.modelId }, 'Skill proposal merge: the model call failed');
    return { kind: 'model_error' };
  }
}

/** The new embedding of a merged text; null (refilled later by ensureProposalEmbeddings) when it cannot be computed. */
async function embeddingOf(name: string, description: string, proposalId: string): Promise<number[] | null> {
  if (!(await capabilityConfigured('embedding'))) return null;
  try {
    return await getEmbeddingService().generateEmbedding(similarityText({ name, description }), 'document');
  } catch (err) {
    toolLogger.warn({ err, proposalId }, 'Skill proposal merge: could not embed the merged text; it is embedded on the next dedup');
    return null;
  }
}

/**
 * Merge `incoming` (seen at `sourceRef`, or several refs for an absorbed
 * proposal) into the open proposal `target`. Throws `ProposalNotOpenError`
 * when `target` is no longer pending or a candidate. Does not promote:
 * callers run `promoteIfEligible` on the result.
 */
export async function mergeIntoProposal(
  target: SkillProposalRecord,
  incoming: MergeIncoming,
  sourceRef: string | string[],
  opts: MergeOptions = {},
): Promise<MergeResult> {
  const allowDistinct = opts.allowDistinct ?? false;
  const refs = Array.isArray(sourceRef) ? sourceRef : [sourceRef];
  const reply = await askMergeModel(target, incoming, allowDistinct);
  if (reply.kind === 'distinct') {
    toolLogger.info({ proposalId: target.id, incoming: incoming.name }, 'Skill proposal merge: the model says it is a different skill');
    return { verdict: 'distinct' };
  }
  let degradedReason: Extract<MergeResult, { verdict: 'merged' | 'unchanged' }>['degradedReason'] =
    reply.kind === 'merged' || reply.kind === 'unchanged' ? undefined : reply.kind;
  // In the related band the model's verdict is the only evidence that the two
  // are one skill: without it they stay apart rather than being counted together.
  if (degradedReason && allowDistinct) {
    toolLogger.warn({ proposalId: target.id, incoming: incoming.name, reason: degradedReason, ...(reply.kind === 'malformed' ? { detail: reply.reason } : {}) },
      'Skill proposal merge: the merge model could not judge a related pair; treating them as different skills');
    return { verdict: 'distinct', degradedReason };
  }
  if (degradedReason) {
    toolLogger.warn({ proposalId: target.id, reason: degradedReason, ...(reply.kind === 'malformed' ? { detail: reply.reason } : {}) },
      'Skill proposal merge degraded to a count-only merge');
  }
  const text = reply.kind === 'merged' ? reply : null;
  const embedding = text ? await embeddingOf(target.name, text.description, target.id) : null;

  const proposal = await getDb().transaction(async (tx) => {
    const [current] = await tx.select().from(skillProposals).where(eq(skillProposals.id, target.id)).limit(1).for('update');
    if (!current) throw new ProposalNotOpenError(target.id, 'gone');
    if (current.status !== 'pending' && current.status !== 'candidate') throw new ProposalNotOpenError(target.id, current.status);
    // Merged by someone else since the model read it: the new text would drop theirs.
    const changeText = text && current.draftPromptTemplate === target.draftPromptTemplate;
    if (text && !changeText) degradedReason = 'concurrent_change';
    const [updated] = await tx.update(skillProposals).set({
      exemplarCount: current.exemplarCount + Math.max(1, opts.exemplars ?? 1),
      sourceRefs: appendSourceRefs(current.sourceRefs, refs),
      lastExemplarAt: new Date(),
      signal: strongerSignal(current.signal, incoming.signal),
      ...(changeText && text ? {
        previousDraft: current.draftPromptTemplate,
        description: text.description,
        draftPromptTemplate: text.content,
        embedding,
      } : {}),
    }).where(and(eq(skillProposals.id, current.id), inArray(skillProposals.status, ['pending', 'candidate']))).returning();
    return updated;
  });

  const verdict = reply.kind === 'merged' && !degradedReason ? 'merged' : 'unchanged';
  toolLogger.info({ proposalId: proposal.id, verdict, degradedReason, exemplarCount: proposal.exemplarCount, sessions: sessionCountOf(proposal.sourceRefs) },
    'Merged an observation into a skill proposal');
  return { verdict, mergeDegraded: degradedReason !== undefined, ...(degradedReason ? { degradedReason } : {}), proposal };
}
