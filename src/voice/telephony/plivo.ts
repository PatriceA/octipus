/**
 * Plivo telephony provider — Voice API + XML.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { fetchWithTimeout } from '@/utils/http';
import { logger } from '@/utils/logger';
import type {
  CallInstruction, CallSession, CallStatus, InitiateCallOptions, SpokenLine, TelephonyProvider, TelephonyWebhookEvent, WebhookReply,
} from './interface';

const log = logger.child({ component: 'plivo-provider' });

const XML = 'application/xml';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** Plivo's `CallStatus` values for a call that is over → how it ended. */
const FINAL_STATUS: Record<string, CallStatus> = {
  completed: 'ended', busy: 'busy', failed: 'failed', timeout: 'no-answer', 'no-answer': 'no-answer',
};

export class PlivoProvider implements TelephonyProvider {
  readonly name = 'plivo';
  readonly mediaStream = false;

  private authId: string;
  private authToken: string;
  private fromNumber: string;
  private baseUrl = 'https://api.plivo.com/v1';

  constructor(config: { authId: string; authToken: string; fromNumber: string }) {
    this.authId = config.authId;
    this.authToken = config.authToken;
    this.fromNumber = config.fromNumber;
  }

  async initiateCall(options: InitiateCallOptions): Promise<CallSession> {
    const callId = `call_${randomBytes(8).toString('hex')}`;
    const from = options.from || this.fromNumber;

    const body = {
      from,
      // One number: `<` separates the numbers of a bulk call.
      to: options.to,
      answer_url: options.webhookUrl,
      answer_method: 'POST',
      hangup_url: `${options.webhookUrl}/status`,
      hangup_method: 'POST',
      ...(options.timeout ? { ring_timeout: options.timeout } : {}),
    };

    const response = await fetchWithTimeout(`${this.baseUrl}/Account/${this.authId}/Call/`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${this.authId}:${this.authToken}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      throw new Error(`Plivo call initiation failed (${response.status}): ${err}`);
    }

    const data = await response.json() as { request_uuid: string };

    log.info({ callId, providerCallId: data.request_uuid, to: options.to }, 'Plivo call initiated');

    return {
      id: callId,
      provider: 'plivo',
      providerCallId: data.request_uuid,
      direction: 'outbound',
      from,
      to: options.to,
      status: 'initiated',
      startedAt: new Date(),
      metadata: { mode: options.mode || 'notify' },
    };
  }

  /**
   * Plivo posts form fields. Every callback names the call by `CallUUID`,
   * the id its REST API takes; an outbound call's callbacks also carry the
   * `RequestUUID` the Make Call API returned, which is all we know the call by
   * until its first callback. An outbound call's callbacks carry `Event`:
   * `Ring`, `StartApp` (the answer URL) or `Hangup`. The answer URL of an
   * inbound call carries no `Event`: `Direction=inbound`, `CallStatus=ringing`.
   * A `<GetInput>` action posts `Speech`.
   * https://www.plivo.com/docs/voice/api/call/make-a-call (callbacks), …/xml/request, …/xml/getinput
   */
  parseWebhook(fields: Record<string, unknown>): TelephonyWebhookEvent {
    const field = (name: string) => (typeof fields[name] === 'string' ? fields[name] as string : '');
    const direction = field('Direction');
    const status = field('CallStatus');
    const happened = field('Event');
    const event: TelephonyWebhookEvent = {
      type: 'other',
      callId: field('CallUUID'),
      aliases: [field('RequestUUID'), field('ALegRequestUUID')].filter(Boolean),
      direction: direction === 'inbound' ? 'inbound' : direction === 'outbound' ? 'outbound' : undefined,
      from: field('From'),
      to: field('To'),
    };
    const speech = field('Speech').trim();
    if (speech) return { ...event, type: 'speech', speech };
    if (happened === 'Hangup' || status in FINAL_STATUS) return { ...event, type: 'hangup', status: FINAL_STATUS[status] ?? 'ended' };
    if (happened === 'Ring') return { ...event, type: 'ringing' };
    // The answer URL of an inbound call: it waits for its XML.
    if (!happened && event.direction === 'inbound' && status === 'ringing') return { ...event, type: 'incoming' };
    if (happened === 'StartApp') {
      // The answer URL: an inbound call waits for its XML, an outbound call was picked up.
      return { ...event, type: event.direction === 'outbound' ? 'answered' : 'incoming' };
    }
    return event;
  }

