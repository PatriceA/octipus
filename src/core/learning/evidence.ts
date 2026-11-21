import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agentEvents } from '@/db/schema/agent-events';
import { backgroundJobs } from '@/db/schema/background-jobs';
import { messages } from '@/db/schema/messages';
import { visibleMessages } from '@/db/repositories/message-visibility';
import { skills } from '@/db/schema/skills';
import { skillProposals } from '@/db/schema/skill-proposals';
import { verificationEvidence } from '@/db/schema/verification-evidence';
import { filterPII } from '@/core/agent/pii-filter';
import { capabilityConfigured } from '@/core/capabilities/gates';
import { getEmbeddingService } from '@/core/rag/embeddings';
import { ensureProposalEmbeddings, ensureSkillEmbeddings } from '@/skills/embedding-backfill';
import { MAX_PATCHED_SKILL_CHARS } from '@/skills/patch';
import { coreLogger } from '@/utils/logger';

export interface LearningEvidence { id: string; kind: 'user' | 'assistant' | 'execution' | 'verification' | 'plan' | 'request'; text: string }
export const MAX_EVIDENCE_CHARS = 40_000;
/** Keep category coverage while bounding cost. Each excerpt is explicitly truncated. */
export function boundEvidence(rows: LearningEvidence[], budget = MAX_EVIDENCE_CHARS): LearningEvidence[] {
  let remaining = budget;
  const out: LearningEvidence[] = [];
  for (const row of rows) {
    if (remaining <= 100) break;
    const clean = filterPII(row.text).filtered;
    // Reserve room for actual tool results even when chat/check records are long.
    const perKind = row.kind === 'user' || row.kind === 'assistant' || row.kind === 'verification' ? 900 : 2400;
    const limit = Math.min(perKind, remaining - row.id.length - 80);
    const text = clean.length > limit ? clean.slice(0, limit) + '\n[excerpt truncated]' : clean;
    out.push({ ...row, text });
    remaining -= text.length + row.id.length + 50;
  }
  return out;
}

/**
 * A user row a person typed; Companion handoffs, monitors, schedules, internal
 * inputs and the plan brief are stored as user rows too but are not the
 * owner's words.
 */
const typedByOwner = sql<boolean>`(coalesce(${messages.metadata}->>'trigger', 'user') = 'user' AND ${messages.metadata}->>'synthetic' IS NULL AND ${visibleMessages})`;

export interface GatherEvidenceOptions {
  /** Room the review input needs for other material (patch targets, `existing`), taken off MAX_EVIDENCE_CHARS so the whole stays within it. */
  reserveChars?: number;
  /**
   * Read execution events and verification records created after this only
   * (the previous review's `through`). Chat messages keep the last 8
   * regardless. Omitted: the full window, as a manual check reads.
   */
  since?: Date;
}

