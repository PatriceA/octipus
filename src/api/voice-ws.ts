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
 * Engine posture (local-first): whisper.cpp streaming is the default — no key,
 * runs on this box, ~windowSeconds latency. `?engine=mistral` opts into Mistral
 * Voxtral realtime (true low-latency streaming) when a key is configured.
 *
 * Client → server:
 *   - binary frame  → a chunk of 16 kHz mono s16le PCM
 *   - {"type":"stop"} → end of utterance; flush and finalize
 * Server → client:
 *   - {"type":"ready","engine":"whisper|mistral"}
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

/** Build the STT engine for this connection: whisper (default) or Mistral. */
async function resolveEngine(engineParam: string | null): Promise<{ engine: STTEngine; name: string } | { error: string }> {
  const config = getConfig();
  const language = config.voice.language || 'en';

  if (engineParam === 'mistral') {
    const { getMistralApiKey } = await import('@/models/providers/mistral-provider');
    if (!(await getMistralApiKey())) return { error: 'Mistral engine requested but no Mistral API key is configured.' };
    const { MistralSTTEngine } = await import('@/voice/stt');
    return { engine: new MistralSTTEngine(undefined, { language }), name: 'mistral' };
  }

  // Default: local whisper.cpp streaming.
  const { whisperModelPath } = await import('@/voice/whisper');
  const modelPath = config.voice.whisperModelPath || whisperModelPath();
  if (!(await Bun.file(modelPath).exists())) {
    return { error: 'Local whisper is not installed. Run `octi setup`, or connect with ?engine=mistral.' };
  }
  const { WhisperEngine } = await import('@/voice/stt');
  return { engine: new WhisperEngine(modelPath, { language }), name: 'whisper' };
}

/** Join a new STT emission onto the running transcript. */
function appendTranscript(full: string, piece: string, engineName: string): string {
  const t = piece.trim();
  if (!t) return full;
  // Mistral yields sub-word deltas (concatenate); whisper yields whole-window
  // transcripts (space-join).
  if (engineName === 'mistral') return full + piece;
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
