'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAuthenticatedWebSocket } from '@/lib/api';

/**
 * Realtime (streaming) voice loop for web chat — the Phase 4b upgrade over the
 * turn-based useVoiceConversation hook.
 *
 * Instead of record-an-utterance → POST /transcribe, it holds one WebSocket to
 * `/voice` open for the whole session and streams 16 kHz mono s16le PCM frames
 * off an AudioWorklet. The server runs streaming STT (local whisper by default,
 * Mistral when engine='mistral') and pushes back a *running full transcript*.
 *
 * Utterance segmentation is client-side: the same RMS VAD as the turn hook marks
 * end-of-utterance on trailing silence; at that point the transcript delta since
 * the last dispatch is fed into the normal chat turn (sendTranscript = the text
 * composer's sendMessage), so spawn-vs-answer, memory and background agents come
 * free — exactly as for typed input.
 *
 * Half-duplex: PCM frames stream only while `listening`, so the assistant's own
 * spoken reply can't be picked up and transcribed. Barge-in is Phase 4c.
 *
 * ponytail: playback (speak) intentionally mirrors useVoiceConversation rather
 * than sharing code — keeping the working Phase 1 hook untouched. Converge into
 * one tts-playback helper when 4c refactors both.
 */

export type RealtimeState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

interface UseVoiceRealtimeArgs {
  enabled: boolean;
  /** 'whisper' (local, default) or 'mistral' (cloud low-latency, needs key). */
  engine?: 'whisper' | 'mistral';
  isTurnActive: boolean;
  getAssistantReply: () => string | null;
  sendTranscript: (text: string) => void;
}

// VAD tuning — same knobs as the turn hook (real mics/rooms vary).
const RMS_SPEAKING = 0.015;
const SILENCE_MS = 900;
const MIN_SPEECH_MS = 350;
const MAX_TTS_CHARS = 5000;
// Fallback flush when STT emits nothing after silence; > the 2 s whisper window
// so the real tail transcript (fast path) still wins in the common case.
const DISPATCH_GRACE_MS = 3500;

// AudioWorklet processor: native-rate Float32 frames → Int16 PCM, posted to the
// main thread. The AudioContext is forced to 16 kHz, so the browser resamples
// the mic for us and no client-side resampler is needed (that's the server's job
// for telephony). Loaded from an inline Blob URL — no public asset, no build step.
const WORKLET_CODE = `
class PCMWorklet extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const pcm = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-worklet', PCMWorklet);
`;

