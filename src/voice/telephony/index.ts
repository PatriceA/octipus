/**
 * Telephony module — factory for voice call providers.
 * Credentials are loaded from the vault at runtime.
 */

import type { TelephonyProvider } from './interface';
export { CallManager, getCallManager } from './interface';
export type { TelephonyProvider, CallSession, CallStatus, CallDirection, InitiateCallOptions, CallEvent } from './interface';

let cachedProvider: TelephonyProvider | null = null;
let cachedProviderName: string | null = null;

/**
 * Create a telephony provider based on the configured provider name.
 * Credentials are loaded from the vault.
 */
export async function getTelephonyProvider(providerName?: string): Promise<TelephonyProvider | null> {
  const { getSettingsService } = await import('@/config/settings-service');
  const settings = getSettingsService();
  const name = providerName || (await settings.get('voice.telephonyProvider') as string | null);

  if (!name || name === 'disabled') return null;
  if (cachedProvider && cachedProviderName === name) return cachedProvider;

  const { getVault } = await import('@/security/vault');
  const vault = getVault();

  // Helper: search system scope first, then all users (credentials might be stored under user ID)
  async function getSecret(key: string): Promise<string | null> {
    const systemVal = await vault.getByName('system', key);
    if (systemVal) return systemVal;
    // Search across all vault entries by listing system + checking first admin
    try {
      const { getDb } = await import('@/db/postgres');
      const { users } = await import('@/db/schema/users');
      const { eq } = await import('drizzle-orm');
      const db = getDb();
      const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isAdmin, true)).limit(1);
      if (admin) {
        const userVal = await vault.getByName(admin.id, key);
        if (userVal) return userVal;
      }
    } catch { /* fallback failed */ }
    return null;
  }

  switch (name) {
    case 'twilio': {
      const accountSid = await getSecret('twilio_account_sid');
      const authToken = await getSecret('twilio_auth_token');
      if (!accountSid || !authToken) return null;
      const fromNumber = await getSecret('twilio_phone_number') || '';

      const { TwilioProvider } = await import('./twilio');
      cachedProvider = new TwilioProvider({ accountSid, authToken, fromNumber });
      break;
    }

    case 'telnyx': {
      const apiKey = await getSecret('telnyx_api_key');
      const connectionId = await getSecret('telnyx_connection_id') || '';
      const fromNumber = await getSecret('telnyx_phone_number') || '';
      const publicKey = await getSecret('telnyx_public_key') || undefined;
      if (!apiKey) return null;

      const { TelnyxProvider } = await import('./telnyx');
      cachedProvider = new TelnyxProvider({ apiKey, connectionId, fromNumber, publicKey });
      break;
    }

    case 'plivo': {
      const authId = await getSecret('plivo_auth_id');
      const authToken = await getSecret('plivo_auth_token');
      const fromNumber = await getSecret('plivo_phone_number') || '';
      if (!authId || !authToken) return null;

      const { PlivoProvider } = await import('./plivo');
      cachedProvider = new PlivoProvider({ authId, authToken, fromNumber });
      break;
    }

    default:
      return null;
  }

  cachedProviderName = name;
  return cachedProvider;
}

/** Reset cached provider (e.g., after credential change) */
export function resetTelephonyProvider(): void {
  cachedProvider = null;
  cachedProviderName = null;
}