/** Caller validates session ownership. Read only evidence available at the milestone. */
export async function gatherEvidence(userId: string, sessionId: string, through: Date, plan?: unknown, { reserveChars = 0, since }: GatherEvidenceOptions = {}): Promise<LearningEvidence[]> {
  const db = getDb();
  const [chat, checks, events] = await Promise.all([
    db.select({ id: messages.id, role: messages.role, text: sql<string>`left(${messages.content}, 3000)`, typed: typedByOwner }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), lte(messages.createdAt, through), inArray(messages.role, ['user', 'assistant'])))
      .orderBy(desc(messages.createdAt)).limit(8),
    db.select({ id: verificationEvidence.id, text: sql<string>`left(jsonb_build_object('kind', ${verificationEvidence.kind}, 'passed', ${verificationEvidence.passed}, 'detail', ${verificationEvidence.detail})::text, 3000)` })
      .from(verificationEvidence).where(and(eq(verificationEvidence.sessionId, sessionId), lte(verificationEvidence.createdAt, through),
        since ? gt(verificationEvidence.createdAt, since) : undefined))
      .orderBy(desc(verificationEvidence.createdAt)).limit(8),
    db.select({ id: agentEvents.id, observed: sql<boolean>`(${agentEvents.data}->>'type' = 'cli_tool_result' OR ${agentEvents.data} ? 'results')`, text: sql<string>`left(${agentEvents.data}::text, 3000)` }).from(agentEvents)
      .where(and(eq(agentEvents.userId, userId), eq(agentEvents.sessionId, sessionId), lte(agentEvents.createdAt, through),
        since ? gt(agentEvents.createdAt, since) : undefined,
        inArray(agentEvents.type, ['action', 'observation', 'error'])))
      .orderBy(desc(agentEvents.id)).limit(100),
  ]);
  return boundEvidence([
    ...(plan ? [{ id: 'plan', kind: 'plan' as const, text: JSON.stringify(plan) }] : []),
    // Only a typed user row is `user` evidence (the only kind a personal memory
    // may cite); any other user row is a request to the agent.
    ...chat.map(row => ({ id: `message:${row.id}`, kind: row.role === 'user' ? (row.typed ? 'user' as const : 'request' as const) : 'assistant' as const, text: row.text })),
    ...checks.map(row => ({ id: `check:${row.id}`, kind: 'verification' as const, text: row.text })),
    ...events.map(row => ({ id: `event:${row.id}`, kind: row.observed ? 'execution' as const : 'request' as const, text: row.text })),
  ], MAX_EVIDENCE_CHARS - reserveChars);
}

/** A learned skill the review may propose a patch for, with its current content. */
export interface PatchableSkill { id: string; name: string; content: string }
export const MAX_PATCHABLE_SKILLS = 2;
/** All patch targets together stay within this share of MAX_EVIDENCE_CHARS. */
export const MAX_PATCH_TARGET_CHARS = 12_000;

/** What the patch targets take of the review input, as gatherEvidence's `reserveChars`. */
export function patchTargetChars(targets: PatchableSkill[]): number {
  return targets.reduce((n, skill) => n + skill.id.length + skill.name.length + skill.content.length + 50, 0);
}

/**
 * The owner's learned skills (own, not system, not archived, not owner-edited)
 * whose body this session loaded up to `through`: the only patch targets
 * offered to the review, so a patch always targets a skill the work used.
 *
 * "Loaded" is read from this session's action events, in one pass:
 * `skill_load` (the in-process get_skill, src/tools/skill-loader.ts) and a CLI
 * agent's `cli_tool_use` of get_skill through the MCP bridge, whose arguments
 * name the skill (Claude Code records them; a CLI that records no arguments
 * offers no targets). A skill id merely appearing in an event — a list_skills
 * result, the skill index — does not count.
 *
 * Most recently used first, at most MAX_PATCHABLE_SKILLS within
 * MAX_PATCH_TARGET_CHARS; skills already at the patched-size cap are left out.
 * Caller validates session ownership.
 */
export async function gatherPatchableSkills(userId: string, sessionId: string, through: Date): Promise<PatchableSkill[]> {
  const loaded = sql`SELECT coalesce(${agentEvents.data}->>'skillId', ${agentEvents.data}->'args'->>'skill_id') FROM ${agentEvents}
    WHERE ${agentEvents.userId} = ${userId} AND ${agentEvents.sessionId} = ${sessionId} AND ${agentEvents.type} = 'action'
      AND ${agentEvents.createdAt} <= ${through.toISOString()}::timestamptz
      AND (${agentEvents.data}->>'type' = 'skill_load'
        OR (${agentEvents.data}->>'type' = 'cli_tool_use' AND ${agentEvents.data}->>'toolName' ~ '(^|[_.:])(octipus_)?get_skill$'))`;
  const rows = await getDb().select({ id: skills.id, name: skills.name, content: skills.content }).from(skills)
    .where(and(sql`${skills.id} IN (${loaded})`, sql`${skills.userId}::text = ${userId}`, eq(skills.isSystem, false),
      isNull(skills.archivedAt), isNull(skills.ownerEditedAt), ne(skills.content, ''), sql`length(${skills.content}) <= ${MAX_PATCHED_SKILL_CHARS}`))
    .orderBy(sql`${skills.lastUsedAt} DESC NULLS LAST`).limit(MAX_PATCHABLE_SKILLS);
  const targets: PatchableSkill[] = [];
  for (const row of rows) {
    // Content is shown redacted, like every other excerpt; a patch quoting a
    // redaction placeholder simply fails the exact match against the stored text.
    const target = { id: row.id, name: row.name, content: filterPII(row.content ?? '').filtered };
    if (patchTargetChars([...targets, target]) <= MAX_PATCH_TARGET_CHARS) targets.push(target);
  }
  return targets;
}

