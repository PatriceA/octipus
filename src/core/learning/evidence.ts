import { and, desc, eq, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agentEvents } from '@/db/schema/agent-events';
import { messages } from '@/db/schema/messages';
import { visibleMessages } from '@/db/repositories/message-visibility';
import { skills } from '@/db/schema/skills';
import { verificationEvidence } from '@/db/schema/verification-evidence';
import { filterPII } from '@/core/agent/pii-filter';
import { MAX_PATCHED_SKILL_CHARS } from '@/skills/patch';

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
 * Caller validates session ownership. Read only evidence available at the milestone.
 * `reserveChars`: room the review input needs for other material (patch
 * targets), taken off MAX_EVIDENCE_CHARS so the whole stays within it.
 */
export async function gatherEvidence(userId: string, sessionId: string, through: Date, plan?: unknown, { reserveChars = 0 }: { reserveChars?: number } = {}): Promise<LearningEvidence[]> {
  const db = getDb();
  const [chat, checks, events] = await Promise.all([
    db.select({ id: messages.id, role: messages.role, text: sql<string>`left(${messages.content}, 3000)`,
      // A user row a person typed; Companion handoffs, monitors, schedules,
      // internal inputs and the plan brief are stored as user rows too but are
      // not the owner's words.
      typed: sql<boolean>`(coalesce(${messages.metadata}->>'trigger', 'user') = 'user' AND ${messages.metadata}->>'synthetic' IS NULL AND ${visibleMessages})` }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), lte(messages.createdAt, through), inArray(messages.role, ['user', 'assistant'])))
      .orderBy(desc(messages.createdAt)).limit(8),
    db.select({ id: verificationEvidence.id, text: sql<string>`left(jsonb_build_object('kind', ${verificationEvidence.kind}, 'passed', ${verificationEvidence.passed}, 'detail', ${verificationEvidence.detail})::text, 3000)` })
      .from(verificationEvidence).where(and(eq(verificationEvidence.sessionId, sessionId), lte(verificationEvidence.createdAt, through)))
      .orderBy(desc(verificationEvidence.createdAt)).limit(8),
    db.select({ id: agentEvents.id, observed: sql<boolean>`(${agentEvents.data}->>'type' = 'cli_tool_result' OR ${agentEvents.data} ? 'results')`, text: sql<string>`left(${agentEvents.data}::text, 3000)` }).from(agentEvents)
      .where(and(eq(agentEvents.userId, userId), eq(agentEvents.sessionId, sessionId), lte(agentEvents.createdAt, through),
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
