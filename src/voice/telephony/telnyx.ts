/**
 * Telnyx telephony provider — Call Control v2.
 */

import { randomBytes } from 'crypto';
import { verifyEd25519 } from '@/core/federation/identity';
import { fetchWithTimeout } from '@/utils/http';
import { logger } from '@/utils/logger';
import type {
  CallInstruction, CallSession, CallStatus, InitiateCallOptions, TelephonyProvider, TelephonyWebhookEvent, WebhookReply,
} from './interface';

const log = logger.child({ component: 'telnyx-provider' });

/** Telnyx only needs a 2xx: the call is driven by commands, not by the webhook's reply. */
const ACK: WebhookReply = { contentType: 'application/json', body: '{}' };

/**
 * The speak command requires a voice, and a voice speaks one language. Used
 * only when no Speech engine of the install speaks the line (then the audio
 * is played instead).
 */
const SPEAK_VOICE: Record<string, string> = {
  en: 'AWS.Polly.Joanna', de: 'AWS.Polly.Vicki', fr: 'AWS.Polly.Lea', es: 'AWS.Polly.Lucia', it: 'AWS.Polly.Bianca',
  pt: 'AWS.Polly.Camila', nl: 'AWS.Polly.Lotte', ja: 'AWS.Polly.Mizuki', ko: 'AWS.Polly.Seoyeon', pl: 'AWS.Polly.Ewa',
  sv: 'AWS.Polly.Astrid', da: 'AWS.Polly.Naja', ru: 'AWS.Polly.Tatyana', tr: 'AWS.Polly.Filiz',
};

/** `hangup_cause` of `call.hangup` → how the call ended. Anything else ended normally. */
const HANGUP_STATUS: Record<string, CallStatus> = {
  user_busy: 'busy', busy: 'busy', timeout: 'no-answer', no_answer: 'no-answer', call_rejected: 'failed', not_found: 'failed', unspecified: 'failed',
};

/** What a spoken line asked for, carried through Telnyx as the command's `client_state` (base64). */
const stateOf = (after: 'listen' | 'hangup') => Buffer.from(`octipus:${after}`).toString('base64');
function afterOf(clientState: unknown): 'listen' | 'hangup' | undefined {
  if (typeof clientState !== 'string' || !clientState) return undefined;
  const decoded = Buffer.from(clientState, 'base64').toString('utf8');
  return decoded === 'octipus:hangup' ? 'hangup' : decoded === 'octipus:listen' ? 'listen' : undefined;
}

/** Largest distance, either way, between a webhook's `telnyx-timestamp` and now, in seconds. */
export const TELNYX_WEBHOOK_TOLERANCE_SECONDS = 300;

export class TelnyxProvider implements TelephonyProvider {
  readonly name = 'telnyx';
  readonly mediaStream = false;

  private apiKey: string;
  private connectionId: string;
  private fromNumber: string;
  private publicKey?: string; // For webhook verification
  private baseUrl = 'https://api.telnyx.com/v2';

  constructor(config: { apiKey: string; connectionId: string; fromNumber: string; publicKey?: string }) {
    this.apiKey = config.apiKey;
    this.connectionId = config.connectionId;
    this.fromNumber = config.fromNumber;
    this.publicKey = config.publicKey;
  }

  async initiateCall(options: InitiateCallOptions): Promise<CallSession> {
    const callId = `call_${randomBytes(8).toString('hex')}`;
    const from = options.from || this.fromNumber;

    const body = {
      connection_id: this.connectionId,
      to: options.to,
      from,
      webhook_url: options.webhookUrl,
      answering_machine_detection: 'disabled',
      ...(options.timeout ? { timeout_secs: options.timeout } : {}),
    };

    const response = await fetchWithTimeout(`${this.baseUrl}/calls`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text().catch(() => '');
      throw new Error(`Telnyx call initiation failed (${response.status}): ${err}`);
    }

    const data = await response.json() as { data: { call_control_id: string; call_session_id: string } };

    log.info({ callId, providerCallId: data.data.call_control_id, to: options.to }, 'Telnyx call initiated');

    return {
      id: callId,
      provider: 'telnyx',
      providerCallId: data.data.call_control_id,
      direction: 'outbound',
      from,
      to: options.to,
      status: 'initiated',
      startedAt: new Date(),
      metadata: { mode: options.mode || 'notify', sessionId: data.data.call_session_id },
    };
  }