  /** The XML answering the webhook is the answer. */
  async acceptIncoming(): Promise<boolean> {
    return true;
  }

  async rejectIncoming(): Promise<WebhookReply> {
    return { contentType: XML, body: `${XML_HEAD}<Response>\n  <Hangup reason="rejected"/>\n</Response>` };
  }

  acknowledge(): WebhookReply {
    return { contentType: XML, body: `${XML_HEAD}<Response></Response>` };
  }

  /** A line as Plivo XML: the install's own voice when synthesised (`<Play>`), else `<Speak>` in the call's language. */
  private line(line: SpokenLine, locale: string): string {
    if (line.audioUrl) return `<Play>${this.escapeXml(line.audioUrl)}</Play>`;
    return `<Speak language="${this.escapeXml(locale)}">${this.escapeXml(line.text)}</Speak>`;
  }

  async instruct(_providerCallId: string, instruction: CallInstruction): Promise<WebhookReply> {
    const { say, locale } = instruction;
    let xml = `${XML_HEAD}<Response>\n`;

    if (instruction.then === 'listen') {
      if (!instruction.callbackUrl) throw new Error('Plivo needs a callback URL to listen for speech.');
      const getInput = `<GetInput action="${this.escapeXml(instruction.callbackUrl)}" method="POST" inputType="speech" language="${this.escapeXml(locale)}" executionTimeout="10">`;
      xml += say ? `  ${getInput}\n    ${this.line(say, locale)}\n  </GetInput>\n` : `  ${getInput}</GetInput>\n`;
      // Without input the XML runs on: re-prompt once, then hang up.
      if (instruction.reprompt) {
        xml += `  ${this.line(instruction.reprompt.stillThere, locale)}\n`;
        xml += `  ${getInput}\n    ${this.line(instruction.reprompt.listening, locale)}\n  </GetInput>\n`;
      }
      xml += '  <Hangup/>\n';
    } else if (instruction.then === 'stream') {
      throw new Error('Plivo calls are not connected to the media stream.');
    } else {
      if (say) xml += `  ${this.line(say, locale)}\n`;
      xml += '  <Hangup/>\n';
    }

    xml += '</Response>';
    return { contentType: XML, body: xml };
  }

  /** `providerCallId` is the call's `CallUUID` (the request id only cancels a call still queued). */
  async endCall(providerCallId: string): Promise<void> {
    const response = await fetchWithTimeout(`${this.baseUrl}/Account/${this.authId}/Call/${providerCallId}/`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${this.authId}:${this.authToken}`).toString('base64')}`,
      },
    });
    if (!response.ok) throw new Error(`Plivo could not end call ${providerCallId} (HTTP ${response.status})`);
  }

  /**
   * Plivo's V2 signature: base64 HMAC-SHA256, keyed with the auth token, of
   * the called URL without its query string followed by the
   * `X-Plivo-Signature-V2-Nonce`. A request without the V2 signature and its
   * nonce is refused: the legacy header is another scheme (HMAC-SHA1 over the
   * URL and sorted parameters) that the old fallback never computed.
   */
  verifyWebhook(headers: Record<string, string>, _body: string, url: string): boolean {
    const signature = headers['x-plivo-signature-v2'];
    const nonce = headers['x-plivo-signature-v2-nonce'];
    if (!signature || !nonce || !this.authToken) return false;

    const u = new URL(url);
    const expected = createHmac('sha256', this.authToken).update(`${u.origin}${u.pathname}${nonce}`).digest('base64');

    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  async checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    if (!this.authId || !this.authToken) return { healthy: false, error: 'Plivo credentials not configured' };
    try {
      const res = await fetch(`${this.baseUrl}/Account/${this.authId}/`, {
        headers: { 'Authorization': `Basic ${Buffer.from(`${this.authId}:${this.authToken}`).toString('base64')}` },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? { healthy: true } : { healthy: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { healthy: false, error: (e as Error).message };
    }
  }

  private escapeXml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
