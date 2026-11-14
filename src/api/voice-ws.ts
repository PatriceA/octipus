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
 * backup); `?engine=` may name one (see resolveEngine).
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
  /** Drops this socket from the user's socket list (user-sockets.ts). */
  untrack?: () => void;
}

function stateOf(ws: { data: unknown }): VoiceWsState {
  return ws.data as VoiceWsState;
}

/**
 * The engine for this connection: the model bound to the Transcription lane
 * (src/voice/resolve.ts — primary, then backup, protection levels applied).
 * `?engine=` may ask for one: a row name or an old engine name (`whisper`,
 * `fasterwhisper`, `mistral`, `openai`, `auto`), which picks the bound row of
 * that engine. An account that may not use the install's hosted keys gets a
 * local engine or none.
 */
async function resolveEngine(engineParam: string | null, userId: string): Promise<{ engine: STTEngine; name: string; row: import('@/db/schema/models').ModelConfigEntry } | { error: string }> {
  try {
    const { resolveSttEngine } = await import('@/voice/resolve');
    const { mayUseInstallModels } = await import('@/models/install-access');
    const { engine, name, row } = await resolveSttEngine({
      override: engineParam || null,
      userId,
      allowHosted: await mayUseInstallModels(userId),
    });
    return { engine, name, row };
  } catch (err) {
    return { error: (err as Error).message };
  }
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
      const mark = userChangeMark();
      const session = await getSessionManager().validate(token);
      if (!session) {
        ws.close(4001, 'Invalid or expired token');
        return;
      }

      const resolved = await resolveEngine(url.searchParams.get('engine'), session.userId);
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
            full = appendTranscript(full, piece, name);
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
      st.untrack?.();
      st.end?.(); // unblock streamTranscribe so it drains and disposes
      apiLogger.debug({ userId: st.userId }, 'voice-ws closed');
    },
  });
}
