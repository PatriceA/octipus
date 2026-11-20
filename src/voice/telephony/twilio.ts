/**
 * Twilio telephony provider — Programmable Voice + Media Streams.
 *
 * Supports:
 * - Outbound calls (notify + conversation mode)
 * - Webhooks read into the shared event shape, answered with TwiML
 * - Media Streams (WebSocket) for real-time audio
 * - Webhook signature verification
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { fetchWithTimeout } from '@/utils/http';
import { logger } from '@/utils/logger';
import type {
  CallInstruction, CallSession, CallStatus, InitiateCallOptions, SpokenLine, TelephonyProvider, TelephonyWebhookEvent, WebhookReply,
} from './interface';

const log = logger.child({ component: 'twilio-provider' });

const XML = 'application/xml';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** Twilio's `CallStatus` values for a call that is over → how it ended. */
const FINAL_STATUS: Record<string, CallStatus> = {
  completed: 'ended', canceled: 'ended', busy: 'busy', 'no-answer': 'no-answer', failed: 'failed',
};

export class TwilioProvider implements TelephonyProvider {
  readonly name = 'twilio';
  readonly mediaStream = true;

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

    const response = await fetchWithTimeout(
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

  /**
   * Twilio posts form fields: `CallSid`, `CallStatus`, `Direction`
   * (`inbound`, `outbound-api`, …), `From`, `To`, and `SpeechResult` on the
   * callback of a `<Gather>`. An inbound call's webhook carries `StirVerstat`
   * when the carrier checked the caller ID: `TN-Validation-Passed-A` is full
   * attestation.
   * https://www.twilio.com/docs/voice/trusted-calling-with-shakenstir
   */
  parseWebhook(fields: Record<string, unknown>): TelephonyWebhookEvent {
    const field = (name: string) => (typeof fields[name] === 'string' ? fields[name] as string : '');
    const status = field('CallStatus');
    const direction = field('Direction');
    const event: TelephonyWebhookEvent = {
      type: 'other',
      callId: field('CallSid'),
      aliases: [],
      direction: direction ? (direction.startsWith('outbound') ? 'outbound' : 'inbound') : undefined,
      from: field('From'),
      to: field('To'),
      callerVerified: field('StirVerstat') === 'TN-Validation-Passed-A',
    };
    const speech = field('SpeechResult').trim();
    // A Gather callback carries CallStatus=in-progress too: speech comes first.
    if (speech) return { ...event, type: 'speech', speech };
    if (status in FINAL_STATUS) return { ...event, type: 'hangup', status: FINAL_STATUS[status] };
    if (status === 'in-progress') return { ...event, type: 'answered' };
    if (status === 'ringing') return { ...event, type: event.direction === 'outbound' ? 'ringing' : 'incoming' };
    if (status === 'queued' || status === 'initiated') return { ...event, type: 'ringing' };
    return event;
  }

  /** The TwiML answering the webhook is the answer. */
  async acceptIncoming(): Promise<boolean> {
    return true;
  }

  async rejectIncoming(): Promise<WebhookReply> {
    return { contentType: XML, body: `${XML_HEAD}<Response>\n  <Reject/>\n</Response>` };
  }

  acknowledge(): WebhookReply {
    return { contentType: XML, body: `${XML_HEAD}<Response></Response>` };
  }

  /**
   * A line as TwiML: the install's own voice when it was synthesised
   * (`<Play>`), else `<Say>` in the call's language. No `voice` attribute:
   * Twilio then uses the voice the account has set for that language
   * (Console → Voice → Settings → Text-to-speech).
   */
  private line(line: SpokenLine, locale: string): string {
    if (line.audioUrl) return `<Play>${this.escapeXml(line.audioUrl)}</Play>`;
    return `<Say language="${this.escapeXml(locale)}">${this.escapeXml(line.text)}</Say>`;
  }

  async instruct(_providerCallId: string, instruction: CallInstruction): Promise<WebhookReply> {
    const { say, locale } = instruction;
    let twiml = `${XML_HEAD}<Response>\n`;

    if (instruction.then === 'listen') {
      if (!instruction.callbackUrl) throw new Error('Twilio needs a callback URL to listen for speech.');
      const gather = `<Gather input="speech" action="${this.escapeXml(instruction.callbackUrl)}" speechTimeout="auto" language="${this.escapeXml(locale)}" enhanced="true">`;
      // Speak, then gather speech input
      twiml += say ? `  ${gather}\n    ${this.line(say, locale)}\n  </Gather>\n` : `  ${gather}</Gather>\n`;
      // No speech detected — re-prompt once instead of hanging up
      if (instruction.reprompt) {
        twiml += `  ${this.line(instruction.reprompt.stillThere, locale)}\n`;
        twiml += `  ${gather}\n    ${this.line(instruction.reprompt.listening, locale)}\n  </Gather>\n`;
      }
      twiml += '  <Hangup/>\n';
    } else if (instruction.then === 'stream') {
      if (!instruction.streamUrl) throw new Error('Twilio needs a stream URL to connect a media stream.');
      // Speak the greeting, then hand the call to the bidirectional stream
      if (say) twiml += `  ${this.line(say, locale)}\n`;
      twiml += `  <Connect>\n    <Stream url="${this.escapeXml(instruction.streamUrl)}" />\n  </Connect>\n`;
    } else {
      // Speak and hang up
      if (say) twiml += `  ${this.line(say, locale)}\n`;
      twiml += '  <Hangup/>\n';
    }

    twiml += '</Response>';
    return { contentType: XML, body: twiml };
  }

  async endCall(providerCallId: string): Promise<void> {
    const response = await fetchWithTimeout(
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
      throw new Error(`Twilio could not end call ${providerCallId} (HTTP ${response.status})`);
    }
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
      const response = await fetchWithTimeout(
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
      const response = await fetchWithTimeout(
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