/**
 * The lower bound of an automatic review's evidence window: the `through` of
 * the session's previous learning check that ended (`done` or `error`), not
 * `jobId` itself. Null when there is none (the session's first review).
 */
export async function previousReviewThrough(userId: string, sessionId: string, jobId: string): Promise<Date | null> {
  const [row] = await getDb().select({ payload: backgroundJobs.payload }).from(backgroundJobs).where(and(
    eq(backgroundJobs.kind, 'learning'), eq(backgroundJobs.userId, userId), ne(backgroundJobs.id, jobId),
    sql`${backgroundJobs.payload}->>'sessionId' = ${sessionId}`, inArray(backgroundJobs.status, ['done', 'error']),
  )).orderBy(desc(backgroundJobs.seq)).limit(1);
  const through = row?.payload.through;
  if (typeof through !== 'string') return null;
  const date = new Date(through);
  if (Number.isNaN(date.getTime())) throw new Error(`Learning check for session ${sessionId} has an invalid through: ${through}`);
  return date;
}

/** A live skill or open proposal the review is shown so it extends instead of duplicating. */
export interface ExistingItem {
  /** `skill:<id>` or `proposal:<id>`; a skill candidate's `extends` names a proposal ref from here. */
  ref: string;
  name: string;
  description?: string;
  /** The first EXISTING_EXCERPT_CHARS of its content or draft (not for system skills). */
  excerpt?: string;
}
export interface ExistingContext { skills: ExistingItem[]; proposals: ExistingItem[] }
export const NEAREST_EXISTING = 5;
export const EXISTING_EXCERPT_CHARS = 600;
const EXISTING_DESCRIPTION_CHARS = 400;
/** Without embeddings: the most recent open proposals, and learned-skill names. */
export const FALLBACK_PROPOSALS = 10;
export const FALLBACK_SKILL_NAMES = 30;
/** All of `existing` together stays within this share of MAX_EVIDENCE_CHARS. */
export const MAX_EXISTING_CHARS = 8_000;

/** What `existing` takes of the review input, as part of gatherEvidence's `reserveChars`. */
export function existingChars(existing: ExistingContext): number {
  return [...existing.skills, ...existing.proposals].reduce((n, item) => n + JSON.stringify(item).length + 2, 0);
}

/** Keep `existing` within `budget`, nearest first, taking proposals and skills in turn. */
export function boundExisting(existing: ExistingContext, budget = MAX_EXISTING_CHARS): ExistingContext {
  const out: ExistingContext = { skills: [], proposals: [] };
  let used = 0;
  for (let i = 0; i < Math.max(existing.skills.length, existing.proposals.length); i++) {
    for (const key of ['proposals', 'skills'] as const) {
      const item = existing[key][i];
      if (!item) continue;
      const size = JSON.stringify(item).length + 2;
      if (used + size > budget) continue;
      out[key].push(item);
      used += size;
    }
  }
  return out;
}

/** The patch targets on offer: the loaded ones first, then the nearest, at most MAX_PATCHABLE_SKILLS within MAX_PATCH_TARGET_CHARS. */
export function mergePatchTargets(loaded: PatchableSkill[], nearest: PatchableSkill[]): PatchableSkill[] {
  const targets: PatchableSkill[] = [];
  for (const skill of [...loaded, ...nearest]) {
    if (targets.length >= MAX_PATCHABLE_SKILLS) break;
    if (targets.some(target => target.id === skill.id)) continue;
    if (patchTargetChars([...targets, skill]) <= MAX_PATCH_TARGET_CHARS) targets.push(skill);
  }
  return targets;
}

