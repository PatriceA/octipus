/**
 * Speech engines as model rows (docs/VOICE.md → Engines are models).
 *
 * Speech to text and text to speech run on the model bound to the
 * Transcription and Speech lanes, like every other kind of model work. The
 * engine adapters in `stt.ts` / `tts.ts` stay what they are — subprocess and
 * socket plumbing — but are only ever built from a row, here:
 *
 *   provider `local-audio`   whisper.cpp:<model> · faster-whisper:<model>  (Transcription)
 *                            kokoro:<voice> · piper:<voice>                (Speech)
 *   provider `mistral`       voxtral-* (both lanes)
 *   provider `openai`        gpt-4o-transcribe / whisper-1 · gpt-4o-mini-tts
 *   any row with an endpoint an OpenAI-compatible speech server: Speaches,
 *   (`custom-openai`, or     vLLM / vLLM-Omni, LocalAI, NeMo-Speech, NIM, Groq, …
 *   `openai` + endpoint)     (src/voice/compatible.ts) — any model it serves
 *
 * The model id, key (`apiKeyRef`) and streaming model come from the row, never
 * from a constant. `SPEECH_ENGINE_CATALOG` is the curated list of engines the
 * setup and the migration can create rows for — a list of what exists, not a
 * choice: nothing is used until it is bound to a lane.
 */
import type { ModelConfigEntry, NewModelConfigEntry } from '@/db/schema/models';
import { speechConfigOf } from './speech-hints';
import type { STTEngine } from './stt';
import type { TTSEngine, TTSOptions } from './tts';

export const LOCAL_AUDIO_PROVIDER = 'local-audio';

export type SpeechDirection = 'stt' | 'tts';
export type SpeechFormat = 'mp3' | 'wav' | 'opus' | 'ogg' | 'pcm' | 'flac';

/**
 * The file extension for an audio MIME type — the name a cloud API and
 * ffmpeg read the container from (`audio/x-m4a` → m4a, `audio/mpeg` → mp3).
 */
export function audioExtensionFor(mimeType: string | undefined, fallback = 'ogg'): string {
  const sub = (mimeType?.split('/')[1] || '').split(';')[0].trim().toLowerCase().replace(/^x-/, '');
  const known: Record<string, string> = {
    mpeg: 'mp3', mp3: 'mp3', mpga: 'mp3', mp4: 'm4a', m4a: 'm4a', aac: 'aac', wav: 'wav', wave: 'wav',
    ogg: 'ogg', opus: 'opus', webm: 'webm', flac: 'flac', amr: 'amr', '3gpp': '3gp',
  };
  if (sub.startsWith('vnd.wave')) return 'wav';
  return known[sub] ?? (/^[a-z0-9]{2,5}$/.test(sub) ? sub : fallback);
}

/** The engine families a row can be, and their old `voice.*Provider` names (kept as request aliases). */
export type SpeechEngineKind = 'whisper' | 'fasterwhisper' | 'kokoro' | 'piper' | 'mistral' | 'openai' | 'compatible';

export interface SpeechEngineEntry {
  kind: SpeechEngineKind;
  direction: SpeechDirection;
  /** The row this engine is registered as. */
  row: Pick<NewModelConfigEntry, 'name' | 'provider' | 'modelId'> & { metadata?: NewModelConfigEntry['metadata'] };
}

/** Curated: the engines Octipus can drive. Model ids are the vendors' current ones. */
export const SPEECH_ENGINE_CATALOG: readonly SpeechEngineEntry[] = [
  { kind: 'whisper', direction: 'stt', row: { name: 'local whisper.cpp base', provider: LOCAL_AUDIO_PROVIDER, modelId: 'whisper.cpp:base' } },
  { kind: 'fasterwhisper', direction: 'stt', row: { name: 'local faster-whisper small', provider: LOCAL_AUDIO_PROVIDER, modelId: 'faster-whisper:small' } },
  { kind: 'mistral', direction: 'stt', row: { name: 'mistral voxtral transcribe', provider: 'mistral', modelId: 'voxtral-mini-latest', metadata: { speech: { streamingModel: 'voxtral-mini-transcribe-realtime-2602' } } } },
  { kind: 'openai', direction: 'stt', row: { name: 'openai gpt-4o-transcribe', provider: 'openai', modelId: 'gpt-4o-transcribe', metadata: { speech: { streamingModel: 'gpt-realtime-whisper' } } } },
  { kind: 'kokoro', direction: 'tts', row: { name: 'local kokoro', provider: LOCAL_AUDIO_PROVIDER, modelId: 'kokoro:af_sarah', metadata: { speech: { formats: ['wav'] } } } },
  { kind: 'piper', direction: 'tts', row: { name: 'local piper', provider: LOCAL_AUDIO_PROVIDER, modelId: 'piper:en_US-lessac-medium', metadata: { speech: { formats: ['wav'] } } } },
  { kind: 'mistral', direction: 'tts', row: { name: 'mistral voxtral speech', provider: 'mistral', modelId: 'voxtral-mini-tts-2603', metadata: { speech: { formats: ['mp3', 'wav', 'opus', 'flac', 'pcm'] } } } },
  { kind: 'openai', direction: 'tts', row: { name: 'openai gpt-4o-mini-tts', provider: 'openai', modelId: 'gpt-4o-mini-tts', metadata: { speech: { formats: ['mp3', 'wav', 'opus', 'flac', 'pcm'] } } } },
];

