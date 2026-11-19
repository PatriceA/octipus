import type { Elysia } from '@/api/http';
import { apiLogger } from '@/utils/logger';
import type { PhoneMediaCall } from '@/voice/telephony/media-call';

/**
 * Telephony media-stream WebSocket — `/voice/media/:provider`.
 *
 * The socket end of a Twilio `<Connect><Stream>` call, and nothing more: it
 * reads Twilio's JSON frames (`start`, `media`, `mark`, `stop`), writes
 * `media` / `mark` / `clear` back, and hands everything in between — who is
 * talking, what was said, the reply and its speech — to `PhoneMediaCall`
 * (src/voice/telephony/media-call.ts), which is the phone's counterpart of
 * the web and mobile voice conversation.
 *
 * The call is the one the webhook registered in `CallManager` (found by its
 * CallSid), so `/api/voice/calls` lists it and its history is kept on it.
 *
 * Auth: Twilio doesn't token-auth the media socket, so the webhook mints a
 * short-lived single-use token into the Stream URL that we validate on
 * connect; the stream must then be for the call the token was minted for.
 * ponytail: in-memory token store — fine for a single instance; move to a
 * shared store if telephony ever runs multi-instance.
 */

interface MediaToken {
  callSid: string;
  expiresAt: number;
}
const mediaTokens = new Map<string, MediaToken>();

/** Mint a one-call token for the Stream URL; valid ~2 min (call setup window). */
export function mintMediaStreamToken(callSid: string): string {
  const token = crypto.randomUUID().replace(/-/g, '');
  mediaTokens.set(token, { callSid, expiresAt: Date.now() + 120_000 });
  for (const [k, v] of mediaTokens) if (v.expiresAt < Date.now()) mediaTokens.delete(k); // sweep
  return token;
}

/** Validate + consume (single-use) a stream token: the CallSid it was minted for, or null. */
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

