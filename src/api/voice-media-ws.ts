import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnProcess as spawn } from '@/utils/proc';
import type { Elysia } from '@/api/http';
import { getConfig } from '@/config';
import { apiLogger } from '@/utils/logger';
import { pcm16kToTwilioMedia, TwilioInboundDecoder } from '@/voice/telephony/media-bridge';
import { generatePhoneReply, type PhoneTurn } from '@/voice/telephony/reply';
import { fileAt, writeFileAt } from '@/utils/fs-file';

/**
 * Telephony media-stream WebSocket — `/voice/media/:provider` (Phase 4d).
 *
 * Wires the dead Twilio `<Connect><Stream>` branch into a full duplex phone
 * agent: inbound 8 kHz μ-law → (4a codec) 16 kHz PCM → whisper streaming STT →
 * generatePhoneReply → TTS → 16 kHz → 8 kHz μ-law → back to the caller.
 *
 * Turn-taking uses one whisper stream *per utterance*: opened on speech onset,
 * closed on trailing silence so the tail window flushes and even short answers
 * ("yes") get a transcript. The reply runs fire-and-forget (not awaited in the
 * message handler) behind a single-turn guard, and TTS frames are paced to
 * real-time so a caller talking over the reply can barge in.
 *
 * The pure audio bridge (media-bridge.ts) is unit-tested; the live turn-taking
 * here needs a real carrier + public wss to verify, so its VAD/timing constants
 * are calibration knobs, not tuned values.
 *
 * Auth: Twilio doesn't token-auth the media socket, so the webhook mints a
 * short-lived single-use token into the Stream URL that we validate on connect.
 * ponytail: in-memory token store — fine for a single instance; move to Redis if
 * telephony ever runs multi-instance.
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

/** Validate + consume (single-use) a stream token. Exported for tests. */
export function consumeMediaStreamToken(token: string | null): boolean {
  if (!token) return false;
  const entry = mediaTokens.get(token);
  if (!entry || entry.expiresAt < Date.now()) return false;
  mediaTokens.delete(token);
  return true;
}

// ── Turn-taking calibration knobs (need a live call to tune) ──────────────────
const RMS_SPEAKING = 0.02; // decoded-PCM energy above which the caller is talking
const SILENCE_FRAMES = 40; // ~800 ms of 20 ms frames of trailing silence ends a turn
const MIN_SPEECH_FRAMES = 10; // ignore sub-200 ms blips
const OUT_FRAME_SAMPLES = 320; // 20 ms @ 16 kHz per outbound frame

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** TTS a reply to 16 kHz mono s16le PCM (mp3 → ffmpeg), rate-safe for the bridge. */
async function synthesizeReplyPcm16k(text: string): Promise<Int16Array | null> {
  const { MistralTTSEngine } = await import('@/voice/tts');
  // ponytail: fixed default voice; expose a voice.ttsVoice setting when callers
  // need to pick one (the /speak route already accepts a per-request voice_id).
  const voice = 'en_paul_neutral';
  let mp3: Buffer;
  try {
    mp3 = await new MistralTTSEngine(voice, { outputFormat: 'mp3' }).synthesize(text);
  } catch (err) {
    apiLogger.error({ err }, 'phone TTS synthesis failed');
    return null;
  }
  const src = join(tmpdir(), `phone-tts-${crypto.randomUUID()}.mp3`);
  const out = join(tmpdir(), `phone-tts-${crypto.randomUUID()}.pcm`);
  try {
    await writeFileAt(src, mp3);
    const ff = spawn({ cmd: ['ffmpeg', '-y', '-i', src, '-ar', '16000', '-ac', '1', '-f', 's16le', out], stderr: 'pipe' });
    await ff.exited;
    if (ff.exitCode !== 0) {
      apiLogger.error({ stderr: (await new Response(ff.stderr).text()).slice(-200) }, 'phone TTS ffmpeg failed');
      return null;
    }
    const bytes = new Uint8Array(await fileAt(out).arrayBuffer());
    return new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  } finally {
    await rm(src, { force: true });
    await rm(out, { force: true });
  }
}

