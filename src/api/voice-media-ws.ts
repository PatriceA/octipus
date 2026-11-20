import type { Elysia } from '@/api/http';
import { apiLogger } from '@/utils/logger';
import type { PhoneAssistant } from '@/voice/telephony/assistant';
import type { PhoneMediaCall } from '@/voice/telephony/media-call';
import { type MediaWire, mediaWireFor } from '@/voice/telephony/media-wire';

/**
 * Telephony media-stream WebSocket — `/voice/media/:provider`.
 *
 * The socket end of a streamed call — Twilio `<Connect><Stream>`, Telnyx
 * `streaming_start`, Plivo `<Stream bidirectional>` — and nothing more: the
 * carrier's frames are read and written through its wire format
 * (src/voice/telephony/media-wire.ts), and everything in between — who is
 * talking, what was said, the reply and its speech — is `PhoneMediaCall`'s
 * (src/voice/telephony/media-call.ts), the phone's counterpart of the web
 * and mobile voice conversation.
 *
 * The call is the one the webhook registered in `CallManager` (found by the
 * carrier's call id), so `/api/voice/calls` lists it and its history is kept
 * on it. A call the webhook let through to the full assistant
 * (`metadata.assistant`, src/voice/telephony/assistant.ts) is answered by
 * the owner's root agent; every other call by the restricted phone reply.
 *
 * Auth: carriers don't token-auth the media socket, so the webhook mints a
 * short-lived single-use token into the stream URL that we validate on
 * connect; the stream must then be for the call the token was minted for.
 * ponytail: in-memory token store — fine for a single instance; move to a
 * shared store if telephony ever runs multi-instance.
 */

interface MediaToken {
  callSid: string;
  expiresAt: number;
}
const mediaTokens = new Map<string, MediaToken>();

/** Mint a one-call token for the stream URL; valid ~2 min (call setup window). */
export function mintMediaStreamToken(callSid: string): string {
  const token = crypto.randomUUID().replace(/-/g, '');
  mediaTokens.set(token, { callSid, expiresAt: Date.now() + 120_000 });
  for (const [k, v] of mediaTokens) if (v.expiresAt < Date.now()) mediaTokens.delete(k); // sweep
  return token;
}

/** Validate + consume (single-use) a stream token: the call id it was minted for, or null. */
export function redeemMediaStreamToken(token: string | null): string | null {
  if (!token) return null;
  const entry = mediaTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) return null;
  mediaTokens.delete(token);
  return entry.callSid;
}

/** Validate + consume (single-use) a stream token. Exported for tests. */
export function consumeMediaStreamToken(token: string | null): boolean {
  return redeemMediaStreamToken(token) !== null;
}

export interface MediaSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export interface MediaState {
  provider: string;
  wire: MediaWire;
  /** The carrier's id of the call the stream token was minted for. */
  callSid: string;
  streamId?: string;
  /** The call's id in CallManager. */
  callId?: string;
  call?: PhoneMediaCall;
  assistant?: PhoneAssistant;
  /** Media that arrived while the call was being set up; heard as soon as it is. */
  early: string[];
  closed: boolean;
  /** The call's end at the carrier is taken care of: the carrier stopped the stream, or we hung up. */
  stopped: boolean;
}

/** Ten seconds of 20 ms frames: more than any call setup takes. */
const MAX_EARLY_FRAMES = 500;

function stateOf(ws: { data: unknown }): MediaState | undefined {
  return (ws.data as { media?: MediaState }).media;
}

/** Send to the carrier; a socket that has gone away ends the call's speech, which `close` handles. */
function sendTo(ws: MediaSocket, st: MediaState, message: Record<string, unknown>): void {
  if (st.closed || !st.streamId) return;
  try {
    ws.send(JSON.stringify(message));
  } catch (err) {
    apiLogger.debug({ err, callId: st.callId }, 'voice media socket send failed (closing)');
  }
}

/** A socket for `provider` presenting `token`: its state, or null when it may not stream (no such carrier, bad token). */
export function openMediaStream(provider: string, token: string | null): MediaState | null {
  const wire = mediaWireFor(provider);
  const callSid = wire ? redeemMediaStreamToken(token) : null;
  if (!wire || callSid === null) return null;
  return { provider, wire, callSid, early: [], closed: false, stopped: false };
}

