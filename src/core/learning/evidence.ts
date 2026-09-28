import { and, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { agentEvents } from '@/db/schema/agent-events';
import { messages } from '@/db/schema/messages';
import { verificationEvidence } from '@/db/schema/verification-evidence';
import { filterPII } from '@/core/agent/pii-filter';

export interface LearningEvidence { id: string; kind: 'user' | 'assistant' | 'execution' | 'verification' | 'plan' | 'request'; text: string }
export const MAX_EVIDENCE_CHARS = 40_000;
/** Keep category coverage while bounding cost. Each excerpt is explicitly truncated. */
export function boundEvidence(rows: LearningEvidence[]): LearningEvidence[] {
  let remaining = MAX_EVIDENCE_CHARS;
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

/** Caller validates session ownership. Read only evidence available at the milestone. */
export async function gatherEvidence(userId: string, sessionId: string, through: Date, plan?: unknown): Promise<LearningEvidence[]> {
  const db = getDb();
  const [chat, checks, events] = await Promise.all([
    db.select({ id: messages.id, role: messages.role, text: sql<string>`left(${messages.content}, 3000)` }).from(messages)
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
    ...chat.map(row => ({ id: `message:${row.id}`, kind: row.role as 'user' | 'assistant', text: row.text })),
    ...checks.map(row => ({ id: `check:${row.id}`, kind: 'verification' as const, text: row.text })),
    ...events.map(row => ({ id: `event:${row.id}`, kind: row.observed ? 'execution' as const : 'request' as const, text: row.text })),
  ]);
}
