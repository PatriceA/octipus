/**
 * What the assistant says on a phone call — the one implementation, used by
 * the turn-based webhook path (`call-flow.ts`) and by the media stream
 * (`media-call.ts`).
 *
 * A phone turn goes straight to the model bound to the `voice` topic with a
 * spoken-reply prompt: no root agent, no tools, for latency and because a
 * caller can be anyone (the owner's verified number may reach the full
 * assistant instead: assistant.ts). The conversation
 * is kept on the call (`session.metadata.conversationHistory`), so
 * `/api/voice/calls`, `make_call` and both reply paths see the same history.
 * The model ends the call by writing `[END_CALL]`, which is never spoken.
 */
import type { AgentMessage } from '@/core/types';
import type { CompletionOptions } from '@/models/litellm-client';
import { SPOKEN_REPLY_DIRECTIVE } from '@/shared/speech-text';
import { logger } from '@/utils/logger';
import type { CallSession } from './interface';

const log = logger.child({ component: 'phone-reply' });

export interface PhoneTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** The part of a call a reply needs: its id (for logs) and where its history and prompt live. */
export type PhoneCall = Pick<CallSession, 'id' | 'metadata'>;

export interface PhoneReply {
  text: string;
  endCall: boolean;
}

export const END_CALL_MARKER = '[END_CALL]';
/** The last 20 exchanges are sent to the model; older turns are dropped. */
export const PHONE_HISTORY_LIMIT = 40;

const PHONE_SPECIFICS =
  'You are on a live phone call. The person only hears you and has no screen: nothing can be shown or sent in writing during the call, so say what matters.';
const END_CALL_RULE =
  `When the caller says goodbye or clearly wants to hang up, answer with a brief farewell and end your reply with the exact marker ${END_CALL_MARKER}. Never say the marker in any other reply.`;

/**
 * The system prompt of a phone turn: the call's prompt when it has one
 * (`callPrompt`: its own, else `voice.expertPrompt`), else the
 * shared spoken-reply directive with what is particular to a phone line —
 * and, either way, how to end the call.
 */
export function phoneSystemPrompt(expertPrompt?: string | null): string {
  const base = expertPrompt?.trim() || `${PHONE_SPECIFICS} ${SPOKEN_REPLY_DIRECTIVE}`;
  return `${base}\n\n${END_CALL_RULE}`;
}

/** The call's conversation so far. Created on the call when it has none. */
export function phoneHistory(call: PhoneCall): PhoneTurn[] {
  const existing = call.metadata.conversationHistory;
  if (Array.isArray(existing)) return existing as PhoneTurn[];
  const history: PhoneTurn[] = [];
  call.metadata.conversationHistory = history;
  return history;
}

function capHistory(history: PhoneTurn[]): void {
  if (history.length > PHONE_HISTORY_LIMIT) history.splice(0, history.length - PHONE_HISTORY_LIMIT);
}

/**
 * Record what the caller said. Said in two breaths before any reply (the
 * caller went on while the first reply was still being prepared), it is one
 * turn: the model answers both at once.
 */
export function recordCallerTurn(call: PhoneCall, text: string): void {
  const history = phoneHistory(call);
  const last = history[history.length - 1];
  if (last?.role === 'user') last.content = `${last.content} ${text}`;
  else history.push({ role: 'user', content: text });
  capHistory(history);
}

/** Record what the assistant said. */
export function recordAssistantTurn(call: PhoneCall, text: string): void {
  if (!text) return;
  const history = phoneHistory(call);
  history.push({ role: 'assistant', content: text });
  capHistory(history);
}

/**
 * The prompt a call answers with: its own (`metadata.expertPrompt`, set by
 * whoever placed it), else the operator's phone prompt (`voice.expertPrompt`,
 * read on every turn so a change applies to calls in progress), else none —
 * the shared phone prompt then applies.
 */
async function callPrompt(call: PhoneCall): Promise<string | null> {
  const own = call.metadata.expertPrompt;
  if (typeof own === 'string' && own.trim()) return own;
  const { getSettingsService } = await import('@/config/settings-service');
  const configured = await getSettingsService().get('voice.expertPrompt');
  return typeof configured === 'string' && configured.trim() ? configured : null;
}