/** The carrier opened the stream: find the call, and start hearing and answering it. */
async function startCall(ws: MediaSocket, st: MediaState): Promise<void> {
  const [{ getCallManager, getTelephonyProvider }, { PhoneMediaCall: MediaCall }, reply, resolve, { getSettingsService }, { phonePhrase }, assistantModule] = await Promise.all([
    import('@/voice/telephony'), import('@/voice/telephony/media-call'), import('@/voice/telephony/reply'),
    import('@/voice/resolve'), import('@/config/settings-service'), import('@/voice/telephony/phrases'), import('@/voice/telephony/assistant'),
  ]);
  const callManager = getCallManager();
  // The webhook that answered the call registered it; a stream without one still gets a call of its own.
  let session = callManager.getByProviderCallId(st.callSid);
  if (st.closed) {
    // The stream ended while this was loading: no call to start, and the
    // registered one is over (`endMediaStream` ran before its id was known).
    if (session) {
      st.callId = session.id;
      await markEnded(st);
    }
    return;
  }
  if (!session) {
    session = {
      id: `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      provider: st.provider, providerCallId: st.callSid, direction: 'inbound', from: '', to: '',
      status: 'active', startedAt: new Date(), answeredAt: new Date(),
      metadata: { mode: 'conversation', conversationHistory: [] },
    };
    callManager.create(session);
  }
  // Known from here on: an end of the stream marks this call ended.
  st.callId = session.id;
  const call = session;

  const settings = getSettingsService();
  const silence = Number(await settings.get('voice.endpointSilenceMs'));
  const silenceMs = Number.isFinite(silence) && silence > 0 ? Math.min(3000, Math.max(300, silence)) : 700;
  const bargeIn = (await settings.get('voice.bargeIn')) !== false;
  const language = (await settings.get('voice.language')) as string | null;
  if (st.closed) {
    await markEnded(st);
    return;
  }
  callManager.updateStatus(call.id, 'active');
  call.metadata.streaming = true;

  const hangup = async (): Promise<void> => {
    st.stopped = true;
    const provider = await getTelephonyProvider(st.provider);
    try {
      if (provider) await provider.endCall(st.callSid);
    } finally {
      try {
        ws.close(1000, 'end call');
      } catch (err) {
        apiLogger.debug({ err, callId: call.id }, 'voice media socket was already closed');
      }
    }
  };

  // The owner's full assistant, when the webhook let this call through to it.
  const owner = call.metadata.assistant as { userId?: unknown; sessionId?: unknown } | undefined;
  let assistant: PhoneAssistant | null = null;
  if (typeof owner?.userId === 'string' && typeof owner.sessionId === 'string') {
    assistant = new assistantModule.PhoneAssistant(
      { callId: call.id, userId: owner.userId, sessionId: owner.sessionId, language },
      await assistantModule.liveAssistantDeps(owner.userId, owner.sessionId),
    );
    st.assistant = assistant;
    apiLogger.info({ callId: call.id, userId: owner.userId }, 'phone call answered by the full assistant');
  }

  let liveRow: import('@/db/schema/models').ModelConfigEntry | null = null;
  // A phone call has no signed-in requester: the install's lanes, no user or session.
  const media = new MediaCall(
    { callId: call.id, endpointer: { silenceMs, bargeIn }, troubleLine: phonePhrase('trouble', language) },
    {
      resolveStt: async () => {
        const { engine, name, row } = await resolve.resolveSttEngine({});
        liveRow = row;
        return { engine, name };
      },
      transcribe: async (wav) => (await resolve.transcribeWithLane(wav, { format: 'wav' })).text,
      heard: (text) => {
        reply.recordCallerTurn(call, text);
        assistant?.heard(text);
      },
      reply: (signal) => (assistant ? assistant.reply(signal) : reply.streamPhoneReply(call, { signal })),
      said: (text) => reply.recordAssistantTurn(call, text),
      speak: (text) => resolve.streamSpeechWithLane(text, {}),
      hangup,
      // A live engine is counted against its row by what it heard.
      recordHeard: async (seconds) => { if (liveRow && seconds > 0) await resolve.recordSpeechUsage(liveRow, 'transcription', {}, { seconds }); },
    },
    {
      audio: (frame) => sendTo(ws, st, st.wire.audio(st.streamId ?? '', Buffer.from(frame).toString('base64'))),
      clear: () => sendTo(ws, st, st.wire.clear(st.streamId ?? '')),
      mark: (name) => sendTo(ws, st, st.wire.mark(st.streamId ?? '', name)),
    },
  );
  st.call = media;
  for (const payload of st.early.splice(0)) media.pushMedia(payload);
  if (st.closed) {
    // Ended while the call was being built: `endCall` found nothing to stop.
    await media.close();
    await markEnded(st);
    return;
  }
  try {
    await media.start();
  } catch (err) {
    // Nothing can hear the caller: end the call rather than leave them talking to silence.
    apiLogger.error({ err, callId: call.id }, 'phone media call cannot listen (no transcription engine); hanging up');
    await hangup().catch((hangupErr: unknown) => apiLogger.error({ err: hangupErr, callId: call.id }, 'phone media call could not be hung up'));
  }
}

/** Mark the call ended (once its id is known) and let go of its assistant. */
async function markEnded(st: MediaState): Promise<void> {
  await st.assistant?.close();
  if (!st.callId) return;
  const { getCallManager, isFinalCallStatus } = await import('@/voice/telephony');
  const callManager = getCallManager();
  const session = callManager.get(st.callId);
  if (!session || isFinalCallStatus(session.status)) return;
  callManager.updateStatus(session.id, 'ended');
  if (st.stopped) return;
  // The socket went away without the carrier stopping the stream: the call
  // may still be up at the carrier (Telnyx keeps a call whose stream ended),
  // with nobody listening. Hang it up.
  const { getTelephonyProvider } = await import('@/voice/telephony');
  const provider = await getTelephonyProvider(st.provider);
  await provider?.endCall(st.callSid).catch((err: unknown) => apiLogger.debug({ err, callId: st.callId }, 'carrier call was already over'));
}

/** The stream is over: stop the call's work and mark it ended. */
export async function endMediaStream(st: MediaState): Promise<void> {
  if (st.closed) return;
  st.closed = true;
  await st.call?.close();
  await markEnded(st);
}

/** One frame from the carrier. */
export async function handleMediaFrame(ws: MediaSocket, st: MediaState, raw: unknown): Promise<void> {
  if (st.closed) return;
  let frame: unknown;
  try {
    frame = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    apiLogger.warn({ err }, 'voice media stream sent a frame that is not JSON');
    return;
  }
  const event = st.wire.read(frame);
  switch (event.type) {
    case 'start':
      if (st.streamId) return; // one stream per socket
      if (event.callId !== st.callSid) {
        apiLogger.warn({ provider: st.provider }, 'voice media stream is for another call than its token; closing');
        ws.close(4003, 'Stream does not match its token');
        return;
      }
      st.streamId = event.streamId || event.callId;
      try {
        await startCall(ws, st);
      } catch (err) {
        apiLogger.error({ err }, 'phone media call could not start');
        ws.close(1011, 'Call could not start');
      }
      return;
    case 'stop':
      st.stopped = true;
      await endMediaStream(st);
      return;
    case 'mark':
      if (event.name) st.call?.markReached(event.name);
      return;
    case 'error':
      apiLogger.warn({ provider: st.provider, callId: st.callId, detail: event.detail }, 'carrier reported a media stream error');
      return;
    case 'media':
      // Only once the stream has started: media before `start` belongs to no known call.
      if (!st.streamId) return;
      if (st.call) st.call.pushMedia(event.payload);
      else if (st.early.length < MAX_EARLY_FRAMES) st.early.push(event.payload);
      return;
    default:
      return;
  }
}

export function setupVoiceMediaWebSocket(app: Elysia): void {
  app.ws('/voice/media/:provider', {
    open(ws) {
      const url = new URL(ws.data.request.url);
      const provider = url.pathname.split('/').pop() || '';
      const st = openMediaStream(provider, url.searchParams.get('token'));
      if (!st) {
        ws.close(4001, 'Invalid or expired stream token');
        return;
      }
      (ws.data as { media?: MediaState }).media = st;
      apiLogger.info({ provider }, 'voice media stream opened');
    },

    async message(ws, raw) {
      const st = stateOf(ws);
      if (st) await handleMediaFrame(ws, st, raw);
    },

    async close(ws) {
      const st = stateOf(ws);
      if (st) await endMediaStream(st);
      apiLogger.info('voice media stream closed');
    },
  });
}
