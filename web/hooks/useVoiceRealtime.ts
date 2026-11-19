'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAuthenticatedWebSocket } from '@/lib/api';
import type { VoiceClientMessage, VoiceServerMessage } from '@/lib/types/voice';

/**
 * The browser's end of a live voice conversation (docs/VOICE.md → One
 * pipeline). It is a transport: the microphone goes up the `/voice` socket
 * in conversation mode as 16 kHz PCM, all the time, and the audio that comes
 * back is played. Where a turn ends, what is said aloud and when talking over
 * a reply stops it are decided on the server (src/voice/session.ts), the same
 * for every client.
 *
 * What the server hears as a finished turn arrives as `utterance`; the page
 * sends it as the chat message (`chat.send` with `spoken: true`), so the turn
 * runs exactly like a typed one. The reply's speech then arrives here as PCM
 * frames. Nothing is synthesised in the browser.
 */

export type RealtimeState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking';

interface UseVoiceRealtimeArgs {
  enabled: boolean;
  /** The chat whose replies are spoken. The socket is opened for it, and reopened when it changes. */
  sessionId: string | null;
  /** True while a chat turn is in flight. On its falling edge a turn that was not spoken (an error, no speech engine) goes back to listening. */
  isTurnActive: boolean;
  /** A finished turn, as text: the page sends it as the chat message. */
  onUtterance: (text: string) => void;
}

/** Started this far ahead when nothing is queued, so the next frame's arrival jitter is not heard as a gap. */
const PLAYBACK_LEAD_S = 0.08;
/** A dropped connection is reopened once; a second drop within this long ends the conversation instead of looping. */
const RECONNECT_ONCE_PER_MS = 30_000;
/** Close codes the server uses to refuse: signing in again or choosing an engine fixes them, a retry does not. */
const REFUSED = new Set([4001, 4002]);

// AudioWorklet processor: Float32 frames → Int16 PCM, posted to the main
// thread. The capture AudioContext runs at 16 kHz, so the browser resamples
// the microphone. Loaded from an inline Blob URL: no public asset.
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

type AudioHeader = Extract<VoiceServerMessage, { type: 'audio' }>;

function newAudioContext(sampleRate?: number): AudioContext {
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new Ctor(sampleRate ? { sampleRate } : undefined);
}