/**
 * A faster-whisper model: a size, a release name (`large-v3-turbo`, `turbo`,
 * `distil-large-v3`) or a CTranslate2 repository on Hugging Face (`owner/name`).
 * The name becomes a process argument, so it is held to that shape.
 */
const FASTER_WHISPER_MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export function catalogEntry(kind: SpeechEngineKind, direction: SpeechDirection, size?: string): SpeechEngineEntry | undefined {
  const entry = SPEECH_ENGINE_CATALOG.find((e) => e.kind === kind && e.direction === direction);
  if (!entry || !size || kind !== 'fasterwhisper') return entry;
  if (!FASTER_WHISPER_MODEL.test(size)) throw new Error(`"${size}" is not a faster-whisper model name (a size such as small, a release such as large-v3-turbo, or owner/name on Hugging Face).`);
  return { ...entry, row: { ...entry.row, name: `local faster-whisper ${size.replace('/', ' ')}`, modelId: `faster-whisper:${size}` } };
}

type KindRow = Pick<ModelConfigEntry, 'provider' | 'modelId'> & Partial<Pick<ModelConfigEntry, 'endpoint'>>;

/** Which engine family a row is (undefined: not a speech engine this build drives). */
export function engineKindOf(row: KindRow): SpeechEngineKind | undefined {
  if (row.provider === LOCAL_AUDIO_PROVIDER) {
    if (row.modelId.startsWith('whisper.cpp:')) return 'whisper';
    if (row.modelId.startsWith('faster-whisper:')) return 'fasterwhisper';
    if (row.modelId.startsWith('kokoro:')) return 'kokoro';
    if (row.modelId.startsWith('piper:')) return 'piper';
    return undefined;
  }
  if (row.provider === 'mistral') return 'mistral';
  // An endpoint of its own makes the row an OpenAI-compatible speech server,
  // whatever it is called; OpenAI itself is the row without one.
  if (row.endpoint && (row.provider === 'custom-openai' || row.provider === 'openai')) return 'compatible';
  if (row.provider === 'openai') return 'openai';
  return undefined;
}

type DirectionRow = KindRow & Partial<Pick<ModelConfigEntry, 'metadata' | 'topicRoles' | 'topics'>>;

/**
 * Which way a speech row works: transcription (stt) or speech (tts);
 * undefined = not a speech engine. A local engine is what it is; any other
 * row says so (`metadata.speech.direction`), or is known by its model id
 * (`speech-hints.ts`). A chat model on a speech provider has neither.
 */
export function speechDirectionOf(row: DirectionRow): SpeechDirection | undefined {
  const kind = engineKindOf(row);
  if (!kind) return undefined;
  if (kind === 'whisper' || kind === 'fasterwhisper') return 'stt';
  if (kind === 'kokoro' || kind === 'piper') return 'tts';
  const declared = row.metadata?.speech?.direction;
  if (declared) return declared;
  if (kind === 'compatible') return speechConfigOf(row).direction;
  const id = row.modelId.toLowerCase();
  if (/tts|speech/.test(id)) return 'tts';
  if (/transcri|whisper|voxtral/.test(id)) return 'stt';
  return undefined; // a chat model of a speech provider
}

/** A local engine runs on this machine (protection levels 3–4 may use it). */
export function isLocalSpeechRow(row: Pick<ModelConfigEntry, 'provider'>): boolean {
  return row.provider === LOCAL_AUDIO_PROVIDER;
}

