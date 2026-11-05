import { and, eq } from 'drizzle-orm';
import { getDb } from '@/db/postgres';
import { companionIncidents, companionSettings } from '@/db/schema/companion-supervision';

/** A revision is a revocable delegation, never converted into owner intent. */
export async function companionActionAuthorized(action: { authorityRevision: number | null; authoritySettingsId: string | null; incidentId?: string | null; strategyIndex?: number | null }, scope: { userId: string; workspaceId: string }) {
  if (action.authorityRevision === null) return true;
  if (!action.authoritySettingsId) return false;
  const [settings] = await getDb().select().from(companionSettings).where(and(eq(companionSettings.id, action.authoritySettingsId),
    eq(companionSettings.userId, scope.userId), eq(companionSettings.workspaceId, scope.workspaceId)));
  if (action.incidentId) {
    const [incident] = await getDb().select().from(companionIncidents).where(eq(companionIncidents.id, action.incidentId));
    if (incident?.state !== 'repairing' || incident.strategies.length !== action.strategyIndex) return false;
  }
  return !!settings?.enabled && settings.autonomy !== 'observe' && settings.revision === action.authorityRevision;
}
