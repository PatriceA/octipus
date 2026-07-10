'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

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
          body: JSON.stringify({ text: text.slice(0, MAX_TTS_CHARS) }),
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
        const url = URL.createObjectURL(new Blob([arrayBuf], { type }));
        const audio = audioElRef.current ?? new Audio();
        audioElRef.current = audio;
        audio.src = url;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          if (stateRef.current === 'speaking') setPhase('listening');
        };
        await audio.play().catch(() => {
          // Autoplay blocked or decode error — don't wedge the loop.
          URL.revokeObjectURL(url);
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
        const base64 = await blobToBase64(blob);
        const format = (mimeType.split('/')[1] || 'webm').split(';')[0];
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
      if (cancelled || !analyser) return;
      const buf = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(buf);
      let sumSq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSq += v * v;
      }
      const rms = Math.sqrt(sumSq / buf.length);
      const now = performance.now();

      // Only segment while listening (half-duplex: never during thinking/
      // speaking, so the assistant's own audio can't self-trigger a turn).
      if (stateRef.current === 'listening') {
        const recording = recorder?.state === 'recording';
        if (rms >= RMS_SPEAKING) {
          lastVoice = now;
          if (!recording) beginUtterance();
        } else if (recording && (now - lastVoice >= SILENCE_MS || now - uttStart >= MAX_UTTERANCE_MS)) {
          recorder?.stop(); // → finishUtterance
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
      ctx?.close().catch(() => {});
      mediaStream?.getTracks().forEach((t) => t.stop());
      setStream(null);
      pendingSpeakRef.current = false;
      setPhase('idle');
    };
  }, [enabled, setPhase]);

  return { state, error, stream };
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
