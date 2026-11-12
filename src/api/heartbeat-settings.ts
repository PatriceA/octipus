import { getConfig } from '@/config';
import { getSettingsService } from '@/config/settings-service';
import { requireScope, type Principal } from '@/security/principal';
import { API_SCOPES } from '@/security/scopes';

/** An admin's enable action in Heartbeat settings activates its server prerequisite too. */
export async function activateHeartbeatService(user: { id: string; isAdmin?: boolean }, principal: Principal | null | undefined): Promise<void> {
  if (getConfig().heartbeat.enabled || !user.isAdmin || !requireScope(principal, API_SCOPES.ADMIN)) return;
  await getSettingsService().set('heartbeat.enabled', true, user.id);
}
