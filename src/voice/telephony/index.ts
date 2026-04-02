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

  switch (name) {
    case 'twilio': {
      const accountSid = await vault.getByName('system', 'twilio_account_sid');
      const authToken = await vault.getByName('system', 'twilio_auth_token');
      const fromNumber = await vault.getByName('system', 'twilio_phone_number') || '';
      if (!accountSid || !authToken) return null;

      const { TwilioProvider } = await import('./twilio');
      cachedProvider = new TwilioProvider({ accountSid, authToken, fromNumber });
      break;
    }

    case 'telnyx': {
      const apiKey = await vault.getByName('system', 'telnyx_api_key');
      const connectionId = await vault.getByName('system', 'telnyx_connection_id') || '';
      const fromNumber = await vault.getByName('system', 'telnyx_phone_number') || '';
      const publicKey = await vault.getByName('system', 'telnyx_public_key') || undefined;
      if (!apiKey) return null;

      const { TelnyxProvider } = await import('./telnyx');
      cachedProvider = new TelnyxProvider({ apiKey, connectionId, fromNumber, publicKey });
      break;
    }

    case 'plivo': {
      const authId = await vault.getByName('system', 'plivo_auth_id');
      const authToken = await vault.getByName('system', 'plivo_auth_token');
      const fromNumber = await vault.getByName('system', 'plivo_phone_number') || '';
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