const redact = (text: string, max: number) => filterPII(text.slice(0, max)).filtered;

/** Plan title and goal plus the last typed user messages: what the review is about, for ranking `existing`. */
async function reviewTopicText(sessionId: string, through: Date, plan: unknown): Promise<string> {
  const parts: string[] = [];
  if (plan && typeof plan === 'object') {
    const { title, goal } = plan as { title?: unknown; goal?: unknown };
    for (const value of [title, goal]) if (typeof value === 'string' && value.trim()) parts.push(value.trim());
  }
  const typed = await getDb().select({ text: sql<string>`left(${messages.content}, 1000)` }).from(messages)
    .where(and(eq(messages.sessionId, sessionId), lte(messages.createdAt, through), eq(messages.role, 'user'), typedByOwner))
    .orderBy(desc(messages.createdAt)).limit(3);
  parts.push(...typed.map(row => row.text));
  return filterPII(parts.join('\n')).filtered.trim();
}

/** The topic's embedding after bringing stored embeddings up to date; null without an embedding model. */
async function topicEmbedding(userId: string, topic: string): Promise<number[] | null> {
  if (!topic || !(await capabilityConfigured('embedding'))) return null;
  await ensureSkillEmbeddings({ limit: 20 });
  await ensureProposalEmbeddings(userId, { limit: 20 });
  try {
    return await getEmbeddingService().generateEmbedding(topic, 'query');
  } catch (err) {
    coreLogger.warn({ err, userId }, 'Learning check: no embedding for the review topic; offering the most recent proposals instead');
    return null;
  }
}

/** Stored vectors of another dimension (an earlier embedding model) cannot be compared and are skipped. */
function comparable(column: typeof skills.descriptionEmbedding | typeof skillProposals.embedding, vector: number[]) {
  return and(isNotNull(column), sql`vector_dims(${column}) = ${vector.length}`);
}
function nearestFirst(column: typeof skills.descriptionEmbedding | typeof skillProposals.embedding, vector: number[]) {
  return sql`${column} <=> ${`[${vector.join(',')}]`}::vector`;
}

/** The owner's learned skills a patch may target (the rules of `assertPatchable`, and within the size cap). */
const patchableBy = (userId: string) => and(sql`${skills.userId}::text = ${userId}`, eq(skills.isSystem, false),
  sql`${skills.id} NOT LIKE 'external:%'`, isNull(skills.archivedAt), isNull(skills.ownerEditedAt), ne(skills.content, ''),
  sql`length(${skills.content}) <= ${MAX_PATCHED_SKILL_CHARS}`);

const openProposalsOf = (userId: string) => and(eq(skillProposals.userId, userId), ne(skillProposals.kind, 'patch'),
  inArray(skillProposals.status, ['pending', 'candidate']));

/**
 * What the review is shown besides the evidence (docs/plans/self-learning-consolidation.md):
 *
 * - `existing`: up to NEAREST_EXISTING live skills (the owner's own, and
 *   system skills by name and description only) and up to NEAREST_EXISTING of
 *   the owner's open proposals, nearest to the plan title/goal plus the last
 *   typed user messages. Without an embedding model (or with nothing to rank
 *   by): the FALLBACK_PROPOSALS most recent open proposals and up to
 *   FALLBACK_SKILL_NAMES learned-skill names. Redacted, within MAX_EXISTING_CHARS.
 * - `patchTargets`: `loaded` (the skills this session loaded) first, then the
 *   nearest patchable learned skills, within the patch-target caps. A skill
 *   offered as a patch target is not repeated in `existing`.
 *
 * Nothing of another user is read. Caller validates session ownership.
 */