interface MediaSocket {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

interface MediaState {
  provider: string;
  /** The call the stream token was minted for. */
  callSid: string;
  streamSid?: string;
  /** The call's id in CallManager. */
  callId?: string;
  call?: PhoneMediaCall;
  /** Media that arrived while the call was being set up; heard as soon as it is. */
  early: string[];
  closed: boolean;
}

/** Ten seconds of 20 ms frames: more than any call setup takes. */
const MAX_EARLY_FRAMES = 500;

/** A Twilio media-stream message, as far as it is read here. */
interface TwilioStreamMessage {
  event?: string;
  streamSid?: string;
  start?: { streamSid?: string; callSid?: string };
  media?: { track?: string; payload?: string };
  mark?: { name?: string };
}

function stateOf(ws: { data: unknown }): MediaState | undefined {
  return (ws.data as { media?: MediaState }).media;
}

/** Send to the carrier; a socket that has gone away ends the call's speech, which `close` handles. */
function sendTo(ws: MediaSocket, st: MediaState, message: Record<string, unknown>): void {
  if (st.closed || !st.streamSid) return;
  try {
    ws.send(JSON.stringify({ ...message, streamSid: st.streamSid }));
  } catch (err) {
    apiLogger.debug({ err, callId: st.callId }, 'voice media socket send failed (closing)');
  }
}

/** Twilio opened the stream: find the call, and start hearing and answering it. */
async function startCall(ws: MediaSocket, st: MediaState): Promise<void> {
  const [{ getCallManager, getTelephonyProvider }, { PhoneMediaCall: MediaCall }, reply, resolve, { getSettingsService }, { phonePhrase }] = await Promise.all([
    import('@/voice/telephony'), import('@/voice/telephony/media-call'), import('@/voice/telephony/reply'),
    import('@/voice/resolve'), import('@/config/settings-service'), import('@/voice/telephony/phrases'),
  ]);
  const callManager = getCallManager();
  // The webhook that answered the call registered it; a stream without one still gets a call of its own.
  let session = callManager.getByProviderCallId(st.callSid);
  if (!session) {
    session = {
      id: `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      provider: st.provider, providerCallId: st.callSid, direction: 'inbound', from: '', to: '',
      status: 'active', startedAt: new Date(), answeredAt: new Date(),
      metadata: { mode: 'conversation', conversationHistory: [] },
    };
    callManager.create(session);
  }
  callManager.updateStatus(session.id, 'active');
  session.metadata.streaming = true;
  st.callId = session.id;
  const call = session;

  const settings = getSettingsService();
  const silence = Number(await settings.get('voice.endpointSilenceMs'));
  const silenceMs = Number.isFinite(silence) && silence > 0 ? Math.min(3000, Math.max(300, silence)) : 700;
  const bargeIn = (await settings.get('voice.bargeIn')) !== false;
  const language = (await settings.get('voice.language')) as string | null;

  const hangup = async (): Promise<void> => {
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
      heard: (text) => reply.recordCallerTurn(call, text),
      reply: (signal) => reply.streamPhoneReply(call, { signal }),
      said: (text) => reply.recordAssistantTurn(call, text),
      speak: (text) => resolve.streamSpeechWithLane(text, {}),
      hangup,
      // A live engine is counted against its row by what it heard.
      recordHeard: async (seconds) => { if (liveRow && seconds > 0) await resolve.recordSpeechUsage(liveRow, 'transcription', {}, { seconds }); },
    },
    {
      audio: (frame) => sendTo(ws, st, { event: 'media', media: { payload: Buffer.from(frame).toString('base64') } }),
      clear: () => sendTo(ws, st, { event: 'clear' }),
      mark: (name) => sendTo(ws, st, { event: 'mark', mark: { name } }),
    },
  );
  st.call = media;
  for (const payload of st.early.splice(0)) media.pushMedia(payload);
  if (st.closed) {
    await media.close();
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

/** The stream is over: stop the call's work and mark it ended. */
async function endCall(st: MediaState): Promise<void> {
  if (st.closed) return;
  st.closed = true;
  await st.call?.close();
  if (!st.callId) return;
  const { getCallManager, isFinalCallStatus } = await import('@/voice/telephony');
  const callManager = getCallManager();
  const session = callManager.get(st.callId);
  if (session && !isFinalCallStatus(session.status)) callManager.updateStatus(session.id, 'ended');
}

export function setupVoiceMediaWebSocket(app: Elysia): void {
  app.ws('/voice/media/:provider', {
    open(ws) {
      const url = new URL(ws.data.request.url);
      const callSid = redeemMediaStreamToken(url.searchParams.get('token'));
      if (callSid === null) {
        ws.close(4001, 'Invalid or expired stream token');
        return;
      }
      const provider = url.pathname.split('/').pop() || 'twilio';
      const st: MediaState = { provider, callSid, early: [], closed: false };
      (ws.data as { media?: MediaState }).media = st;
      apiLogger.info({ provider }, 'voice media stream opened');
    },

    async message(ws, raw) {
      const st = stateOf(ws);
      if (!st || st.closed) return;
      let msg: TwilioStreamMessage;
      try {
        msg = typeof raw === 'string' ? JSON.parse(raw) as TwilioStreamMessage : (raw as TwilioStreamMessage);
      } catch (err) {
        apiLogger.warn({ err }, 'voice media stream sent a frame that is not JSON');
        return;
      }

      if (msg.event === 'start') {
        if (st.streamSid) return; // one stream per socket
        if (msg.start?.callSid !== st.callSid) {
          apiLogger.warn({ provider: st.provider }, 'voice media stream is for another call than its token; closing');
          ws.close(4003, 'Stream does not match its token');
          return;
        }
        st.streamSid = msg.start?.streamSid || msg.streamSid;
        try {
          await startCall(ws, st);
        } catch (err) {
          apiLogger.error({ err }, 'phone media call could not start');
          ws.close(1011, 'Call could not start');
        }
        return;
      }
      if (msg.event === 'stop') {
        await endCall(st);
        return;
      }
      if (msg.event === 'mark') {
        if (msg.mark?.name) st.call?.markReached(msg.mark.name);
        return;
      }
      if (msg.event !== 'media' || !msg.media?.payload) return;
      if (msg.media.track && msg.media.track !== 'inbound') return; // caller only
      if (st.call) st.call.pushMedia(msg.media.payload);
      else if (st.early.length < MAX_EARLY_FRAMES) st.early.push(msg.media.payload);
    },

    async close(ws) {
      const st = stateOf(ws);
      if (st) await endCall(st);
      apiLogger.info('voice media stream closed');
    },
  });
}
