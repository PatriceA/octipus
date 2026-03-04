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

export interface ChannelBinding {
  channelType: string;
  channelUserId: string;
  channelUserName?: string;
  isVerified: boolean;
  createdAt: string;
}

export interface HealthStatus {
  services: Record<string, { status: string; latency?: number }>;
}