/**
 * Does speech on this row stay on the owner's machine or network — a local
 * engine, or a speech server at a private address? Such a row spends none of
 * the install's hosted keys, so an account that may not use those may use it.
 */
export async function speechStaysLocal(row: Pick<ModelConfigEntry, 'provider' | 'modelId' | 'endpoint' | 'metadata'>): Promise<boolean> {
  if (isLocalSpeechRow(row)) return true;
  if (engineKindOf(row) !== 'compatible') return false;
  const { runsLocally } = await import('@/core/protection/routing');
  return runsLocally(row);
}

/** What a row writes; the first is its default. */
export function speechFormats(row: Pick<ModelConfigEntry, 'provider' | 'modelId' | 'metadata'> & Partial<Pick<ModelConfigEntry, 'endpoint'>>): SpeechFormat[] {
  const declared = speechConfigOf(row).formats;
  if (declared?.length) return declared;
  const kind = engineKindOf(row);
  if (kind === 'kokoro' || kind === 'piper') return ['wav'];
  // Every speech server writes WAV; the rest is not promised by the protocol.
  if (kind === 'compatible') return ['wav', 'mp3', 'opus', 'flac', 'pcm'];
  return ['mp3', 'wav', 'opus', 'flac', 'pcm'];
}

/**
 * The row's own key (`apiKeyRef`: a vault name or `env:NAME`), or undefined
 * when the row names none — then the provider's install key is used. A ref
 * that names a key that is not there fails loud: billing another key would be wrong.
 */
async function rowApiKey(row: Pick<ModelConfigEntry, 'apiKeyRef' | 'name'>): Promise<string | undefined> {
  if (!row.apiKeyRef) return undefined;
  const { resolveCustomApiKey } = await import('@/services/provider-service');
  const key = await resolveCustomApiKey(row.apiKeyRef);
  if (!key) throw new Error(`The key "${row.apiKeyRef}" of model "${row.name}" is not set.`);
  return key;
}

/**
 * The speech-to-text adapter for `row`. `stream` = the live socket (needs a
 * streaming engine); `batch` = a whole clip.
 */
export async function sttEngineFor(row: ModelConfigEntry, opts: { language: string; streamWindowSeconds?: number }): Promise<STTEngine> {
  const stt = await import('./stt');
  const kind = engineKindOf(row);
  switch (kind) {
    case 'whisper': {
      const { whisperModelPath } = await import('./whisper');
      return new stt.WhisperEngine(row.metadata?.modelPath || whisperModelPath(), { language: opts.language, streamWindowSeconds: opts.streamWindowSeconds });
    }
    case 'fasterwhisper': {
      // Resident: the model stays loaded between requests (stt.ts residentFasterWhisper).
      const speech = row.metadata?.speech;
      return stt.residentFasterWhisper({
        language: opts.language, model: row.modelId.slice('faster-whisper:'.length) || 'small',
        streamWindowSeconds: opts.streamWindowSeconds, device: speech?.device, computeType: speech?.computeType,
      });
    }
    case 'compatible': {
      const { CompatibleSTTEngine, speechEndpointOf } = await import('./compatible');
      return new CompatibleSTTEngine(await speechEndpointOf(row), row.modelId, speechConfigOf(row), {
        language: opts.language, streamWindowSeconds: opts.streamWindowSeconds,
      });
    }
    case 'mistral':
      return new stt.MistralSTTEngine(row.modelId, { language: opts.language, apiKey: await rowApiKey(row), streamingModel: row.metadata?.speech?.streamingModel });
    case 'openai':
      return new stt.OpenAIRealtimeSTTEngine(row.metadata?.speech?.streamingModel || row.modelId, {
        language: opts.language, apiKey: await rowApiKey(row), batchModel: row.modelId,
      });
    default:
      throw new Error(`Model "${row.name}" (${row.provider}/${row.modelId}) is not a speech-to-text engine this install can run.`);
  }
}

/** What one request asks of the engine, beyond the text. */
export interface SpeechVoice {
  /** A voice the engine offers (a preset id). */
  voice?: string;
  /** How the voice should sound, in words. */
  instructions?: string;
  /** A reference clip to speak in the voice of, and what is said in it. */
  refAudio?: { data: Buffer; mimeType: string };
  refText?: string;
  speed?: number;
}

