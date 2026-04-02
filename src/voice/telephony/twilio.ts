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
  private baseUrl = 'https://api.twilio.com/2010-04-01';

  constructor(config: { accountSid: string; authToken: string; fromNumber: string }) {
    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.fromNumber = config.fromNumber;
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
      twiml += `  <Gather input="speech" action="${this.escapeXml(options.callbackUrl)}" `;
      twiml += `speechTimeout="${options.gatherTimeout || 3}" language="en-US">\n`;
      twiml += `    <Say voice="${voice}">${this.escapeXml(options.message)}</Say>\n`;
      twiml += '  </Gather>\n';
      // Fallback if no speech detected
      twiml += `  <Say voice="${voice}">I didn't hear anything. Goodbye.</Say>\n`;
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

      // Auto-detect phone number if not configured
      if (response.ok && !this.fromNumber) {
        await this.autoDetectPhoneNumber();
      }

      return response.ok ? { healthy: true } : { healthy: false, error: `HTTP ${response.status}` };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  private escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
