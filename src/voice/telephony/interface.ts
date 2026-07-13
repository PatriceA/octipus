/**
 * Telephony provider interface — abstraction for voice call providers
 * (Twilio, Telnyx, Plivo). Each provider handles call initiation,
 * webhook events, and audio streaming.
 */

export type CallStatus = 'initiated' | 'ringing' | 'answered' | 'active' | 'ended' | 'failed' | 'busy' | 'no-answer';
export type CallDirection = 'inbound' | 'outbound';

export interface CallSession {
  id: string;
  provider: string;
  providerCallId: string;
  direction: CallDirection;
  from: string;
  to: string;
  status: CallStatus;
  startedAt: Date;
  answeredAt?: Date;
  endedAt?: Date;
  metadata: Record<string, unknown>;
}

export interface InitiateCallOptions {
  to: string;
  from?: string; // Uses default fromNumber if not specified
  message?: string; // Initial TTS message to speak
  mode?: 'notify' | 'conversation'; // notify = one-way, conversation = interactive
  webhookUrl: string; // Where to receive call events
  streamUrl?: string; // WebSocket URL for media streaming
  voice?: string; // TTS voice to use
  language?: string;
  timeout?: number; // Ring timeout in seconds
}

export interface CallEvent {
  type: 'ringing' | 'answered' | 'speech' | 'dtmf' | 'ended' | 'error';
  callId: string;
  providerCallId: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

export interface WebhookVerification {
  /** Verify the webhook signature from the provider */
  verify(headers: Record<string, string>, body: string, url: string): boolean;
}

/**
 * Base interface for all telephony providers.
 */
export interface TelephonyProvider {
  readonly name: string;

  /** Initiate an outbound call */
  initiateCall(options: InitiateCallOptions): Promise<CallSession>;

  /** Generate TwiML/XML response for answering a call with speech */
  generateAnswerResponse(options: {
    message: string;
    voice?: string;
    gatherSpeech?: boolean; // Enable speech-to-text gathering
    gatherTimeout?: number;
    callbackUrl?: string;
    /** Bidirectional media-stream URL (Phase 4d) — emits <Connect><Stream>. */
    streamUrl?: string;
  }): string;

  /** Generate response to hang up the call */
  generateHangupResponse(): string;

  /** End an active call */
  endCall(providerCallId: string): Promise<void>;

  /** Get call status from provider */
  getCallStatus(providerCallId: string): Promise<CallStatus>;

  /** Verify webhook signature */
  verifyWebhook(headers: Record<string, string>, body: string, url: string): boolean;

  /** Check if provider is configured and healthy */
  checkHealth(): Promise<{ healthy: boolean; error?: string }>;
}

/**
 * Call state manager — tracks active calls in memory.
 */
export class CallManager {
  private calls = new Map<string, CallSession>();

  create(session: CallSession): void {
    this.calls.set(session.id, session);
  }

  get(callId: string): CallSession | undefined {
    return this.calls.get(callId);
  }

  getByProviderCallId(providerCallId: string): CallSession | undefined {
    for (const session of this.calls.values()) {
      if (session.providerCallId === providerCallId) return session;
    }
    return undefined;
  }

  updateStatus(callId: string, status: CallStatus): void {
    const session = this.calls.get(callId);
    if (session) {
      session.status = status;
      if (status === 'answered' && !session.answeredAt) session.answeredAt = new Date();
      if (status === 'ended' || status === 'failed') session.endedAt = new Date();
    }
  }

  getActive(): CallSession[] {
    return [...this.calls.values()].filter(c => c.status === 'active' || c.status === 'answered' || c.status === 'ringing');
  }

  remove(callId: string): void {
    this.calls.delete(callId);
  }

  /** Clean up calls older than maxAge */
  cleanup(maxAgeMs: number = 3600_000): void {
    const now = Date.now();
    for (const [id, session] of this.calls) {
      if (session.endedAt && now - session.endedAt.getTime() > maxAgeMs) {
        this.calls.delete(id);
      }
    }
  }
}

// Singleton
let callManagerInstance: CallManager | null = null;
export function getCallManager(): CallManager {
  if (!callManagerInstance) callManagerInstance = new CallManager();
  return callManagerInstance;
}
