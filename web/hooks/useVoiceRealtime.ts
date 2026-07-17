'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAuthenticatedWebSocket } from '@/lib/api';
import { stripForSpeech } from '@/lib/voice-speech';

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
  /**
   * Force a transcription engine: 'whisper' (local), 'mistral' (Voxtral cloud),
   * or 'openai'. Omit or 'auto' to let the server's `voice.sttProvider` setting
   * decide.
   */
  engine?: 'auto' | 'whisper' | 'mistral' | 'openai';
  /** True while a chat turn is in flight. On its falling edge, if still
   * 'thinking' (no reply spoken — e.g. an error), the mic is unstuck to
   * 'listening'. NOT the speak trigger; that's the page. */
  isTurnActive: boolean;
  sendTranscript: (text: string) => void;
}

// VAD tuning — same knobs as the turn hook (real mics/rooms vary).
const RMS_SPEAKING = 0.015;
// Trailing silence that ends an utterance. Short windows split a sentence on a
// thinking pause and feed its tail into the next turn. 1500 ms trades a little
// pause-tolerance for snappier turn-taking. ponytail: calibration knob — raise
// if it still cuts you off, lower if replies feel laggy.
const SILENCE_MS = 1500;
const MIN_SPEECH_MS = 350;
const MAX_TTS_CHARS = 5000;
// TTS playback speed. The voices synthesize a touch slow; 1.2× reads naturally
// with preservesPitch on (no chipmunk). ponytail: calibration knob.
const SPEECH_RATE = 1.2;
// Fallback flush when STT emits nothing after silence; > the 2 s whisper window
// so the real tail transcript (fast path) still wins in the common case.
const DISPATCH_GRACE_MS = 3500;
// Barge-in: interrupt the assistant's spoken reply when the user talks over it.
// Threshold is higher than RMS_SPEAKING and requires sustained speech, because
// the mic still hears residual TTS (browser AEC cancels most, not all) — this
// margin keeps the assistant's own voice from self-interrupting.
const RMS_BARGE_IN = 0.04;
const BARGE_IN_MS = 300;

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

