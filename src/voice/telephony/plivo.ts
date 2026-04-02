/**
 * Plivo telephony provider — Voice API + XML.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { logger } from '@/utils/logger';
import type { TelephonyProvider, InitiateCallOptions, CallSession, CallStatus } from './interface';
import { randomBytes } from 'crypto';

const log = logger.child({ component: 'plivo-provider' });

export class PlivoProvider implements TelephonyProvider {
  readonly name = 'plivo';

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
      to: `<${options.to}>`,
      answer_url: options.webhookUrl,
      answer_method: 'POST',
      hangup_url: `${options.webhookUrl}/status`,
      hangup_method: 'POST',
      ...(options.timeout ? { ring_timeout: options.timeout } : {}),
    };

    const response = await fetch(`${this.baseUrl}/Account/${this.authId}/Call/`, {
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

  generateAnswerResponse(options: {
    message: string;
    voice?: string;
    gatherSpeech?: boolean;
    gatherTimeout?: number;
    callbackUrl?: string;
  }): string {
    const voice = options.voice || 'WOMAN';
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n';

    if (options.gatherSpeech && options.callbackUrl) {
      xml += `  <GetInput action="${this.escapeXml(options.callbackUrl)}" inputType="speech" `;
      xml += `executionTimeout="${options.gatherTimeout || 10}">\n`;
      xml += `    <Speak voice="${voice}">${this.escapeXml(options.message)}</Speak>\n`;
      xml += '  </GetInput>\n';
    } else {
      xml += `  <Speak voice="${voice}">${this.escapeXml(options.message)}</Speak>\n`;
      xml += '  <Hangup/>\n';
    }

    xml += '</Response>';
    return xml;
  }

  generateHangupResponse(): string {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Hangup/>\n</Response>';
  }

  async endCall(providerCallId: string): Promise<void> {
    await fetch(`${this.baseUrl}/Account/${this.authId}/Call/${providerCallId}/`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Basic ${Buffer.from(`${this.authId}:${this.authToken}`).toString('base64')}`,
      },
    });
  }

  async getCallStatus(providerCallId: string): Promise<CallStatus> {
    const response = await fetch(`${this.baseUrl}/Account/${this.authId}/Call/${providerCallId}/`, {
      headers: {
        'Authorization': `Basic ${Buffer.from(`${this.authId}:${this.authToken}`).toString('base64')}`,
      },
    });
    if (!response.ok) return 'failed';
    const data = await response.json() as { call_status: string };
    const map: Record<string, CallStatus> = {
      'machine-not-sure': 'answered', ringing: 'ringing', 'in-progress': 'active',
      completed: 'ended', busy: 'busy', 'no-answer': 'no-answer', failed: 'failed',
    };
    return map[data.call_status] || 'failed';
  }

  verifyWebhook(headers: Record<string, string>, body: string, url: string): boolean {
    const signature = headers['x-plivo-signature-v2'] || headers['x-plivo-signature'];
    if (!signature) return false;

    const nonce = headers['x-plivo-signature-v2-nonce'] || '';
    const payload = nonce ? `${url}${nonce}` : `${url}${body}`;
    const expected = createHmac('sha256', this.authToken).update(payload).digest('base64');

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
