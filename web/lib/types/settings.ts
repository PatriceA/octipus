// Canonical, dependency-free definition shared with the backend (M19). Imported
// for local use (UserProfile.channelBindings) and re-exported so existing
// `import { ChannelBinding } from '@/lib/types/settings'` consumers keep working.
import type { ChannelBinding } from '../../../src/shared/types';
export type { ChannelBinding };

export interface UserProfile {
  id: string;
  username: string;
  email?: string;
  isAdmin: boolean;
  totpEnabled: boolean;
  channelBindings?: ChannelBinding[];
  preferences?: {
    theme?: string;
    language?: string;
    notifications?: boolean;
    defaultModel?: string;
    timezone?: string;
  };
}

/**
 * `GET /health/detailed`. The per-service map is `health`, not `services` — the
 * Settings page read `services` off `GET /health` (which carries neither), so
 * its Service Status panel rendered an empty grid under a heading from the day
 * it shipped.
 */
export interface HealthStatus {
  status: string;
  uptime?: number;
  agents?: { total: number; running: number };
  health: Record<string, { service: string; status: string; latency?: number; lastChecked?: string }>;
}
