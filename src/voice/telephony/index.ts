/**
 * Telephony module — factory for voice call providers.
 * Credentials are loaded from the vault at runtime.
 */

import { coreLogger } from '@/utils/logger';
import type { TelephonyProvider } from './interface';

export type {
  CallDirection, CallInstruction, CallSession, CallStatus, InitiateCallOptions, SpokenLine, TelephonyProvider, TelephonyWebhookEvent, WebhookReply,
} from './interface';
export { CallManager, getCallManager, isFinalCallStatus } from './interface';

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

  // Helper: search system scope first, then admin user's vault
  async function getSecret(key: string): Promise<string | null> {
    const systemVal = await vault.getByName('system', key);
    if (systemVal) return systemVal;
    // Credentials stored via the web UI are under the user's ID, not 'system'.
    // Search the first real admin user's vault (exclude test users).
    try {
      const { getDb } = await import('@/db/postgres');
      const { users } = await import('@/db/schema/users');
      const { eq, and, not, like } = await import('drizzle-orm');
      const db = getDb();
      const [admin] = await db.select({ id: users.id }).from(users)
        .where(and(eq(users.isAdmin, true), not(like(users.username, 'e2e_test_%'))))
        .limit(1);
      if (admin) {
        const userVal = await vault.getByName(admin.id, key);
        if (userVal) return userVal;
      }
    } catch (err) {
      coreLogger.warn({ err, key }, 'Telephony credential lookup in the admin vault failed');
    }
    return null;
  }

  switch (name) {
    case 'twilio': {
      const accountSid = await getSecret('twilio_account_sid');
      const authToken = await getSecret('twilio_auth_token');
      if (!accountSid || !authToken) return null;
      // Phone number: setting first, vault fallback, auto-detect last
      const fromNumber = (await settings.get('voice.phoneNumber') as string | null)
        || await getSecret('twilio_phone_number') || '';

      const { TwilioProvider } = await import('./twilio');
      cachedProvider = new TwilioProvider({ accountSid, authToken, fromNumber });
      break;
    }

    case 'telnyx': {
      const apiKey = await getSecret('telnyx_api_key');
      const connectionId = await getSecret('telnyx_connection_id') || '';
      const fromNumber = (await settings.get('voice.phoneNumber') as string | null)
        || await getSecret('telnyx_phone_number') || '';
      const publicKey = await getSecret('telnyx_public_key') || undefined;
      if (!apiKey) return null;

      const { TelnyxProvider } = await import('./telnyx');
      cachedProvider = new TelnyxProvider({ apiKey, connectionId, fromNumber, publicKey });
      break;
    }

    case 'plivo': {
      const authId = await getSecret('plivo_auth_id');
      const authToken = await getSecret('plivo_auth_token');
      const fromNumber = (await settings.get('voice.phoneNumber') as string | null)
        || await getSecret('plivo_phone_number') || '';
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
  // Re-probe the `voice` capability row, not just the tool registry's cache.
  // The role gate (getToolsForRole) reads the capabilities TABLE — before this,
  // configuring Twilio/Telnyx/Plivo after boot left `voice` marked unavailable
  // until the next restart, so the communication worker spawned without the
  // make_call tool and voice functionality appeared "lost".
  import('@/capabilities/service')
    .then((m) => m.getCapabilityService().reprobe('voice'))
    .catch((err: unknown) => coreLogger.error({ err }, 'voice capability re-probe failed after telephony reset'));
}
