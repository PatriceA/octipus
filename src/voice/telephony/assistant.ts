/**
 * The full assistant on a phone call — opt-in, and only for the owner.
 *
 * A phone call normally gets the restricted reply (reply.ts): the `voice`
 * topic's model, no tools, because a caller can be anyone. An admin may list
 * numbers in `voice.callAssistant`, each with the user it belongs to; a call
 * from a listed number then reaches that user's root agent with its tools, on
 * a chat session of that user's made for the call. Caller ID alone can be
 * spoofed, so the number is not enough: the carrier must also report the
 * caller ID as verified with full STIR/SHAKEN attestation (A)
 * (`TelephonyWebhookEvent.callerVerified`). Anything less — a listed number
 * with B or C attestation, a failed check, a carrier or route without one —
 * gets the restricted reply. Outbound calls (`make_call`) never get it.
 *
 * The assistant needs the live media stream (`voice.streaming`): a turn with
 * tools can take longer than a carrier waits for a webhook's reply, so the
 * turn-based path stays on the restricted reply.
 *
 * On the call, each finished utterance is sent to the root agent as a spoken
 * turn (`handleMessage(…, { spoken: true })`), and the agent's text deltas
 * for that session (`chat.delta` on the gateway bus) are spoken as they
 * come, through media-call.ts (sentence chunker, TTS, barge-in). A tool that
 * needs permission, or an approval the agent asks for, cannot be shown on a
 * phone: its question is spoken, and the caller's next utterance answers it —
 * a plain yes allows, anything else refuses (and anything that is not a plain
 * no is then sent on as the caller's next turn). A question still open when
 * the call ends is refused.
 */
import { logger } from '@/utils/logger';
import type { VoiceTurnEvent } from '../session';
import { unspoken } from '../session';
import type { TelephonyWebhookEvent } from './interface';
import { phonePhrase } from './phrases';
import type { PhoneReplyStream } from './reply';

const log = logger.child({ component: 'phone-assistant' });

/** The channel a phone call's turns arrive on. */
export const PHONE_CHANNEL = 'phone';

/** One entry of `voice.callAssistant`: a number (E.164) and the user (username) it belongs to. */
export interface CallAssistantEntry {
  number: string;
  user: string;
}

/** `+1 (415) 555-1234` → `+14155551234`: numbers compare by their digits. */
export function normalizeNumber(number: string): string {
  const digits = number.replace(/[^\d+]/g, '');
  return digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : digits.replace(/\+/g, '');
}

