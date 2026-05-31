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

export interface HealthStatus {
  services: Record<string, { status: string; latency?: number }>;
}
