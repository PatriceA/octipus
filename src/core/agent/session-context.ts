/**
 * `GET /api/sessions/:id/context` — the Context inspector's data
 * (docs/CONTEXT-INSPECTOR.md).
 *
 * Sizes come from the `promptComposition` stored with each root turn's user
 * message. The latest turn's text comes from this process's memory, when it
 * still holds it; otherwise the response says so (`textAvailable: false`)
 * rather than showing an empty section.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { messages } from '@/db/schema/messages';
import { costLog } from '@/db/schema/models';
import {
  type PromptComposition,
  type ProviderInputUsage,
  type SessionContextResponse,
  tokensByCategory,
} from '@/shared/prompt-composition';
import { getLatestComposition } from './prompt-composition';

/** Turns on the growth chart. */
export const CONTEXT_TURNS_SHOWN = 40;

function isComposition(value: unknown): value is PromptComposition {
  const v = value as Partial<PromptComposition> | null;
  return !!v && v.version === 1 && Array.isArray(v.sections) && typeof v.totals?.tokens === 'number';
}

/** What the provider reported for the measured agent's FIRST request of the turn: the one the estimate describes. */
async function firstRequestUsage(agentId: string | null): Promise<ProviderInputUsage | null> {
  if (!agentId) return null;
  const [row] = await getDb()
    .select({
      inputTokens: costLog.inputTokens,
      cachedInputTokens: costLog.cachedInputTokens,
      cacheCreationTokens: costLog.cacheCreationTokens,
      createdAt: costLog.createdAt,
    })
    .from(costLog)
    .where(eq(costLog.agentId, agentId))
    .orderBy(asc(costLog.createdAt))
    .limit(1);
  return row
    ? { inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, cacheCreationTokens: row.cacheCreationTokens, at: row.createdAt.toISOString() }
    : null;
}

export async function readSessionContext(sessionId: string): Promise<SessionContextResponse> {
  const rows = await getDb()
    .select({
      id: messages.id,
      agentId: messages.agentId,
      createdAt: messages.createdAt,
      composition: sql<unknown>`${messages.metadata}->'promptComposition'`,
    })
    .from(messages)
    .where(and(
      eq(messages.sessionId, sessionId),
      eq(messages.role, 'user'),
      sql`${messages.metadata} ? 'promptComposition'`,
    ))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(CONTEXT_TURNS_SHOWN);

  const stored = rows.filter((r) => isComposition(r.composition)) as Array<typeof rows[number] & { composition: PromptComposition }>;
  const turns = stored.slice().reverse().map((r) => ({
    messageId: r.id,
    at: r.createdAt.toISOString(),
    totals: r.composition.totals,
    byCategory: tokensByCategory(r.composition.sections),
  }));

  const newest = stored[0];
  const inMemory = getLatestComposition(sessionId);
  // Memory wins when it is the newest turn: the stored row, or a turn that
  // stored no row (a room). A newer stored row (another process) wins over it.
  const memoryIsNewest = !!inMemory && (
    !newest
    || inMemory.messageId === newest.id
    || (!inMemory.messageId && inMemory.composition.measuredAt > newest.composition.measuredAt)
  );

  let latest: SessionContextResponse['latest'] = null;
  let agentId: string | null = null;
  if (memoryIsNewest && inMemory) {
    latest = { ...inMemory.composition, ...(inMemory.messageId ? { messageId: inMemory.messageId } : {}), textAvailable: true };
    agentId = inMemory.agentId;
  } else if (newest) {
    latest = { ...newest.composition, messageId: newest.id, textAvailable: false };
    agentId = newest.agentId;
  }

  return { latest, turns, usage: await firstRequestUsage(agentId) };
}
