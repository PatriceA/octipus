import { and, eq, sql } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { sessions } from '@/db/schema/sessions';
import { sessionProtectionLevel } from '@/core/protection/session-level';
import { getFlowLabel } from '@/security/flow-guard';
import type { CompanionScope } from '@/shared/companion-supervision';

/** Capture this process's labels synchronously, then persist before transferring content.
 * This also covers reads whose normal background label write has not committed yet.
 */
export async function persistCompanionSource(scope: CompanionScope, sessionId: string) {
  const label = getFlowLabel(sessionId);
  const flags: Partial<Record<'secret' | 'private' | 'suspicious', string>> = {};
  for (const flag of ['secret', 'private', 'suspicious'] as const) if (label[flag]) flags[flag] = label.sources[flag] ?? 'Companion source session';
  const [stored] = await getDb().update(sessions).set({
    protectionLevel: sql`greatest(coalesce(${sessions.protectionLevel},1),${sessionProtectionLevel(sessionId)})`,
    flowLabel: sql`${JSON.stringify(flags)}::jsonb || coalesce(${sessions.flowLabel},'{}'::jsonb)`,
  }).where(and(eq(sessions.id, sessionId), eq(sessions.userId, scope.userId), eq(sessions.workspaceId, scope.workspaceId), eq(sessions.kind, 'chat'), sql`${sessions.groupChannelId} IS NULL`))
    .returning({ protectionLevel: sessions.protectionLevel, flowLabel: sessions.flowLabel });
  if (!stored) throw new Error('Companion source is not your personal session');
  return stored;
}