/** The text-to-speech adapter for `row`, writing `format` (validated against `speechFormats`). */
export async function ttsEngineFor(row: ModelConfigEntry, opts: SpeechVoice & { format: SpeechFormat }): Promise<TTSEngine> {
  const tts = await import('./tts');
  const kind = engineKindOf(row);
  const format = opts.format as 'mp3' | 'wav' | 'opus' | 'flac' | 'pcm';
  const config = speechConfigOf(row);
  const voice = opts.voice || config.voice;
  const options: TTSOptions = {
    outputFormat: format, model: row.modelId, speed: opts.speed, instructions: opts.instructions,
    refAudio: opts.refAudio, refText: opts.refText, extraBody: config.extraBody,
  };
  switch (kind) {
    case 'kokoro':
      // The row names its voice (kokoro:<voice>); a voice asked for explicitly wins.
      return new tts.KokoroEngine(voice || row.modelId.slice('kokoro:'.length) || undefined, { outputFormat: 'wav', ...(opts.speed ? { speed: opts.speed } : {}) });
    case 'piper': {
      const modelPath = row.metadata?.modelPath || `~/.local/share/piper/voices/${row.modelId.slice('piper:'.length)}.onnx`;
      return new tts.PiperEngine(modelPath, modelPath.replace(/\.onnx$/, '.json'), { outputFormat: 'wav', ...(opts.speed ? { speed: opts.speed } : {}) });
    }
    case 'mistral':
      return new tts.MistralTTSEngine(voice, { ...options, apiKey: await rowApiKey(row) });
    case 'openai':
      return new tts.OpenAITTSEngine(voice, { ...options, apiKey: await rowApiKey(row) });
    case 'compatible': {
      const { CompatibleTTSEngine, speechEndpointOf } = await import('./compatible');
      return new CompatibleTTSEngine(await speechEndpointOf(row), row.modelId, config, { ...options, voice });
    }
    default:
      throw new Error(`Model "${row.name}" (${row.provider}/${row.modelId}) is not a text-to-speech engine this install can run.`);
  }
}

/** Local transcription converts recordings and voice notes with ffmpeg first. */
async function ffmpegMissing(): Promise<string | null> {
  const { whichSync } = await import('@/utils/proc');
  return whichSync('ffmpeg') ? null : '`ffmpeg` is not installed; local transcription converts recordings with it. Install ffmpeg.';
}

/**
 * Can this row run here, now? Local engines are probed (binary runs, model
 * present); cloud engines need a key. The reason says what to do.
 */
export async function speechRowAvailable(row: Pick<ModelConfigEntry, 'provider' | 'modelId' | 'apiKeyRef' | 'metadata'> & Partial<Pick<ModelConfigEntry, 'endpoint'>>): Promise<{ ok: true } | { ok: false; reason: string }> {
  const kind = engineKindOf(row);
  switch (kind) {
    case 'whisper': {
      const { probeWhisper } = await import('./whisper');
      const probe = await probeWhisper();
      if (!probe.binaryOk) return { ok: false, reason: `${probe.binaryReason ?? 'Local whisper is not installed'}. Install it on the Voice page (Settings → Voice), or run \`octi setup\`.` };
      const noFfmpeg = await ffmpegMissing();
      if (noFfmpeg) return { ok: false, reason: noFfmpeg };
      if (row.metadata?.modelPath) {
        const { fileAt } = await import('@/utils/fs-file');
        if (!(await fileAt(row.metadata.modelPath).exists())) return { ok: false, reason: `The whisper model file ${row.metadata.modelPath} is missing.` };
      } else if (!probe.modelOk) {
        return { ok: false, reason: 'The whisper model file is missing. Install it on the Voice page (Settings → Voice), or run `octi setup`.' };
      }
      return { ok: true };
    }
    case 'fasterwhisper':
    case 'kokoro': {
      const { hasUv, kokoroModelsPresent, UV_INSTALL_HINT } = await import('./provision');
      if (!hasUv()) return { ok: false, reason: `\`uv\` is not installed. ${UV_INSTALL_HINT}` };
      if (kind === 'fasterwhisper' && !FASTER_WHISPER_MODEL.test(row.modelId.slice('faster-whisper:'.length))) {
        return { ok: false, reason: `"${row.modelId.slice('faster-whisper:'.length)}" is not a faster-whisper model name.` };
      }
      if (kind === 'fasterwhisper') {
        const noFfmpeg = await ffmpegMissing();
        if (noFfmpeg) return { ok: false, reason: noFfmpeg };
      }
      if (kind === 'kokoro' && !(await kokoroModelsPresent())) return { ok: false, reason: 'Kokoro model files are missing. Install Kokoro on the Voice page (Settings → Voice), or run `octi setup`.' };
      return { ok: true };
    }
    case 'piper': {
      if (!row.metadata?.modelPath) return { ok: false, reason: 'Piper needs its voice model path (the row\'s model path).' };
      const { fileAt } = await import('@/utils/fs-file');
      return (await fileAt(row.metadata.modelPath).exists()) ? { ok: true } : { ok: false, reason: `Piper voice not found at ${row.metadata.modelPath}.` };
    }
    case 'mistral':
    case 'openai': {
      if (row.apiKeyRef) {
        const { resolveCustomApiKey } = await import('@/services/provider-service');
        return (await resolveCustomApiKey(row.apiKeyRef)) ? { ok: true } : { ok: false, reason: `The model's key "${row.apiKeyRef}" is not set.` };
      }
      const has = kind === 'mistral'
        ? !!(await (await import('@/models/providers/mistral-provider')).getMistralApiKey())
        : !!(await (await import('@/models/providers/openai-provider')).getOpenAIApiKey());
      return has ? { ok: true } : { ok: false, reason: `No ${kind === 'mistral' ? 'Mistral' : 'OpenAI'} API key is configured.` };
    }
    case 'compatible': {
      // The server is asked when it is used: a probe on every status poll would
      // hammer it, and a failure at call time falls to the backup, with the reason.
      if (!row.apiKeyRef) return { ok: true };
      const { resolveCustomApiKey } = await import('@/services/provider-service');
      return (await resolveCustomApiKey(row.apiKeyRef)) ? { ok: true } : { ok: false, reason: `The model's key "${row.apiKeyRef}" is not set.` };
    }
    default:
      return { ok: false, reason: `${row.provider}/${row.modelId} is not a speech engine this install can run. Add it as a speech server (its endpoint URL and model id) on the Voice page.` };
  }
}

