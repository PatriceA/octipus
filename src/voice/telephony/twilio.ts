/**
 * Twilio telephony provider — Programmable Voice + Media Streams.
 *
 * Supports:
 * - Outbound calls (notify + conversation mode)
 * - TwiML generation for call flow control
 * - Media Streams (WebSocket) for real-time audio
 * - Webhook signature verification
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '@/utils/logger';
import type { TelephonyProvider, InitiateCallOptions, CallSession, CallStatus } from './interface';
import { randomBytes } from 'crypto';

const log = logger.child({ component: 'twilio-provider' });

export class TwilioProvider implements TelephonyProvider {
  readonly name = 'twilio';

  private accountSid: string;
  private authToken: string;
  private fromNumber: string;
  private language: string;
  private baseUrl = 'https://api.twilio.com/2010-04-01';

  constructor(config: { accountSid: string; authToken: string; fromNumber: string; language?: string }) {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.fromNumber = config.fromNumber;
    this.language = config.language || 'en-US';
  }

  async initiateCall(options: InitiateCallOptions): Promise<CallSession> {
    const callId = `call_${randomBytes(8).toString('hex')}`;
    const from = options.from || this.fromNumber;

    const params = new URLSearchParams({
      To: options.to,
      From: from,
      Url: options.webhookUrl,
      Method: 'POST',
      StatusCallback: `${options.webhookUrl}/status`,
      StatusCallbackMethod: 'POST',
    });

    if (options.timeout) {
      params.set('Timeout', String(options.timeout));
    }

    // If media streaming is requested, add stream URL
    if (options.streamUrl) {
      params.set('Url', options.webhookUrl); // TwiML will be served from webhook
    }

    const response = await fetch(
      `${this.baseUrl}/Accounts/${this.accountSid}/Calls.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      },
    );

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      throw new Error(`Twilio call initiation failed (${response.status}): ${err}`);
    }

    const data = await response.json() as { sid: string; status: string };

    log.info({ callId, providerCallId: data.sid, to: options.to }, 'Twilio call initiated');

    return {
      id: callId,
      provider: 'twilio',
      providerCallId: data.sid,
      direction: 'outbound',
      from,
      to: options.to,
      status: 'initiated',
      startedAt: new Date(),
      metadata: { mode: options.mode || 'notify' },
    };
  }

  generateAnswerResponse(options: {
    message: string;
    voice?: string;
    gatherSpeech?: boolean;
    gatherTimeout?: number;
    callbackUrl?: string;
    streamUrl?: string;
  }): string {
    const voice = options.voice || 'Polly.Amy';
    let twiml = '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n';

    if (options.gatherSpeech && options.callbackUrl) {
      // Interactive mode: speak, then gather speech input
      const lang = this.language || 'en-US';
      twiml += `  <Gather input="speech" action="${this.escapeXml(options.callbackUrl)}" `;
      twiml += `speechTimeout="${options.gatherTimeout || 'auto'}" language="${lang}" enhanced="true">\n`;
      twiml += `    <Say voice="${voice}">${this.escapeXml(options.message)}</Say>\n`;
      twiml += '  </Gather>\n';
      // Fallback if no speech detected — re-prompt instead of hanging up
      twiml += `  <Say voice="${voice}">I didn't catch that. Are you still there?</Say>\n`;
      twiml += `  <Gather input="speech" action="${this.escapeXml(options.callbackUrl)}" speechTimeout="auto" language="${lang}" enhanced="true">\n`;
      twiml += `    <Say voice="${voice}">Go ahead, I'm listening.</Say>\n`;
      twiml += '  </Gather>\n';
      twiml += '  <Hangup/>\n';
    } else if (options.streamUrl) {
      // Media streaming mode: speak greeting, then start bidirectional stream
      twiml += `  <Say voice="${voice}">${this.escapeXml(options.message)}</Say>\n`;
      twiml += `  <Connect>\n`;
      twiml += `    <Stream url="${this.escapeXml(options.streamUrl)}" />\n`;
      twiml += `  </Connect>\n`;
    } else {
      // Notify mode: speak and hang up
      twiml += `  <Say voice="${voice}">${this.escapeXml(options.message)}</Say>\n`;
      twiml += '  <Hangup/>\n';
    }

    twiml += '</Response>';
    return twiml;
  }

  generateHangupResponse(): string {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup/>\n</Response>';
  }

  async endCall(providerCallId: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/Accounts/${this.accountSid}/Calls/${providerCallId}.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'Status=completed',
      },
    );

    if (!response.ok) {
      log.error({ providerCallId, status: response.status }, 'Failed to end Twilio call');
    }
  }

  async getCallStatus(providerCallId: string): Promise<CallStatus> {
    const response = await fetch(
      `${this.baseUrl}/Accounts/${this.accountSid}/Calls/${providerCallId}.json`,
      {
        headers: {
          'Authorization': `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
        },
      },
    );

    if (!response.ok) return 'failed';

    const data = await response.json() as { status: string };
    const statusMap: Record<string, CallStatus> = {
      queued: 'initiated', ringing: 'ringing', 'in-progress': 'active',
      completed: 'ended', busy: 'busy', 'no-answer': 'no-answer',
      canceled: 'ended', failed: 'failed',
    };
    return statusMap[data.status] || 'failed';
  }

  verifyWebhook(headers: Record<string, string>, body: string, url: string): boolean {
    const signature = headers['x-twilio-signature'];
    if (!signature) return false;

    // Sort POST parameters and append to URL
    const params = new URLSearchParams(body);
    const sortedKeys = [...params.keys()].sort();
    let fullUrl = url;
    for (const key of sortedKeys) {
      fullUrl += key + params.get(key);
    }

    const expected = createHmac('sha1', this.authToken)
      .update(fullUrl)
      .digest('base64');

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  /**
   * Auto-detect the first available phone number from the Twilio account.
   * Called when no fromNumber is configured.
   */
  async autoDetectPhoneNumber(): Promise<string | null> {
    try {
      const response = await fetch(
        `${this.baseUrl}/Accounts/${this.accountSid}/IncomingPhoneNumbers.json?PageSize=1`,
        {
          headers: {
            'Authorization': `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) return null;
      const data = await response.json() as { incoming_phone_numbers: Array<{ phone_number: string }> };
      const number = data.incoming_phone_numbers?.[0]?.phone_number;
      if (number) {
        this.fromNumber = number;
        log.info({ phoneNumber: number }, 'Auto-detected Twilio phone number');
      }
      return number || null;
    } catch {
      return null;
    }
  }

  async checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    if (!this.accountSid || !this.authToken) {
      return { healthy: false, error: 'Twilio credentials not configured' };
    }

    // Basic format validation — Account SIDs always start with "AC" and are 34 chars
    if (!this.accountSid.startsWith('AC') || this.accountSid.length !== 34) {
      return { healthy: false, error: `Invalid Account SID format (expected "AC" + 32 hex chars, got "${this.accountSid.slice(0, 6)}…" length ${this.accountSid.length}). Check vault secret "twilio_account_sid".` };
    }

    if (this.authToken.length !== 32) {
      return { healthy: false, error: `Invalid Auth Token format (expected 32 hex chars, got length ${this.authToken.length}). Check vault secret "twilio_auth_token".` };
    }

    try {
      const response = await fetch(
        `${this.baseUrl}/Accounts/${this.accountSid}.json`,
        {
          headers: {
            'Authorization': `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (response.ok) {
        // Auto-detect phone number if not configured
        if (!this.fromNumber) {
          await this.autoDetectPhoneNumber();
        }
        return { healthy: true };
      }

      // Parse the Twilio error response for a meaningful message
      let detail = '';
      try {
        const body = await response.json() as { message?: string; code?: number; more_info?: string; status?: string };
        if (body.message) detail = body.message;
        if (body.code) detail += ` (code ${body.code})`;
        // Surface account status issues (suspended, closed)
        if (body.status && body.status !== 'active') detail += ` — account status: ${body.status}`;
      } catch {
        detail = await response.text().catch(() => '');
      }

      if (response.status === 401) {
        return { healthy: false, error: `Authentication failed (HTTP 401). The Auth Token does not match the Account SID. Regenerate it in the Twilio Console → Account → API keys & tokens.${detail ? ' ' + detail : ''}` };
      }
      if (response.status === 403) {
        return { healthy: false, error: `Permission denied (HTTP 403). Common causes: (1) account is suspended or closed, (2) Auth Token was regenerated and the old one is stored in the vault, (3) credentials belong to a sub-account but are used against the main account endpoint. Verify in the Twilio Console.${detail ? ' ' + detail : ''}` };
      }
      if (response.status === 404) {
        return { healthy: false, error: `Account not found (HTTP 404). The Account SID "${this.accountSid.slice(0, 10)}…" does not exist. Double-check the vault secret "twilio_account_sid".${detail ? ' ' + detail : ''}` };
      }

      return { healthy: false, error: `HTTP ${response.status}${detail ? ': ' + detail : ''}` };
    } catch (error) {
      const msg = (error as Error).message;
      if (msg.includes('timeout') || msg.includes('abort')) {
        return { healthy: false, error: 'Connection to Twilio timed out (10s). Check network/firewall.' };
      }
      return { healthy: false, error: msg };
    }
  }

  private escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