interface MediaState {
  provider: string;
  streamSid?: string;
  callSid?: string;
  decoder: TwilioInboundDecoder;
  history: PhoneTurn[];
  // Per-utterance whisper stream:
  inTurn: boolean;
  turnController: ReadableStreamDefaultController<Uint8Array> | null;
  turnText: string;
  turnConsume: Promise<void> | null;
  turnInFlight: boolean; // a reply is being generated/spoken
  speaking: boolean; // sending TTS out → inbound speech should barge in
  speechFrames: number;
  silenceFrames: number;
  closed: boolean;
}

/** RMS energy of an s16le PCM byte buffer, normalized to [0,1]. */
function pcmRms(pcm: Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const n = Math.floor(pcm.byteLength / 2);
  if (!n) return 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / n);
}

/** Open a fresh whisper stream for one utterance; consume loop fills st.turnText. */
async function startTurn(st: MediaState): Promise<void> {
  st.inTurn = true;
  st.turnText = '';
  st.speechFrames = 0;
  st.silenceFrames = 0;
  const { whisperModelPath } = await import('@/voice/whisper');
  const { WhisperEngine } = await import('@/voice/stt');
  const engine = new WhisperEngine(getConfig().voice.whisperModelPath || whisperModelPath(), {
    language: getConfig().voice.language || 'en',
    streamWindowSeconds: 2,
  });
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  st.turnController = controller;
  st.turnConsume = (async () => {
    try {
      for await (const piece of engine.streamTranscribe(stream)) {
        const t = piece.trim();
        if (t) st.turnText = st.turnText ? `${st.turnText} ${t}` : t;
      }
    } catch (err) {
      apiLogger.error({ err }, 'phone media STT failed');
    }
  })();
}

/** Feed a decoded PCM frame into the active turn stream (guarded). */
function feedTurn(st: MediaState, pcm: Uint8Array): void {
  if (!st.turnController) return;
  try {
    st.turnController.enqueue(pcm);
  } catch {
    st.turnController = null; // stream already closed
  }
}

/** Close the turn stream without replying (utterance too short / aborted). */
function abortTurn(st: MediaState): void {
  st.inTurn = false;
  const c = st.turnController;
  st.turnController = null;
  try { c?.close(); } catch { /* closed */ }
  st.turnConsume = null;
  st.speechFrames = 0;
  st.silenceFrames = 0;
}

/** Close the turn stream, await the transcript, then reply (fire-and-forget). */
function finishTurn(ws: { send: (d: string) => void; close: (c?: number, r?: string) => void }, st: MediaState): void {
  st.inTurn = false;
  const controller = st.turnController;
  st.turnController = null;
  try { controller?.close(); } catch { /* closed */ }
  const consume = st.turnConsume;
  st.turnConsume = null;
  st.turnInFlight = true;
  void (async () => {
    try {
      await consume; // stream closed → whisper flushes the tail window → turnText final
      const utterance = st.turnText.trim();
      if (utterance && !st.closed) await handleTurn(ws, st, utterance);
    } finally {
      st.turnInFlight = false;
    }
  })();
}

/** Generate a reply, speak it back paced to real-time, hang up on [END_CALL]. */
async function handleTurn(
  ws: { send: (d: string) => void; close: (c?: number, r?: string) => void },
  st: MediaState,
  utterance: string,
): Promise<void> {
  let reply: string;
  let endCall = false;
  try {
    ({ text: reply, endCall } = await generatePhoneReply(utterance, st.history));
  } catch (err) {
    apiLogger.error({ err }, 'phone reply generation failed');
    return;
  }
  const pcm = await synthesizeReplyPcm16k(reply);
  if (pcm && st.streamSid && !st.closed) {
    st.speaking = true;
    st.speechFrames = 0;
    // Pace outbound to real-time so a caller talking over the reply flips
    // st.speaking (barge-in in the message handler) and this loop stops.
    for (let off = 0; off < pcm.length && st.speaking && !st.closed; off += OUT_FRAME_SAMPLES) {
      const chunk = pcm.subarray(off, off + OUT_FRAME_SAMPLES);
      ws.send(JSON.stringify({ event: 'media', streamSid: st.streamSid, media: { payload: pcm16kToTwilioMedia(chunk) } }));
      await sleep(20);
    }
    st.speaking = false;
  }
  if (endCall && !st.closed) {
    try {
      const { getTelephonyProvider } = await import('@/voice/telephony');
      const provider = await getTelephonyProvider(st.provider);
      if (provider && st.callSid) await provider.endCall(st.callSid);
    } catch (err) {
      apiLogger.warn({ err }, 'phone end-call hangup failed');
    }
    try { ws.close(1000, 'end call'); } catch { /* closed */ }
  }
}

