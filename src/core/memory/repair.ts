/**
 * Model-free memory repair, run daily from the cron tick
 * (`src/core/cron-runner.ts`). Two passes, no model and no embedding call:
 *
 *  1. Expire: an active row whose `expires_at` has passed is retired
 *     (`valid_until = expires_at`, `archive_reason = 'expired'`). Recall
 *     already skips such a row from the moment it ends; this records why.
 *  2. Merge: active rows of one user and scope (workspace, role) whose text is
 *     the same after normalisation (`factKey`) are folded into one. The row
 *     kept is the most-read, then the oldest; the others point at it
 *     (`superseded_by`, `archive_reason = 'merged'`). A kept row that was
 *     tentative becomes observed when a duplicate came from another message,
 *     and takes a duplicate's quote if it had none.
 *
 * What it does not do: merge paraphrases ("prefers tabs" / "likes tabs
 * better") — that needs the judge and its model; or retire facts that have
 * gone stale without an end date (`archive_reason = 'stale'` is reserved for
 * that and nothing writes it yet).
 */

import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { type MemoryStatus, memories } from '@/db/schema/memories';
import { factKey } from './quote-basis';

export interface MemoryRepairResult {
  expired: number;
  merged: number;
}

interface RepairRow {
  id: string;
  workspaceId: string | null;
  agentScope: string | null;
  content: string;
  sourceMessageId: string | null;
  sourceQuote: string | null;
  status: MemoryStatus | null;
  accessCount: number;
  createdAt: Date;
}

/** What to fold: for each group of exact duplicates, the row kept and the rows merged into it. Pure. */
export function planMerges(rows: readonly RepairRow[]): Array<{ keep: RepairRow; merge: RepairRow[] }> {
  const groups = new Map<string, RepairRow[]>();
  for (const row of rows) {
    const key = `${row.workspaceId ?? ''}\u0000${row.agentScope ?? ''}\u0000${factKey(row.content)}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const plans: Array<{ keep: RepairRow; merge: RepairRow[] }> = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [keep, ...merge] = [...group].sort((a, b) =>
      b.accessCount - a.accessCount || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    plans.push({ keep, merge });
  }
  return plans;
}

async function expirePastDue(now: Date): Promise<number> {
  const rows = await getDb()
    .update(memories)
    .set({ validUntil: sql`${memories.expiresAt}`, archiveReason: 'expired', updatedAt: now })
    .where(and(
      isNotNull(memories.expiresAt),
      lte(memories.expiresAt, now),
      isNull(memories.supersededBy),
      or(isNull(memories.validUntil), sql`${memories.validUntil} > ${memories.expiresAt}`),
    ))
    .returning({ id: memories.id });
  return rows.length;
}

async function mergeDuplicates(userId: string, now: Date): Promise<number> {
  const db = getDb();
  const rows = await db
    .select({
      id: memories.id, workspaceId: memories.workspaceId, agentScope: memories.agentScope, content: memories.content,
      sourceMessageId: memories.sourceMessageId, sourceQuote: memories.sourceQuote, status: memories.status,
      accessCount: memories.accessCount, createdAt: memories.createdAt,
    })
    .from(memories)
    .where(and(
      eq(memories.userId, userId),
      isNull(memories.supersededBy),
      or(isNull(memories.validUntil), sql`${memories.validUntil} > ${now.toISOString()}::timestamptz`),
      or(isNull(memories.expiresAt), sql`${memories.expiresAt} > ${now.toISOString()}::timestamptz`),
    ))
    .orderBy(asc(memories.createdAt));
  let merged = 0;
  for (const { keep, merge } of planMerges(rows)) {
    const otherSource = merge.some((m) => m.sourceMessageId && m.sourceMessageId !== keep.sourceMessageId);
    const quoted = keep.sourceQuote ? null : merge.find((m) => m.sourceQuote);
    await db.transaction(async (tx) => {
      const done = await tx
        .update(memories)
        .set({ supersededBy: keep.id, archiveReason: 'merged', updatedAt: now })
        .where(and(inArray(memories.id, merge.map((m) => m.id)), isNull(memories.supersededBy)))
        .returning({ id: memories.id });
      merged += done.length;
      if (done.length === 0) return;
      const patch = {
        ...(otherSource && keep.status === 'tentative' ? { status: 'observed' as const } : {}),
        ...(quoted ? { sourceQuote: quoted.sourceQuote, sourceMessageId: quoted.sourceMessageId } : {}),
      };
      if (Object.keys(patch).length > 0) {
        await tx.update(memories).set({ ...patch, updatedAt: now }).where(eq(memories.id, keep.id));
      }
    });
  }
  return merged;
}

/** Run both passes over every user. Safe to run concurrently on two instances: every write is guarded on the row still being active. */
export async function repairMemories(now: Date = new Date()): Promise<MemoryRepairResult> {
  const expired = await expirePastDue(now);
  const users = await getDb()
    .selectDistinct({ userId: memories.userId })
    .from(memories)
    .where(isNull(memories.supersededBy));
  let merged = 0;
  for (const { userId } of users) merged += await mergeDuplicates(userId, now);
  return { expired, merged };
}