/**
 * Register an engine from the catalog as a model row and, when its lane has
 * no binding yet (or `makePrimary`), bind it there. What every installer and
 * the setup ends with, so an installed engine is used without another step —
 * but never silently replaces an engine someone chose.
 */
export async function useSpeechEngine(
  kind: SpeechEngineKind,
  direction: SpeechDirection,
  opts: { size?: string; modelPath?: string; makePrimary?: boolean } = {},
): Promise<{ row: ModelConfigEntry; bound: 'primary' | 'already-bound' | 'not-bound'; lane: 'transcription' | 'speech' }> {
  const entry = catalogEntry(kind, direction, opts.size);
  if (!entry) throw new Error(`No ${direction === 'stt' ? 'speech-to-text' : 'text-to-speech'} engine "${kind}"`);
  const { getModelRegistry } = await import('@/models/model-registry');
  const registry = getModelRegistry();
  const lane = direction === 'stt' ? 'transcription' as const : 'speech' as const;
  let row = await registry.getModel(entry.row.name);
  if (row && opts.modelPath && row.metadata?.modelPath !== opts.modelPath) {
    row = (await registry.updateModel(row.name, { metadata: { ...(row.metadata ?? {}), modelPath: opts.modelPath } })) ?? row;
  }
  if (!row) {
    row = await registry.registerModel({
      ...entry.row,
      supportsTools: false,
      supportsStreaming: false,
      supportsVision: false,
      metadata: { ...(entry.row.metadata ?? {}), ...(opts.modelPath ? { modelPath: opts.modelPath } : {}), capabilitiesDetectedAt: new Date().toISOString() },
    } as NewModelConfigEntry);
  }
  return bindSpeechRow(row, lane, opts.makePrimary);
}

/**
 * Bind a speech row to its lane: primary when the lane is free or
 * `makePrimary`. The engine it replaces becomes the one backup, so nothing
 * that worked stops working; an older backup steps down.
 */