/** The model call of a phone turn: the `voice` topic's model, its parameters, the prompt and the history. */
async function phoneCompletion(call: PhoneCall): Promise<CompletionOptions> {
  const { ModelSelector } = await import('@/core/agent/model-selector');
  // A phone call has no signed-in requester: install lanes only (§8.2).
  const routing = await new ModelSelector().selectForWorker('voice', false);
  let model = routing.model;
  let modelConfigName = routing.name || undefined;
  if (!model) {
    // Nothing bound to the voice topic: the install's default model answers the phone.
    const { getModelRegistry } = await import('@/models/model-registry');
    const fallback = await getModelRegistry().getDefaultModel();
    if (!fallback?.modelId) throw new Error('No model is bound to the voice topic, and the install has no default model.');
    log.warn({ callId: call.id, model: fallback.name }, 'No model bound to the voice topic; the default model answers the call');
    model = fallback.modelId;
    modelConfigName = fallback.name;
  }

  // The voice topic's temperature and max tokens (Topics page) over the phone defaults.
  const { applyTopicParamOverrides, getTopicConfig } = await import('@/models/topic-config');
  const params = applyTopicParamOverrides({ temperature: 0.7, maxTokens: 256 }, getTopicConfig('voice'));

  const expertPrompt = await callPrompt(call);
  const messages: AgentMessage[] = [
    { role: 'system', content: phoneSystemPrompt(expertPrompt), timestamp: new Date() },
    ...phoneHistory(call).map((turn) => ({ role: turn.role, content: turn.content, timestamp: new Date() })),
  ];
  return {
    model,
    modelConfigName,
    messages,
    ...params,
    // A phone call has no signed-in requester: the install's phone line pays.
    funding: 'install',
  };
}

/** Split a finished reply into what is spoken and whether it ends the call. */
export function parsePhoneReply(raw: string): PhoneReply {
  return { text: raw.split(END_CALL_MARKER).join('').trim(), endCall: raw.includes(END_CALL_MARKER) };
}

/** One call's turns run one after the other: carriers may post two at once. */
const turnQueue = new WeakMap<object, Promise<unknown>>();

/**
 * Answer what the caller said, in one piece. Records both turns on the call.
 * `text` is empty when the model wrote nothing to say.
 */
export function generatePhoneReply(call: PhoneCall, transcript: string): Promise<PhoneReply> {
  const run = async (): Promise<PhoneReply> => {
    recordCallerTurn(call, transcript);
    const started = Date.now();
    const options = await phoneCompletion(call);
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    const result = await getLiteLLMClient().complete(options);
    const reply = parsePhoneReply(result.content || '');
    recordAssistantTurn(call, reply.text);
    log.info({ callId: call.id, latencyMs: Date.now() - started, model: options.model, endCall: reply.endCall }, 'Phone reply generated');
    return reply;
  };
  const key = call.metadata;
  const turn = (turnQueue.get(key) ?? Promise.resolve()).then(run);
  // The queue only orders the turns: a failed turn is its caller's to handle, and the next one still runs.
  turnQueue.set(key, turn.then(() => undefined, () => undefined));
  return turn;
}

/**
 * A reply as it is written: text to speak, piece by piece. `endCall` is
 * final once the iteration has ended.
 */
export interface PhoneReplyStream extends AsyncIterable<string> {
  readonly endCall: boolean;
}

/**
 * Takes the end-of-call marker out of streamed text. The marker may arrive
 * split over several deltas, so text that could be its beginning is held
 * back until it is clear what it is.
 */
export class EndCallFilter {
  private held = '';
  endCall = false;

  push(delta: string): string {
    let text = this.held + delta;
    this.held = '';
    while (text.includes(END_CALL_MARKER)) {
      this.endCall = true;
      text = text.replace(END_CALL_MARKER, '');
    }
    for (let length = Math.min(END_CALL_MARKER.length - 1, text.length); length > 0; length--) {
      if (END_CALL_MARKER.startsWith(text.slice(-length))) {
        this.held = text.slice(-length);
        return text.slice(0, -length);
      }
    }
    return text;
  }

  /** The stream ended: what was held back was not the marker after all. */
  flush(): string {
    const text = this.held;
    this.held = '';
    return text;
  }
}

/**
 * Answer the call's conversation as it stands (the caller's turn is already
 * recorded with `recordCallerTurn`), streamed. The reply is NOT recorded
 * here: a reply on a live line can be cut off at any word, and only the
 * reader knows how much of it the caller heard — it records that with
 * `recordAssistantTurn`.
 */
export function streamPhoneReply(call: PhoneCall, options: { signal?: AbortSignal } = {}): PhoneReplyStream {
  const filter = new EndCallFilter();
  async function* deltas(): AsyncGenerator<string> {
    const started = Date.now();
    const completion = await phoneCompletion(call);
    const { getLiteLLMClient } = await import('@/models/litellm-client');
    for await (const chunk of getLiteLLMClient().stream({ ...completion, stream: true, signal: options.signal })) {
      if (options.signal?.aborted) return;
      if (!chunk.content) continue;
      const clean = filter.push(chunk.content);
      if (clean) yield clean;
    }
    if (options.signal?.aborted) return;
    const tail = filter.flush();
    if (tail) yield tail;
    log.info({ callId: call.id, latencyMs: Date.now() - started, model: completion.model, endCall: filter.endCall }, 'Phone reply streamed');
  }
  return {
    [Symbol.asyncIterator]: deltas,
    get endCall() { return filter.endCall; },
  };
}
