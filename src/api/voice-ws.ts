import type { Elysia } from '@/api/http';
import { getSessionManager } from '@/security/auth/session';
import { userChangeMark } from '@/security/user-change-marks';
import type { STTEngine } from '@/voice/stt';
import { apiLogger } from '@/utils/logger';
import { trackUserSocket } from './user-sockets';

/**
 * Realtime voice WebSocket — `/voice`.
 *
 * The duplex upgrade over the turn-based `/voice/transcribe` POST loop
 * (Phase 4b). The browser opens this socket, streams raw 16 kHz mono s16le PCM
 * frames (from an AudioWorklet) as binary messages, and receives progressive
 * transcripts back as JSON. It is deliberately NOT the JSON `/gateway` socket,
 * which decodes every binary frame to a string (gateway-ws.ts) — this one keeps
 * binary as PCM.
 *
 * Engine selection: the model bound to the Transcription lane (primary, then
 * backup); an admin's `?engine=` may name one (see resolveEngine), and in a
 * conversation `?tts=` names the Speech engine the same way.
 *
 * Two modes (`?mode=`):
 *
 * `dictation` (the default; what older clients speak) — transcribe only:
 *   Client → server:
 *     - binary frame  → a chunk of 16 kHz mono s16le PCM
 *     - {"type":"stop"} → end of utterance; flush and finalize
 *   Server → client:
 *     - {"type":"ready","engine":"whisper|mistral|openai"}
 *     - {"type":"transcript","text": "<running full text>","final": false|true}
 *     - {"type":"error","message": "..."}
 *
 * `conversation` — a whole voice conversation (src/voice/session.ts): the
 * server decides where a turn ends and speaks the reply while it is written.
 * `?session=` names the chat whose replies are spoken, `?speak=0` listens
 * only, `?audio=wav` sends one clip per sentence instead of PCM frames,
 * `?silence=<ms>` sets the pause that ends a turn, `?partials=0` turns off
 * what is being said before the turn ends.
 *   Client → server:
 *     - binary frame  → 16 kHz mono s16le PCM, all the time (also while a reply plays)
 *     - {"type":"interrupt"}       stop speaking
 *     - {"type":"expect_reply"}    speak the next reply (a typed message, a retry)
 *     - {"type":"say","text":…}    read this aloud
 *     - {"type":"playback","state":"ended"}  everything sent has been played
 *     - {"type":"stop"}            end the conversation
 *   Server → client:
 *     - {"type":"ready","mode":"conversation","engine":…,"live":bool,"speak":bool}
 *     - {"type":"speech_start"} · {"type":"transcript","text":…,"final":false}
 *     - {"type":"utterance","text":…}   the turn, for the client to send as a chat
 *                                       message with `spoken: true`
 *     - {"type":"audio","seq":n,"format":"pcm|wav","sampleRate":hz,"ms":n,"text"?:…}
 *       followed by one binary frame of that audio
 *     - {"type":"speaking","on":bool} · {"type":"barge_in"} · {"type":"error","message":…}
 */

interface VoiceWsState {
  /** Conversation mode: the session that hears, endpoints and speaks. */
  conversation?: import('@/voice/session').VoiceSession;
  userId?: string;
  /** Feeds inbound PCM frames into the STT engine's ReadableStream. */
  push?: (pcm: Uint8Array) => void;
  /** Closes the PCM stream so streamTranscribe drains its tail and finishes. */
  end?: () => void;
  closed?: boolean;
  /** Drops this socket from the user's socket list (user-sockets.ts). */
  untrack?: () => void;
}

function stateOf(ws: { data: unknown }): VoiceWsState {
  return ws.data as VoiceWsState;
}

/** An engine named on the socket's URL counts only for an admin; anyone else gets the lane's binding. */
async function adminOverride(param: string | null, userId: string): Promise<string | null> {
  if (!param) return null;
  const { userRepository } = await import('@/db/repositories/user-repository');
  return (await userRepository.findById(userId))?.isAdmin ? param : null;
}

/**
 * The engine for this connection: the model bound to the Transcription lane
 * (src/voice/resolve.ts — primary, then backup, protection levels applied).
 * `?engine=` may ask for one: a row name or an old engine name (`whisper`,
 * `fasterwhisper`, `mistral`, `openai`, `auto`), which picks the bound row of
 * that engine. An account that may not use the install's hosted keys gets a
 * local engine or none.
 */