export function setupVoiceMediaWebSocket(app: Elysia): void {
  app.ws('/voice/media/:provider', {
    open(ws) {
      const url = new URL(ws.data.request.url);
      if (!consumeMediaStreamToken(url.searchParams.get('token'))) {
        ws.close(4001, 'Invalid or expired stream token');
        return;
      }
      const provider = url.pathname.split('/').pop() || 'twilio';
      const st: MediaState = {
        provider,
        decoder: new TwilioInboundDecoder(),
        history: [],
        inTurn: false,
        turnController: null,
        turnText: '',
        turnConsume: null,
        turnInFlight: false,
        speaking: false,
        speechFrames: 0,
        silenceFrames: 0,
        closed: false,
      };
      (ws.data as { media?: MediaState }).media = st;
      apiLogger.info({ provider }, 'voice media stream opened');
    },

    async message(ws, raw) {
      const st = (ws.data as { media?: MediaState }).media;
      if (!st || st.closed) return;
      let msg: {
        event?: string;
        start?: { streamSid?: string; callSid?: string };
        media?: { track?: string; payload?: string };
        streamSid?: string;
      };
      try {
        msg = typeof raw === 'string' ? JSON.parse(raw) : (raw as typeof msg);
      } catch {
        return;
      }

      if (msg.event === 'start') {
        st.streamSid = msg.start?.streamSid || msg.streamSid;
        st.callSid = msg.start?.callSid;
        return;
      }
      if (msg.event === 'stop') {
        st.closed = true;
        abortTurn(st);
        return;
      }
      if (msg.event !== 'media' || !msg.media?.payload) return;
      if (msg.media.track && msg.media.track !== 'inbound') return; // caller only

      const pcm = st.decoder.push(msg.media.payload);
      const rms = pcmRms(pcm);

      // While the assistant is speaking, listen only for barge-in.
      if (st.speaking) {
        if (rms >= RMS_SPEAKING) {
          st.speechFrames++;
          if (st.speechFrames >= MIN_SPEECH_FRAMES) {
            st.speaking = false; // stops the paced send loop
            st.speechFrames = 0;
            if (st.streamSid) ws.send(JSON.stringify({ event: 'clear', streamSid: st.streamSid }));
          }
        } else {
          st.speechFrames = 0;
        }
        return;
      }

      // A reply is being generated (post-utterance, pre-speech) — ignore input.
      if (st.turnInFlight) return;

      // Idle: wait for speech onset to open a turn.
      if (!st.inTurn) {
        if (rms < RMS_SPEAKING) return;
        await startTurn(st);
      }

      feedTurn(st, pcm);
      if (rms >= RMS_SPEAKING) {
        st.speechFrames++;
        st.silenceFrames = 0;
      } else {
        st.silenceFrames++;
        if (st.silenceFrames >= SILENCE_FRAMES) {
          if (st.speechFrames >= MIN_SPEECH_FRAMES) finishTurn(ws, st);
          else abortTurn(st); // too short — a click, not a turn
        }
      }
    },

    close(ws) {
      const st = (ws.data as { media?: MediaState }).media;
      if (st) {
        st.closed = true;
        abortTurn(st);
      }
      apiLogger.info('voice media stream closed');
    },
  });
}
