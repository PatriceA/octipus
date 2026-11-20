/**
 * What a speech model is known to do, read off its model id — the same kind
 * of detection `src/models/capability-detect.ts` does for chat models. A row's
 * own `metadata.speech` always wins: these are the defaults a row starts
 * with when someone types `openbmb/VoxCPM2` and nothing else.
 *
 * Nothing here selects a model. It only describes the request shape of a
 * model someone bound to a lane.
 */
import type { ModelMetadata } from '@/db/schema/models';

export type SpeechConfig = NonNullable<ModelMetadata['speech']>;

interface Hint {
  match: RegExp;
  speech: SpeechConfig;
}

/** First match wins: specific families before the generic names. */
const HINTS: readonly Hint[] = [
  // VoxCPM: voice design is a parenthesised prefix on the text, cloning takes a reference clip, 48 kHz.
  { match: /voxcpm/i, speech: { direction: 'tts', instructions: 'prefix', cloning: true, streams: true, speed: false, sampleRate: 48000, formats: ['wav', 'pcm'] } },
  // Breeze-TTS: speaker tags S0–S9 (S0 unless a voice is chosen: it knows no "default"), `instructions` for voice design, reference clip for cloning, 24 kHz.
  { match: /breeze[-_ ]?tts/i, speech: { direction: 'tts', instructions: 'field', cloning: true, streams: true, speed: false, sampleRate: 24000, voice: 'S0', voices: ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'], formats: ['wav', 'pcm'] } },
  { match: /kokoro/i, speech: { direction: 'tts', instructions: 'none', speed: true, sampleRate: 24000 } },
  { match: /gpt-4o-mini-tts/i, speech: { direction: 'tts', instructions: 'field', speed: true, streams: true, sampleRate: 24000 } },
  // NVIDIA streaming ASR (NeMo-Speech.cpp, NIM): WAV uploads, its own realtime socket.
  { match: /nemotron.*asr|parakeet|canary/i, speech: { direction: 'stt', upload: 'wav', realtime: { protocol: 'nemo', sampleRate: 16000 } } },
  { match: /whisper|transcri|[-_/]asr|[-_/]stt|voxtral(?!.*tts)/i, speech: { direction: 'stt' } },
  { match: /tts|speech|voice/i, speech: { direction: 'tts' } },
];

/** The defaults for a model id, or `{}` when nothing is known about it. */
export function speechHintsFor(modelId: string): SpeechConfig {
  return HINTS.find((h) => h.match.test(modelId))?.speech ?? {};
}

/** A row's speech settings: what is known of its model, overridden by what the row says. */
export function speechConfigOf(row: { modelId: string; metadata?: ModelMetadata | null }): SpeechConfig {
  return { ...speechHintsFor(row.modelId), ...(row.metadata?.speech ?? {}) };
}

/**
 * The realtime socket live audio streams to, or undefined when there is none
 * — also when the row turned it off (`protocol: 'off'`) over a model that is
 * known to have one: then each turn is transcribed whole.
 */
export function liveRealtime(config: SpeechConfig): (NonNullable<SpeechConfig['realtime']> & { protocol: 'openai' | 'nemo' }) | undefined {
  const realtime = config.realtime;
  return realtime && realtime.protocol !== 'off' ? realtime as NonNullable<SpeechConfig['realtime']> & { protocol: 'openai' | 'nemo' } : undefined;
}

/** Two speech settings say the same (the objects among them compared by value). */
export function sameSetting(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