export async function gatherReviewContext(userId: string, sessionId: string, through: Date, plan: unknown, loaded: PatchableSkill[]): Promise<{ existing: ExistingContext; patchTargets: PatchableSkill[] }> {
  const db = getDb();
  const embedding = await topicEmbedding(userId, await reviewTopicText(sessionId, through, plan));
  if (!embedding) {
    const [proposals, names] = await Promise.all([
      db.select({ id: skillProposals.id, name: skillProposals.name, description: skillProposals.description, draft: skillProposals.draftPromptTemplate })
        .from(skillProposals).where(openProposalsOf(userId)).orderBy(desc(skillProposals.createdAt)).limit(FALLBACK_PROPOSALS),
      db.select({ id: skills.id, name: skills.name }).from(skills)
        .where(and(sql`${skills.userId}::text = ${userId}`, eq(skills.isSystem, false), isNull(skills.archivedAt),
          loaded.length ? notInArray(skills.id, loaded.map(skill => skill.id)) : undefined))
        .orderBy(sql`${skills.lastUsedAt} DESC NULLS LAST`, desc(skills.updatedAt)).limit(FALLBACK_SKILL_NAMES),
    ]);
    return {
      patchTargets: mergePatchTargets(loaded, []),
      existing: boundExisting({
        proposals: proposals.map(row => ({ ref: `proposal:${row.id}`, name: redact(row.name, 100),
          description: redact(row.description, EXISTING_DESCRIPTION_CHARS), excerpt: redact(row.draft, EXISTING_EXCERPT_CHARS) })),
        skills: names.map(row => ({ ref: `skill:${row.id}`, name: redact(row.name, 100) })),
      }),
    };
  }

  const nearestPatchable = await db.select({ id: skills.id, name: skills.name, content: skills.content }).from(skills)
    .where(and(patchableBy(userId), comparable(skills.descriptionEmbedding, embedding),
      loaded.length ? notInArray(skills.id, loaded.map(skill => skill.id)) : undefined))
    .orderBy(nearestFirst(skills.descriptionEmbedding, embedding)).limit(MAX_PATCHABLE_SKILLS);
  const patchTargets = mergePatchTargets(loaded,
    nearestPatchable.map(row => ({ id: row.id, name: row.name, content: filterPII(row.content ?? '').filtered })));
  const offered = patchTargets.map(skill => skill.id);

  const [liveSkills, proposals] = await Promise.all([
    db.select({ id: skills.id, name: skills.name, description: skills.description, content: skills.content, isSystem: skills.isSystem }).from(skills)
      .where(and(or(sql`${skills.userId}::text = ${userId}`, eq(skills.isSystem, true)), isNull(skills.archivedAt),
        comparable(skills.descriptionEmbedding, embedding), offered.length ? notInArray(skills.id, offered) : undefined))
      .orderBy(nearestFirst(skills.descriptionEmbedding, embedding)).limit(NEAREST_EXISTING),
    db.select({ id: skillProposals.id, name: skillProposals.name, description: skillProposals.description, draft: skillProposals.draftPromptTemplate })
      .from(skillProposals).where(and(openProposalsOf(userId), comparable(skillProposals.embedding, embedding)))
      .orderBy(nearestFirst(skillProposals.embedding, embedding)).limit(NEAREST_EXISTING),
  ]);
  return {
    patchTargets,
    existing: boundExisting({
      skills: liveSkills.map(row => ({ ref: `skill:${row.id}`, name: redact(row.name, 100), description: redact(row.description, EXISTING_DESCRIPTION_CHARS),
        // A system skill is shown by name and description only.
        ...(!row.isSystem && row.content ? { excerpt: redact(row.content, EXISTING_EXCERPT_CHARS) } : {}) })),
      proposals: proposals.map(row => ({ ref: `proposal:${row.id}`, name: redact(row.name, 100),
        description: redact(row.description, EXISTING_DESCRIPTION_CHARS), excerpt: redact(row.draft, EXISTING_EXCERPT_CHARS) })),
    }),
  };
}
