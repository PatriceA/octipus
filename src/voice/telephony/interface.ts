/**
 * Telephony provider interface — abstraction for voice call providers
 * (Twilio, Telnyx, Plivo). Each provider places calls, verifies and reads its
 * own webhooks, and carries out what the call flow decides
 * (`call-flow.ts`): the flow never sees a provider's field names.
 */
import { EventEmitter } from 'node:events';

export type CallStatus = 'initiated' | 'ringing' | 'answered' | 'active' | 'ended' | 'failed' | 'busy' | 'no-answer';
export type CallDirection = 'inbound' | 'outbound';

const FINAL_STATUSES: ReadonlySet<CallStatus> = new Set(['ended', 'failed', 'busy', 'no-answer']);

/** True once a call is over, however it ended. */
export function isFinalCallStatus(status: CallStatus): boolean {
  return FINAL_STATUSES.has(status);
}

export interface CallSession {
  id: string;
  provider: string;
  /** The provider's id for the call, as its REST API addresses it. */
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
  timeout?: number; // Ring timeout in seconds
}

/**
 * What a provider's webhook says happened, in one shape for all providers.
 *
 *   incoming   an inbound call is ringing and waits to be answered or rejected
 *   ringing    an outbound call is ringing
 *   answered   the call is connected (outbound picked up; inbound answered out of band)
 *   speech     the caller said something (`speech`)
 *   spoken     the provider finished saying a line (`after`: what the line asked for)
 *   hangup     the call is over (`status`: how it ended)
 *   other      nothing the call flow acts on
 */
export interface TelephonyWebhookEvent {
  type: 'incoming' | 'ringing' | 'answered' | 'speech' | 'spoken' | 'hangup' | 'other';
  /** The provider's id for the call, as its REST API addresses it. '' when the webhook names none. */
  callId: string;
  /** Other ids the same call is known by (Plivo: the request id an outbound call was created with). */
  aliases: string[];
  direction?: CallDirection;
  from: string;
  to: string;
  speech?: string;
  status?: CallStatus;
  after?: 'listen' | 'hangup';
}

/** A line for the caller: its text, and the same line in the install's voice when one could speak it. */
export interface SpokenLine {
  text: string;
  /** A short-lived public URL of the line as audio (mp3 or wav). Played instead of the provider's own voice. */
  audioUrl?: string;
}

/** What the call does next. */
export interface CallInstruction {
  say?: SpokenLine;
  /** After the line: wait for the caller to speak, hang up, or hand the call to the media stream. */
  then: 'listen' | 'hangup' | 'stream';
  /** `listen`: where an XML provider posts what the caller said. */
  callbackUrl?: string;
  /** `stream`: the bidirectional media socket. */
  streamUrl?: string;
  /** The call's language as a locale (`en-US`, `de-DE`), for the provider's recogniser and voice. */
  locale: string;
  /** `listen`: said when the caller stays silent, before listening once more. */
  reprompt?: { stillThere: SpokenLine; listening: SpokenLine };
  /** The first instruction of an answered call. */
  opening?: boolean;
}

/** The HTTP answer to a webhook. */
export interface WebhookReply {
  contentType: string;
  body: string;
}

/**
 * Base interface for all telephony providers.
 */
export interface TelephonyProvider {
  readonly name: string;
  /** The provider can hand an answered call to a bidirectional media socket (`then: 'stream'`). */
  readonly mediaStream: boolean;

  /** Initiate an outbound call */
  initiateCall(options: InitiateCallOptions): Promise<CallSession>;

  /** Read a verified webhook's fields into the shared event shape. */
  parseWebhook(fields: Record<string, unknown>): TelephonyWebhookEvent;

  /**
   * Answer a ringing inbound call. True: the reply to this very webhook
   * answers it, so the caller goes on to `instruct` (XML providers). False:
   * the answer was sent out of band and the provider reports `answered` in a
   * later webhook.
   */
  acceptIncoming(providerCallId: string): Promise<boolean>;

  /** Turn a ringing inbound call away. */
  rejectIncoming(providerCallId: string): Promise<WebhookReply>;