/** The setting's entries; anything malformed is left out. */
export function callAssistantEntries(value: unknown): CallAssistantEntry[] {
  const list = typeof value === 'string' ? safeJson(value) : value;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { number, user } = entry as Record<string, unknown>;
    if (typeof number !== 'string' || typeof user !== 'string' || !normalizeNumber(number) || !user.trim()) return [];
    return [{ number: normalizeNumber(number), user: user.trim() }];
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface CallAssistantLookup {
  settings: { get(key: string): Promise<unknown> };
  /** The id of the user with this username, or null. */
  findUserId(username: string): Promise<string | null>;
}

/**
 * The user whose full assistant answers this inbound call, or null: the call
 * gets the restricted reply. Both must hold: the calling number is listed in
 * `voice.callAssistant`, and the carrier verified it (full attestation).
 */
export async function callAssistantUser(event: TelephonyWebhookEvent, lookup: CallAssistantLookup): Promise<string | null> {
  if (event.direction === 'outbound') return null;
  const entries = callAssistantEntries(await lookup.settings.get('voice.callAssistant'));
  const from = normalizeNumber(event.from);
  const entry = from ? entries.find((e) => e.number === from) : undefined;
  if (!entry) return null;
  if (event.callerVerified !== true) {
    // A listed number without verification may be someone else using it as caller ID.
    log.warn({ caller: event.from }, 'Listed caller without a verified caller ID (STIR/SHAKEN A): restricted phone reply');
    return null;
  }
  const userId = await lookup.findUserId(entry.user);
  if (!userId) log.warn({ caller: event.from, user: entry.user }, 'voice.callAssistant names a user that does not exist: restricted phone reply');
  return userId;
}

/** A spoken yes or no — the whole utterance — or null. */
export function spokenAnswer(text: string): 'yes' | 'no' | null {
  const said = text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (/^(yes|yeah|yep|sure|ok|okay|allow|allow it|approve|approved|go ahead|do it|yes please|ja|ja bitte|klar|okay bitte)$/.test(said)) return 'yes';
  if (/^(no|nope|deny|don't|do not|no thanks|no thank you|stop|cancel|nein|nein danke)$/.test(said)) return 'no';
  return null;
}

export interface PhoneAssistantDeps {
  /** Send one spoken turn to the root agent on the call's chat session; resolves with its final text. */
  send(text: string): Promise<{ response: string; classification?: { type?: string } }>;
  /** The user's gateway events (`chat.delta`, `permission.*`, `agent.approval_required`, `approval.resolved`). Returns the unsubscribe. */
  subscribe(handler: (event: VoiceTurnEvent) => void): () => void;
  /** Answer a tool's permission request. */
  answerPermission(requestId: string, allow: boolean): Promise<void>;
  /** Answer an approval the agent asked for. */
  answerApproval(requestId: string, approve: boolean, said: string): Promise<void>;
}

export interface PhoneAssistantOptions {
  callId: string;
  userId: string;
  sessionId: string;
  /** `voice.language`, for the spoken questions. */
  language?: string | null;
}

interface OpenQuestion {
  kind: 'permission' | 'approval';
  requestId: string;
  line: string;
}

/** Events a reply is reading, and a way to wait for the next one. */
class EventQueue {
  readonly items: VoiceTurnEvent[] = [];
  private wake: (() => void) | null = null;

  push(event: VoiceTurnEvent): void {
    this.items.push(event);
    this.notify();
  }

  notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  next(): Promise<void> {
    return new Promise((resolve) => { this.wake = resolve; });
  }
}

/** One call's conversation with the owner's root agent. */
export class PhoneAssistant {
  /** What the caller said that has not been sent yet. */
  private pending = '';
  /** The last turn sent: a reply follows it to its end. */
  private turn: Promise<unknown> = Promise.resolve();
  /** A question the agent asked that the caller has not answered yet. */
  private open: OpenQuestion | null = null;
  private readers = new Set<EventQueue>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(private readonly options: PhoneAssistantOptions, private readonly deps: PhoneAssistantDeps) {
    this.unsubscribe = deps.subscribe((event) => this.onEvent(event));
  }

  /** The caller finished an utterance. */
  heard(text: string): void {
    this.pending = this.pending ? `${this.pending} ${text}` : text;
  }

  private onEvent(event: VoiceTurnEvent): void {
    if (this.closed || event.sessionId !== this.options.sessionId || (event.userId && event.userId !== this.options.userId)) return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    if (event.type === 'permission.request' && requestId) {
      const tool = String(payload.toolName || payload.action || 'a tool').replace(/[_-]+/g, ' ');
      this.open = { kind: 'permission', requestId, line: phonePhrase('askPermission', this.options.language).replace('{tool}', tool) };
    } else if (event.type === 'agent.approval_required' && requestId) {
      const question = String(payload.question || payload.summary || '').trim() || 'May I go ahead?';
      this.open = { kind: 'approval', requestId, line: phonePhrase('askApproval', this.options.language).replace('{question}', question) };
    } else if ((event.type === 'permission.resolved' || event.type === 'approval.resolved') && this.open?.requestId === requestId) {
      // Answered somewhere else (the web app, the mobile app).
      this.open = null;
    }
    for (const reader of this.readers) reader.push(event);
  }

  /**
   * The reply to what the caller said since the last reply, as it is
   * written. Aborting stops the reading, not the turn: the agent finishes it
   * and its answer is in the chat.
   */
  reply(signal: AbortSignal): PhoneReplyStream {
    const self = this;
    async function* deltas(): AsyncGenerator<string> {
      const said = self.pending.trim();
      self.pending = '';
      if (!said || self.closed) return;
      const queue = new EventQueue();
      self.readers.add(queue);
      const onAbort = () => queue.notify();
      signal.addEventListener('abort', onAbort);
      try {
        const { follow, fresh } = await self.dispatch(said);
        // A fresh turn waits behind the one before it: what that one still says is not this reply.
        if (fresh) await until(fresh, signal, queue);
        if (signal.aborted) return;
        if (fresh) queue.items.length = 0;
        let done = false;
        let result: { response?: string } | undefined;
        let failure: unknown;
        follow.then((value) => { result = value as { response?: string }; }, (err: unknown) => { failure = err; })
          .finally(() => { done = true; queue.notify(); });
        // The root agent of the followed turn: its deltas are marked spoken; a worker's are not read.
        let agentId: string | null = null;
        let iteration = -1;
        let streamed = '';
        for (;;) {
          while (queue.items.length) {
            const event = queue.items.shift()!;
            const payload = (event.payload ?? {}) as { agentId?: unknown; delta?: unknown; iteration?: unknown; spoken?: unknown };
            if (event.type === 'chat.delta' && typeof payload.delta === 'string' && payload.spoken === true) {
              if (typeof payload.agentId === 'string') {
                agentId ??= payload.agentId;
                if (payload.agentId !== agentId) continue;
              }
              const at = typeof payload.iteration === 'number' ? payload.iteration : 0;
              if (at !== iteration) {
                // A new model call: what the last one said is complete (it went on to use a tool).
                if (streamed) yield '\n\n';
                iteration = at;
              }
              streamed += payload.delta;
              yield payload.delta;
            } else if ((event.type === 'permission.request' || event.type === 'agent.approval_required') && self.open) {
              // The turn waits on the caller: ask, and give them the line.
              yield `${streamed ? '\n\n' : ''}${self.open.line}`;
              return;
            }
          }
          if (signal.aborted) return;
          if (done) break;
          await queue.next();
        }
        if (failure) throw failure;
        const final = typeof result?.response === 'string' ? result.response : '';
        const rest = unspoken(final, streamed);
        if (rest.length) yield `${streamed ? '\n\n' : ''}${rest.join(' ')}`;
      } finally {
        signal.removeEventListener('abort', onAbort);
        self.readers.delete(queue);
      }
    }
    return { [Symbol.asyncIterator]: deltas, endCall: false };
  }

  /**
   * Send what the caller said. It answers the open question when there is
   * one (the reply then follows the turn that asked); else, or when it was
   * more than a yes or no, it is a turn of its own.
   */
  private async dispatch(said: string): Promise<{ follow: Promise<unknown>; fresh?: Promise<unknown> }> {
    const question = this.open;
    if (question) {
      this.open = null;
      const answer = spokenAnswer(said);
      // Only a plain yes allows: a question nobody can see is refused unless clearly agreed to.
      await this.answer(question, answer === 'yes', said);
      if (answer) return { follow: this.turn };
    }
    const before = this.turn;
    const turn = this.deps.send(said);
    this.turn = turn.catch(() => undefined);
    return { follow: turn, fresh: before };
  }

  private async answer(question: OpenQuestion, yes: boolean, said: string): Promise<void> {
    log.info({ callId: this.options.callId, kind: question.kind, allowed: yes }, 'Phone caller answered a question of the agent');
    try {
      if (question.kind === 'permission') await this.deps.answerPermission(question.requestId, yes);
      else await this.deps.answerApproval(question.requestId, yes, said);
    } catch (err) {
      log.error({ err, callId: this.options.callId, requestId: question.requestId }, 'Could not answer the agent\'s question');
    }
  }

  /** The call is over: an open question is refused, so the turn does not wait for nobody. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const reader of this.readers) reader.notify();
    const question = this.open;
    this.open = null;
    if (question) await this.answer(question, false, '');
  }
}

/** Wait for `promise`, or until the reply is aborted. */
async function until(promise: Promise<unknown>, signal: AbortSignal, queue: EventQueue): Promise<void> {
  let settled = false;
  void promise.catch(() => undefined).finally(() => { settled = true; queue.notify(); });
  while (!settled && !signal.aborted) await queue.next();
}

/** The live dependencies: the root agent, the gateway bus, the permission and approval managers. */
export async function liveAssistantDeps(userId: string, sessionId: string): Promise<PhoneAssistantDeps> {
  const [{ getAgentService }, { getGatewayHub }, { getPermissionManager }] = await Promise.all([
    import('@/core/agent/service'), import('@/core/gateway/hub'), import('@/security/permissions'),
  ]);
  return {
    send: (text) => {
      // `options.spoken`: the reply is read aloud, so the turn answers in spoken style.
      const agent = getAgentService() as unknown as SpokenTurnAgent;
      return agent.handleMessage(sessionId, userId, text, PHONE_CHANNEL, [], undefined, undefined, undefined, undefined, undefined, { spoken: true });
    },
    subscribe: (handler) => {
      const bus = getGatewayHub().eventBus;
      const offs = ['chat.delta', 'permission.request', 'permission.resolved', 'agent.approval_required', 'approval.resolved']
        .map((type) => bus.subscribe(type, handler as never));
      return () => { for (const off of offs) off(); };
    },
    answerPermission: async (requestId, allow) => {
      const permissions = getPermissionManager();
      if (allow) await permissions.approve(requestId, userId, 'allowed by voice on a phone call');
      else await permissions.deny(requestId, userId, 'refused on a phone call');
    },
    answerApproval: async (requestId, approve, said) => {
      await getAgentService().resolveApprovalDetailed(requestId, approve, said || undefined, { forUserId: userId, resolvedBy: userId });
    },
  };
}

/** The root agent's `handleMessage` as this module calls it: a spoken turn on the phone channel. */
interface SpokenTurnAgent {
  handleMessage(
    sessionId: string, userId: string, message: string, channel: string, attachedFiles: [], forcedOutputMode: undefined,
    beforeStart: undefined, groupTurn: undefined, trigger: undefined, inlineUi: undefined, options: { spoken: true },
  ): Promise<{ response: string; classification?: { type?: string } }>;
}