async function resolveEngine(engineParam: string | null, userId: string, sessionParam: string | null): Promise<{ engine: STTEngine; name: string; row: import('@/db/schema/models').ModelConfigEntry } | { error: string }> {
  try {
    const { resolveSttEngine } = await import('@/voice/resolve');
    const { mayUseInstallModels } = await import('@/models/install-access');
    // `?session=`: the conversation being dictated into; its protection level
    // decides whether a cloud engine may hear it. Only one the caller may speak in.
    let sessionId: string | undefined;
    if (sessionParam) {
      const { sessionRepository } = await import('@/db/repositories/session-repository');
      const { canActInSession } = await import('@/core/rooms/access');
      // i2: by id, used only when canActInSession says the caller may speak in it.
      if (!(await canActInSession(await sessionRepository.findById(sessionParam), userId, 'voice'))) return { error: 'Session not found' };
      sessionId = sessionParam;
    }
    const { engine, name, row } = await resolveSttEngine({
      override: await adminOverride(engineParam, userId),
      userId,
      sessionId,
      allowHosted: await mayUseInstallModels(userId),
    });
    return { engine, name, row };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** Join a new STT emission onto the running transcript. */
function appendTranscript(full: string, piece: string, live: boolean): string {
  // A live engine yields sub-word deltas — concatenate verbatim so a
  // whitespace-only delta (the space between two words) is preserved.
  if (live) return full + piece;
  // Whisper yields whole-window transcripts — trim and space-join.
  const t = piece.trim();
  if (!t) return full;
  return full ? `${full} ${t}` : t;
}

/** The socket as the handlers below use it. */
interface VoiceSocket {
  data: unknown;
  send(data: string | Uint8Array): unknown;
  close(code?: number, reason?: string): unknown;
}

/**
 * Open a voice conversation on this socket (src/voice/session.ts). The chat
 * session named by `?session=` must be one the caller may speak in, or not
 * exist yet (a fresh chat): the turn's events are matched on the caller's
 * user id as well, so a session id that is not theirs yields nothing.
 */
async function openConversation(ws: VoiceSocket, url: URL, userId: string, mark: ReturnType<typeof userChangeMark>): Promise<void> {
  const refuse = (message: string, code = 4002) => {
    try { ws.send(JSON.stringify({ type: 'error', message })); ws.close(code, message.slice(0, 100)); } catch { /* connection closed */ }
  };
  const sessionId = url.searchParams.get('session') ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return refuse('A conversation needs the chat session it belongs to (?session=).');
  const [{ sessionRepository }, { canActInSession }, { mayUseInstallModels }, resolve, { VoiceSession }, { getSettingsService }, { getGatewayHub }] = await Promise.all([
    import('@/db/repositories/session-repository'), import('@/core/rooms/access'), import('@/models/install-access'),
    import('@/voice/resolve'), import('@/voice/session'), import('@/config/settings-service'), import('@/core/gateway/hub'),
  ]);
  // i2: by id, used only when canActInSession says the caller may speak in it.
  const mayUse = async (session: Awaited<ReturnType<typeof sessionRepository.findById>>) => !session || canActInSession(session, userId, 'voice');
  let existing = await sessionRepository.findById(sessionId);
  if (!(await mayUse(existing))) return refuse('Session not found');

  const allowHosted = await mayUseInstallModels(userId);
  // The chat's protection level decides which engines may hear and speak it.
  // A fresh chat is created by the first utterance, so its row is looked up
  // again until it exists: from then on its level counts.
  const request = { userId, sessionId: existing ? sessionId : undefined as string | undefined, allowHosted };
  const current = async (): Promise<typeof request> => {
    if (!request.sessionId) {
      existing = await sessionRepository.findById(sessionId);
      if (existing) {
        if (!(await mayUse(existing))) throw new Error('Session not found');
        request.sessionId = sessionId;
      }
    }
    return request;
  };
  const sttOverride = await adminOverride(url.searchParams.get('engine'), userId);
  const ttsOverride = await adminOverride(url.searchParams.get('tts'), userId);
  const hearing = async () => ({ ...(await current()), override: sttOverride });
  const speaking = async () => ({ ...(await current()), override: ttsOverride });
  const settings = getSettingsService();
  const number = async (key: string, fallback: number, min: number, max: number) => {
    const value = Number(await settings.get(key));
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const silenceParam = Number(url.searchParams.get('silence'));
  const silenceMs = Number.isFinite(silenceParam) && silenceParam > 0
    ? Math.min(3000, Math.max(300, silenceParam))
    : await number('voice.endpointSilenceMs', 700, 300, 3000);
  const bargeIn = (await settings.get('voice.bargeIn')) !== false;
  // Speaking needs a Speech engine; without one the conversation still listens.
  const wantsSpeech = url.searchParams.get('speak') !== '0';
  const speak = wantsSpeech && (await resolve.speechStatus('tts', await speaking())).available;

  const st = stateOf(ws);
  if (st.closed) return;
  st.userId = userId;
  const untrack = trackUserSocket(userId, ws as never, mark);
  if (!untrack) return;
  st.untrack = untrack;

  let liveRow: import('@/db/schema/models').ModelConfigEntry | null = null;
  const conversation = new VoiceSession(
    { userId, sessionId, speak, audio: url.searchParams.get('audio') === 'wav' ? 'wav' : 'pcm', endpointer: { silenceMs, bargeIn }, partials: url.searchParams.get('partials') !== '0' },
    {
      resolveStt: async () => {
        const { engine, name, row } = await resolve.resolveSttEngine({ ...(await hearing()), endpointSilenceMs: silenceMs });
        liveRow = row;
        return { engine, name, local: await resolve.speechRowStaysLocal(row) };
      },
      transcribe: async (wav, options) => (await resolve.transcribeWithLane(wav, { ...(await hearing()), format: 'wav', ...(options?.interim ? { interim: true } : {}) })).text,
      // A cloud engine that streams heard the chat while its level allowed it; once the level is raised it stops.
      mayKeepListening: async () => !liveRow || (await resolve.speechRowRefusal(liveRow, await hearing())) === null,
      // A quarter second of silence through the lane: loads a local engine's
      // model (resident afterwards). Not counted: nobody said anything.
      warmUp: async () => { await resolve.warmSpeechEngines(await hearing()); },
      speak: async (text) => resolve.streamSpeechWithLane(text, await speaking()),
      subscribe: (handler) => {
        const bus = getGatewayHub().eventBus;
        const offs = ['chat.delta', 'chat.response', 'chat.error', 'chat.message', 'voice.speak'].map((type) => bus.subscribe(type, handler as never));
        return () => { for (const off of offs) off(); };
      },
      // A live engine is counted against its row by what it heard.
      recordHeard: async (seconds) => { if (liveRow && seconds > 0) await resolve.recordSpeechUsage(liveRow, 'transcription', await current(), { seconds }); },
    },
    (message, binary) => {
      if (st.closed) return;
      try {
        ws.send(JSON.stringify(message));
        if (binary) ws.send(binary);
      } catch { /* connection closed */ }
    },
  );
  try {
    await conversation.start();
  } catch (err) {
    untrack();
    return refuse((err as Error).message);
  }
  if (st.closed) { untrack(); await conversation.close(); return; }
  st.conversation = conversation;
  apiLogger.debug({ userId, sessionId, speak }, 'voice conversation opened');
}

export function setupVoiceWebSocket(app: Elysia): void {
  app.ws('/voice', {
    async open(ws) {
      const url = new URL(ws.data.request.url);
      const token = url.searchParams.get('token');
      if (!token) {
        ws.close(4001, 'Authentication required');
        return;
      }
      const mark = userChangeMark();
      const session = await getSessionManager().validate(token);
      if (!session) {
        ws.close(4001, 'Invalid or expired token');
        return;
      }

      if (url.searchParams.get('mode') === 'conversation') {
        await openConversation(ws, url, session.userId, mark);
        return;
      }

      const resolved = await resolveEngine(url.searchParams.get('engine'), session.userId, url.searchParams.get('session'));
      if ('error' in resolved) {
        ws.send(JSON.stringify({ type: 'error', message: resolved.error }));
        ws.close(4002, 'No STT engine');
        return;
      }
      const { engine, name, row } = resolved;
      let pcmBytes = 0;

      const st = stateOf(ws);
      st.userId = session.userId;
      const untrack = trackUserSocket(session.userId, ws, mark);
      if (!untrack) return;
      st.untrack = untrack;

      // A ReadableStream fed by inbound binary frames; the STT engine pulls from
      // it while `message` pushes into it.
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let ended = false;
      // Byte-counting queue so desiredSize reflects buffered PCM bytes: if a slow
      // STT engine falls >10 s of 16 kHz s16le behind, shed frames rather than grow
      // memory unbounded for the life of the connection. Half-duplex means we only
      // receive while listening, so hitting this means STT is badly behind anyway.
      const MAX_BUFFERED = 16000 * 2 * 10;
      const pcmStream = new ReadableStream<Uint8Array>(
        {
          start(c) {
            controller = c;
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: MAX_BUFFERED }),
      );
      st.push = (pcm) => {
        if (controller && controller.desiredSize !== null && controller.desiredSize <= 0) return; // shed load
        pcmBytes += pcm.byteLength;
        controller?.enqueue(pcm);
      };
      st.end = () => {
        if (!ended) {
          ended = true;
          try {
            controller?.close();
          } catch {
            /* already closed */
          }
        }
      };

      const safeSend = (data: unknown) => {
        try {
          ws.send(JSON.stringify(data));
        } catch {
          /* connection closed */
        }
      };

      safeSend({ type: 'ready', engine: name });

      // Consume the transcript stream for the life of the connection.
      void (async () => {
        let full = '';
        try {
          for await (const piece of engine.streamTranscribe(pcmStream)) {
            if (st.closed) break;
            full = appendTranscript(full, piece, !!engine.live);
            safeSend({ type: 'transcript', text: full, final: false });
          }
          safeSend({ type: 'transcript', text: full, final: true });
        } catch (err) {
          apiLogger.error({ err, engine: name }, 'voice-ws stream transcription failed');
          safeSend({ type: 'error', message: err instanceof Error ? err.message : 'Transcription failed' });
        } finally {
          await engine.dispose().catch(() => {});
          // Counted against the bound row: 16 kHz mono s16le is 32 000 bytes a second.
          const { recordSpeechUsage } = await import('@/voice/resolve');
          await recordSpeechUsage(row, 'transcription', { userId: session.userId }, { seconds: Math.round(pcmBytes / 32_000) });
          if (!st.closed) {
            try {
              ws.close(1000, 'done');
            } catch {
              /* already closed */
            }
          }
        }
      })();

      apiLogger.debug({ userId: session.userId, engine: name }, 'voice-ws opened');
    },

    message(ws, message) {
      const st = stateOf(ws);
      if (st.closed) return;
      // Binary frame → PCM (Buffer is a Uint8Array subclass, so one check covers it).
      if (message instanceof Uint8Array || message instanceof ArrayBuffer) {
        const pcm = message instanceof ArrayBuffer ? new Uint8Array(message) : message;
        if (st.conversation) st.conversation.pushAudio(pcm);
        else st.push?.(pcm);
        return;
      }
      // Control frame ({type:"stop"}) — Elysia may hand it over as a raw JSON
      // string OR already parsed into an object, so accept both.
      let ctrl: { type?: string } | null = null;
      if (typeof message === 'string') {
        try {
          ctrl = JSON.parse(message);
        } catch {
          /* ignore malformed control frame */
        }
      } else if (message && typeof message === 'object') {
        ctrl = message as { type?: string };
      }
      if (st.conversation) {
        const c = ctrl as { type?: string; text?: unknown; state?: unknown } | null;
        if (c?.type === 'interrupt') st.conversation.interrupt();
        else if (c?.type === 'expect_reply') st.conversation.expectReply();
        else if (c?.type === 'say' && typeof c.text === 'string') st.conversation.say(c.text.slice(0, 5000));
        else if (c?.type === 'playback' && c.state === 'ended') st.conversation.playbackEnded();
        else if (c?.type === 'stop') { try { ws.close(1000, 'done'); } catch { /* already closed */ } }
        return;
      }
      if (ctrl?.type === 'stop') st.end?.();
    },

    close(ws) {
      const st = stateOf(ws);
      st.closed = true;
      st.untrack?.();
      void st.conversation?.close();
      st.end?.(); // unblock streamTranscribe so it drains and disposes
      apiLogger.debug({ userId: st.userId }, 'voice-ws closed');
    },
  });
}
