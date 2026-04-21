/**
 * Telnyx telephony provider — Call Control v2.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { logger } from '@/utils/logger';
import type { CallSession, CallStatus, InitiateCallOptions, TelephonyProvider } from './interface';

const log = logger.child({ component: 'telnyx-provider' });

export class TelnyxProvider implements TelephonyProvider {
  readonly name = 'telnyx';

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

    const response = await fetch(`${this.baseUrl}/calls`, {
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

  generateAnswerResponse(options: { message: string; voice?: string }): string {
    // Telnyx uses Call Control API, not XML. Return JSON command.
    return JSON.stringify({
      command: 'speak',
      payload: { payload: options.message, voice: options.voice || 'female', language: 'en-US' },
    });
  }

  generateHangupResponse(): string {
    return JSON.stringify({ command: 'hangup' });
  }

  async endCall(providerCallId: string): Promise<void> {
    await fetch(`${this.baseUrl}/calls/${providerCallId}/actions/hangup`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
  }

  async getCallStatus(providerCallId: string): Promise<CallStatus> {
    const response = await fetch(`${this.baseUrl}/calls/${providerCallId}`, {
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
    });
    if (!response.ok) return 'failed';
    const data = await response.json() as { data: { state: string } };
    const map: Record<string, CallStatus> = {
      initiated: 'initiated', ringing: 'ringing', answered: 'answered',
      bridging: 'active', active: 'active', hangup: 'ended',
    };
    return map[data.data.state] || 'failed';
  }

  verifyWebhook(headers: Record<string, string>, body: string): boolean {
    if (!this.publicKey) return true; // Skip if no public key configured
    const signature = headers['telnyx-signature-ed25519'];
    const timestamp = headers['telnyx-timestamp'];
    if (!signature || !timestamp) return false;

    try {
      const payload = `${timestamp}|${body}`;
      const expected = createHmac('sha256', this.publicKey).update(payload).digest('hex');
      return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
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
