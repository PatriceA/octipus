'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

/** What `POST /voice/speak` is asked for from the Voice page. */
export interface SpeakRequest {
  text: string;
  /** A speech engine row to try instead of the one in use (admin). */
  model?: string;
  profile?: string;
  voice?: string;
  instructions?: string;
  speed?: number;
}

export interface Spoken {
  /** The engine that answered (`X-Speech-Model`); null when the answer did not name it. */
  engine: string | null;
  /** From the request to the audio being here. */
  ms: number;
  blob: Blob;
}

/**
 * Speak a line through the server and play it. One clip at a time: starting
 * another stops the one playing. `busy` is the key of the request in flight.
 */
export function useSpeak() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => stop, [stop]);

  /** Play a clip that is already here (a preview kept from an earlier request, a profile's reference clip). */
  const playBlob = useCallback(async (blob: Blob) => {
    stop();
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;
    await audio.play();
  }, [stop]);

  const speak = useCallback(async (key: string, request: SpeakRequest): Promise<Spoken> => {
    stop();
    setBusy(key);
    const started = performance.now();
    try {
      const { blob, headers } = await api.postForBlob('/voice/speak', request);
      const ms = Math.round(performance.now() - started);
      const named = headers.get('X-Speech-Model');
      const engine = named ? decodeURIComponent(named) : null;
      try {
        await playBlob(blob);
      } catch (err) {
        throw new Error(`${engine ?? 'The speech engine'} answered, but the audio could not be played here: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { engine, ms, blob };
    } finally {
      setBusy(null);
    }
  }, [stop, playBlob]);

  return { speak, playBlob, busy };
}