export function useVoiceRealtime({ enabled, sessionId, isTurnActive, onUtterance }: UseVoiceRealtimeArgs) {
  const [state, setState] = useState<RealtimeState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState('');
  /** Whether replies are spoken (`ready.speak`); null until the server has said. */
  const [speaks, setSpeaks] = useState<boolean | null>(null);

  const stateRef = useRef<RealtimeState>('idle');
  const onUtteranceRef = useRef(onUtterance);
  const prevTurnRef = useRef(false);
  const interruptRef = useRef<() => void>(() => {});

  useEffect(() => {
    onUtteranceRef.current = onUtterance;
  });

  const setPhase = useCallback((next: RealtimeState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // A turn that ended without being spoken (it failed, or there is no speech
  // engine): back to listening. A spoken reply has moved on to 'speaking'.
  useEffect(() => {
    const was = prevTurnRef.current;
    prevTurnRef.current = isTurnActive;
    if (was && !isTurnActive && stateRef.current === 'thinking') setPhase('listening');
  }, [isTurnActive, setPhase]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const session = sessionId;
    let cancelled = false;
    let released = false;
    let mediaStream: MediaStream | null = null;
    let captureCtx: AudioContext | null = null;
    let playCtx: AudioContext | null = null;
    let ws: WebSocket | null = null;
    let lastReconnectAt = 0;

    // Playback: frames are scheduled back to back on the playback context.
    const sources = new Set<AudioBufferSourceNode>();
    let nextStart = 0;
    let pendingAudio: AudioHeader | null = null;
    /** The server is still sending this reply (`speaking` on). */
    let serverSpeaking = false;
    /** After a tap on stop: frames already on their way are dropped until the server confirms it stopped. */
    let dropUntilQuiet = false;
    /** WAV clips decode asynchronously; this keeps them in the order they arrived. */
    let decoding: Promise<void> = Promise.resolve();

    const send = (message: VoiceClientMessage) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    const stopPlayback = () => {
      for (const source of sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {
          /* not started yet: disconnecting it below is enough */
        }
        source.disconnect();
      }
      sources.clear();
      nextStart = 0;
      pendingAudio = null;
    };

    const release = () => {
      if (released) return;
      released = true;
      stopPlayback();
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.onmessage = null;
        try {
          send({ type: 'stop' });
          // close() is valid while still connecting (it aborts the handshake).
          ws.close();
        } catch {
          /* already closed */
        }
      }
      mediaStream?.getTracks().forEach((track) => track.stop());
      void captureCtx?.close().catch(() => {});
      void playCtx?.close().catch(() => {});
    };

    /** The conversation cannot go on: say why, and let go of the microphone. */
    const fail = (message: string) => {
      if (cancelled) return;
      release();
      setError((previous) => previous ?? message);
      setPartial('');
      setPhase('idle');
    };

    const playbackContext = (sampleRate: number): AudioContext => {
      if (playCtx && playCtx.sampleRate === sampleRate) return playCtx;
      if (playCtx) {
        stopPlayback();
        void playCtx.close().catch(() => {});
      }
      try {
        // At the audio's own rate nothing is resampled frame by frame, so
        // consecutive frames join sample-exactly.
        playCtx = newAudioContext(sampleRate);
      } catch {
        // A rate this browser's output cannot run at: its default, resampled per frame.
        playCtx = newAudioContext();
      }
      return playCtx;
    };

    const onDrained = () => {
      // Lets the server stop treating the microphone as over-talk early.
      send({ type: 'playback', state: 'ended' });
      if (!serverSpeaking && stateRef.current === 'speaking') setPhase('listening');
    };

    const schedule = (ctx: AudioContext, buffer: AudioBuffer) => {
      if (ctx !== playCtx || released) return;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      const now = ctx.currentTime;
      const at = nextStart > now ? nextStart : now + PLAYBACK_LEAD_S;
      source.start(at);
      nextStart = at + buffer.duration;
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        source.disconnect();
        if (sources.size === 0) onDrained();
      };
      if (stateRef.current !== 'speaking') setPhase('speaking');
    };

    const play = (header: AudioHeader, data: ArrayBuffer) => {
      if (dropUntilQuiet) return;
      const ctx = playbackContext(header.sampleRate);
      if (header.format === 'pcm') {
        const pcm = new Int16Array(data, 0, data.byteLength >> 1);
        if (pcm.length === 0) return;
        const buffer = ctx.createBuffer(1, pcm.length, header.sampleRate);
        const channel = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
        schedule(ctx, buffer);
        return;
      }
      decoding = decoding
        .then(() => ctx.decodeAudioData(data))
        .then((buffer) => {
          if (!dropUntilQuiet) schedule(ctx, buffer);
        })
        .catch((err: unknown) => {
          if (!cancelled) setError(`A spoken reply could not be played: ${err instanceof Error ? err.message : String(err)}`);
        });
    };

    const onMessage = (event: MessageEvent) => {
      if (cancelled) return;
      if (typeof event.data !== 'string') {
        const header = pendingAudio;
        pendingAudio = null;
        if (header && event.data instanceof ArrayBuffer) play(header, event.data);
        return;
      }
      let message: VoiceServerMessage;
      try {
        message = JSON.parse(event.data) as VoiceServerMessage;
      } catch {
        setError('The voice connection sent something this page does not understand.');
        return;
      }
      switch (message.type) {
        case 'ready':
          setSpeaks(message.speak);
          if (stateRef.current === 'connecting') setPhase('listening');
          break;
        case 'speech_start':
          setError(null);
          setPartial('');
          break;
        case 'transcript':
          setPartial(message.text);
          break;
        case 'utterance':
          setPartial('');
          setError(null);
          setPhase('thinking');
          onUtteranceRef.current(message.text);
          break;
        case 'audio':
          pendingAudio = message;
          break;
        case 'speaking':
          serverSpeaking = message.on;
          if (message.on) {
            if (!dropUntilQuiet) setPhase('speaking');
          } else {
            dropUntilQuiet = false;
            if (sources.size === 0 && stateRef.current === 'speaking') setPhase('listening');
          }
          break;
        case 'barge_in':
          // The person talked over the reply: nothing of it is played any more.
          stopPlayback();
          setPhase('listening');
          break;
        case 'error':
          setError(message.message);
          break;
      }
    };

    const connect = async () => {
      const socket = await createAuthenticatedWebSocket('/voice', { mode: 'conversation', session });
      if (cancelled || released) {
        socket.close();
        return;
      }
      ws = socket;
      socket.binaryType = 'arraybuffer';
      socket.onmessage = onMessage;
      socket.onclose = (event) => {
        if (cancelled || released || ws !== socket) return;
        stopPlayback();
        serverSpeaking = false;
        dropUntilQuiet = false;
        const why = event.reason || 'The voice connection closed.';
        if (REFUSED.has(event.code) || Date.now() - lastReconnectAt < RECONNECT_ONCE_PER_MS) {
          fail(why);
          return;
        }
        lastReconnectAt = Date.now();
        setPartial('');
        setPhase('connecting');
        connect().catch((err: unknown) => fail(err instanceof Error ? err.message : why));
      };
    };

    interruptRef.current = () => {
      if (released) return;
      dropUntilQuiet = serverSpeaking;
      send({ type: 'interrupt' });
      stopPlayback();
      if (stateRef.current === 'speaking') setPhase('listening');
    };

    (async () => {
      try {
        setError(null);
        setSpeaks(null);
        setPhase('connecting');
        // 16 kHz context: the browser resamples the microphone for the worklet.
        captureCtx = newAudioContext(16000);
        // Echo cancellation keeps the reply being played out of the microphone:
        // frames go up while it plays, and the server listens for over-talk.
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        mediaStream = stream;

        await connect();
        if (cancelled) return;

        const workletUrl = URL.createObjectURL(new Blob([WORKLET_CODE], { type: 'application/javascript' }));
        try {
          await captureCtx.audioWorklet.addModule(workletUrl);
        } finally {
          URL.revokeObjectURL(workletUrl);
        }
        if (cancelled || released) return;
        const source = captureCtx.createMediaStreamSource(stream);
        const node = new AudioWorkletNode(captureCtx, 'pcm-worklet');
        node.port.onmessage = (event) => {
          // Continuously, also while a reply plays. Frames from before the
          // socket is open (or while it reconnects) are not kept.
          if (ws?.readyState === WebSocket.OPEN) ws.send(event.data as ArrayBuffer);
        };
        source.connect(node);
        // The worklet needs a sink to be pulled; a muted gain keeps the microphone out of the speakers.
        const mute = captureCtx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(captureCtx.destination);
      } catch (err) {
        fail(err instanceof Error ? err.message : 'The microphone or the voice connection could not be opened.');
      }
    })();

    return () => {
      cancelled = true;
      interruptRef.current = () => {};
      release();
      setPartial('');
      setError(null);
      setSpeaks(null);
      setPhase('idle');
    };
  }, [enabled, sessionId, setPhase]);

  /** Stop the reply being spoken now (the stop button). */
  const interrupt = useCallback(() => interruptRef.current(), []);

  return { state, error, partial, speaks, interrupt };
}