  /**
   * Call Control v2 webhooks are JSON, with everything under `data`:
   * `data.event_type` and `data.payload` (`call_control_id`, `from`, `to`,
   * `direction` — `incoming` / `outgoing` —, `client_state`, and per event
   * `hangup_cause` or `transcription_data`).
   * https://developers.telnyx.com/docs/voice/programmable-voice/receiving-webhooks
   * https://developers.telnyx.com/docs/voice/programmable-voice/speech-to-text
   */
  parseWebhook(fields: Record<string, unknown>): TelephonyWebhookEvent {
    const data = isRecord(fields.data) ? fields.data : {};
    const payload = isRecord(data.payload) ? data.payload : {};
    const text = (value: unknown) => (typeof value === 'string' ? value : '');
    const happened = text(data.event_type);
    const direction = text(payload.direction);
    const event: TelephonyWebhookEvent = {
      type: 'other',
      callId: text(payload.call_control_id),
      aliases: [],
      direction: direction === 'incoming' ? 'inbound' : direction === 'outgoing' ? 'outbound' : undefined,
      from: text(payload.from),
      to: text(payload.to),
    };
    switch (happened) {
      case 'call.initiated':
        return { ...event, type: event.direction === 'outbound' ? 'ringing' : 'incoming' };
      case 'call.answered':
        return { ...event, type: 'answered' };
      case 'call.transcription': {
        const transcription = isRecord(payload.transcription_data) ? payload.transcription_data : {};
        const speech = text(transcription.transcript).trim();
        // Interim results are the same words again, a moment later, as final.
        return speech && transcription.is_final !== false ? { ...event, type: 'speech', speech } : event;
      }
      case 'call.speak.ended':
      case 'call.playback.ended':
        return { ...event, type: 'spoken', after: afterOf(payload.client_state) };
      case 'call.hangup':
        return { ...event, type: 'hangup', status: HANGUP_STATUS[text(payload.hangup_cause).toLowerCase()] ?? 'ended' };
      default:
        return event;
    }
  }

  /** One Call Control command: `POST /v2/calls/{call_control_id}/actions/{action}`. Fails loud. */
  private async command(providerCallId: string, action: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetchWithTimeout(`${this.baseUrl}/calls/${encodeURIComponent(providerCallId)}/actions/${action}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Telnyx ${action} failed (HTTP ${response.status}): ${detail.slice(0, 300)}`);
    }
  }

  /** Answered by command; Telnyx then sends `call.answered`. */
  async acceptIncoming(providerCallId: string): Promise<boolean> {
    await this.command(providerCallId, 'answer', {});
    return false;
  }

  async rejectIncoming(providerCallId: string): Promise<WebhookReply> {
    await this.command(providerCallId, 'reject', { cause: 'CALL_REJECTED' });
    return ACK;
  }

  acknowledge(): WebhookReply {
    return ACK;
  }

  /**
   * Call Control has no "say this, then listen" verb for speech (its gather
   * commands collect digits), so listening is the call's real-time
   * transcription, started once when the call opens: every final
   * `call.transcription` is a turn. A line is played from the install's
   * engine (`playback_start`) or spoken by Telnyx (`speak`); what follows it
   * travels as `client_state` and comes back on `call.speak.ended` /
   * `call.playback.ended`.
   */
  async instruct(providerCallId: string, instruction: CallInstruction): Promise<WebhookReply> {
    if (instruction.then === 'stream') throw new Error('Telnyx calls are not connected to the media stream.');
    const language = instruction.locale.split('-')[0].toLowerCase();
    if (instruction.opening && instruction.then === 'listen') {
      await this.command(providerCallId, 'transcription_start', {
        transcription_engine: 'Google',
        transcription_engine_config: { language },
        transcription_tracks: 'inbound',
      });
    }
    const say = instruction.say;
    if (!say) {
      if (instruction.then === 'hangup') await this.endCall(providerCallId);
      return ACK;
    }
    const client_state = stateOf(instruction.then);
    if (say.audioUrl) {
      await this.command(providerCallId, 'playback_start', {
        audio_url: say.audioUrl,
        audio_type: /\.wav(?:$|\?)/i.test(say.audioUrl) ? 'wav' : 'mp3',
        cache_audio: false,
        client_state,
      });
    } else {
      await this.command(providerCallId, 'speak', {
        payload: say.text.slice(0, 3000),
        voice: SPEAK_VOICE[language] ?? SPEAK_VOICE.en,
        language: instruction.locale,
        client_state,
      });
    }
    return ACK;
  }

  async endCall(providerCallId: string): Promise<void> {
    await this.command(providerCallId, 'hangup', {});
  }

  /**
   * Telnyx signs `${timestamp}|${body}` with Ed25519; the signature header is
   * base64 and the account's public key is a raw 32-byte key in base64. No
   * configured key means nothing can be verified, so the webhook fails. A
   * `telnyx-timestamp` more than 300 s from now fails too, so a captured
   * webhook cannot be replayed later.
   */
  verifyWebhook(headers: Record<string, string>, body: string, _url?: string, now: number = Date.now()): boolean {
    if (!this.publicKey) {
      log.warn('Telnyx webhook refused: no telnyx_public_key configured to verify it');
      return false;
    }
    const signature = headers['telnyx-signature-ed25519'];
    const timestamp = headers['telnyx-timestamp'];
    if (!signature || !timestamp) return false;
    if (!/^\d{1,12}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > TELNYX_WEBHOOK_TOLERANCE_SECONDS) {
      log.warn({ timestamp }, 'Telnyx webhook refused: timestamp outside the 300 s window');
      return false;
    }

    try {
      return verifyEd25519(this.publicKey, Buffer.from(`${timestamp}|${body}`), Buffer.from(signature, 'base64'));
    } catch (err) {
      log.warn({ err }, 'Telnyx webhook refused: telnyx_public_key is not an Ed25519 key');
      return false;
    }
  }

  async checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    if (!this.apiKey) return { healthy: false, error: 'Telnyx API key not configured' };
    try {
      const res = await fetch(`${this.baseUrl}/phone_numbers`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok ? { healthy: true } : { healthy: false, error: `HTTP ${res.status}` };
    } catch (e) {
      return { healthy: false, error: (e as Error).message };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
