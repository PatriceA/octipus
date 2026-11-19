/**
 * Lines spoken by the install's own Speech engine, held for the carrier to
 * fetch (`GET /api/voice/webhook/audio/:id`, unauthenticated: a carrier
 * presents no credentials, so the id is the secret — 128 random bits).
 *
 * In memory, short-lived and bounded: a clip is fetched within seconds of the
 * webhook reply that names it, and a carrier may fetch it more than once
 * (a HEAD or a retry), so it is served until it expires.
 * ponytail: single instance only; a multi-instance install needs a shared store.
 */
import { randomBytes } from 'node:crypto';
import { forSpeech } from '@/shared/speech-text';
import { logger } from '@/utils/logger';
import type { SpokenLine } from './interface';

const log = logger.child({ component: 'phone-audio' });

export const CALL_AUDIO_TTL_MS = 5 * 60_000;
/** All clips held at once. The oldest go first when a new one would exceed it. */
export const CALL_AUDIO_MAX_BYTES = 32 * 1024 * 1024;

interface Clip {
  audio: Buffer;
  contentType: string;
  expiresAt: number;
}

export class CallAudioStore {
  private clips = new Map<string, Clip>();
  private bytes = 0;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = CALL_AUDIO_TTL_MS,
    private readonly maxBytes = CALL_AUDIO_MAX_BYTES,
  ) {}

  /** Hold a clip; returns the id it is served under. */
  put(audio: Buffer, contentType: string): string {
    if (audio.length > this.maxBytes) throw new Error(`A ${audio.length}-byte clip is larger than the call audio store (${this.maxBytes} bytes).`);
    this.sweep();
    // Insertion order is age: the oldest clips make room.
    for (const [id, clip] of this.clips) {
      if (this.bytes + audio.length <= this.maxBytes) break;
      this.clips.delete(id);
      this.bytes -= clip.audio.length;
    }
    const id = randomBytes(16).toString('hex');
    this.clips.set(id, { audio, contentType, expiresAt: this.now() + this.ttlMs });
    this.bytes += audio.length;
    return id;
  }

  get(id: string): { audio: Buffer; contentType: string } | null {
    this.sweep();
    const clip = this.clips.get(id);
    return clip ? { audio: clip.audio, contentType: clip.contentType } : null;
  }

  /** How much longer a clip is served, in ms; 0 when it is gone. */
  remainingMs(id: string): number {
    const clip = this.clips.get(id);
    return clip ? Math.max(0, clip.expiresAt - this.now()) : 0;
  }

  get size(): number {
    return this.clips.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, clip] of this.clips) {
      if (clip.expiresAt > now) continue;
      this.clips.delete(id);
      this.bytes -= clip.audio.length;
    }
  }
}

let store: CallAudioStore | null = null;
export function getCallAudioStore(): CallAudioStore {
  if (!store) store = new CallAudioStore();
  return store;
}

/** The formats every carrier's play verb takes. */
const PLAYABLE = new Set(['mp3', 'wav']);

/** Stock lines (the re-prompt, the apology) already spoken: text → clip id. A handful of entries. */
const stockClips = new Map<string, string>();

/**
 * A line for the caller. With a Speech engine bound and a public URL the
 * carrier can reach (`audioBaseUrl`, where the audio route is mounted), the
 * line is spoken by the install's engine in its active voice and handed over
 * as a URL; otherwise — or when synthesis fails, which is logged — the
 * carrier's own voice reads the text. `stock`: a line said the same on every
 * call; its clip is reused while it is served for a good while longer.
 */
export async function prepareSpokenLine(text: string, audioBaseUrl: string | null, stock = false): Promise<SpokenLine> {
  const line: SpokenLine = { text: forSpeech(text) || text.trim() };
  if (!audioBaseUrl || !line.text) return line;
  const base = audioBaseUrl.replace(/\/+$/, '');
  const held = stock ? stockClips.get(line.text) : undefined;
  if (held && getCallAudioStore().remainingMs(held) > CALL_AUDIO_TTL_MS / 2) return { ...line, audioUrl: `${base}/${held}` };
  const { speechStatus, synthesizeWithLane } = await import('../resolve');
  if (!(await speechStatus('tts')).available) return line;
  try {
    const spoken = await synthesizeWithLane(line.text, { format: 'mp3' });
    if (!PLAYABLE.has(spoken.format)) {
      log.warn({ model: spoken.model, format: spoken.format }, 'The Speech engine writes neither mp3 nor wav; the carrier voice speaks this call');
      return line;
    }
    const id = getCallAudioStore().put(spoken.audio, spoken.contentType);
    if (stock) stockClips.set(line.text, id);
    return { ...line, audioUrl: `${base}/${id}` };
  } catch (err) {
    log.error({ err }, 'Phone line could not be synthesised; the carrier voice speaks it');
    return line;
  }
}