async function bindSpeechRow(
  row: ModelConfigEntry, lane: 'transcription' | 'speech', makePrimary?: boolean,
): Promise<{ row: ModelConfigEntry; bound: 'primary' | 'already-bound' | 'not-bound'; lane: 'transcription' | 'speech' }> {
  const { getModelRegistry } = await import('@/models/model-registry');
  const registry = getModelRegistry();
  const current = await registry.getModelForTopic(lane);
  const currentBound = current && (current.topics?.includes(lane) || (current.topicRoles && lane in current.topicRoles)) ? current : null;
  if (currentBound?.name === row.name) return { row, bound: 'already-bound', lane };
  if (currentBound && !makePrimary) return { row, bound: 'not-bound', lane };
  if (currentBound) {
    const backup = await registry.getBackupModelForTopic(lane);
    if (backup && backup.name !== currentBound.name && backup.name !== row.name && backup.topicRoles?.[lane]) {
      const { [lane]: _dropped, ...rest } = backup.topicRoles;
      await registry.updateModel(backup.name, { topicRoles: rest });
    }
    await registry.updateModel(currentBound.name, { topicRoles: { ...(currentBound.topicRoles ?? {}), [lane]: 'backup' } });
  }
  const bound = await registry.updateModel(row.name, { topicRoles: { ...(row.topicRoles ?? {}), [lane]: 'primary' } }) ?? row;
  return { row: bound, bound: 'primary', lane };
}

export interface SpeechServerInput {
  direction: SpeechDirection;
  /** The server's base URL, with or without `/v1`. */
  endpoint: string;
  /** The model id the server serves it under (`openai/whisper-large-v3-turbo`, `openbmb/VoxCPM2`). */
  modelId: string;
  /** Shown in the lists; defaults to the model id. */
  name?: string;
  /** A vault secret name or `env:NAME`; none for a keyless local server. */
  apiKeyRef?: string;
  /** What this model takes, where it differs from what its id is known for. */
  speech?: NonNullable<ModelConfigEntry['metadata']>['speech'];
  makePrimary?: boolean;
}

/**
 * Register a model on an OpenAI-compatible speech server as a model row and
 * bind it to its lane (docs/VOICE.md → Your own speech server). The row
 * starts with what is known of the model (`speech-hints.ts`), so a model
 * someone names by id works without a list of its quirks; a server at a
 * private address is marked as staying local, so protected content may use it.
 */
export async function useSpeechServer(input: SpeechServerInput): Promise<{ row: ModelConfigEntry; bound: 'primary' | 'already-bound' | 'not-bound'; lane: 'transcription' | 'speech' }> {
  const modelId = input.modelId.trim();
  if (!modelId) throw new Error('A model id is required (what the server serves the model as).');
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint.trim()); } catch { throw new Error(`"${input.endpoint}" is not a URL (for example http://localhost:8000/v1).`); }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('The endpoint must be an http or https URL.');
  const { getModelRegistry } = await import('@/models/model-registry');
  const { isPrivateEndpoint } = await import('@/models/decision');
  const { speechHintsFor } = await import('./speech-hints');
  const registry = getModelRegistry();
  const lane = input.direction === 'stt' ? 'transcription' as const : 'speech' as const;
  const name = (input.name?.trim() || `${input.direction === 'stt' ? 'transcribe' : 'speech'} ${modelId}`).slice(0, 120);
  const url = endpoint.toString().replace(/\/+$/, '');
  // A value sent as null means "not set": the model's known default applies.
  const given = Object.fromEntries(Object.entries(input.speech ?? {}).filter(([, v]) => v !== null && v !== undefined));
  const speech = { ...speechHintsFor(modelId), ...given, direction: input.direction };
  const metadata: NewModelConfigEntry['metadata'] = {
    customProvider: { auth: { type: 'bearer' } },
    speech,
    ...(isPrivateEndpoint(url) ? { dataPolicy: { hosting: 'local' as const, retention: 'none' as const, trainsOnInput: false } } : {}),
    capabilitiesDetectedAt: new Date().toISOString(),
  };
  const existing = await registry.getModel(name);
  if (existing && (existing.ownerUserId || speechDirectionOf(existing) !== input.direction)) {
    throw new Error(`A model named "${name}" already exists and is not a ${input.direction === 'stt' ? 'speech-to-text' : 'text-to-speech'} engine. Choose another name.`);
  }
  const row = existing
    ? (await registry.updateModel(name, {
      endpoint: url, modelId, apiKeyRef: input.apiKeyRef?.trim() || null,
      metadata: { ...(existing.metadata ?? {}), ...metadata, customProvider: existing.metadata?.customProvider ?? metadata.customProvider },
    })) ?? existing
    : await registry.registerModel({
      name, provider: 'custom-openai', modelId, endpoint: url, apiKeyRef: input.apiKeyRef?.trim() || null,
      supportsTools: false, supportsStreaming: false, supportsVision: false, metadata,
    } as NewModelConfigEntry);
  return bindSpeechRow(row, lane, input.makePrimary);
}
