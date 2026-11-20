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

/** How long a webhook nonce is remembered: the same signed request posted again within it is refused. */
export const PLIVO_NONCE_TTL_MS = 30 * 60_000;
/** More nonces than this within the window is not a carrier: the oldest are forgotten. */
const MAX_NONCES = 50_000;

/** Nonces seen within a window, each accepted once. */
export class SeenNonces {
  private seen = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  /** True the first time `nonce` is seen within the window. */
  claim(nonce: string, now: number): boolean {
    for (const [key, expires] of this.seen) {
      // Insertion order is expiry order: stop at the first one still live.
      if (expires > now && this.seen.size <= MAX_NONCES) break;
      this.seen.delete(key);
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
}

/** One for the process: a provider rebuilt after a credential change still refuses a replay. */
const seenNonces = new SeenNonces(PLIVO_NONCE_TTL_MS);

/**
 * Plivo's V3 signature of a POST, as its SDKs build it (plivo-node
 * lib/utils/v3Security.js, plivo-python plivo/utils/signature_v3.py):
 * base64 HMAC-SHA256, keyed with the auth token, of the URL (path decoded,
 * query re-sorted as `k=v&…`), `?`, the sorted query again followed by `.`
 * when there is one, every POST parameter as name+value sorted by name (a
 * repeated name: each of its values, sorted), then `.` and the nonce.
 * https://www.plivo.com/docs/voice/concepts/signature-validation
 */
export function plivoV3Signature(authToken: string, url: string, params: URLSearchParams, nonce: string): string {
  const u = new URL(url);
  const sorted = (source: URLSearchParams, join: (key: string, value: string) => string) =>
    [...new Set(source.keys())].sort().flatMap((key) => source.getAll(key).sort().map((value) => join(key, value)));
  const query = sorted(u.searchParams, (k, v) => `${k}=${v}`).join('&');
  const posted = sorted(params, (k, v) => `${k}${v}`).join('');
  let base = `${u.protocol}//${u.host}${decodeURIComponent(u.pathname)}`;
  if (query || posted) base += `?${query}`;
  if (query && posted) base += '.';
  base += posted;
  return createHmac('sha256', authToken).update(`${base}.${nonce}`).digest('base64');
}

export class PlivoProvider implements TelephonyProvider {
  readonly name = 'plivo';
  readonly mediaStream = true;

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
   * A `<GetInput>` action posts `Speech`. The answer URL of an inbound call
   * carries `StirVerification`: `Verified` is full attestation (A), `Not
   * Verified` B or C, `Not Applicable` a call STIR/SHAKEN does not cover.
   * https://www.plivo.com/docs/voice/api/call/make-a-call (callbacks), …/xml/request, …/xml/getinput,
   * https://www.plivo.com/docs/voice/concepts/stir-shaken
   */
  parseWebhook(fields: Record<string, unknown>): TelephonyWebhookEvent {
    const field = (name: string) => (typeof fields[name] === 'string' ? fields[name] as string : '');
    const direction = field('Direction');
    const status = field('CallStatus');
    const happened = field('Event');
    // Plivo's own pages spell it both ways.
    const stir = (field('StirVerification') || field('STIRVerification')).trim().toLowerCase();
    const event: TelephonyWebhookEvent = {
      type: 'other',
      callId: field('CallUUID'),
      aliases: [field('RequestUUID'), field('ALegRequestUUID')].filter(Boolean),
      direction: direction === 'inbound' ? 'inbound' : direction === 'outbound' ? 'outbound' : undefined,
      from: field('From'),
      to: field('To'),
      callerVerified: stir === 'verified',
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
      if (!instruction.streamUrl) throw new Error('Plivo needs a stream URL to connect a media stream.');
      // Speak the greeting, then hand the call to the bidirectional stream:
      // 8 kHz μ-law both ways (what the media bridge speaks), and the call
      // stays up for as long as the stream does (`keepCallAlive`); when the
      // stream ends the XML runs out and the call ends with it.
      // https://www.plivo.com/docs/voice/xml/audio-streaming
      if (say) xml += `  ${this.line(say, locale)}\n`;
      xml += `  <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000">${this.escapeXml(instruction.streamUrl)}</Stream>\n`;
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
   * `X-Plivo-Signature-V3` over the URL, the posted parameters and
   * `X-Plivo-Signature-V3-Nonce` (`plivoV3Signature`); the header holds one
   * signature per active auth token, comma-separated. V2 is not accepted: it
   * covers only the URL and the nonce, so a captured signature verified with
   * any body. A nonce is accepted once: the same signed request posted again
   * within `PLIVO_NONCE_TTL_MS` is refused.
   */
  verifyWebhook(headers: Record<string, string>, body: string, url: string, now: number = Date.now()): boolean {
    const header = headers['x-plivo-signature-v3'];
    const nonce = headers['x-plivo-signature-v3-nonce'];
    if (!header || !nonce || !this.authToken) return false;

    const expected = Buffer.from(plivoV3Signature(this.authToken, url, new URLSearchParams(body), nonce));
    const signed = header.split(',').some((signature) => {
      const given = Buffer.from(signature.trim());
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!signed) return false;
    if (!seenNonces.claim(nonce, now)) {
      log.warn('Plivo webhook refused: its nonce was already used (replay)');
      return false;
    }
    return true;
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
