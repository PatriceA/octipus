import type { Elysia } from 'elysia';
import { getConfig } from '@/config';
import { getSessionManager } from '@/security/auth/session';
import type { STTEngine } from '@/voice/stt';
import { apiLogger } from '@/utils/logger';

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
 * Engine selection: an explicit `?engine=` (whisper | mistral | openai) wins;
 * otherwise `voice.sttProvider` decides. `auto` prefers a cloud realtime engine
 * (Voxtral/OpenAI, true low-latency streaming) when a key is set, else falls
 * back to local whisper.cpp streaming (~windowSeconds latency, no key).
 *
 * Client → server:
 *   - binary frame  → a chunk of 16 kHz mono s16le PCM
 *   - {"type":"stop"} → end of utterance; flush and finalize
 * Server → client:
 *   - {"type":"ready","engine":"whisper|mistral|openai"}
 *   - {"type":"transcript","text": "<running full text>","final": false|true}
 *   - {"type":"error","message": "..."}
 */

interface VoiceWsState {
  userId?: string;
  /** Feeds inbound PCM frames into the STT engine's ReadableStream. */
  push?: (pcm: Uint8Array) => void;
  /** Closes the PCM stream so streamTranscribe drains its tail and finishes. */
  end?: () => void;
  closed?: boolean;
}

function stateOf(ws: { data: unknown }): VoiceWsState {
  return ws.data as VoiceWsState;
}

async function mistralEngine(language: string): Promise<{ engine: STTEngine; name: string } | { error: string }> {
  const { getMistralApiKey } = await import('@/models/providers/mistral-provider');
  if (!(await getMistralApiKey())) return { error: 'Voxtral (Mistral) selected but no Mistral API key is configured.' };
  const { MistralSTTEngine } = await import('@/voice/stt');
  return { engine: new MistralSTTEngine(undefined, { language }), name: 'mistral' };
}

async function openaiEngine(language: string): Promise<{ engine: STTEngine; name: string } | { error: string }> {
  const { getOpenAIApiKey } = await import('@/models/providers/openai-provider');
  if (!(await getOpenAIApiKey())) return { error: 'OpenAI selected but no OpenAI API key is configured.' };
  const { OpenAIRealtimeSTTEngine } = await import('@/voice/stt');
  return { engine: new OpenAIRealtimeSTTEngine(undefined, { language }), name: 'openai' };
}

async function whisperEngine(language: string): Promise<{ engine: STTEngine; name: string } | { error: string }> {
  const { whisperModelPath } = await import('@/voice/whisper');
  const config = getConfig();
  const modelPath = config.voice.whisperModelPath || whisperModelPath();
  if (!(await Bun.file(modelPath).exists())) {
    return { error: 'Local whisper is not installed. Run `octi setup`, or pick a cloud engine in Settings → Voice.' };
  }
  const { WhisperEngine } = await import('@/voice/stt');
  return { engine: new WhisperEngine(modelPath, { language }), name: 'whisper' };
}

/**
 * Build the STT engine for this connection. An explicit `?engine=` query param
 * wins (whisper | mistral | openai); otherwise the configured `voice.sttProvider`
 * decides, with `auto` preferring a cloud realtime engine (lower latency) and
 * falling back to local whisper.
 */
async function resolveEngine(engineParam: string | null): Promise<{ engine: STTEngine; name: string } | { error: string }> {
  const config = getConfig();
  const language = config.voice.language || 'en';
  // An explicit ?engine= wins only if it names a real engine; an unknown value
  // (typo, stale client) falls back to the setting rather than silently routing
  // to a cloud engine the caller never asked for.
  const known = ['whisper', 'mistral', 'openai'];
  const choice = engineParam && known.includes(engineParam) ? engineParam : config.voice.sttProvider || 'auto';

  if (choice === 'mistral') return mistralEngine(language);
  if (choice === 'openai') return openaiEngine(language);
  if (choice === 'whisper') return whisperEngine(language);

  // auto: cloud realtime first (low latency), else local whisper.
  const { getMistralApiKey } = await import('@/models/providers/mistral-provider');
  if (await getMistralApiKey()) return mistralEngine(language);
  const { getOpenAIApiKey } = await import('@/models/providers/openai-provider');
  if (await getOpenAIApiKey()) return openaiEngine(language);
  return whisperEngine(language);
}

/** Join a new STT emission onto the running transcript. */
function appendTranscript(full: string, piece: string, engineName: string): string {
  // Mistral & OpenAI yield sub-word deltas — concatenate verbatim so a
  // whitespace-only delta (the space between two words) is preserved.
  if (engineName === 'mistral' || engineName === 'openai') return full + piece;
  // Whisper yields whole-window transcripts — trim and space-join.
  const t = piece.trim();
  if (!t) return full;
  return full ? `${full} ${t}` : t;
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
      const session = await getSessionManager().validate(token);
      if (!session) {
        ws.close(4001, 'Invalid or expired token');
        return;
      }

      const resolved = await resolveEngine(url.searchParams.get('engine'));
      if ('error' in resolved) {
        ws.send(JSON.stringify({ type: 'error', message: resolved.error }));
        ws.close(4002, 'No STT engine');
        return;
      }
      const { engine, name } = resolved;

      const st = stateOf(ws);
      st.userId = session.userId;

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
            full = appendTranscript(full, piece, name);
            safeSend({ type: 'transcript', text: full, final: false });
          }
          safeSend({ type: 'transcript', text: full, final: true });
        } catch (err) {
          apiLogger.error({ err, engine: name }, 'voice-ws stream transcription failed');
          safeSend({ type: 'error', message: err instanceof Error ? err.message : 'Transcription failed' });
        } finally {
          await engine.dispose().catch(() => {});
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
        st.push?.(message instanceof ArrayBuffer ? new Uint8Array(message) : message);
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
      if (ctrl?.type === 'stop') st.end?.();
    },

    close(ws) {
      const st = stateOf(ws);
      st.closed = true;
      st.end?.(); // unblock streamTranscribe so it drains and disposes
      apiLogger.debug({ userId: st.userId }, 'voice-ws closed');
    },
  });
}
