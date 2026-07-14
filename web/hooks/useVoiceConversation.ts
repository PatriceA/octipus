'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { stripForSpeech } from '@/lib/voice-speech';

/**
 * Turn-based (half-duplex) voice conversation loop for the web chat.
 *
 * mic → VAD-segmented utterance → /voice/transcribe (local whisper.cpp by
 * default) → sendTranscript() → [the normal chat turn runs, agents spawn as in
 * text] → on turn completion, /voice/speak the reply → play → listen again.
 *
 * It deliberately reuses the existing chat pipeline: sendTranscript is the same
 * sendMessage the text composer calls, so classification, memory and background
 * agents come free. No streaming STT, no barge-in — those are the Phase 4
 * realtime upgrade. The capture machinery lives inside one effect (local
 * closures) so the VAD loop can self-schedule and setState only ever fires from
 * async callbacks, matching the repo's hook conventions.
 */

export type VoiceState =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'error';

interface UseVoiceConversationArgs {
  enabled: boolean;
  /** True while a chat turn is in flight (chat page `isLoading`). */
  isTurnActive: boolean;
  /** Latest assistant reply text, read on the turn's falling edge to be spoken. */
  getAssistantReply: () => string | null;
  /** Feed a transcript into the normal chat turn (i.e. sendMessage). */
  sendTranscript: (text: string) => void;
}

// ── VAD tuning (calibration knobs — real mics/rooms vary) ────────────────────
// ponytail: RMS threshold + silence timeout, no VAD library. The AudioContext
// analyser is the same one audio-waveform.tsx already mounts. Tune per feedback.
const RMS_SPEAKING = 0.015; // above this = speech present
const SILENCE_MS = 900; // trailing silence that ends an utterance
const MIN_UTTERANCE_MS = 350; // ignore lip-smacks / clicks shorter than this
const MAX_UTTERANCE_MS = 30_000; // hard cap on a single utterance
const MAX_TTS_CHARS = 5000; // matches the /speak route's cap