export function useVoiceRealtime({ enabled, engine = 'auto', isTurnActive, sendTranscript }: UseVoiceRealtimeArgs) {
  const [state, setState] = useState<RealtimeState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(''); // live in-progress utterance text

  const stateRef = useRef<RealtimeState>('idle');
  const sendRef = useRef(sendTranscript);
  const prevTurnRef = useRef(false);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const playbackIdRef = useRef(0); // bumped to cancel in-flight TTS playback (barge-in / new turn)

  // Running transcript bookkeeping (whole session).
  const fullRef = useRef(''); // latest server full transcript
  const dispatchedLenRef = useRef(0); // how much of `full` we've already sent as turns
  const awaitingFinalRef = useRef(false); // silence detected; waiting for STT to catch up

  useEffect(() => {
    sendRef.current = sendTranscript;
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
    // Reply is spoken when the page receives the chat_response and calls speak()
    // — decoupled from turn timing, so no stale-reply reads.
    setPhase('thinking');
    sendRef.current(delta);
  }, [setPhase]);

  // Stop any in-flight TTS playback and invalidate its speak() loop. Used by
  // barge-in (user speaks over the reply) and when a new turn supersedes an old
  // one. Bumping the token makes the running speak() bail at its next check.
  const stopPlayback = useCallback(() => {
    playbackIdRef.current++;
    const a = audioElRef.current;
    if (a) {
      a.pause();
      a.src = '';
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  // Speak the reply, streaming per sentence so time-to-first-audio is one
  // sentence, not the whole reply. `/speak` is called per sentence (no new
  // endpoint). The NEXT sentence is synthesized while the current one plays, so
  // there's no synth-latency gap between sentences; at most two blob URLs are
  // alive at once and every exit path (barge-in, superseding turn, synth error)
  // drains the in-flight prefetch so nothing leaks. Barge-in or a new turn bumps
  // playbackIdRef, and every await re-checks it to bail promptly.
  const speak = useCallback(
    async (text: string) => {
      const myId = ++playbackIdRef.current;
      setPhase('speaking');
      const clipped = stripForSpeech(text).slice(0, MAX_TTS_CHARS);
      if (!clipped) {
        setPhase('listening');
        return;
      }
      const sentences = clipped.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) || [clipped];
      const audio = audioElRef.current ?? new Audio();
      audioElRef.current = audio;

      const synth = async (sentence: string): Promise<string | null> => {
        const res = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sentence }),
          credentials: 'include',
        });
        if (!res.ok) {
          if (res.status === 503) setError('Voice replies are off — enable a TTS provider in settings.');
          return null; // caller stops the reply rather than POSTing every sentence
        }
        const buf = await res.arrayBuffer();
        const type = res.headers.get('Content-Type') || 'audio/mpeg';
        return URL.createObjectURL(new Blob([buf], { type }));
      };

      // Resolves true if the clip played to completion, false on autoplay block /
      // decode error (caller then stops rather than silently churning sentences).
      const play = (url: string) =>
        new Promise<boolean>((resolve) => {
          audioUrlRef.current = url;
          audio.src = url;
          audio.playbackRate = SPEECH_RATE; // preservesPitch defaults true → no pitch shift
          audio.onended = () => resolve(true);
          audio.onerror = () => resolve(false);
          void audio.play().then(undefined, () => resolve(false));
        });

      // Prefetch pipeline: hold the next sentence's synth in flight while the
      // current one plays. `pending` is always the not-yet-played clip.
      let pending = synth(sentences[0]).catch(() => null);
      const drain = async () => { const u = await pending; if (u) URL.revokeObjectURL(u); };
      try {
        for (let i = 0; i < sentences.length; i++) {
          const url = await pending;
          // Kick off the next synth now, so it overlaps this sentence's playback.
          pending = i + 1 < sentences.length ? synth(sentences[i + 1]).catch(() => null) : Promise.resolve(null);
          if (playbackIdRef.current !== myId) {
            if (url) URL.revokeObjectURL(url); // cancelled between synth and play
            await drain();
            return;
          }
          if (!url) break; // synth failed (503/error) — stop, don't hammer /speak
          const ok = await play(url);
          if (playbackIdRef.current !== myId) { await drain(); return; } // barged
          URL.revokeObjectURL(url); // done with this clip — revoke immediately
          if (audioUrlRef.current === url) audioUrlRef.current = null;
          if (!ok) break; // autoplay blocked / decode error — stop the reply
        }
        await drain(); // revoke any prefetched-but-unplayed clip
      } finally {
        // Only advance if we're still the active playback (not barged/superseded).
        if (playbackIdRef.current === myId && stateRef.current === 'speaking') setPhase('listening');
      }
    },
    [setPhase],
  );

  // Safety net: unstick from 'thinking' on a turn that ends without a spoken
  // reply (chat_error / empty response). speak() moves us to 'speaking' first,
  // so this only fires when nothing was spoken.
  useEffect(() => {
    const was = prevTurnRef.current;
    prevTurnRef.current = isTurnActive;
    if (was && !isTurnActive && stateRef.current === 'thinking') setPhase('listening');
  }, [isTurnActive, setPhase]);

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
    let bargeStart = 0; // when sustained over-talk began during playback
    // Pre-roll: while not listening, keep the last ~0.5 s of mic frames so a
    // barge-in doesn't lose its opening words (they're spoken before the state
    // flips to listening). Flushed to STT on barge-in.
    const PREROLL_MAX_BYTES = 16000; // ~0.5 s of 16 kHz s16le
    let preRoll: ArrayBuffer[] = [];
    let preRollBytes = 0;

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
      } else if (stateRef.current === 'speaking') {
        // Barge-in: sustained over-talk interrupts the reply and reopens the mic.
        if (rms >= RMS_BARGE_IN) {
          if (!bargeStart) bargeStart = now;
          if (now - bargeStart >= BARGE_IN_MS) {
            bargeStart = 0;
            hadSpeech = false; // let the new utterance segment cleanly
            stopPlayback();
            setPhase('listening');
            // Flush the pre-roll so the interruption's opening words (spoken
            // during 'speaking', before this flip) actually reach STT.
            if (ws?.readyState === WebSocket.OPEN) for (const b of preRoll) ws.send(b);
            preRoll = [];
            preRollBytes = 0;
          }
        } else {
          bargeStart = 0;
        }
      } else {
        bargeStart = 0;
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
        // echoCancellation lets barge-in work — the browser AEC subtracts the
        // assistant's own TTS playback from the mic so it can't self-interrupt.
        const s = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        mediaStream = s;
        setError(null);
        setPhase('connecting');

        // WebSocket first, so we're ready to stream the moment speech starts.
        ws = await createAuthenticatedWebSocket('/voice', engine && engine !== 'auto' ? { engine } : undefined);
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
              if (awaitingFinalRef.current && stateRef.current === 'listening') {
                dispatchUtterance();
              } else if (delta && stateRef.current === 'listening' && !hadSpeech && !awaitingSince) {
                // Orphaned STT tail: whisper's last 2 s window landed AFTER we
                // dispatched and the user has gone silent, so no speech→silence
                // transition follows to flush it — it would hang in `partial`
                // forever. Arm the same grace timer the silence path uses so the
                // tail flushes as its own turn instead of stalling.
                awaitingFinalRef.current = true;
                awaitingSince = performance.now();
              }
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
          const frame = e.data as ArrayBuffer;
          // Stream frames only while listening (half-duplex). While not
          // listening, keep a short pre-roll so barge-in can recover its opening
          // words (see the barge-in flush in tick).
          if (stateRef.current === 'listening') {
            if (ws?.readyState === WebSocket.OPEN) ws.send(frame);
          } else {
            preRoll.push(frame);
            preRollBytes += frame.byteLength;
            while (preRollBytes > PREROLL_MAX_BYTES && preRoll.length) {
              preRollBytes -= preRoll.shift()!.byteLength;
            }
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
      stopPlayback(); // pause audio, revoke url, and bail any in-flight speak() loop
      ctx?.close().catch(() => {});
      mediaStream?.getTracks().forEach((t) => t.stop());
      fullRef.current = '';
      dispatchedLenRef.current = 0;
      awaitingFinalRef.current = false;
      setPartial('');
      setPhase('idle');
    };
  }, [enabled, engine, setPhase, dispatchUtterance, stopPlayback]);

  return { state, error, partial, speak };
}
