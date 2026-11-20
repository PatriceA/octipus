/**
 * What the voice routes and the `/voice` conversation socket say, as the web
 * reads it.
 *
 * The server's own declarations live in `src/voice/overview.ts`,
 * `src/voice/profiles.ts`, `src/voice/install-jobs.ts` and
 * `src/voice/session.ts`. Those files import server modules through the
 * `@/` alias, which in this build means `web/`, so they cannot be imported
 * from here (even type-only). This is the one web-side copy: every voice
 * screen and the conversation hook import it, none declares its own.
 */

export type SpeechDirection = 'stt' | 'tts';
export type SpeechEngineKind = 'whisper' | 'fasterwhisper' | 'kokoro' | 'piper' | 'mistral' | 'openai' | 'compatible';
/** The engines `POST /voice/engines/install` downloads and sets up on the server. */
export type InstallableEngine = 'whisper' | 'fasterwhisper' | 'kokoro';
export type VoiceDescriptionMode = 'field' | 'prefix' | 'none';

/** What serves one direction now (`GET /voice/engines` → `hear` / `speak`). */
export interface SpeechServing {
  available: boolean;
  model: string | null;
  engine: string | null;
  local: boolean;
  reason: string | null;
}

export interface SpeechEngineRow {
  name: string;
  direction: SpeechDirection;
  kind: SpeechEngineKind;
  modelId: string;
  endpoint: string | null;
  apiKeyRef: string | null;
  role: 'primary' | 'backup' | null;
  local: boolean;
  available: boolean;
  reason: string | null;
  speech: {
    voices: string[];
    instructions: VoiceDescriptionMode;
    cloning: boolean;
    speed: boolean;
    streams: boolean;
    sampleRate: number | null;
    formats: string[];
    realtime: string | null;
    upload: 'any' | 'wav';
    device: string | null;
  };
}

export interface SpeechCatalogEntry {
  kind: SpeechEngineKind;
  direction: SpeechDirection;
  label: string;
  local: boolean;
  installable: boolean;
  note: string;
  sizes?: Array<{ id: string; download: string; ram: string; note: string }>;
}

export interface SpeechInstallJob {
  engine: InstallableEngine;
  size?: string;
  stage: 'running' | 'done' | 'error';
  log: string[];
  error?: string;
  model?: string;
  bound?: 'primary' | 'already-bound' | 'not-bound';
  startedAt: number;
  finishedAt?: number;
}

export interface SpeechOverview {
  hear: SpeechServing;
  speak: SpeechServing;
  engines: SpeechEngineRow[];
  catalog: SpeechCatalogEntry[];
  jobs: SpeechInstallJob[];
  host: { uv: boolean; ffmpeg: boolean };
}

/**
 * An engine row's own settings, as `POST /voice/engines/server` and `PATCH
 * /voice/engines/:name` take them: only those sent change. `null` clears one
 * (what the model is known for applies again). `realtime` is merged into the
 * stored one, so `{ protocol: 'off' }` keeps a stored URL and rate.
 */
export interface SpeechSettingsInput {
  sampleRate?: number | null;
  instructions?: VoiceDescriptionMode | null;
  cloning?: boolean | null;
  streams?: boolean | null;
  speed?: boolean | null;
  extraBody?: Record<string, unknown> | null;
  upload?: 'any' | 'wav' | null;
  realtime?: { protocol: 'openai' | 'nemo' | 'off'; url?: string; sampleRate?: number } | null;
  device?: 'auto' | 'cpu' | 'cuda' | null;
}

/** The answer of `POST /voice/engines/use` and `/voice/engines/server`. */
export interface SpeechEngineBound {
  model: string;
  lane: 'transcription' | 'speech';
  bound: 'primary' | 'already-bound' | 'not-bound';
}

/** A voice profile as `GET /voice/voices` lists it; a non-admin gets the name, note, voice and `hasClip` only. */
export interface VoiceProfile {
  name: string;
  description?: string;
  voice?: string;
  instructions?: string;
  refText?: string;
  speed?: number;
  model?: string;
  hasClip: boolean;
}

/** `GET /voice/voices`. */
export interface VoicesAnswer {
  model: string | null;
  voices: string[];
  reason?: string;
  active: string;
  profiles: VoiceProfile[];
}

/** `PUT /voice/profiles/:name`. */
export interface VoiceProfileInput {
  description?: string;
  voice?: string;
  instructions?: string;
  refText?: string;
  speed?: number;
  model?: string;
  clip?: { data: string; mimeType: string } | null;
  active?: boolean;
}

/** `GET /voice/status` (the model names are an admin's). */
export interface VoiceStatus {
  sttAvailable: boolean;
  sttReason: string | null;
  sttLocal?: boolean;
  sttModel?: string | null;
  ttsAvailable: boolean;
  ttsReason: string | null;
  ttsModel?: string | null;
  language?: string;
}

/** `POST /voice/transcribe`: a failed transcription answers 200 with `error`. */
export interface TranscribeAnswer {
  text?: string;
  model?: string;
  language?: string;
  duration?: number;
  error?: string;
}

/** What the `/voice` socket sends in conversation mode (JSON text frames). An `audio` message is followed by one binary frame. */
export type VoiceServerMessage =
  | { type: 'ready'; mode: 'conversation'; engine: string; live: boolean; speak: boolean }
  | { type: 'speech_start' }
  | { type: 'transcript'; text: string; final: false }
  | { type: 'utterance'; text: string }
  | { type: 'audio'; seq: number; format: 'pcm' | 'wav'; sampleRate: number; ms: number; text?: string }
  | { type: 'speaking'; on: boolean }
  | { type: 'barge_in' }
  | { type: 'error'; message: string };

/** What the client sends besides microphone frames. */
export type VoiceClientMessage =
  | { type: 'interrupt' }
  | { type: 'playback'; state: 'ended' }
  | { type: 'stop' };