export function useVoiceConversation({
  enabled,
  isTurnActive,
  getAssistantReply,
  sendTranscript,
}: UseVoiceConversationArgs) {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);

  const stateRef = useRef<VoiceState>('idle');
  const sendRef = useRef(sendTranscript);
  const replyRef = useRef(getAssistantReply);
  const pendingSpeakRef = useRef(false); // a voice turn is awaiting its reply
  const prevTurnRef = useRef(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null); // current TTS blob URL, for cleanup

  // Keep the latest page callbacks reachable from the capture closures without
  // re-running the mic effect (ref writes in an effect, never during render).
  useEffect(() => {
    sendRef.current = sendTranscript;
    replyRef.current = getAssistantReply;
  });

  const setPhase = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  const speak = useCallback(
    async (text: string) => {
      setPhase('speaking');
      try {
        const res = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: stripForSpeech(text).slice(0, MAX_TTS_CHARS) }),
          credentials: 'include',
        });
        if (!res.ok) {
          // TTS disabled (503) or misconfigured (500): degrade to text-only and
          // keep the loop alive — the "cloud default, piper opt-in" path when no
          // TTS provider/key is set up.
          if (res.status === 503) setError('Voice replies are off — enable a TTS provider in settings.');
          setPhase('listening');
          return;
        }
        const arrayBuf = await res.arrayBuffer();
        const type = res.headers.get('Content-Type') || 'audio/mpeg';
        // Revoke any prior clip before replacing it; the teardown effect revokes
        // whatever is current, so an interrupted reply can't leak its URL.
        const revoke = () => {
          if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
          audioUrlRef.current = null;
        };
        revoke();
        const url = URL.createObjectURL(new Blob([arrayBuf], { type }));
        audioUrlRef.current = url;
        const audio = audioElRef.current ?? new Audio();
        audioElRef.current = audio;
        audio.src = url;
        audio.onended = () => {
          revoke();
          if (stateRef.current === 'speaking') setPhase('listening');
        };
        await audio.play().catch(() => {
          // Autoplay blocked or decode error — don't wedge the loop.
          revoke();
          setPhase('listening');
        });
      } catch (err) {
        console.error('Voice synthesis failed:', err);
        setPhase('listening');
      }
    },
    [setPhase],
  );

  // Speak the assistant reply on the chat turn's falling edge. setState is
  // deferred to a microtask so it doesn't fire synchronously inside the effect.
  useEffect(() => {
    const was = prevTurnRef.current;
    prevTurnRef.current = isTurnActive;
    if (was && !isTurnActive && pendingSpeakRef.current) {
      pendingSpeakRef.current = false;
      const reply = replyRef.current();
      if (reply && reply.trim()) queueMicrotask(() => void speak(reply));
      else queueMicrotask(() => setPhase('listening'));
    }
  }, [isTurnActive, speak, setPhase]);

  // ── Mic + VAD lifecycle ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let mediaStream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let analyser: AnalyserNode | null = null;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let raf: number | null = null;
    let uttStart = 0;
    let lastVoice = 0;
    let vadBuf: Uint8Array<ArrayBuffer> | null = null; // reused per frame — no per-tick alloc

    const finishUtterance = async (mimeType: string) => {
      const captured = chunks;
      chunks = [];
      recorder = null;
      if (captured.length === 0 || performance.now() - uttStart < MIN_UTTERANCE_MS) {
        if (stateRef.current !== 'speaking') setPhase('listening');
        return;
      }
      setPhase('transcribing');
      try {
        const blob = new Blob(captured, { type: mimeType || 'audio/webm' });
        // Encode 16 kHz mono WAV in the browser (native decode+resample) so the
        // host needs no ffmpeg for whisper. Fall back to the raw container if
        // decoding fails — the server can still ffmpeg-convert it.
        let audioBlob = blob;
        let format = 'wav';
        try {
          audioBlob = await encodeWav16kMono(blob);
        } catch {
          format = (mimeType.split('/')[1] || 'webm').split(';')[0];
        }
        const base64 = await blobToBase64(audioBlob);
        // No `model` field → backend defaults to local whisper.cpp (local-first).
        const res = await fetch('/api/voice/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64, format }),
          credentials: 'include',
        });
        const data = await res.json();
        if (cancelled) return;
        const text = (data?.text || '').trim();
        if (text) {
          setError(null);
          pendingSpeakRef.current = true;
          setPhase('thinking');
          sendRef.current(text);
        } else {
          // Surface a real failure (e.g. STT misconfigured) rather than looping
          // silently; an empty result with no error just means nothing was said.
          if (data?.error) setError(`Transcription failed: ${data.error}`);
          setPhase('listening');
        }
      } catch (err) {
        console.error('Voice transcription failed:', err);
        if (!cancelled) setPhase('listening');
      }
    };

    const beginUtterance = () => {
      if (!mediaStream) return;
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/ogg')
          ? 'audio/ogg'
          : '';
      recorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream);
      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => void finishUtterance(mimeType);
      recorder.start();
      uttStart = performance.now();
      lastVoice = performance.now();
    };

    const tick = () => {
      if (cancelled || !analyser || !vadBuf) return;
      analyser.getByteTimeDomainData(vadBuf);
      let sumSq = 0;
      for (let i = 0; i < vadBuf.length; i++) {
        const v = (vadBuf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / vadBuf.length);
      const now = performance.now();

      // Only segment while listening (half-duplex: never during thinking/
      // speaking, so the assistant's own audio can't self-trigger a turn).
      if (stateRef.current === 'listening') {
        const recording = recorder?.state === 'recording';
        if (rms >= RMS_SPEAKING) {
          lastVoice = now;
          if (!recording) beginUtterance();
        } else if (recording && (now - lastVoice >= SILENCE_MS || now - uttStart >= MAX_UTTERANCE_MS)) {
          // Flip out of 'listening' synchronously so the next frame can't start a
          // fresh recorder in the gap before the async onstop → finishUtterance.
          setPhase('transcribing');
          recorder?.stop();
        }
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        mediaStream = s;
        setStream(s);
        setError(null);
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new AudioCtx();
        const src = ctx.createMediaStreamSource(s);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        vadBuf = new Uint8Array(analyser.fftSize);
        src.connect(analyser);
        setPhase('listening');
        raf = requestAnimationFrame(tick);
      } catch (err) {
        console.error('Microphone access failed:', err);
        if (!cancelled) {
          setError('Microphone access denied. Check browser permissions.');
          setPhase('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (raf != null) cancelAnimationFrame(raf);
      try {
        if (recorder?.state === 'recording') recorder.stop();
      } catch {
        /* already stopped */
      }
      recorder = null;
      if (audioElRef.current) {
        audioElRef.current.pause();
        audioElRef.current.src = '';
      }
      // Revoke a clip interrupted mid-playback — onended won't fire after this.
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
      ctx?.close().catch(() => {});
      mediaStream?.getTracks().forEach((t) => t.stop());
      setStream(null);
      pendingSpeakRef.current = false;
      setPhase('idle');
    };
  }, [enabled, setPhase]);

  return { state, error, stream };
}

/**
 * Decode recorded audio and re-encode it as 16 kHz mono 16-bit PCM WAV — exactly
 * what whisper.cpp wants — using native Web Audio (no library, no host ffmpeg).
 */
async function encodeWav16kMono(blob: Blob): Promise<Blob> {
  const arrayBuf = await blob.arrayBuffer();
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const decodeCtx = new AudioCtx();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf);
  } finally {
    void decodeCtx.close();
  }
  const rate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * rate));
  const offline = new OfflineAudioContext(1, frames, rate); // 1 ch → downmix to mono
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return pcmToWav(rendered.getChannelData(0), rate);
}

/** Float32 PCM → 16-bit mono WAV blob (44-byte RIFF header + samples). */
function pcmToWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1)); // strip data: URI prefix
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