  /**
   * Carry out an instruction on an answered call: as the webhook's reply
   * (XML providers) or as commands to the provider's API, in which case the
   * reply only acknowledges the webhook.
   */
  instruct(providerCallId: string, instruction: CallInstruction): Promise<WebhookReply>;

  /** The reply to a webhook that asks for nothing. */
  acknowledge(): WebhookReply;

  /** End an active call */
  endCall(providerCallId: string): Promise<void>;

  /** Verify webhook signature */
  verifyWebhook(headers: Record<string, string>, body: string, url: string): boolean;

  /** Check if provider is configured and healthy */
  checkHealth(): Promise<{ healthy: boolean; error?: string }>;
}

/** An ended call stays listed this long (for `make_call`'s result and `end_call`). */
export const ENDED_CALL_RETENTION_MS = 3_600_000;
/** A call that never reported its end is forgotten after this long (carriers cap a call at 24 h). */
export const STALE_CALL_MS = 24 * 3_600_000;

/**
 * Call state manager — tracks calls in memory. Emits `status` with the call
 * whenever its status changes. Ended calls are dropped after
 * `ENDED_CALL_RETENTION_MS`, swept whenever a call is created or changes.
 */
export class CallManager extends EventEmitter<{ status: [CallSession] }> {
  private calls = new Map<string, CallSession>();

  constructor(private readonly now: () => number = () => Date.now()) {
    super();
    // One listener per waiting `make_call`: no fixed number is a leak.
    this.setMaxListeners(0);
  }

  create(session: CallSession): void {
    this.sweep();
    this.calls.set(session.id, session);
  }

  get(callId: string): CallSession | undefined {
    return this.calls.get(callId);
  }

  getByProviderCallId(providerCallId: string): CallSession | undefined {
    if (!providerCallId) return undefined;
    for (const session of this.calls.values()) {
      if (session.providerCallId === providerCallId) return session;
    }
    return undefined;
  }

  updateStatus(callId: string, status: CallStatus): void {
    const session = this.calls.get(callId);
    if (session && session.status !== status) {
      session.status = status;
      const at = new Date(this.now());
      if ((status === 'answered' || status === 'active') && !session.answeredAt) session.answeredAt = at;
      if (isFinalCallStatus(status) && !session.endedAt) session.endedAt = at;
      this.emit('status', session);
    }
    this.sweep();
  }

  /**
   * Resolves with the call's status once it is over, or with the status it
   * has when `timeoutMs` runs out. `undefined`: no such call.
   */
  waitForEnd(callId: string, timeoutMs: number): Promise<CallStatus | undefined> {
    const current = this.calls.get(callId);
    if (!current || isFinalCallStatus(current.status)) return Promise.resolve(current?.status);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off('status', onStatus);
        resolve(this.calls.get(callId)?.status);
      };
      const onStatus = (session: CallSession) => {
        if (session.id === callId && isFinalCallStatus(session.status)) done();
      };
      const timer = setTimeout(done, timeoutMs);
      this.on('status', onStatus);
    });
  }

  getActive(): CallSession[] {
    return [...this.calls.values()].filter(c => c.status === 'active' || c.status === 'answered' || c.status === 'ringing');
  }

  /** Every call still held: the active ones and those that ended within the retention window. */
  list(): CallSession[] {
    this.sweep();
    return [...this.calls.values()];
  }

  /** Drop calls that ended more than the retention window ago, and calls that never reported an end. */
  private sweep(): void {
    const now = this.now();
    for (const [id, session] of this.calls) {
      const expired = session.endedAt
        ? now - session.endedAt.getTime() > ENDED_CALL_RETENTION_MS
        : now - session.startedAt.getTime() > STALE_CALL_MS;
      if (expired) this.calls.delete(id);
    }
  }
}

// Singleton
let callManagerInstance: CallManager | null = null;
export function getCallManager(): CallManager {
  if (!callManagerInstance) callManagerInstance = new CallManager();
  return callManagerInstance;
}