export function useVoiceRealtime({
  enabled,
  engine = 'whisper',
  isTurnActive,
  getAssistantReply,
  sendTranscript,
}: UseVoiceRealtimeArgs) {
  const [state, setState] = useState<RealtimeState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(''); // live in-progress utterance text

  const stateRef = useRef<RealtimeState>('idle');
  const sendRef = useRef(sendTranscript);
  const replyRef = useRef(getAssistantReply);
  const pendingSpeakRef = useRef(false);
  const prevTurnRef = useRef(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  // Running transcript bookkeeping (whole session).
  const fullRef = useRef(''); // latest server full transcript
  const dispatchedLenRef = useRef(0); // how much of `full` we've already sent as turns
  const awaitingFinalRef = useRef(false); // silence detected; waiting for STT to catch up

  useEffect(() => {
    sendRef.current = sendTranscript;
    replyRef.current = getAssistantReply;
  });

  const setPhase = useCallback((s: RealtimeState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  // Dispatch the transcript delta since the last utterance as a chat turn.
  const dispatchUtterance = useCallback(() => {
    const delta = fullRef.current.slice(dispatchedLenRef.current).trim();
    awaitingFinalRef.current = false;
    if (!delta) {
      setPhase('listening');
      return;
    }
    dispatchedLenRef.current = fullRef.current.length;
    setPartial('');
    setError(null);
    pendingSpeakRef.current = true;
    setPhase('thinking');
    sendRef.current(delta);
  }, [setPhase]);

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
          if (res.status === 503) setError('Voice replies are off — enable a TTS provider in settings.');
          setPhase('listening');
          return;
        }
        const arrayBuf = await res.arrayBuffer();
        const type = res.headers.get('Content-Type') || 'audio/mpeg';
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

  // Speak the reply on the chat turn's falling edge (same pattern as turn hook).
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

  // ── Mic + worklet + WS lifecycle ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let mediaStream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let ws: WebSocket | null = null;
    let raf: number | null = null;
    let analyser: AnalyserNode | null = null;
    let vadBuf: Uint8Array<ArrayBuffer> | null = null;
    let speechStart = 0;
    let lastVoice = 0;
    let hadSpeech = false;
    let awaitingSince = 0; // when trailing silence began waiting for the STT tail

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

      if (stateRef.current === 'listening') {
        if (rms >= RMS_SPEAKING) {
          if (!hadSpeech) speechStart = now;
          hadSpeech = true;
          lastVoice = now;
          awaitingFinalRef.current = false;
          awaitingSince = 0;
        } else if (hadSpeech && now - lastVoice >= SILENCE_MS) {
          // End of utterance — but only if it was long enough to be real speech.
          if (now - speechStart >= MIN_SPEECH_MS) {
            hadSpeech = false;
            awaitingFinalRef.current = true; // wait for STT to emit the tail
            awaitingSince = now;
          } else {
            hadSpeech = false; // too short — a click; ignore
          }
        }
        // Fast path is ws.onmessage (dispatch as soon as the tail transcript
        // lands). Fallback: if STT emits nothing after silence (Mistral goes
        // quiet, or a whisper window never updates), flush anyway so the turn
        // can't hang. Grace > the 2 s whisper window so we don't cut the tail.
        if (awaitingFinalRef.current && awaitingSince && now - awaitingSince >= DISPATCH_GRACE_MS) {
          awaitingSince = 0;
          dispatchUtterance();
        }
      }
      raf = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        // 16 kHz context → browser resamples the mic; worklet gets 16 kHz frames.
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        ctx = new AudioCtx({ sampleRate: 16000 });
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        mediaStream = s;
        setError(null);
        setPhase('connecting');

        // WebSocket first, so we're ready to stream the moment speech starts.
        ws = await createAuthenticatedWebSocket('/voice', engine === 'mistral' ? { engine } : undefined);
        ws.binaryType = 'arraybuffer';
        ws.onmessage = (e) => {
          if (cancelled) return;
          try {
            const msg = JSON.parse(typeof e.data === 'string' ? e.data : '') as {
              type: string;
              text?: string;
              message?: string;
            };
            if (msg.type === 'transcript') {
              fullRef.current = msg.text || '';
              // Show the in-progress delta live.
              const delta = fullRef.current.slice(dispatchedLenRef.current).trim();
              if (stateRef.current === 'listening' || stateRef.current === 'connecting') setPartial(delta);
              // If we're waiting on the STT tail after silence, dispatch now.
              if (awaitingFinalRef.current && stateRef.current === 'listening') dispatchUtterance();
            } else if (msg.type === 'error') {
              setError(msg.message || 'Voice stream error');
            }
          } catch {
            /* non-JSON frame — ignore */
          }
        };
        ws.onerror = () => {
          if (!cancelled) setError('Voice connection failed.');
        };
        ws.onclose = (e) => {
          // Server-initiated close (STT ended/errored, token expired, no engine).
          // Without this the mic would keep capturing into a dead socket forever.
          if (cancelled || stateRef.current === 'idle') return;
          setError((prev) => prev ?? (e.reason || 'Voice connection closed.'));
          setPhase('error');
        };
        await new Promise<void>((resolve, reject) => {
          if (!ws) return reject(new Error('no socket'));
          if (ws.readyState === WebSocket.OPEN) return resolve();
          ws.addEventListener('open', () => resolve(), { once: true });
          ws.addEventListener('error', () => reject(new Error('ws failed to open')), { once: true });
        });
        if (cancelled) return;

        // Worklet capture.
        const workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
        try {
          await ctx.audioWorklet.addModule(workletUrl);
        } finally {
          URL.revokeObjectURL(workletUrl);
        }
        if (cancelled) return;
        const src = ctx.createMediaStreamSource(s);
        const node = new AudioWorkletNode(ctx, 'pcm-worklet');
        node.port.onmessage = (e) => {
          // Stream frames only while listening (half-duplex).
          if (ws?.readyState === WebSocket.OPEN && stateRef.current === 'listening') {
            ws.send(e.data as ArrayBuffer);
          }
        };
        src.connect(node);
        // Worklet needs a sink to pull audio through it, but we don't want to hear
        // the mic — route through a muted gain node to the destination.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);

        // VAD analyser off the same source.
        analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        vadBuf = new Uint8Array(analyser.fftSize);
        src.connect(analyser);

        setPhase('listening');
        raf = requestAnimationFrame(tick);
      } catch (err) {
        console.error('Realtime voice init failed:', err);
        // Release the mic/socket/context we may have already acquired — the effect
        // cleanup won't run while `enabled` stays true, so a failure here would
        // otherwise leave the mic hot and the socket half-open.
        try {
          ws?.close();
        } catch {
          /* not open */
        }
        mediaStream?.getTracks().forEach((t) => t.stop());
        ctx?.close().catch(() => {});
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Microphone or connection failed.');
          setPhase('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (raf != null) cancelAnimationFrame(raf);
      try {
        if (ws) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
          // close() unconditionally — valid on CONNECTING too (aborts the
          // handshake), so a rapid on/off can't leak a socket + server STT session.
          ws.close();
        }
      } catch {
        /* already closed */
      }
      if (audioElRef.current) {
        audioElRef.current.pause();
        audioElRef.current.src = '';
      }
      if (audioUrlRef.current) {
        URL.revokeObjectURL(audioUrlRef.current);
        audioUrlRef.current = null;
      }
      ctx?.close().catch(() => {});
      mediaStream?.getTracks().forEach((t) => t.stop());
      fullRef.current = '';
      dispatchedLenRef.current = 0;
      awaitingFinalRef.current = false;
      pendingSpeakRef.current = false;
      setPartial('');
      setPhase('idle');
    };
  }, [enabled, engine, setPhase, dispatchUtterance]);

  return { state, error, partial };
}
